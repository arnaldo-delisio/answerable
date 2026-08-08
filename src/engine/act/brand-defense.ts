// Act station, brand-defense slice: open brand-defense claims become ONE owned
// answer-page draft per web surface (asset type page, state generated): an honest
// "Is <brand> legit?" page whose factual section carries only observed evidence values
// (crawl JSON-LD Organization rows, provenance URLs cited per fact) plus surface-config
// statements labeled as config, never invented facts. Reputation questions come from
// the observing geo panels' brand prompts; the page ships a FAQPage JSON-LD block.
// Prose and FAQ answers via LLM (claude -p, stdin, strict factual template over the
// listed facts only); LLM absent = draft-pending body, state stays generated.
// A per-claim failure is a note, never a throw that kills the act pass.

import { desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../../db";
import { DRAFT_PENDING, llmJson } from "./llm";
import { upsertAsset } from "./asset-write";

type ClaimRow = typeof schema.claims.$inferSelect;
type EvidenceRow = typeof schema.evidence.$inferSelect;
type SurfaceRow = typeof schema.surfaces.$inferSelect;

export interface BrandDefenseAsset {
  assetId: string;
  betId: string;
  claimIds: string[];
  route: string;
  state: "generated";
  draftPending: boolean;
}

export interface BrandDefenseResult {
  assets: BrandDefenseAsset[];
  notes: string[];
}

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

interface Fact {
  text: string;
  source: string; // provenance URL, or "surface config" for config-derived statements
}

function surfaceRow(id: string): SurfaceRow | undefined {
  return db.select().from(schema.surfaces).where(eq(schema.surfaces.id, id)).get();
}

function observersOf(surfaceId: string): SurfaceRow[] {
  return db
    .select()
    .from(schema.surfaces)
    .all()
    .filter((s) => (s.configSnapshot as { observes?: string }).observes === surfaceId);
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

// Observed facts from the latest crawl: JSON-LD rows whose types include Organization.
function organizationFacts(webSurfaceId: string, domain: string): { facts: Fact[]; evidence: EvidenceRow[] } {
  const runId = latestRunId(webSurfaceId);
  if (!runId) return { facts: [], evidence: [] };
  const rows = db
    .select()
    .from(schema.evidence)
    .where(eq(schema.evidence.runId, runId))
    .all()
    .filter((r) => r.checkKey.startsWith("crawl/json-ld@"));
  const facts: Fact[] = [];
  const used: EvidenceRow[] = [];
  for (const r of rows) {
    const types = (r.value as { types?: string[] } | null)?.types ?? [];
    if (!types.includes("Organization")) continue;
    const url = (r.provenance as { url?: string }).url ?? `https://${domain}/`;
    facts.push({
      text: `The site publishes ${types.join(" + ")} JSON-LD structured data on ${url} (observed by crawl).`,
      source: url,
    });
    used.push(r);
  }
  return { facts, evidence: used };
}

// Reputation questions: the observing geo panels' brand prompts (prompt text contains
// the brand token), verbatim from config. Fallback to the canonical pair if none.
function brandQuestions(observers: SurfaceRow[], brand: string, domain: string): string[] {
  const questions = new Set<string>();
  for (const o of observers) {
    const prompts =
      ((o.configSnapshot as { target?: { prompt_set?: { prompts?: string[] } } }).target?.prompt_set
        ?.prompts ?? []);
    for (const p of prompts) if (p.toLowerCase().includes(brand)) questions.add(p);
  }
  if (questions.size === 0) {
    questions.add(`Is ${domain.replace(/^www\./, "")} legit?`);
    questions.add(`What is ${brand}?`);
  }
  return [...questions];
}

function faqJsonLd(qa: { q: string; a: string }[]): string {
  return JSON.stringify(
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: qa.map(({ q, a }) => ({
        "@type": "Question",
        name: q,
        acceptedAnswer: { "@type": "Answer", text: a },
      })),
    },
    null,
    2,
  );
}

interface LlmPage {
  body: string;
  answers: Record<string, string>;
}

function pagePrompt(brand: string, domain: string, facts: Fact[], questions: string[]): string {
  return [
    `Write the body of an honest owned answer page titled "Is ${domain.replace(/^www\./, "")} legit?" for the brand "${brand}".`,
    ``,
    `The ONLY facts you may state about the company are these observed/config values:`,
    ...facts.map((f) => `- ${f.text} [source: ${f.source}]`),
    ``,
    `Reputation questions the page must answer directly:`,
    ...questions.map((q) => `- ${q}`),
    ``,
    `Strict rules:`,
    `- Cite only the facts listed above; NEVER invent statistics, review counts, founding dates, team facts, or claims of safety you cannot ground in the list.`,
    `- Be honest and direct: acknowledge that third-party scam-checker sites exist and that readers should verify independently.`,
    `- No puffery, no superlatives.`,
    `- Respond with ONLY a JSON object: {"body": "<markdown page body>", "answers": {"<question>": "<2-3 sentence direct answer>", ...}} with one answer per question above.`,
  ].join("\n");
}

function renderPage(
  domain: string,
  claims: ClaimRow[],
  facts: Fact[],
  qa: { q: string; a: string }[],
  body: string,
): string {
  const bare = domain.replace(/^www\./, "");
  return `# Is ${bare} legit? (owned answer page draft)

Type: brand-defense owned answer page (asset type \`page\`, state \`generated\`,
review-gated per claim taxonomy: honest, factual, schema-marked).

## Claims answered

${claims.map((c) => `- ${c.id} [${c.class}]: ${c.title}`).join("\n")}

## Factual basis (observed evidence + labeled config; nothing invented)

${facts.map((f) => `- ${f.text} [source: ${f.source}]`).join("\n")}

## Page body

${body}

## Direct answers

${qa.map(({ q, a }) => `**${q}**\n\n${a}\n`).join("\n")}

## FAQPage JSON-LD

\`\`\`html
<script type="application/ld+json">
${faqJsonLd(qa)}
</script>
\`\`\`
`;
}

// One owned answer page per web surface, attached to the highest-priority open
// brand-defense claim's bet; all open brand-defense claims listed on the page.
export function generateBrandDefensePages(surfaceId: string): BrandDefenseResult {
  const notes: string[] = [];
  const assets: BrandDefenseAsset[] = [];

  const surface = surfaceRow(surfaceId);
  if (!surface) {
    notes.push(`surface "${surfaceId}" not onboarded; nothing to generate`);
    return { assets, notes };
  }
  const observers = observersOf(surfaceId);
  const surfaceIds = [surfaceId, ...observers.map((o) => o.id)];

  const claims = db
    .select()
    .from(schema.claims)
    .where(inArray(schema.claims.surfaceId, surfaceIds))
    .all()
    .filter((c) => c.class === "brand-defense" && c.status === "open");
  if (claims.length === 0) {
    notes.push("no open brand-defense claims on this surface (or its observers); nothing to generate");
    return { assets, notes };
  }

  try {
    // The owned page lives on the web surface (this one, or the observed one).
    const config = surface.configSnapshot as { target?: { domain?: string }; observes?: string };
    const webSurfaceId = config.target?.domain ? surfaceId : (config.observes ?? surfaceId);
    const webSurface = surfaceRow(webSurfaceId);
    const domain =
      ((webSurface?.configSnapshot as { target?: { domain?: string } } | undefined)?.target?.domain) ??
      surfaceId;
    const brand = domain.replace(/^www\./, "").split(".")[0].toLowerCase();

    // The asset attaches to a bet: first claim (config order) that has one.
    const betted = claims
      .map((c) => ({ claim: c, bet: db.select().from(schema.bets).where(eq(schema.bets.claimId, c.id)).get() }))
      .filter((x) => x.bet !== undefined);
    // Cancellation is terminal: a withdrawn bet never attaches a page (the same rule in
    // every act generator and in fix-spec).
    for (const x of betted.filter((y) => y.bet!.state === "cancelled")) {
      notes.push(`bet ${x.bet!.id} is cancelled; the operator withdrew this work, nothing generated`);
    }
    const eligible = betted.filter((x) => x.bet!.state !== "cancelled");
    for (const c of claims) {
      if (!betted.some((x) => x.claim.id === c.id)) {
        notes.push(`claim ${c.id}: no bet placed; listed on the page but not the attaching bet`);
      }
    }
    if (eligible.length === 0) {
      notes.push("no open brand-defense claim has a placed bet; page assets attach to a bet, nothing generated");
      return { assets, notes };
    }
    const bet = eligible[0].bet!;

    const { facts: observedFacts } = organizationFacts(webSurfaceId, domain);
    // business_goal is the ENGINE's strategy statement for this surface, not what the
    // company is or aims at — rendering it as the company's mission was a faithfulness
    // bug. It is deliberately omitted from the page's factual
    // basis; engine context stays in the engine's own records, never on the public page.
    const facts: Fact[] = [
      { text: `The company operates the website https://${domain}/ (surface config).`, source: "surface config" },
      ...observedFacts,
    ];
    if (observedFacts.length === 0) {
      notes.push(`brand-defense: no crawl JSON-LD Organization evidence for ${webSurfaceId}; factual basis is config-only`);
    }

    const questions = brandQuestions(observers.length > 0 ? observers : [surface], brand, domain);
    const llm = llmJson<LlmPage>(
      pagePrompt(brand, domain, facts, questions),
      `brand-defense page for ${domain}`,
      notes,
    );
    const body = llm?.body?.trim() || DRAFT_PENDING;
    const qa = questions.map((q) => ({ q, a: llm?.answers?.[q]?.trim() || DRAFT_PENDING }));
    const draftPending = llm === null;

    const route = `/is-${slugify(domain.replace(/^www\./, ""))}-legit`;
    // Asset identity is the ACTING surface plus the claim the page attaches to, never
    // the observed web surface: two ai-answer surfaces observing one web surface each
    // act on their OWN claims, and keying on the observed surface made them collide on
    // a single asset row (the later act silently rewrote the earlier one's page and
    // re-pointed its bet). Same shape as tool-spec's `asset:<surface>:<claim>:...`.
    const assetId = `asset:${surfaceId}:brand-defense:${slugify(eligible[0].claim.id)}:owned-answer-page`;
    const markdown = renderPage(domain, claims, facts, qa, body);
    const write = upsertAsset({
      id: assetId,
      betId: bet.id,
      type: "page",
      body: markdown,
      route,
      state: "generated",
      skipReason: null,
      // Every open brand-defense claim is answered by this one page, but the asset
      // hangs off a single bet: the covered list lets the other bets link here
      // instead of dead-ending (Actions covered-by row).
      coveredClaimIds: claims.map((c) => c.id),
    });
    if (!write.written) {
      notes.push(write.note!);
      return { assets, notes };
    }
    assets.push({
      assetId,
      betId: bet.id,
      claimIds: claims.map((c) => c.id),
      route,
      state: "generated",
      draftPending,
    });
  } catch (e) {
    notes.push(
      `brand-defense page failed: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`,
    );
  }
  return { assets, notes };
}
