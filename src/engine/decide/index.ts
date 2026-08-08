// Decide station: open claims -> ranked bets under policy.
// score = impact x confidence x class_weight(surface policy) x prior(class win-rate) / effort
// (the decomposed prioritization score, never a black-box number: every factor is stored
// decomposed on the bet row).
// Only `open` claims are bet-eligible. Creates bets (state placed) for the top-ranked
// claims not already bet on; re-scores standing placed bets so the queue reflects
// today's policy and priors. A scoring failure is a visible note, never a throw that
// kills the run. Like infer, deciding a web surface also decides the assistant
// surfaces observing it.

import { and, eq, like } from "drizzle-orm";
import { db, schema } from "../../db";
import { priorFor } from "../learn/priors";
import type { Prior } from "../learn/priors";

type ClaimRow = typeof schema.claims.$inferSelect;

// Default class weights (overridable per surface in config `policy`). `content-keyword`
// and `authority` are reserved classes: no detector in src/engine/infer emits either, so
// their rows here (and in DEFAULT_IMPACT and CLASS_OUTCOME_METRIC below) never score a
// real claim. They are kept so the taxonomy stays whole when a detector lands.
const DEFAULT_CLASS_WEIGHT: Record<string, number> = {
  "brand-defense": 1.5,
  "ai-visibility": 1.4,
  eligibility: 1.2,
  technical: 1.2,
  "tool-opportunity": 1.1,
  "content-keyword": 1.0,
  competitor: 1.0,
  authority: 0.9,
};

// Impact defaults per class (1-5, "estimated effect on the surface's desired
// conversion"). These are adjustable POLICY DEFAULTS, not measurements, overridable per
// surface in config `policy`. Their relative ordering follows the shape of the funnel:
// GEO-class gaps (ai-visibility, brand-defense) default highest because being invisible
// or misidentified in an AI answer forecloses the interaction entirely, before any other
// claim class gets a chance to matter; eligibility/technical default medium-high because
// they gate downstream discovery outright; tool-opportunity defaults medium for its
// dual-lane payoff (search and AI answers both); content-keyword and competitor default
// medium-low as contested, slower-compounding ground; authority defaults low pending
// deeper measurement (content-keyword and authority are reserved, per the note above). A claim class missing here scores at the neutral 3.
const DEFAULT_IMPACT: Record<string, number> = {
  "brand-defense": 5,
  "ai-visibility": 4,
  eligibility: 4,
  technical: 3,
  "tool-opportunity": 3,
  "content-keyword": 2,
  competitor: 2,
  authority: 2,
};

// Effort rubric: 1 config-only change, 2 technical fix spec, 3 single content
// page, 4 multi-page or entity-level work, 5 tool build. Mapped from the claim's
// recommended_asset type (the class taxonomy's "answered by" mapping).
function effortFor(recommendedAsset: string | null): number {
  const asset = (recommendedAsset ?? "").toLowerCase();
  if (asset.includes("tool")) return 5; // tool spec then build
  if (asset.includes("entity")) return 4; // AEO blocks + entity/structured-claims work
  // Effort rung 1: config-only changes (robots policy, config flips) are cheaper than
  // a technical fix spec and score accordingly.
  if (asset.includes("config") || asset.includes("robots policy")) return 1;
  if (asset.includes("fix spec") || asset.includes("robots")) return 2; // technical fix spec
  if (asset.includes("page")) return 3; // single content page
  return 3; // unknown asset type: neutral single-page effort
}

// Outcome metric per class, bound from the fixed class-to-metric catalog: the snapshot
// metric this bet is judged on after ship (outcome check, never execution check).
const CLASS_OUTCOME_METRIC: Record<string, string> = {
  technical: "eligibility_pass_rate", // re-crawlable site health checks
  eligibility: "eligibility_pass_rate", // per-bot access x SSR x sitemap x schema
  "content-keyword": "sitemap_url_count", // sitemap-presence proxy (indexation is GSC-gated)
  competitor: "share_of_answer", // panel re-sample: answer-space ownership
  "ai-visibility": "share_of_answer", // share-of-answer per engine lane
  "brand-defense": "brand_query_ownership", // who answers "is X legit" / "X review"
  authority: "community_mention_count", // mention counts, keyless lanes
  "tool-opportunity": "tool_engagement", // per-tool engagement for built assets
};

// Minimum accumulation after ship before outcome assessment (go-live and outcome stay
// separate checks).
const OUTCOME_WINDOW = { minRuns: 2, minDays: 14 };

// How many top-ranked unbet claims get a bet placed per decide pass.
const MAX_NEW_BETS = 5;

export interface ScoredClaim {
  claimId: string;
  claimClass: string;
  title: string;
  impact: number;
  effort: number;
  confidence: number;
  classWeight: number;
  prior: Prior;
  score: number;
  outcomeMetric: string;
}

export interface DecideResult {
  surfaceId: string;
  ranked: ScoredClaim[];
  placed: { betId: string; claimId: string; score: number }[];
  rescored: { betId: string; claimId: string; score: number }[];
  notes: string[];
}

function scoreClaim(claim: ClaimRow, policy: Record<string, number>, priorsFrom: string | null): ScoredClaim {
  const impact = DEFAULT_IMPACT[claim.class] ?? 3;
  const effort = effortFor(claim.recommendedAsset);
  // Claim confidence is the strongest-evidence-tag mapping (observed=0.9, measured=0.85,
  // reported=0.6, reported-unverified=0.4, inference=0.3), stored as text.
  const parsed = Number(claim.confidence);
  const confidence = Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : 0.3;
  const classWeight = policy[claim.class] ?? DEFAULT_CLASS_WEIGHT[claim.class] ?? 1.0;
  const prior = priorFor(claim.surfaceId, claim.class, priorsFrom);
  const score = (impact * confidence * classWeight * prior.multiplier) / effort;
  return {
    claimId: claim.id,
    claimClass: claim.class,
    title: claim.title,
    impact,
    effort,
    confidence,
    classWeight,
    prior,
    score,
    outcomeMetric: CLASS_OUTCOME_METRIC[claim.class] ?? "lane_cost_total",
  };
}

function decideOne(surfaceId: string): DecideResult | null {
  const surface = db.select().from(schema.surfaces).where(eq(schema.surfaces.id, surfaceId)).get();
  if (!surface) return null;
  const config = surface.configSnapshot as { policy?: Record<string, number>; priors_from?: string };
  const policy = config.policy ?? {};
  const priorsFrom = config.priors_from ?? null;
  const notes: string[] = [];

  const openClaims = db
    .select()
    .from(schema.claims)
    .where(and(eq(schema.claims.surfaceId, surfaceId), eq(schema.claims.status, "open")))
    .all();

  const ranked: ScoredClaim[] = [];
  for (const claim of openClaims) {
    try {
      ranked.push(scoreClaim(claim, policy, priorsFrom));
    } catch (e) {
      notes.push(`scoring failed for ${claim.id}: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`);
    }
  }
  ranked.sort((a, b) => b.score - a.score || a.claimId.localeCompare(b.claimId));

  const existingBets = db.select().from(schema.bets).where(eq(schema.bets.surfaceId, surfaceId)).all();
  const betByClaim = new Map(existingBets.map((b) => [b.claimId, b]));
  const now = Date.now();

  // Place bets for the top-ranked claims not already bet on.
  const placed: DecideResult["placed"] = [];
  for (const sc of ranked.filter((r) => !betByClaim.has(r.claimId)).slice(0, MAX_NEW_BETS)) {
    try {
      const betId = `bet:${sc.claimId.replace(/^claim:/, "")}`;
      const claim = openClaims.find((c) => c.id === sc.claimId)!;
      db.insert(schema.bets)
        .values({
          id: betId,
          claimId: sc.claimId,
          surfaceId,
          actionClass: claim.recommendedAsset ?? sc.claimClass,
          impact: sc.impact,
          effort: sc.effort,
          confidence: sc.confidence,
          classWeight: sc.classWeight,
          prior: sc.prior.multiplier,
          score: sc.score,
          outcomeMetric: sc.outcomeMetric,
          outcomeWindow: OUTCOME_WINDOW,
          state: "placed",
          placedAt: now,
        })
        .onConflictDoNothing()
        .run();
      placed.push({ betId, claimId: sc.claimId, score: sc.score });
    } catch (e) {
      notes.push(`bet placement failed for ${sc.claimId}: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`);
    }
  }

  // Re-score standing placed bets against today's policy and priors (placed only:
  // shipped and later states are frozen at their placement-time reasoning).
  const rescored: DecideResult["rescored"] = [];
  for (const bet of existingBets.filter((b) => b.state === "placed")) {
    try {
      const claim = db.select().from(schema.claims).where(eq(schema.claims.id, bet.claimId)).get();
      if (!claim) {
        notes.push(`bet ${bet.id}: claim ${bet.claimId} missing; not re-scored`);
        continue;
      }
      if (claim.status !== "open") {
        notes.push(`bet ${bet.id}: claim ${bet.claimId} is ${claim.status} (no longer open); not re-scored`);
        continue;
      }
      const sc = scoreClaim(claim, policy, priorsFrom);
      db.update(schema.bets)
        .set({
          impact: sc.impact,
          effort: sc.effort,
          confidence: sc.confidence,
          classWeight: sc.classWeight,
          prior: sc.prior.multiplier,
          score: sc.score,
          outcomeMetric: sc.outcomeMetric,
        })
        .where(eq(schema.bets.id, bet.id))
        .run();
      rescored.push({ betId: bet.id, claimId: bet.claimId, score: sc.score });
    } catch (e) {
      notes.push(`re-score failed for bet ${bet.id}: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`);
    }
  }

  return { surfaceId, ranked, placed, rescored, notes };
}

// Decide for a surface; a site surface also decides the assistant surfaces
// observing it (their claims live on the observing surface), mirroring infer.
export function decide(surfaceId: string): DecideResult[] {
  const own = decideOne(surfaceId);
  if (!own) throw new Error(`surface "${surfaceId}" not onboarded (answerable onboard <file> first)`);
  const results = [own];
  const observers = db
    .select()
    .from(schema.surfaces)
    .where(like(schema.surfaces.configSnapshot, `%"observes":"${surfaceId}"%`))
    .all();
  for (const obs of observers) {
    const r = decideOne(obs.id);
    if (r) results.push(r);
  }
  return results;
}
