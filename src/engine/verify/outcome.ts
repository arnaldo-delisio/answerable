// Verify station, outcome slice (directed and verified, never autonomous: go-live and
// outcome are separate checks): for a bet in
// exec-verified state, check whether its outcome_window is satisfied (>= minRuns runs
// AFTER shipped_at AND >= minDays days elapsed). Satisfied -> transition to
// outcome-assessed with outcome_assessed_at and an outcome_note summarizing the bet's
// outcome_metric snapshot values pre/post ship (real rows only; a missing metric row is
// reported, never fabricated). Not satisfied -> reported immature with what is missing:
// "exec-verified but outcome immature" is a distinct, visible state, printed honestly.
// `now` is injectable for fixture-timestamp tests.

import { and, asc, desc, eq, gt, lte } from "drizzle-orm";
import { db, schema } from "../../db";
import { assertTransition } from "../../db/transitions";

type BetRow = typeof schema.bets.$inferSelect;

const DAY_MS = 86_400_000;

export interface OutcomeAssessment {
  betId: string;
  outcomeMetric: string;
  mature: boolean;
  runsAfterShip: number;
  daysElapsed: number;
  required: { minRuns: number; minDays: number };
  // Human-honest line: for mature bets the pre/post summary written to outcome_note;
  // for immature bets what is still missing.
  note: string;
  applied: boolean; // true when the bet transitioned to outcome-assessed
}

// Latest snapshot row for (surface, metric) within a started_at bound. Deterministic
// secondary sort: started_at ties broken by run id (documented run-ordering rule).
function latestMetricValue(
  surfaceId: string,
  metric: string,
  bound: { after?: number; atOrBefore?: number },
): { value: number; runId: string; startedAt: number } | null {
  const conds = [eq(schema.runs.surfaceId, surfaceId), eq(schema.snapshots.metric, metric)];
  if (bound.after !== undefined) conds.push(gt(schema.runs.startedAt, bound.after));
  if (bound.atOrBefore !== undefined) conds.push(lte(schema.runs.startedAt, bound.atOrBefore));
  const row = db
    .select({ value: schema.snapshots.value, runId: schema.runs.id, startedAt: schema.runs.startedAt })
    .from(schema.snapshots)
    .innerJoin(schema.runs, eq(schema.snapshots.runId, schema.runs.id))
    .where(and(...conds))
    .orderBy(desc(schema.runs.startedAt), desc(schema.runs.id))
    .limit(1)
    .get();
  return row ?? null;
}

export function assessOutcome(bet: BetRow, now: number = Date.now()): OutcomeAssessment {
  const required = bet.outcomeWindow;
  const base: Omit<OutcomeAssessment, "mature" | "note" | "applied"> = {
    betId: bet.id,
    outcomeMetric: bet.outcomeMetric,
    runsAfterShip: 0,
    daysElapsed: 0,
    required,
  };
  if (bet.shippedAt === null) {
    // Guarded upstream (transition rules), reported honestly if legacy data hits it.
    return { ...base, mature: false, note: "no shipped_at on the bet; window cannot start", applied: false };
  }

  const runsAfter = db
    .select()
    .from(schema.runs)
    .where(and(eq(schema.runs.surfaceId, bet.surfaceId), gt(schema.runs.startedAt, bet.shippedAt)))
    .orderBy(asc(schema.runs.startedAt), asc(schema.runs.id))
    .all();
  const daysElapsed = (now - bet.shippedAt) / DAY_MS;
  base.runsAfterShip = runsAfter.length;
  base.daysElapsed = daysElapsed;

  const missing: string[] = [];
  if (runsAfter.length < required.minRuns) missing.push(`${runsAfter.length}/${required.minRuns} runs after ship`);
  if (daysElapsed < required.minDays) missing.push(`${daysElapsed.toFixed(1)}/${required.minDays} days elapsed`);
  if (missing.length > 0) {
    return { ...base, mature: false, note: `outcome immature: ${missing.join(", ")}`, applied: false };
  }

  // Window satisfied: summarize the metric's pre/post-ship snapshot values, real rows
  // only. Pre = latest snapshot at or before ship; post = latest snapshot after ship.
  const pre = latestMetricValue(bet.surfaceId, bet.outcomeMetric, { atOrBefore: bet.shippedAt });
  const post = latestMetricValue(bet.surfaceId, bet.outcomeMetric, { after: bet.shippedAt });
  const fmt = (s: { value: number; runId: string } | null, label: string) =>
    s ? `${label} ${s.value} (run ${s.runId})` : `${label} no snapshot row`;
  const note = `${bet.outcomeMetric}: ${fmt(pre, "pre-ship")} -> ${fmt(post, "post-ship")}; window ${runsAfter.length} runs / ${daysElapsed.toFixed(1)} days (required ${required.minRuns}/${required.minDays})`;

  assertTransition(bet, "outcome-assessed");
  db.update(schema.bets)
    .set({ state: "outcome-assessed", outcomeAssessedAt: now, outcomeNote: note })
    .where(eq(schema.bets.id, bet.id))
    .run();
  return { ...base, mature: true, note, applied: true };
}

// All exec-verified bets on the surface, assessed in id order (deterministic report).
export function assessOutcomes(surfaceId: string, now: number = Date.now()): OutcomeAssessment[] {
  const bets = db
    .select()
    .from(schema.bets)
    .where(and(eq(schema.bets.surfaceId, surfaceId), eq(schema.bets.state, "exec-verified")))
    .orderBy(asc(schema.bets.id))
    .all();
  // A per-bet failure is a structured, honest assessment note, never a throw that kills
  // the whole verify pass (same rule as the execution leg).
  return bets.map((bet) => {
    try {
      return assessOutcome(bet, now);
    } catch (e) {
      return {
        betId: bet.id,
        outcomeMetric: bet.outcomeMetric,
        mature: false,
        runsAfterShip: 0,
        daysElapsed: 0,
        required: bet.outcomeWindow,
        note: `outcome assessment refused: ${e instanceof Error ? e.message : String(e)}`,
        applied: false,
      };
    }
  });
}
