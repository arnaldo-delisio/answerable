// Act station, comparison slice: open competitor claims backed by page-shaped or
// panel evidence naming competitors become comparison-page drafts ("<brand> vs
// <competitor>" + "<competitor> alternatives" angle in one asset per competitor,
// type page, state generated). Per-fact source-URL rule: every factual statement
// about the competitor cites an evidence row's provenance URL (or its check_key when
// the row's provenance is a db aggregation with no URL); facts with no evidence render
// as [NEEDS SOURCE] placeholders, never invented. Intro prose via LLM (claude -p,
// stdin, facts-only template); LLM absent = draft-pending prose, state stays generated.
// A per-competitor failure is a note, never a throw that kills the act pass.

import { desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../../db";
import { DRAFT_PENDING, llmText } from "./llm";
import { upsertAsset } from "./asset-write";

type ClaimRow = typeof schema.claims.$inferSelect;
type EvidenceRow = typeof schema.evidence.$inferSelect;

export interface ComparisonAsset {
  assetId: string;
  betId: string;
  claimId: string;
  competitor: string;
  route: string;
  state: "generated";
  draftPending: boolean;
}

export interface ComparisonResult {
  assets: ComparisonAsset[];
  notes: string[];
}

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

interface Fact {
  text: string;
  source: string; // provenance URL, or "evidence <check_key> (<method>)" when URL-less
}

function surfaceConfig(id: string): Record<string, unknown> | undefined {
  return db.select().from(schema.surfaces).where(eq(schema.surfaces.id, id)).get()
    ?.configSnapshot as Record<string, unknown> | undefined;
}

function latestRunId(surfaceId: string): string | null {
  const run = db
    .select({ id: schema.runs.id })
    .from(schema.runs)
    .where(eq(schema.runs.surfaceId, surfaceId))
    .orderBy(desc(schema.runs.startedAt), desc(schema.runs.id))
    .limit(1)
    .get();
  return run?.id ?? null;
}

// Evidenced facts about one competitor from the web surface's latest run:
// homepage crawl (title, free tools, JSON-LD) and answer-ownership aggregation.
function competitorFacts(webSurfaceId: string, competitor: string): { facts: Fact[]; evidenceKeys: string[] } {
  const facts: Fact[] = [];
  const evidenceKeys: string[] = [];
  const runId = latestRunId(webSurfaceId);
  if (!runId) return { facts, evidenceKeys };
  const slug = slugify(competitor);
  const rows = db
    .select()
    .from(schema.evidence)
    .where(eq(schema.evidence.runId, runId))
    .all()
    .filter(
      (r) =>
        r.checkKey.startsWith(`competitor/page@v1/${slug}-`) ||
        r.checkKey.startsWith(`competitor/answer-ownership@v1/${slug}`),
    );
  const sourceOf = (r: EvidenceRow): string => {
    const url = (r.provenance as { url?: string | null }).url;
    if (url) return url;
    const method = (r.provenance as { method?: string }).method ?? "unknown";
    return `evidence ${r.checkKey} (${method})`;
  };
  for (const r of rows) {
    if (r.status !== "pass") continue;
    evidenceKeys.push(r.checkKey);
    const v = r.value as {
      title?: string | null;
      has_free_tools?: boolean;
      jsonld_types?: string[];
      cited_fraction?: number;
      prompt_total?: number;
    } | null;
    if (r.checkKey.includes("/page@")) {
      if (typeof v?.title === "string" && v.title.length > 0) {
        facts.push({ text: `${competitor}'s homepage title reads "${v.title}".`, source: sourceOf(r) });
      }
      if (v?.has_free_tools === false) {
        facts.push({ text: `No free-tool offers were observed on ${competitor}'s homepage.`, source: sourceOf(r) });
      }
    } else if (typeof v?.cited_fraction === "number" && typeof v?.prompt_total === "number") {
      facts.push({
        text: `${competitor} was cited in ${Math.round(v.cited_fraction * 100)}% of ${v.prompt_total} AI-answer panel prompts observed for this surface.`,
        source: sourceOf(r),
      });
    }
  }
  return { facts, evidenceKeys };
}

// Competitors named by the claim: config competitor names appearing in the claim's
// title/query_topic, plus comparison_targets from its page-shaped linked evidence.
function namedCompetitors(claim: ClaimRow, configCompetitors: string[]): string[] {
  const haystack = `${claim.title} ${claim.queryTopic ?? ""}`.toLowerCase();
  const named = new Set(configCompetitors.filter((n) => haystack.includes(n.toLowerCase())));
  const linked = db
    .select({ e: schema.evidence })
    .from(schema.claimEvidence)
    .innerJoin(schema.evidence, eq(schema.claimEvidence.evidenceId, schema.evidence.id))
    .where(eq(schema.claimEvidence.claimId, claim.id))
    .all()
    .map((r) => r.e);
  for (const r of linked) {
    const targets = (r.value as { comparison_targets?: unknown } | null)?.comparison_targets;
    if (!Array.isArray(targets)) continue;
    for (const t of targets) if (typeof t === "string") named.add(t);
  }
  return [...named];
}

function introPrompt(brand: string, competitor: string, facts: Fact[]): string {
  return [
    `Write a 2-paragraph markdown intro for a comparison page "${brand} vs ${competitor}" (which also serves "${competitor} alternatives" intent).`,
    ``,
    `The ONLY facts you may state about ${competitor} are:`,
    ...(facts.length > 0 ? facts.map((f) => `- ${f.text} [source: ${f.source}]`) : ["- (no evidenced facts; say only that the comparison below is evidence-gated)"]),
    ``,
    `Strict rules:`,
    `- Never invent features, pricing, review scores, or customer counts for either product; anything beyond the listed facts must be omitted.`,
    `- No puffery about ${brand}; frame the page as an honest comparison the reader can verify.`,
    `- Respond with ONLY the markdown intro, nothing else.`,
  ].join("\n");
}

// Exported so the placeholder gate can be tested against the REAL generated body rather
// than a hand-written stand-in. Pure: the LLM intro arrives as a parameter.
export function renderPage(
  brand: string,
  competitor: string,
  claim: ClaimRow,
  facts: Fact[],
  intro: string,
): string {
  const factRows =
    facts.length > 0
      ? facts.map((f) => `| ${f.text} | ${f.source} |`).join("\n")
      : `| [NEEDS SOURCE] no evidenced facts about ${competitor} collected yet | — |`;
  return `# ${brand} vs ${competitor} (comparison page draft)

Type: competitor comparison page (asset type \`page\`, state \`generated\`, review-gated
per claim taxonomy: generated draft, per-fact source URLs). Also serves the
"${competitor} alternatives" intent.

## Claim

${claim.id} [${claim.class}]: ${claim.title}

## Intro

${intro}

## Evidenced facts about ${competitor} (per-fact source rule)

| Fact | Source |
|---|---|
${factRows}

## Comparison sections (facts without evidence stay placeholders, never invented)

| Dimension | ${brand} | ${competitor} |
|---|---|---|
| Positioning | [NEEDS SOURCE] | ${facts.find((f) => f.text.includes("homepage title"))?.text ?? "[NEEDS SOURCE]"} |
| Pricing | [NEEDS SOURCE] | [NEEDS SOURCE] |
| Free tools | [NEEDS SOURCE] | ${facts.find((f) => f.text.includes("free-tool"))?.text ?? "[NEEDS SOURCE]"} |
| AI-answer visibility | [NEEDS SOURCE] | ${facts.find((f) => f.text.includes("panel prompts"))?.text ?? "[NEEDS SOURCE]"} |
| Reviews | [NEEDS SOURCE] | [NEEDS SOURCE] |

Every [NEEDS SOURCE] cell must be filled with a cited fact (or the row dropped) before
this page can be approved for publishing.
`;
}

// Comparison pages for one surface's open competitor claims (its ai-engine-lane and
// community observers included, mirroring infer/decide). One asset per competitor,
// deduped across claims (first claim with a bet wins the attachment).
export function generateComparisonPages(surfaceId: string): ComparisonResult {
  const notes: string[] = [];
  const assets: ComparisonAsset[] = [];

  const config = surfaceConfig(surfaceId);
  if (!config) {
    notes.push(`surface "${surfaceId}" not onboarded; nothing to generate`);
    return { assets, notes };
  }
  const observers = db
    .select()
    .from(schema.surfaces)
    .all()
    .filter((s) => (s.configSnapshot as { observes?: string }).observes === surfaceId)
    .map((s) => s.id);
  const surfaceIds = [surfaceId, ...observers];

  const claims = db
    .select()
    .from(schema.claims)
    .where(inArray(schema.claims.surfaceId, surfaceIds))
    .all()
    .filter((c) => c.class === "competitor" && c.status === "open");
  if (claims.length === 0) {
    notes.push("no open competitor claims on this surface (or its observers); nothing to generate");
    return { assets, notes };
  }

  const webSurfaceId = (config as { target?: { domain?: string } }).target?.domain
    ? surfaceId
    : ((config as { observes?: string }).observes ?? surfaceId);
  const webConfig = surfaceConfig(webSurfaceId) ?? config;
  const domain = (webConfig as { target?: { domain?: string } }).target?.domain ?? surfaceId;
  const brand = domain.replace(/^www\./, "").split(".")[0];
  const configCompetitors = (
    (webConfig as { competitors?: { name?: string }[] }).competitors ?? []
  )
    .map((c) => c.name)
    .filter((n): n is string => typeof n === "string");

  const done = new Set<string>();
  for (const claim of claims) {
    try {
      const bet = db.select().from(schema.bets).where(eq(schema.bets.claimId, claim.id)).get();
      if (!bet) {
        notes.push(`claim ${claim.id}: no bet placed; comparison assets attach to a bet, skipped`);
        continue;
      }
      if (bet.state === "cancelled") {
        notes.push(`bet ${bet.id} is cancelled; the operator withdrew this work, nothing generated`);
        continue;
      }
      const competitors = namedCompetitors(claim, configCompetitors);
      if (competitors.length === 0) {
        notes.push(`claim ${claim.id}: no competitor named by its evidence/title; no comparison target`);
        continue;
      }
      for (const competitor of competitors) {
        const slug = slugify(competitor);
        if (done.has(slug)) continue;
        done.add(slug);
        const { facts } = competitorFacts(webSurfaceId, competitor);
        const { text: intro, pending } = llmText(
          introPrompt(brand, competitor, facts),
          `comparison intro ${brand} vs ${competitor}`,
          notes,
        );
        const body = renderPage(brand, competitor, claim, facts, pending ? DRAFT_PENDING : intro);
        const route = `/compare/${slugify(brand)}-vs-${slug}`;
        // Acting surface, not the observed web surface: two ai-answer surfaces
        // observing one web surface act on their own competitor claims and must not
        // collide on one asset row (see brand-defense.ts for the same fix).
        const assetId = `asset:${surfaceId}:comparison:${slugify(brand)}-vs-${slug}`;
        const write = upsertAsset({
          id: assetId,
          betId: bet.id,
          type: "page",
          body,
          route,
          state: "generated",
          skipReason: null,
        });
        if (!write.written) {
          notes.push(write.note!);
          continue;
        }
        assets.push({
          assetId,
          betId: bet.id,
          claimId: claim.id,
          competitor,
          route,
          state: "generated",
          draftPending: pending,
        });
      }
    } catch (e) {
      notes.push(
        `comparison failed for claim ${claim.id}: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`,
      );
    }
  }
  return { assets, notes };
}
