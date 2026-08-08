// Act station, AEO slice: open ai-visibility claims become a fix-spec-style asset
// (asset type fix-spec, state generated) of quick-answer (AEO) blocks for the observed
// web surface's key pages: homepage plus the surface's tool pages (generated tool-spec
// routes). Each block is a 40-60 word quick answer targeting one discovery prompt from
// the geo panel's prompt set and cites which prompt it answers; the spec ships a
// FAQPage JSON-LD block over the same set. Answers via LLM (claude -p, stdin, strict
// no-invention template); LLM absent = draft-pending answers, state stays generated.
// A per-claim failure is a note, never a throw that kills the act pass.

import { eq, inArray } from "drizzle-orm";
import { db, schema } from "../../db";
import { DRAFT_PENDING, llmJson } from "./llm";
import { describeViolations, lintText, whitelistForClaim } from "../lib/entity-lint";
import { upsertAsset } from "./asset-write";

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

type ClaimRow = typeof schema.claims.$inferSelect;
type SurfaceRow = typeof schema.surfaces.$inferSelect;

export interface AeoBlocksAsset {
  assetId: string;
  betId: string;
  claimId: string;
  promptCount: number;
  pages: string[];
  state: "generated";
  draftPending: boolean;
}

export interface AeoBlocksResult {
  assets: AeoBlocksAsset[];
  notes: string[];
}

function surfaceRow(id: string): SurfaceRow | undefined {
  return db.select().from(schema.surfaces).where(eq(schema.surfaces.id, id)).get();
}

// Key pages for the blocks: the web surface's homepage plus its generated tool routes
// (the tracking/calculator tool pages the tool-spec slice proposed).
function keyPages(webSurfaceId: string, domain: string, pathPrefix: string, notes: string[]): string[] {
  const homepage = `https://${domain}${pathPrefix}`;
  const toolRoutes = db
    .select({ route: schema.assets.route, surfaceId: schema.bets.surfaceId })
    .from(schema.assets)
    .innerJoin(schema.bets, eq(schema.assets.betId, schema.bets.id))
    .where(eq(schema.assets.type, "tool"))
    .all()
    .filter((r) => r.surfaceId === webSurfaceId && r.route !== null)
    .map((r) => `https://${domain}${pathPrefix}${r.route}`);
  if (toolRoutes.length === 0) {
    notes.push(`aeo-blocks: no generated tool routes on ${webSurfaceId} yet; blocks target the homepage only`);
  }
  return [homepage, ...toolRoutes];
}

// Discovery prompts from the claim surface's geo panel prompt set: every prompt not
// naming the brand (brand prompts are brand-defense territory, not discovery).
function discoveryPrompts(geoConfig: Record<string, unknown>, brand: string): { version: string; prompts: string[] } {
  const promptSet = (geoConfig as { target?: { prompt_set?: { version?: string; prompts?: string[] } } })
    .target?.prompt_set;
  const prompts = (promptSet?.prompts ?? []).filter((p) => !p.toLowerCase().includes(brand));
  return { version: promptSet?.version ?? "unknown", prompts };
}

function answersPrompt(brand: string, domain: string, goal: string, prompts: string[]): string {
  return [
    `Write quick-answer (AEO) blocks for the site https://${domain}/ (brand "${brand}"; ${goal}).`,
    ``,
    `One block per discovery prompt below. Each block must be a direct 40-60 word answer to the prompt that a search/answer engine could quote verbatim, honestly mentioning ${brand} as one relevant option where the prompt asks for platforms.`,
    ...prompts.map((p) => `- ${p}`),
    ``,
    `Strict rules:`,
    `- Never invent statistics, customer counts, rankings, or review claims about ${brand} or anyone else.`,
    `- Make NO claims about any company's capabilities, features, pricing, business model, or how it works — not about ${brand}, not about competitors, not about anyone. Other companies may be NAMED only when the prompt itself names them, and only as names in a neutral list, never characterized.`,
    `- No puffery, no superlatives.`,
    `- Respond with ONLY a JSON object mapping each prompt verbatim to its 40-60 word answer: {"<prompt>": "<answer>", ...}.`,
  ].join("\n");
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

function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

function renderSpec(
  claim: ClaimRow,
  engine: string,
  promptSetVersion: string,
  pages: string[],
  qa: { q: string; a: string }[],
): string {
  const blocks = qa
    .map(
      ({ q, a }) => `### Block: answers "${q}"

> ${a}

(${a === DRAFT_PENDING ? "answer draft-pending" : `${wordCount(a)} words`}; targets prompt "${q}" from prompt set ${promptSetVersion}, ${engine} lane)`,
    )
    .join("\n\n");
  return `# Fix spec: quick-answer (AEO) blocks (${claim.surfaceId})

Type: ai-visibility fix (asset type \`fix-spec\`, state \`generated\`, review-gated).
Claim: ${claim.id} — ${claim.title}

## Change required

Place the quick-answer blocks below near the top of each key page, one visible
40-60 word answer block per targeted discovery prompt, plus the FAQPage JSON-LD.

Key pages:

${pages.map((p) => `- ${p}`).join("\n")}

## Quick-answer blocks (each cites the prompt it answers)

${blocks}

## FAQPage JSON-LD (same prompt set)

\`\`\`html
<script type="application/ld+json">
${faqJsonLd(qa)}
</script>
\`\`\`

## Verification criteria

Panel re-sample across runs (claim taxonomy, ai-visibility row): a later run of the
${engine} geo panel must read owned_hit true on at least one of the targeted discovery
prompts; the claim's falsifiability condition is exactly that flip.
`;
}

// AEO block specs for one surface's open ai-visibility claims (its ai-engine-lane
// observers included, mirroring infer/decide): one asset per claim (per engine lane).
export function generateAeoBlocks(surfaceId: string): AeoBlocksResult {
  const notes: string[] = [];
  const assets: AeoBlocksAsset[] = [];

  const surface = surfaceRow(surfaceId);
  if (!surface) {
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
    .filter((c) => c.class === "ai-visibility" && c.status === "open");
  if (claims.length === 0) {
    notes.push("no open ai-visibility claims on this surface (or its observers); nothing to generate");
    return { assets, notes };
  }

  const config = surface.configSnapshot as {
    target?: { domain?: string; path_prefix?: string };
    observes?: string;
  };
  const webSurfaceId = config.target?.domain ? surfaceId : (config.observes ?? surfaceId);
  const webConfig = (surfaceRow(webSurfaceId)?.configSnapshot ?? {}) as {
    target?: { domain?: string; path_prefix?: string };
    business_goal?: string;
  };
  const domain = webConfig.target?.domain ?? surfaceId;
  const pathPrefix = webConfig.target?.path_prefix ?? "";
  const brand = domain.replace(/^www\./, "").split(".")[0].toLowerCase();
  const goal = (webConfig.business_goal ?? "").trim();
  const pages = keyPages(webSurfaceId, domain, pathPrefix, notes);

  for (const claim of claims) {
    try {
      const bet = db.select().from(schema.bets).where(eq(schema.bets.claimId, claim.id)).get();
      if (!bet) {
        notes.push(`claim ${claim.id}: no bet placed; AEO assets attach to a bet, skipped`);
        continue;
      }
      if (bet.state === "cancelled") {
        notes.push(`bet ${bet.id} is cancelled; the operator withdrew this work, nothing generated`);
        continue;
      }
      const geoConfig = (surfaceRow(claim.surfaceId)?.configSnapshot ?? {}) as Record<string, unknown>;
      const engine =
        ((geoConfig as { target?: { engine?: string } }).target?.engine) ?? claim.surfaceId;
      const { version, prompts } = discoveryPrompts(geoConfig, brand);
      if (prompts.length === 0) {
        notes.push(`claim ${claim.id}: no discovery prompts in ${claim.surfaceId}'s prompt set; no blocks to generate`);
        continue;
      }
      // Entity lint, the deterministic entity-lint language layer: each answer may only name entities/
      // numbers present in the claim's linked data (prompt text included — a prompt
      // naming a competitor licenses that name for its own answer's neutral list).
      const whitelist = whitelistForClaim(claim.id, [brand, domain, ...prompts]);
      const basePrompt = answersPrompt(brand, domain, goal, prompts);
      let llm = llmJson<Record<string, string>>(basePrompt, `AEO answers for ${claim.surfaceId}`, notes);
      if (llm !== null) {
        const bad = prompts.filter((q) => lintText(llm?.[q]?.trim() ?? "", whitelist).length > 0);
        if (bad.length > 0) {
          // One regeneration with the violations named; answers still failing after
          // it fall to draft-pending below — never a shipped invented-entity answer.
          const violationNote = bad
            .map((q) => `- "${q}": ${describeViolations(lintText(llm?.[q]?.trim() ?? "", whitelist))}`)
            .join("\n");
          const retry = llmJson<Record<string, string>>(
            `${basePrompt}\n\nYour previous answers named companies or numbers not present in the prompts themselves:\n${violationNote}\nRegenerate ALL answers naming no company (other than ${brand}) and no number unless the prompt itself contains it.`,
            `AEO answers for ${claim.surfaceId} (lint retry)`,
            notes,
          );
          if (retry !== null) llm = retry;
        }
      }
      const qa = prompts.map((q) => {
        const a = llm?.[q]?.trim() || DRAFT_PENDING;
        if (a === DRAFT_PENDING) return { q, a };
        const violations = lintText(a, whitelist);
        if (violations.length > 0) {
          notes.push(`entity lint: AEO answer for "${q}" still violates after one retry (${describeViolations(violations)}); draft-pending`);
          return { q, a: DRAFT_PENDING };
        }
        return { q, a };
      });
      const draftPending = llm === null || qa.some((x) => x.a === DRAFT_PENDING);

      const body = renderSpec(claim, engine, version, pages, qa);
      // One asset per claim (many prompts, but a single claim), so covered_claim_ids
      // stays null here: the covered-by linkage only applies where one asset answers
      // several claims' bets (brand-defense).
      // Injective over the originating claim (tool-spec's shape): the id carried only
      // the surface, so a second ai-visibility claim on the same surface overwrote the
      // first claim's asset and re-pointed it at the second claim's bet.
      const assetId = `asset:${claim.surfaceId}:${slugify(claim.id)}:aeo-blocks`;
      const write = upsertAsset({
        id: assetId,
        betId: bet.id,
        type: "fix-spec",
        body,
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
        promptCount: prompts.length,
        pages,
        state: "generated",
        draftPending,
      });
    } catch (e) {
      notes.push(
        `aeo-blocks failed for claim ${claim.id}: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`,
      );
    }
  }
  return { assets, notes };
}
