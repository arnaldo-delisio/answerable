// Outcome assessment (verify/outcome.ts) with synthetic fixture timestamps: a bet in
// exec-verified state matures only when its window holds (>= minRuns runs after
// shipped_at AND >= minDays days elapsed); immature bets report what is missing and do
// not transition. Also covers the lifecycle guards (db/transitions.ts) and the mirrored
// SQLite CHECK constraints.

import "./helpers/testdb";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db";
import { assessOutcomes } from "../src/engine/verify/outcome";
import { assertTransition } from "../src/db/transitions";

const S = "outcome-surface";
const DAY = 86_400_000;
const SHIP = 1_000 * DAY; // synthetic epoch

function seedRun(id: string, startedAt: number, metricValue?: number): void {
  db.insert(schema.runs).values({ id, surfaceId: S, startedAt, stationsRun: [], configSnapshot: {} }).run();
  if (metricValue !== undefined) {
    db.insert(schema.snapshots)
      .values({ id: `snap:${id}`, runId: id, surfaceId: S, metric: "eligibility_pass_rate", value: metricValue, meta: null })
      .run();
  }
}

function seedExecVerifiedBet(betId: string): void {
  const claimId = `claim:${betId}`;
  db.insert(schema.claims)
    .values({
      id: claimId,
      surfaceId: S,
      class: "technical",
      status: "open",
      title: "t",
      confidence: "0.9",
      falsifiability: "f",
      createdRunId: "run-pre",
      lastObservedRunId: "run-pre",
    })
    .run();
  db.insert(schema.bets)
    .values({
      id: betId,
      claimId,
      surfaceId: S,
      actionClass: "fix spec",
      impact: 3,
      effort: 2,
      confidence: 0.9,
      outcomeMetric: "eligibility_pass_rate",
      outcomeWindow: { minRuns: 2, minDays: 14 },
      state: "exec-verified",
      placedAt: SHIP - DAY,
      shippedAt: SHIP,
      execVerifiedAt: SHIP + DAY,
    })
    .run();
}

beforeAll(() => {
  db.insert(schema.surfaces).values({ id: S, kind: "site", configSnapshot: {}, onboardedAt: 1 }).run();
  seedRun("run-pre", SHIP - 2 * DAY, 0.4); // pre-ship snapshot
  seedRun("run-post-1", SHIP + 3 * DAY, 0.7);
  seedRun("run-post-2", SHIP + 10 * DAY, 0.9); // latest post-ship snapshot
});

describe("outcome window", () => {
  it("immature window reports what is missing and does not transition", () => {
    seedExecVerifiedBet("bet:immature");
    // Only 2 runs exist after ship but just 5 days elapsed: days requirement unmet.
    const [a] = assessOutcomes(S, SHIP + 5 * DAY);
    expect(a.mature).toBe(false);
    expect(a.applied).toBe(false);
    expect(a.note).toContain("outcome immature");
    expect(a.note).toContain("5.0/14 days");
    const bet = db.select().from(schema.bets).where(eq(schema.bets.id, "bet:immature")).get()!;
    expect(bet.state).toBe("exec-verified");
    expect(bet.outcomeAssessedAt).toBeNull();
    db.delete(schema.bets).where(eq(schema.bets.id, "bet:immature")).run();
  });

  it("satisfied window transitions with a pre/post snapshot summary from real rows", () => {
    seedExecVerifiedBet("bet:mature");
    const now = SHIP + 15 * DAY; // 2 runs after ship, 15 days elapsed: window holds
    const [a] = assessOutcomes(S, now);
    expect(a.mature).toBe(true);
    expect(a.applied).toBe(true);
    expect(a.runsAfterShip).toBe(2);
    expect(a.note).toContain("pre-ship 0.4 (run run-pre)");
    expect(a.note).toContain("post-ship 0.9 (run run-post-2)");
    const bet = db.select().from(schema.bets).where(eq(schema.bets.id, "bet:mature")).get()!;
    expect(bet.state).toBe("outcome-assessed");
    expect(bet.outcomeAssessedAt).toBe(now);
    expect(bet.outcomeNote).toBe(a.note);
  });
});

describe("lifecycle transition guards", () => {
  const base = { id: "bet:x", shippedAt: null as number | null, outcomeAssessedAt: null as number | null };
  it("blocks skipping states and settling without outcome_assessed_at", () => {
    expect(() => assertTransition({ ...base, state: "placed" }, "exec-verified")).toThrow(/requires "shipped"/);
    expect(() => assertTransition({ ...base, state: "shipped" }, "exec-verified")).toThrow(/without shipped_at/);
    expect(() => assertTransition({ ...base, state: "outcome-assessed", shippedAt: 1 }, "settled")).toThrow(
      /without outcome_assessed_at/,
    );
    expect(() =>
      assertTransition({ ...base, state: "outcome-assessed", shippedAt: 1, outcomeAssessedAt: 2 }, "settled"),
    ).not.toThrow();
  });

  it("SQLite CHECK mirrors the guard: settled without outcome_assessed_at is uninsertable", () => {
    expect(() =>
      db
        .insert(schema.bets)
        .values({
          id: "bet:bad-settled",
          claimId: "claim:bet:mature",
          surfaceId: S,
          actionClass: "fix spec",
          impact: 3,
          effort: 2,
          confidence: 0.9,
          outcomeMetric: "eligibility_pass_rate",
          outcomeWindow: { minRuns: 2, minDays: 14 },
          state: "settled",
          placedAt: 1,
          shippedAt: 2,
          settledAt: 3,
        })
        .run(),
    ).toThrow(/CHECK/i);
  });
});
