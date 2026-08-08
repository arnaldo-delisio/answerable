// Infer station: evidence -> claims for the latest run of a surface. Rule-based
// detectors are deterministic; each claim carries a class from the fixed taxonomy
// (technical, eligibility, content-keyword, competitor, ai-visibility, brand-defense,
// authority, tool-opportunity), confidence (strongest supporting confidence_tag mapped
// per the prioritization-score class weights), falsifiability text, claim_evidence
// links, and its brief-schema row.
// Dedup: same class+subject re-observed updates the existing claim (stable id slug),
// never duplicates; a claim whose falsifiability condition is now met flips falsified.
// A detector failure is a logged line, never a throw that kills the run.
// LLM interpretation (community sentiment nuance) is optional: only when
// ANTHROPIC_API_KEY exists or the claude CLI is present; skipped with a visible log
// line otherwise, and any LLM-derived claim gets confidence_tag inference (0.3).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { desc, eq, like, and } from "drizzle-orm";
import { db, schema } from "../../db";
import type { ConfidenceTag } from "../../db/schema";
import { laneEnabled } from "../sense";

type EvidenceRow = typeof schema.evidence.$inferSelect;
type PanelRow = typeof schema.panelObservations.$inferSelect;
type ClaimRow = typeof schema.claims.$inferSelect;

// Confidence mapping: strongest confidence_tag among linked evidence.
const TAG_CONFIDENCE: Record<string, number> = {
  observed: 0.9,
  measured: 0.85,
  reported: 0.6,
  "reported-unverified": 0.4,
  inference: 0.3,
};

// Default class weights: initial priority by class weight (impact x confidence x class
// weight x prior / effort; every factor is stored decomposed, never a black-box score).
const CLASS_WEIGHT: Record<string, number> = {
  "brand-defense": 1.5,
  "ai-visibility": 1.4,
  eligibility: 1.2,
  technical: 1.2,
  "tool-opportunity": 1.1,
  "content-keyword": 1.0,
  competitor: 1.0,
  authority: 0.9,
};

const CLASS_INTENT: Record<string, string> = {
  technical: "site health",
  eligibility: "site health / crawler access",
  "ai-visibility": "discovery",
  "brand-defense": "brand trust / navigational",
  competitor: "comparison",
  "tool-opportunity": "transactional (do-a-task)",
};

const CLASS_ASSET: Record<string, string> = {
  technical: "fix spec",
  eligibility: "fix spec / robots policy",
  "ai-visibility": "quick-answer (AEO) blocks + entity/structured-claims work",
  "brand-defense": "owned answer page (honest, factual, schema-marked)",
  competitor: "comparison / alternative page",
  "tool-opportunity": "tool spec, then build on approval",
};

function priorityFor(claimClass: string): string {
  const w = CLASS_WEIGHT[claimClass] ?? 1.0;
  return w >= 1.4 ? "P1" : w >= 1.1 ? "P2" : "P3";
}

export interface ClaimReport {
  id: string;
  class: string;
  title: string;
  confidence: string;
  status: string;
  action: "created" | "updated" | "falsified" | "unchanged";
}

export interface InferResult {
  surfaceId: string;
  runId: string;
  claims: ClaimReport[];
  notes: string[];
}

function latestRun(surfaceId: string): { id: string } | undefined {
  return db
    .select({ id: schema.runs.id })
    .from(schema.runs)
    .where(eq(schema.runs.surfaceId, surfaceId))
    .orderBy(desc(schema.runs.startedAt), desc(schema.runs.id))
    .limit(1)
    .get();
}

function strongestTag(rows: { confidenceTag: string }[]): { tag: string; confidence: number } {
  let best = { tag: "inference", confidence: TAG_CONFIDENCE.inference };
  for (const r of rows) {
    const c = TAG_CONFIDENCE[r.confidenceTag] ?? 0;
    if (c > best.confidence) best = { tag: r.confidenceTag, confidence: c };
  }
  return best;
}

interface ClaimSpec {
  id: string; // stable slug: claim:<surface>:<subject> — dedup key across runs
  surfaceId: string;
  class: string;
  title: string;
  queryTopic: string | null;
  falsifiability: string;
  evidence: EvidenceRow[];
  runId: string;
  // Explicit tag for claims not backed by evidence rows (demand-map, LLM inference).
  confidenceTagOverride?: ConfidenceTag;
}

// Upsert on the stable id: re-observed gap updates the claim (and reopens a falsified
// one, since the gap is back); answered/dismissed are operator states and stay put.
function upsertClaim(spec: ClaimSpec): ClaimReport {
  const tag = spec.confidenceTagOverride ?? strongestTag(spec.evidence).tag;
  const confidence = String(TAG_CONFIDENCE[tag] ?? TAG_CONFIDENCE.inference);
  const existing = db.select().from(schema.claims).where(eq(schema.claims.id, spec.id)).get();
  const status =
    existing && (existing.status === "answered" || existing.status === "dismissed")
      ? existing.status
      : "open";
  const row = {
    surfaceId: spec.surfaceId,
    class: spec.class,
    status: status as ClaimRow["status"],
    title: spec.title,
    queryTopic: spec.queryTopic,
    intent: CLASS_INTENT[spec.class] ?? null,
    recommendedAsset: CLASS_ASSET[spec.class] ?? null,
    priority: priorityFor(spec.class),
    briefStatus: existing?.briefStatus ?? "open",
    confidence,
    falsifiability: spec.falsifiability,
    lastObservedRunId: spec.runId,
  };
  if (existing) {
    // createdRunId is immutable (set on insert only): a re-observed claim keeps
    // its birth run so "new since last visit" stays truthful.
    db.update(schema.claims).set(row).where(eq(schema.claims.id, spec.id)).run();
  } else {
    db.insert(schema.claims).values({ id: spec.id, createdRunId: spec.runId, ...row }).run();
  }
  // Replace evidence links so the claim always points at its latest supporting rows.
  db.delete(schema.claimEvidence).where(eq(schema.claimEvidence.claimId, spec.id)).run();
  for (const e of spec.evidence) {
    db.insert(schema.claimEvidence)
      .values({ claimId: spec.id, evidenceId: e.id })
      .onConflictDoNothing()
      .run();
  }
  return {
    id: spec.id,
    class: spec.class,
    title: spec.title,
    confidence,
    status,
    action: existing ? "updated" : "created",
  };
}

// The detector's condition no longer holds: an open claim with this id has met its
// falsifiability condition and flips falsified.
function falsifyIfClear(claimId: string): ClaimReport | null {
  const existing = db.select().from(schema.claims).where(eq(schema.claims.id, claimId)).get();
  if (!existing || existing.status !== "open") return null;
  db.update(schema.claims).set({ status: "falsified" }).where(eq(schema.claims.id, claimId)).run();
  return {
    id: claimId,
    class: existing.class,
    title: existing.title,
    confidence: existing.confidence,
    status: "falsified",
    action: "falsified",
  };
}

const push = (out: ClaimReport[], r: ClaimReport | null) => {
  if (r) out.push(r);
};

// ---- rule-based detectors: site crawl evidence ----------------------

function detectHreflang(surfaceId: string, runId: string, rows: EvidenceRow[], out: ClaimReport[]): void {
  const hreflang = rows.filter((r) => r.checkKey.startsWith("crawl/hreflang@"));
  const gaps = hreflang.filter((r) => r.status === "absent" || r.status === "fail");
  const id = `claim:${surfaceId}:hreflang`; // shared slug with act/fix-spec (same subject)
  if (gaps.length === 0) return push(out, falsifyIfClear(id));
  push(
    out,
    upsertClaim({
      id,
      surfaceId,
      class: "technical",
      title: `hreflang missing on ${gaps.length}/${hreflang.length} sampled pages (${surfaceId})`,
      queryTopic: gaps.map((r) => r.checkKey.split("/").slice(2).join("/")).join(", "),
      falsifiability:
        "Falsified when a later run's crawl/hreflang@v1 checks read present on every sampled page, deep pages included.",
      evidence: gaps,
      runId,
    }),
  );
}

// Narrower than detectHreflang: hreflang is present, but some sampled pages carry only
// a strict subset of the locale cluster observed across this run's sampled pages
// (max entry count seen = the full set).
function detectHreflangPartial(surfaceId: string, runId: string, rows: EvidenceRow[], out: ClaimReport[]): void {
  const present = rows.filter((r) => r.checkKey.startsWith("crawl/hreflang@") && r.status === "present");
  const id = `claim:${surfaceId}:hreflang-partial`;
  const localesOf = (r: EvidenceRow): Set<string> => {
    const entries = (r.value as { entries?: { hreflang: string | null }[] } | null)?.entries ?? [];
    return new Set(entries.map((e) => e.hreflang).filter((h): h is string => typeof h === "string"));
  };
  const fullSize = present.reduce((max, r) => Math.max(max, localesOf(r).size), 0);
  const partial = present.filter((r) => {
    const size = localesOf(r).size;
    return size > 0 && size < fullSize;
  });
  if (partial.length === 0) return push(out, falsifyIfClear(id));
  const pages = partial.map((r) => r.checkKey.split("/").slice(2).join("/"));
  push(
    out,
    upsertClaim({
      id,
      surfaceId,
      class: "technical",
      title: `hreflang locale set incomplete on some pages (${partial.length}/${present.length} carry a subset of the ${fullSize}-locale cluster on ${surfaceId})`,
      queryTopic: pages.join(", "),
      falsifiability:
        "Falsified when every sampled page's crawl/hreflang@v1 entries carry the full locale set observed across the run's sampled pages.",
      evidence: partial,
      runId,
    }),
  );
}

function detectSiteBasics(surfaceId: string, runId: string, rows: EvidenceRow[], out: ClaimReport[]): void {
  const robots = rows.filter((r) => r.checkKey.startsWith("crawl/robots-bot-rules@"));
  const sitemap = rows.filter((r) => r.checkKey.startsWith("crawl/sitemap@"));
  const jsonLd = rows.filter((r) => r.checkKey.startsWith("crawl/json-ld@"));
  const robotsMissing = robots.filter(
    (r) => (r.value as { robots_txt_present?: boolean } | null)?.robots_txt_present === false,
  );
  const sitemapMissing = sitemap.filter((r) => r.status !== "pass");
  const schemaMissing = jsonLd.filter((r) => r.status === "absent" || r.status === "fail");
  const missing: string[] = [];
  if (robotsMissing.length > 0) missing.push("robots.txt");
  if (sitemapMissing.length > 0) missing.push("sitemap");
  if (schemaMissing.length === jsonLd.length && jsonLd.length > 0) missing.push("schema (JSON-LD)");
  const id = `claim:${surfaceId}:site-basics`; // shared slug with act/fix-spec
  if (missing.length === 0) return push(out, falsifyIfClear(id));
  push(
    out,
    upsertClaim({
      id,
      surfaceId,
      class: "eligibility",
      title: `site basics missing on ${surfaceId}: ${missing.join(", ")}`,
      queryTopic: missing.join(", "),
      falsifiability:
        "Falsified when a later run reads robots_txt_present true, sitemap pass, and json-ld present on sampled pages.",
      evidence: [...robotsMissing, ...sitemapMissing, ...schemaMissing],
      runId,
    }),
  );
}

function detectBotBlocks(surfaceId: string, runId: string, rows: EvidenceRow[], out: ClaimReport[]): void {
  const blocked = rows.filter(
    (r) =>
      (r.checkKey.startsWith("crawl/robots-bot-rules@") && r.status === "blocked") ||
      (r.checkKey.startsWith("crawl/bot-access@") && (r.status === "blocked" || r.status === "fail")),
  );
  const id = `claim:${surfaceId}:bot-block`;
  if (blocked.length === 0) return push(out, falsifyIfClear(id));
  const bots = [...new Set(blocked.map((r) => r.checkKey.split("/").pop()))].join(", ");
  push(
    out,
    upsertClaim({
      id,
      surfaceId,
      class: "eligibility",
      title: `crawler access blocked on ${surfaceId}: ${bots}`,
      queryTopic: bots,
      falsifiability:
        "Falsified when a later run's robots-bot-rules and bot-access checks all read pass for every probed bot.",
      evidence: blocked,
      runId,
    }),
  );
}

function detectSsr(surfaceId: string, runId: string, rows: EvidenceRow[], out: ClaimReport[]): void {
  const ssr = rows.filter((r) => r.checkKey.startsWith("crawl/ssr@"));
  const failing = ssr.filter((r) => r.status === "thin" || r.status === "fail");
  const id = `claim:${surfaceId}:ssr`;
  if (failing.length === 0) return push(out, falsifyIfClear(id));
  push(
    out,
    upsertClaim({
      id,
      surfaceId,
      class: "technical",
      title: `SSR content thin or failing on ${failing.length}/${ssr.length} sampled pages (${surfaceId})`,
      queryTopic: failing.map((r) => r.checkKey.split("/").slice(2).join("/")).join(", "),
      falsifiability:
        "Falsified when a later run's crawl/ssr@v1 checks read pass (server-rendered text above threshold) on every sampled page.",
      evidence: failing,
      runId,
    }),
  );
}

// Competitor pages naming other competitors but not the brand: the comparison answer
// space is being contested without the brand in it.
function detectComparisonTargets(
  surfaceId: string,
  runId: string,
  rows: EvidenceRow[],
  out: ClaimReport[],
): void {
  const pages = rows.filter((r) => r.checkKey.startsWith("competitor/page@") && r.status === "pass");
  const citing = pages.filter((r) => {
    const targets = (r.value as { comparison_targets?: string[] } | null)?.comparison_targets ?? [];
    return targets.length > 0;
  });
  const id = `claim:${surfaceId}:competitor-comparison`;
  if (citing.length === 0) return push(out, falsifyIfClear(id));
  const targets = [
    ...new Set(
      citing.flatMap((r) => (r.value as { comparison_targets?: string[] }).comparison_targets ?? []),
    ),
  ];
  push(
    out,
    upsertClaim({
      id,
      surfaceId,
      class: "competitor",
      title: `competitor pages run comparison content naming ${targets.join(", ")} but not the brand`,
      queryTopic: targets.join(", "),
      falsifiability:
        "Falsified when a later run's competitor/page checks show no comparison_targets, or the brand appears among them.",
      evidence: citing,
      runId,
    }),
  );
}

// ---- rule-based detectors: tool-opportunity from demand evidence ----------

interface RankedTool {
  rank: number;
  tool: string;
  audience: string;
  why: string;
}

// Top-5 ranked free-tool opportunities from the operator's own demand-research
// document (a markdown table of rank/tool/audience/why rows, scored against a
// real-query, useful-task, credible-next-step test), plus the evidenced query
// formulations in its appendix (each claim carries its justifying queries in
// query_topic). Parsed at runtime so src/ stays customer-agnostic.
function parseDemandMap(filePath: string): { tools: RankedTool[]; queries: string[] } {
  const text = readFileSync(filePath, "utf8");
  const tools: RankedTool[] = [];
  for (const line of text.split("\n")) {
    const m = /^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/.exec(line);
    if (m && Number(m[1]) <= 5) tools.push({ rank: Number(m[1]), tool: m[2], audience: m[3], why: m[4] });
  }
  // Appendix query tables: | query | evidence URL | tag |
  const queries = [...text.matchAll(/^\|\s*([^|]+?)\s*\|\s*https?:\/\/[^|]+\|\s*\[(?:observed|reported)\]\s*\|$/gm)].map(
    (m) => m[1],
  );
  return { tools, queries };
}

// Keyword families tying each ranked tool to its justifying appendix queries.
const TOOL_QUERY_KEYWORDS: Record<string, string[]> = {
  "rate calculator": ["rate calculator", "rate card", "what should i charge", "how much to charge", "rates"],
  "cost/budget calculator": ["cost", "price", "pricing", "charge", "budget"],
  "brief generator": ["brief"],
  "engagement-rate calculator": ["engagement"],
  "rate-card generator": ["rate card", "rate-card"],
};

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function detectToolOpportunities(
  surfaceId: string,
  runId: string,
  rows: EvidenceRow[],
  lanes: Record<string, unknown>,
  out: ClaimReport[],
  notes: string[],
): void {
  // tool-opportunity is fed by the community/demand lane (claim taxonomy); a surface
  // whose community lane is absent, or present but not enabled (draft's proposed
  // scaffold for a domain with no community signal), has no demand evidence to seed
  // from. Same enablement test the sense station uses to decide which adapters run.
  if (!laneEnabled(lanes.community)) {
    notes.push("tool-opportunity: community demand lane not enabled on this surface; detector idle");
    return;
  }
  // The demand map is the operator's own research document: a markdown file listing
  // candidate tools and the demand queries behind them, which this detector matches
  // against real community evidence. Supplying it is optional (without it the detector
  // idles with a note), and it lives in config/ because it is operator territory, never
  // in src/. ANSWERABLE_DEMAND_MAP overrides the location.
  const demandMapPath =
    process.env.ANSWERABLE_DEMAND_MAP ?? path.join(process.cwd(), "config", "demand-map.md");
  if (!existsSync(demandMapPath)) {
    notes.push(`tool-opportunity: no demand map at ${demandMapPath}; detector idle`);
    return;
  }
  const { tools, queries } = parseDemandMap(demandMapPath);
  // Community demand evidence rows (lanes.community.demand_queries) back these claims.
  const demandRows = rows.filter((r) => {
    if (!/^community\/(reddit-mentions|hn-mentions)@/.test(r.checkKey)) return false;
    return (r.value as { query_kind?: string } | null)?.query_kind === "demand";
  });
  for (const tool of tools) {
    // Longest matching keyword-family key wins (so "engagement-rate calculator" is not
    // swallowed by the shorter "rate calculator" family).
    const familyKey = Object.keys(TOOL_QUERY_KEYWORDS)
      .filter((k) => tool.tool.toLowerCase().includes(k))
      .sort((a, b) => b.length - a.length)[0];
    const kws = familyKey ? TOOL_QUERY_KEYWORDS[familyKey] : [];
    const justifying = queries.filter((q) => kws.some((kw) => q.toLowerCase().includes(kw)));
    const supporting = demandRows.filter((r) => {
      const q = ((r.value as { query?: string } | null)?.query ?? "").toLowerCase();
      return q.length > 0 && tool.tool.toLowerCase().split(" ").some((w) => w.length > 3 && q.includes(w));
    });
    push(
      out,
      upsertClaim({
        id: `claim:${surfaceId}:tool-opportunity:${slugify(tool.tool)}`,
        surfaceId,
        class: "tool-opportunity",
        title: `free-tool opportunity #${tool.rank}: ${tool.tool} (${tool.audience} audience)`,
        queryTopic: justifying.length > 0 ? justifying.join("; ") : tool.tool,
        falsifiability:
          "Falsified when the evidenced query cluster stops ranking free tools of this type, or a shipped tool's route shows no engagement over its outcome window.",
        evidence: supporting,
        runId,
        // Demand-map rows are research-doc synthesis, not direct evidence rows: the
        // strongest honest tag is reported unless live community demand rows back it.
        ...(supporting.length === 0 ? { confidenceTagOverride: "reported" as ConfidenceTag } : {}),
      }),
    );
  }
}

// ---- rule-based detectors: assistant panel aggregates ----------------

// Brand token from the observed web surface's domain, e.g. www.example.com -> "example".
function brandToken(observedSurfaceId: string | null): string | null {
  if (!observedSurfaceId) return null;
  const s = db.select().from(schema.surfaces).where(eq(schema.surfaces.id, observedSurfaceId)).get();
  const domain = (s?.configSnapshot as { target?: { domain?: string } } | undefined)?.target?.domain;
  if (!domain) return null;
  return domain.replace(/^www\./, "").split(".")[0].toLowerCase();
}

function promptEvidenceFor(rows: EvidenceRow[], promptIds: string[]): EvidenceRow[] {
  return rows.filter(
    (r) => r.checkKey.startsWith("geo-panel/prompt@") && promptIds.some((p) => r.checkKey.endsWith(`/${p}`)),
  );
}

function detectPanelClaims(
  surfaceId: string,
  runId: string,
  rows: EvidenceRow[],
  panel: PanelRow[],
  observes: string | null,
  out: ClaimReport[],
  notes: string[],
): void {
  if (panel.length === 0) {
    notes.push(`panel: no observations in latest run of ${surfaceId} (lane failed or pending); no panel claims inferred`);
    return;
  }
  // UNGROUNDED rows carry owned_hit null: the lane had no brand identity, so no
  // answer was ever searched for the operator's names. Absence of a search is not
  // evidence of absence from the answer, so these rows mint NO claim — not an
  // ai-visibility gap, not a brand-defense loss, not a competitor-ownership claim
  // (all three are statements about the brand NOT being cited). They are also not
  // grounds to falsify an existing claim: a run that measured nothing resolves
  // nothing either. The lane is simply unmeasured until an identity exists.
  const grounded = panel.filter((p) => p.ownedHit !== null);
  if (grounded.length === 0) {
    notes.push(
      `panel: ${panel.length} observation(s) in latest run of ${surfaceId} but no brand identity to match against (no brand row, no config brand key, no observed surface domain); no panel claims inferred`,
    );
    return;
  }

  const brand = brandToken(observes);
  const isBrandPrompt = (p: PanelRow) => {
    const ev = rows.find((r) => r.checkKey === `geo-panel/prompt@v1/${p.promptId}`);
    const promptText = ((ev?.value as { prompt?: string } | null)?.prompt ?? p.promptId).toLowerCase();
    return brand !== null && promptText.includes(brand);
  };
  // Only grounded rows partition into brand vs discovery prompts: an ungrounded row
  // cannot support either side of the comparison.
  const brandPrompts = grounded.filter(isBrandPrompt);
  const discovery = grounded.filter((p) => !isBrandPrompt(p));
  const engine = grounded[0].engine;

  // share_of_answer 0 on discovery prompts => entity/visibility claim.
  const discoveryOwned = discovery.filter((p) => p.ownedHit === true).length;
  const visId = `claim:${surfaceId}:ai-visibility:discovery-share`;
  if (discovery.length > 0 && discoveryOwned === 0) {
    push(
      out,
      upsertClaim({
        id: visId,
        surfaceId,
        class: "ai-visibility",
        title: `zero discovery share on ${engine}: brand uncited in ${discovery.length}/${discovery.length} discovery prompts`,
        queryTopic: discovery.map((p) => p.promptId).join(", "),
        falsifiability:
          "Falsified when a later panel run cites the brand (owned_hit) in at least one discovery prompt on this engine.",
        evidence: promptEvidenceFor(rows, discovery.map((p) => p.promptId)),
        runId,
      }),
    );
  } else {
    push(out, falsifyIfClear(visId));
  }

  // owned_hit false on brand prompts => brand-defense claim.
  const brandLosses = brandPrompts.filter((p) => p.ownedHit === false);
  const defId = `claim:${surfaceId}:brand-defense`;
  if (brandLosses.length > 0) {
    push(
      out,
      upsertClaim({
        id: defId,
        surfaceId,
        class: "brand-defense",
        title: `brand prompts answered without the brand on ${engine}: ${brandLosses.length}/${brandPrompts.length} lost`,
        queryTopic: brandLosses.map((p) => p.promptId).join(", "),
        falsifiability:
          "Falsified when a later panel run reads owned_hit true on every brand prompt on this engine.",
        evidence: promptEvidenceFor(rows, brandLosses.map((p) => p.promptId)),
        runId,
      }),
    );
  } else {
    push(out, falsifyIfClear(defId));
  }

  // Competitors cited in discovery prompts where the brand is absent => competitor claim.
  const competitorEntities = [
    ...new Set(
      discovery
        .filter((p) => p.ownedHit === false)
        .flatMap((p) => p.entitiesCited.map((e) => e.entity))
        .filter((e) => brand === null || !e.toLowerCase().includes(brand)),
    ),
  ];
  const compId = `claim:${surfaceId}:competitor-answer-space`;
  if (competitorEntities.length > 0) {
    push(
      out,
      upsertClaim({
        id: compId,
        surfaceId,
        class: "competitor",
        title: `competitors own the ${engine} discovery answer space: ${competitorEntities.join(", ")}`,
        queryTopic: discovery.filter((p) => p.ownedHit === false).map((p) => p.promptId).join(", "),
        falsifiability:
          "Falsified when a later panel run cites the brand alongside or above these competitors in the discovery prompts.",
        evidence: promptEvidenceFor(rows, discovery.filter((p) => p.ownedHit === false).map((p) => p.promptId)),
        runId,
      }),
    );
  } else {
    push(out, falsifyIfClear(compId));
  }
}

// ---- optional LLM interpretation: community sentiment nuance --------------

function llmAvailable(): { via: "api" | "cli" } | null {
  if (process.env.ANTHROPIC_API_KEY) return { via: "api" };
  try {
    execFileSync("claude", ["--version"], { stdio: "pipe", timeout: 10_000 });
    return { via: "cli" };
  } catch {
    return null;
  }
}

interface LlmFinding {
  subject: string;
  title: string;
  note: string;
}

function runLlmInterpretation(
  surfaceId: string,
  runId: string,
  rows: EvidenceRow[],
  out: ClaimReport[],
  notes: string[],
): void {
  const mentionRows = rows.filter((r) => {
    if (!/^(community|x)\/[a-z-]+@/.test(r.checkKey) || r.status !== "pass") return false;
    const hits = (r.value as { top_hits?: unknown[] } | null)?.top_hits;
    return Array.isArray(hits) && hits.length > 0;
  });
  const avail = llmAvailable();
  if (!avail) {
    notes.push("llm interpretation skipped: no ANTHROPIC_API_KEY and no claude CLI on PATH");
    return;
  }
  if (mentionRows.length === 0) {
    notes.push("llm interpretation skipped: no community/x mention rows with hits in this run");
    return;
  }
  const digest = mentionRows
    .map((r) => {
      const v = r.value as { query?: string; query_kind?: string; top_hits?: { title?: string }[] };
      const titles = (v.top_hits ?? []).slice(0, 5).map((h) => h.title).filter(Boolean);
      return `query "${v.query}" (${v.query_kind}): ${titles.join(" | ")}`;
    })
    .join("\n");
  // Stable dedup across runs: the LLM must reuse an existing subject slug when the
  // same nuance recurs, so re-observation updates the claim instead of duplicating it.
  const existingSlugs = db
    .select({ id: schema.claims.id })
    .from(schema.claims)
    .where(like(schema.claims.id, `claim:${surfaceId}:sentiment:%`))
    .all()
    .map((r) => r.id.split(":").pop());
  const slugHint =
    existingSlugs.length > 0
      ? `\nExisting subject slugs from earlier runs: ${existingSlugs.join(", ")}. If a nuance matches one of these, reuse that exact slug.`
      : "";
  process.stderr.write(`infer: querying ${avail.via === "api" ? "the Anthropic API" : "claude"} for sentiment nuance...\n`);
  const prompt = `You are the infer station of a search-growth engine analyzing community mention evidence for the surface "${surfaceId}". Below are search queries and the titles of top community hits. Identify at most 2 sentiment or relevance nuances that matter for the brand (e.g. the brand query collides with an unrelated popular term, or hostile/negative sentiment appears). Ignore competitor noise. Respond with ONLY a JSON array (possibly empty) of objects {"subject": "<short-slug>", "title": "<one-line claim>", "note": "<one-sentence rationale>"}.${slugHint}\n\n${digest}`;
  try {
    let text: string;
    if (avail.via === "api") {
      // Minimal direct API call; model kept small and cheap for a nuance pass.
      const body = JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 600,
        messages: [{ role: "user", content: prompt }],
      });
      // The API key never travels as argv (visible in /proc): the whole request,
      // key header included, goes to curl as a --config file piped via stdin.
      const curlConfig = [
        `url = "https://api.anthropic.com/v1/messages"`,
        `header = "content-type: application/json"`,
        `header = "anthropic-version: 2023-06-01"`,
        `header = "x-api-key: ${process.env.ANTHROPIC_API_KEY}"`,
        `data = ${JSON.stringify(body)}`,
      ].join("\n");
      const res = execFileSync(
        "curl",
        ["-sf", "--max-time", "60", "--config", "-"],
        { input: curlConfig, encoding: "utf8" },
      );
      const parsed = JSON.parse(res) as { content?: { text?: string }[] };
      text = parsed.content?.[0]?.text ?? "";
    } else {
      // Prompt travels via stdin, never as a shell argument.
      text = execFileSync("claude", ["-p", "--output-format", "text"], {
        input: prompt,
        encoding: "utf8",
        timeout: 180_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
    }
    const jsonMatch = /\[[\s\S]*\]/.exec(text);
    if (!jsonMatch) {
      notes.push("llm interpretation ran but returned no parseable JSON array; no claims minted");
      return;
    }
    const findings = JSON.parse(jsonMatch[0]) as LlmFinding[];
    for (const f of findings.slice(0, 2)) {
      if (!f?.subject || !f?.title) continue;
      push(
        out,
        upsertClaim({
          id: `claim:${surfaceId}:sentiment:${slugify(f.subject)}`,
          surfaceId,
          class: "brand-defense",
          title: f.title,
          queryTopic: f.note ?? null,
          falsifiability:
            "Falsified when a later run's community/x mention evidence no longer shows this sentiment or collision pattern.",
          evidence: mentionRows,
          runId,
          confidenceTagOverride: "inference",
        }),
      );
    }
    if (findings.length === 0) notes.push("llm interpretation ran: no sentiment nuances found");
  } catch (e) {
    notes.push(`llm interpretation failed honestly (${e instanceof Error ? e.message.slice(0, 120) : String(e)}); rule-based claims unaffected`);
  }
}

// ---- station entry --------------------------------------------------------

function inferOne(surfaceId: string): InferResult | null {
  const run = latestRun(surfaceId);
  if (!run) return null;
  const surface = db.select().from(schema.surfaces).where(eq(schema.surfaces.id, surfaceId)).get();
  if (!surface) return null;
  const config = surface.configSnapshot as { observes?: string };
  const rows = db
    .select()
    .from(schema.evidence)
    .where(and(eq(schema.evidence.runId, run.id), eq(schema.evidence.surfaceId, surfaceId)))
    .all();
  const panel = db
    .select()
    .from(schema.panelObservations)
    .where(eq(schema.panelObservations.runId, run.id))
    .all();

  const out: ClaimReport[] = [];
  const notes: string[] = [];
  const detectors: [string, () => void][] =
    surface.kind === "site"
      ? [
          ["hreflang", () => detectHreflang(surfaceId, run.id, rows, out)],
          ["hreflang-partial", () => detectHreflangPartial(surfaceId, run.id, rows, out)],
          ["site-basics", () => detectSiteBasics(surfaceId, run.id, rows, out)],
          ["bot-block", () => detectBotBlocks(surfaceId, run.id, rows, out)],
          ["ssr", () => detectSsr(surfaceId, run.id, rows, out)],
          ["comparison-targets", () => detectComparisonTargets(surfaceId, run.id, rows, out)],
          ["tool-opportunity", () => detectToolOpportunities(surfaceId, run.id, rows, (surface.configSnapshot as { lanes?: Record<string, unknown> }).lanes ?? {}, out, notes)],
          ["llm-sentiment", () => runLlmInterpretation(surfaceId, run.id, rows, out, notes)],
        ]
      : surface.kind === "assistant"
        ? [["panel", () => detectPanelClaims(surfaceId, run.id, rows, panel, config.observes ?? null, out, notes)]]
        : [["llm-sentiment", () => runLlmInterpretation(surfaceId, run.id, rows, out, notes)]];

  for (const [name, fn] of detectors) {
    try {
      fn();
    } catch (e) {
      // A detector failure is a visible note, never a thrown run-killer.
      notes.push(`detector ${name} failed: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`);
    }
  }
  return { surfaceId, runId: run.id, claims: out, notes };
}

// Infer for a surface's latest run. A site surface also runs inference for the
// assistant surfaces observing it (their claims live on the observing surface,
// per the kind-applicability matrix), so `answerable infer <web-surface>` covers the panel
// aggregates that measure it.
export function infer(surfaceId: string): InferResult[] {
  const own = inferOne(surfaceId);
  if (!own) throw new Error(`surface "${surfaceId}" has no runs or is not onboarded (answerable run <surface-id> first)`);
  const results = [own];
  const observers = db
    .select()
    .from(schema.surfaces)
    .where(like(schema.surfaces.configSnapshot, `%"observes":"${surfaceId}"%`))
    .all();
  for (const obs of observers) {
    const r = inferOne(obs.id);
    if (r) results.push(r);
    else own.notes.push(`observing surface ${obs.id} has no runs yet; skipped`);
  }
  return results;
}
