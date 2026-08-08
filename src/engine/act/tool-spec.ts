// Act station, tool-spec slice: a placed tool-opportunity bet becomes a build spec
// (asset type tool, state generated) from a deterministic template; no LLM call.
// The spec follows the programmatic multiplication pattern: a tool is a template family
// (calculator, generator, builder, finder) instantiated per audience, so one approved
// template fans out into cheap follow-on bets. Justifying queries travel verbatim from
// the claim's query_topic (evidenced formulations, never invented).
// A per-bet failure is a note, never a throw that kills the act pass.

import { and, eq } from "drizzle-orm";
import { db, schema } from "../../db";
import { upsertAsset } from "./asset-write";

type ClaimRow = typeof schema.claims.$inferSelect;
type BetRow = typeof schema.bets.$inferSelect;

export interface ToolSpecAsset {
  assetId: string;
  betId: string;
  claimId: string;
  route: string;
  state: "generated";
}

export interface ToolSpecResult {
  assets: ToolSpecAsset[];
  notes: string[];
}

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// Effort rubric: 5 = tool build (the top of the 1-5 effort scale, config-only changes at 1).
const TOOL_EFFORT_CLASS = 5;

// Template families per the multiplication pattern: a small set of repeatable templates
// multiplied across audiences/platforms, matched on the tool's name.
const TEMPLATE_FAMILIES: [keyword: string, family: string][] = [
  ["calculator", "calculator"],
  ["generator", "generator"],
  ["builder", "builder"],
  ["finder", "finder"],
];

function templateFamily(toolName: string): string {
  const lower = toolName.toLowerCase();
  for (const [kw, family] of TEMPLATE_FAMILIES) if (lower.includes(kw)) return family;
  return "interactive-tool";
}

// Claim titles from the tool-opportunity detector read
// "free-tool opportunity #<rank>: <tool name> (<audience> audience)".
function parseToolClaim(title: string): { tool: string; audience: string | null; rank: string | null } {
  const m = /^free-tool opportunity #(\d+):\s*(.+?)\s*\((.+?)\s+audience\)$/i.exec(title);
  if (m) return { rank: m[1], tool: m[2], audience: m[3] };
  return { rank: null, tool: title, audience: null };
}

function renderSpec(
  claim: ClaimRow,
  bet: BetRow,
  surfaceId: string,
  route: string,
  siblings: string[],
): string {
  const { tool, audience, rank } = parseToolClaim(claim.title);
  const family = templateFamily(tool);
  const queries = (claim.queryTopic ?? "")
    .split(";")
    .map((q) => q.trim())
    .filter(Boolean);
  const queryBlock =
    queries.length > 0
      ? queries.map((q) => `- "${q}"`).join("\n")
      : "- (no justifying queries recorded on the claim)";
  const siblingNote =
    siblings.length > 0
      ? `Sibling instantiations of the same \`${family}\` template on this surface (build the template once, fan these out as follow-on bets): ${siblings.join(", ")}.`
      : `First instantiation of the \`${family}\` template on this surface; once approved and built, further audience/platform variants become cheap follow-on bets.`;

  return `# Tool spec: ${tool} (${surfaceId})

Type: tool build spec (asset type \`tool\`, state \`generated\`). Generated deterministically
from the claim and its evidenced queries; no LLM involved. Build starts only on approval
(claim taxonomy: "tool spec, then build on approval").

## Purpose

A free, hosted ${tool.toLowerCase()} serving the ${audience ?? "target"} audience: it does the
real task the evidenced queries ask for (useful task, not lead-gen theater) and leads
credibly to the surface's desired conversion.${rank ? ` Ranked #${rank} in the demand map's free-tool opportunity list.` : ""}

## Justifying queries (verbatim from the claim)

${queryBlock}

## Lanes served

- **Demand**: captures the evidenced query cluster above directly at \`${route}\` (demand-map lane).
- **Authority**: a genuinely useful free tool is a natural outreach and link target in its
  own right, unlike gated or thin content: people cite and link to a working utility
  because it solves their task, not because they were asked to; the same build does
  double duty as demand capture and a link-building asset.

## Effort class

${TOOL_EFFORT_CLASS} (top of the 1-5 effort rubric: tool build). Bet ${bet.id}: impact ${bet.impact}, confidence ${bet.confidence}${bet.score !== null ? `, score ${bet.score.toFixed(3)}` : ""}.

## Proposed route

\`${route}\` (flat keyword-matching slug, per the multiplication pattern).

## Template instantiation

Derives from the \`${family}\` template family (multiplication pattern: a small
set of repeatable templates multiplied across audiences, not bespoke builds). This spec
instantiates \`${family}\` for the ${audience ?? "target"} audience as "${tool}".
${siblingNote}

## Verification binding

Execution check: route \`${route}\` live and reachable. Outcome: \`${bet.outcomeMetric}\`
movement over the bet's outcome window (min ${bet.outcomeWindow.minRuns} runs, ${bet.outcomeWindow.minDays} days after ship).
`;
}

// Generate tool specs for every placed tool-opportunity bet on the surface.
// Idempotent: deterministic asset ids, regenerating replaces the generated body.
export function generateToolSpecs(surfaceId: string): ToolSpecResult {
  const notes: string[] = [];
  const assets: ToolSpecAsset[] = [];

  const bets = db
    .select()
    .from(schema.bets)
    .where(and(eq(schema.bets.surfaceId, surfaceId), eq(schema.bets.state, "placed")))
    .all();

  const toolBets: { bet: BetRow; claim: ClaimRow }[] = [];
  for (const bet of bets) {
    const claim = db.select().from(schema.claims).where(eq(schema.claims.id, bet.claimId)).get();
    if (!claim) {
      notes.push(`bet ${bet.id}: claim ${bet.claimId} missing; skipped`);
      continue;
    }
    if (claim.class !== "tool-opportunity") continue;
    if (claim.status !== "open") {
      notes.push(`bet ${bet.id}: claim is ${claim.status} (not open); no spec generated`);
      continue;
    }
    toolBets.push({ bet, claim });
  }
  if (toolBets.length === 0) {
    notes.push("no placed tool-opportunity bets on this surface; nothing to spec");
    return { assets, notes };
  }

  // Sibling map per template family, for the multiplication note.
  const byFamily = new Map<string, string[]>();
  for (const { claim } of toolBets) {
    const { tool } = parseToolClaim(claim.title);
    const family = templateFamily(tool);
    byFamily.set(family, [...(byFamily.get(family) ?? []), tool]);
  }

  // Route uniqueness within this pass: two claims naming the same tool slugify to the
  // same product route; the first claim keeps it, later ones get a collision note.
  const routeOwner = new Map<string, string>();

  for (const { bet, claim } of toolBets) {
    try {
      const { tool } = parseToolClaim(claim.title);
      const family = templateFamily(tool);
      const slug = slugify(tool);
      const route = `/tools/${slug}`;
      const owner = routeOwner.get(route);
      if (owner !== undefined) {
        notes.push(
          `route collision: ${route} already speced for claim ${owner}; bet ${bet.id} (claim ${claim.id}) skipped`,
        );
        continue;
      }
      routeOwner.set(route, claim.id);
      const siblings = (byFamily.get(family) ?? []).filter((t) => t !== tool);
      const body = renderSpec(claim, bet, surfaceId, route, siblings);
      // Injective over the originating claim: the claim id is part of the asset id, so
      // two claims recommending the same-named tool can never share an asset row.
      const assetId = `asset:${surfaceId}:${slugify(claim.id)}:tool-spec`;
      // Review-gate protection lives in ONE place now (act/asset-write.ts): an asset the
      // gate has acted on is never rewritten by a regeneration.
      const write = upsertAsset({
        id: assetId,
        betId: bet.id,
        type: "tool",
        body,
        route,
        state: "generated",
        skipReason: null,
      });
      if (!write.written) {
        notes.push(write.note!);
        continue;
      }
      assets.push({ assetId, betId: bet.id, claimId: claim.id, route, state: "generated" });
    } catch (e) {
      notes.push(
        `tool spec failed for bet ${bet.id}: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`,
      );
    }
  }
  return { assets, notes };
}
