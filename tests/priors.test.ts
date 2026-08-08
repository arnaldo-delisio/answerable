// Learn leg (decomposed prioritization score's prior factor): prior = 2 x (wins + 1) /
// (settlements + 2), computed over settled bets keyed by (scope, claim class).
// Exactly 1.0 with no settlements; win = "keep" only; a losing streak dampens but
// never zeroes; scope fallback surface -> priors_from parent -> fleet.

import "./helpers/testdb";
import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "../src/db";
import { priorFor } from "../src/engine/learn/priors";

type Settlement = "keep" | "revise" | "stop";
let seq = 0;

function seedSurface(id: string): void {
  db.insert(schema.surfaces)
    .values({ id, kind: "web-locale", configSnapshot: {}, onboardedAt: 1 })
    .run();
  db.insert(schema.runs)
    .values({ id: `run:${id}`, surfaceId: id, startedAt: 1, stationsRun: [], configSnapshot: {} })
    .run();
}

function seedSettledBet(surfaceId: string, claimClass: string, settlement: Settlement): void {
  seq += 1;
  const claimId = `claim:${surfaceId}:${claimClass}:${seq}`;
  db.insert(schema.claims)
    .values({
      id: claimId,
      surfaceId,
      class: claimClass,
      status: "answered",
      title: "t",
      confidence: "0.9",
      falsifiability: "f",
      createdRunId: `run:${surfaceId}`,
      lastObservedRunId: `run:${surfaceId}`,
    })
    .run();
  db.insert(schema.bets)
    .values({
      id: `bet:${seq}`,
      claimId,
      surfaceId,
      actionClass: "fix spec",
      impact: 3,
      effort: 2,
      confidence: 0.9,
      outcomeMetric: "eligibility_pass_rate",
      outcomeWindow: { minRuns: 2, minDays: 14 },
      state: "settled",
      placedAt: 1,
      // Lifecycle CHECKs (schema.ts): settled rows carry the full timestamp trail.
      shippedAt: 1,
      execVerifiedAt: 1,
      outcomeAssessedAt: 2,
      settledAt: 2,
      settlement,
    })
    .run();
}

beforeAll(() => {
  seedSurface("parent-surface");
  seedSurface("child-surface");
  seedSurface("other-surface");
});

describe("priorFor", () => {
  it("zero settlements anywhere = exactly 1.0, honestly scoped fleet", () => {
    const p = priorFor("child-surface", "never-settled-class");
    expect(p.multiplier).toBe(1.0);
    expect(p.settlements).toBe(0);
    expect(p.wins).toBe(0);
    expect(p.scope).toBe("fleet");
  });

  it("implements 2 x (wins + 1) / (settlements + 2) exactly", () => {
    seedSettledBet("other-surface", "technical", "keep");
    seedSettledBet("other-surface", "technical", "keep");
    seedSettledBet("other-surface", "technical", "stop");
    const p = priorFor("other-surface", "technical");
    expect(p.wins).toBe(2);
    expect(p.settlements).toBe(3);
    expect(p.multiplier).toBe((2 * (2 + 1)) / (3 + 2)); // 1.2
    expect(p.scope).toBe("surface");
  });

  it("only keep counts as a win: revise and stop are non-wins", () => {
    seedSettledBet("other-surface", "eligibility", "keep");
    seedSettledBet("other-surface", "eligibility", "revise");
    seedSettledBet("other-surface", "eligibility", "stop");
    const p = priorFor("other-surface", "eligibility");
    expect(p.wins).toBe(1);
    expect(p.settlements).toBe(3);
    expect(p.multiplier).toBe((2 * 2) / 5); // 0.8
  });

  it("an all-loss streak dampens the class but never reaches 0", () => {
    for (let i = 0; i < 4; i++) seedSettledBet("other-surface", "authority", "stop");
    const p = priorFor("other-surface", "authority");
    expect(p.multiplier).toBe(2 / 6); // 2*(0+1)/(4+2)
    expect(p.multiplier).toBeGreaterThan(0);
  });

  it("stays bounded below 2 even on a perfect record", () => {
    for (let i = 0; i < 20; i++) seedSettledBet("other-surface", "ai-visibility", "keep");
    const p = priorFor("other-surface", "ai-visibility");
    expect(p.multiplier).toBeLessThan(2);
    expect(p.multiplier).toBe((2 * 21) / 22);
  });

  it("scope fallback: no own settlements -> priors_from parent's derived prior", () => {
    seedSettledBet("parent-surface", "brand-defense", "keep");
    seedSettledBet("parent-surface", "brand-defense", "revise");
    const p = priorFor("child-surface", "brand-defense", "parent-surface");
    expect(p.scope).toBe("parent");
    expect(p.settlements).toBe(2);
    expect(p.multiplier).toBe((2 * 2) / 4); // 1.0 from 1 win / 2 settlements
  });

  it("scope fallback: no own, no priors_from -> fleet-wide settlements", () => {
    const p = priorFor("child-surface", "brand-defense"); // no priors_from given
    expect(p.scope).toBe("fleet");
    expect(p.settlements).toBe(2); // parent's rows count fleet-wide
  });

  it("own settlements win over the parent scope once they exist", () => {
    seedSettledBet("child-surface", "brand-defense", "stop");
    const p = priorFor("child-surface", "brand-defense", "parent-surface");
    expect(p.scope).toBe("surface");
    expect(p.settlements).toBe(1);
    expect(p.multiplier).toBe(2 / 3);
  });

  it("classes are independent: settlements in one class never bleed into another", () => {
    const p = priorFor("other-surface", "content-keyword");
    expect(p.settlements).toBe(0);
    expect(p.multiplier).toBe(1.0);
  });
});
