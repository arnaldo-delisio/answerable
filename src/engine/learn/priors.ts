// Learn station: priors are a deterministic derived query over
// settled bets, keyed by (scope: surface or fleet, claim class). Learn owns no table and
// writes nothing; decide calls priorFor at scoring time.
//
// Prioritization-score smoothing: prior = 2 x (wins + 1) / (settlements + 2). Exactly 1.0 with no
// settlements, never 0, bounded below 2. Win = settlement "keep"; "revise" and "stop"
// are non-wins (revise is treated conservatively).
//
// Scope fallback: the surface's own settlements; else the priors_from parent surface's;
// else fleet-wide (all surfaces). The first scope with settlements wins; an empty fleet
// yields the neutral 1.0 prior honestly.

import { and, eq, isNotNull } from "drizzle-orm";
import { db, schema } from "../../db";

export interface Prior {
  multiplier: number;
  wins: number;
  settlements: number;
  scope: "surface" | "parent" | "fleet";
}

function settledCounts(claimClass: string, surfaceId?: string): { wins: number; settlements: number } {
  const where = surfaceId
    ? and(eq(schema.bets.state, "settled"), isNotNull(schema.bets.settlement), eq(schema.claims.class, claimClass), eq(schema.bets.surfaceId, surfaceId))
    : and(eq(schema.bets.state, "settled"), isNotNull(schema.bets.settlement), eq(schema.claims.class, claimClass));
  const rows = db
    .select({ settlement: schema.bets.settlement, betId: schema.bets.id })
    .from(schema.bets)
    .innerJoin(schema.claims, eq(schema.bets.claimId, schema.claims.id))
    .where(where)
    .all();
  const wins = rows.filter((r) => r.settlement === "keep").length;

  // An operator-rejected asset is a negative signal the learn leg must hear.
  // Its bet counts as a NON-WIN SETTLEMENT EQUIVALENT: it enters the denominator
  // (settlements) and never the numerator (wins), exactly like a "revise"/"stop"
  // settlement, without fabricating a bets.settlement value (the bet row itself keeps
  // its true lifecycle state — the equivalence lives only in this derived count).
  // A bet that later genuinely settles is counted once, via its settlement above.
  const rejectedWhere = surfaceId
    ? and(eq(schema.assets.state, "rejected"), eq(schema.claims.class, claimClass), eq(schema.bets.surfaceId, surfaceId))
    : and(eq(schema.assets.state, "rejected"), eq(schema.claims.class, claimClass));
  const rejectedBetIds = new Set(
    db
      .select({ betId: schema.bets.id })
      .from(schema.assets)
      .innerJoin(schema.bets, eq(schema.assets.betId, schema.bets.id))
      .innerJoin(schema.claims, eq(schema.bets.claimId, schema.claims.id))
      .where(rejectedWhere)
      .all()
      .map((r) => r.betId),
  );
  const settledBetIds = new Set(rows.map((r) => r.betId));
  const rejectedOnly = [...rejectedBetIds].filter((id) => !settledBetIds.has(id)).length;

  return { wins, settlements: rows.length + rejectedOnly };
}

const smoothed = (wins: number, settlements: number): number => (2 * (wins + 1)) / (settlements + 2);

// Prior for one (surface, claim class). priorsFrom is the surface's `priors_from`
// config field (parent surface id), evaluated only when the surface itself has no
// settlements of this class; the fleet scope is the last fallback.
export function priorFor(surfaceId: string, claimClass: string, priorsFrom?: string | null): Prior {
  const own = settledCounts(claimClass, surfaceId);
  if (own.settlements > 0) {
    return { multiplier: smoothed(own.wins, own.settlements), ...own, scope: "surface" };
  }
  if (priorsFrom) {
    const parent = settledCounts(claimClass, priorsFrom);
    if (parent.settlements > 0) {
      return { multiplier: smoothed(parent.wins, parent.settlements), ...parent, scope: "parent" };
    }
  }
  const fleet = settledCounts(claimClass);
  return { multiplier: smoothed(fleet.wins, fleet.settlements), ...fleet, scope: "fleet" };
}
