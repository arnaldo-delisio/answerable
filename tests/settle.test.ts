// Settle verb: the last transition in the bet lifecycle and the one that CLOSES THE
// LEARN LOOP. `verify` takes a bet as far as outcome-assessed; the keep / revise / stop
// judgment on what that outcome was worth is the operator's, and until it is recorded
// the bet teaches decide nothing. These tests assert the guards AND that a settled bet
// genuinely reaches priorFor, which is the only place a settlement changes behaviour.

import "./helpers/testdb";
import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "../src/db";
import { settleBet } from "../src/engine/lib/verbs";
import { priorFor } from "../src/engine/learn/priors";

const S = "settle-surface";
const CLASS = "settle-class";

function seedBet(
  id: string,
  state: "placed" | "shipped" | "exec-verified" | "outcome-assessed",
): void {
  const claimId = `claim:${id}`;
  db.insert(schema.claims)
    .values({
      id: claimId,
      surfaceId: S,
      class: CLASS,
      status: "answered",
      title: "a finding",
      confidence: "0.9",
      falsifiability: "would be wrong if the metric fell",
      createdRunId: `run:${S}`,
      lastObservedRunId: `run:${S}`,
    })
    .run();
  db.insert(schema.bets)
    .values({
      id,
      claimId,
      surfaceId: S,
      actionClass: "fix spec",
      impact: 3,
      effort: 2,
      confidence: 0.9,
      outcomeMetric: "eligibility_pass_rate",
      outcomeWindow: { minRuns: 2, minDays: 14 },
      state,
      placedAt: 1,
      // Only the timestamps the state legitimately carries (schema CHECKs mirror this).
      shippedAt: state === "placed" ? null : 1,
      execVerifiedAt: state === "exec-verified" || state === "outcome-assessed" ? 2 : null,
      outcomeAssessedAt: state === "outcome-assessed" ? 3 : null,
    })
    .run();
}

beforeAll(() => {
  db.insert(schema.surfaces)
    .values({ id: S, kind: "site", configSnapshot: {}, onboardedAt: 1 })
    .run();
  db.insert(schema.runs)
    .values({ id: `run:${S}`, surfaceId: S, startedAt: 1, stationsRun: [], configSnapshot: {} })
    .run();
  seedBet("bet-assessed", "outcome-assessed");
  seedBet("bet-shipped", "shipped");
  seedBet("bet-enum", "outcome-assessed");
});

describe("settle guards", () => {
  it("refuses an unknown bet", () => {
    const r = settleBet("no-such-bet", "keep");
    expect(r.ok).toBe(false);
    expect(r.note).toContain("not found");
  });

  it("refuses a settlement that is not keep | revise | stop", () => {
    const r = settleBet("bet-enum", "maybe");
    expect(r.ok).toBe(false);
    expect(r.note).toContain("keep | revise | stop");
    // Nothing written: the bet is untouched.
    expect(db.select().from(schema.bets).all().find((b) => b.id === "bet-enum")!.state).toBe(
      "outcome-assessed",
    );
  });

  it("refuses a bet that has not been outcome-assessed yet (assertTransition)", () => {
    const r = settleBet("bet-shipped", "keep");
    expect(r.ok).toBe(false);
    expect(r.note).toContain('cannot move to "settled" from "shipped"');
  });
});

describe("settle closes the learn loop", () => {
  it("moves outcome-assessed -> settled, recording the choice and its timestamp", () => {
    // Before: no settlements anywhere, so the prior is exactly neutral and honestly
    // scoped to the (empty) fleet — the open-loop state this verb exists to end.
    const before = priorFor(S, CLASS);
    expect(before.settlements).toBe(0);
    expect(before.multiplier).toBe(1);
    expect(before.scope).toBe("fleet");

    const r = settleBet("bet-assessed", "keep");
    expect(r.ok).toBe(true);
    expect(r.note).toBeNull();
    expect(r.state).toBe("settled");
    expect(r.settlement).toBe("keep");
    expect(typeof r.settledAt).toBe("number");

    const row = db.select().from(schema.bets).all().find((b) => b.id === "bet-assessed")!;
    expect(row.state).toBe("settled");
    expect(row.settlement).toBe("keep");
    expect(row.settledAt).toBe(r.settledAt);

    // After: the settled bet actually REACHES the priors. This is the assertion the
    // whole feature is for — a settle that wrote a row the learn station never counted
    // would leave the loop just as open as before.
    const after = priorFor(S, CLASS);
    expect(after.settlements).toBe(1);
    expect(after.wins).toBe(1);
    expect(after.scope).toBe("surface");
    expect(after.multiplier).toBeCloseTo((2 * (1 + 1)) / (1 + 2), 10); // 2 x (wins+1)/(settlements+2)
    expect(after.multiplier).toBeGreaterThan(before.multiplier);
  });

  it("refuses to settle the same bet twice", () => {
    const r = settleBet("bet-assessed", "stop");
    expect(r.ok).toBe(false);
    expect(r.note).toContain('from "settled"');
    // And the first settlement stands, unrewritten.
    expect(db.select().from(schema.bets).all().find((b) => b.id === "bet-assessed")!.settlement).toBe(
      "keep",
    );
  });

  it("counts revise and stop as settlements but never as wins", () => {
    seedBet("bet-revise", "outcome-assessed");
    expect(settleBet("bet-revise", "revise").ok).toBe(true);
    const p = priorFor(S, CLASS);
    expect(p.settlements).toBe(2);
    expect(p.wins).toBe(1);
    expect(p.multiplier).toBeCloseTo((2 * (1 + 1)) / (2 + 2), 10);
  });
});
