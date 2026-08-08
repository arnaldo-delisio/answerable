// Decide station (the decomposed prioritization score): score = impact x confidence x
// class_weight x prior / effort,
// stored decomposed on the bet, never a composite-only number. Policy overrides class
// weights per surface; effort maps from the recommended asset rubric; only open claims
// are bet-eligible; confidence outside (0,1] falls back to the honest 0.3.

import "./helpers/testdb";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db";
import { decide } from "../src/engine/decide";

const S = "decide-surface";
let claimSeq = 0;

function seedClaim(opts: {
  class: string;
  status?: string;
  confidence?: string;
  recommendedAsset?: string | null;
}): string {
  claimSeq += 1;
  const id = `claim:${S}:c${claimSeq}`;
  db.insert(schema.claims)
    .values({
      id,
      surfaceId: S,
      class: opts.class,
      status: (opts.status ?? "open") as "open",
      title: `claim ${claimSeq}`,
      recommendedAsset: opts.recommendedAsset === undefined ? "fix spec" : opts.recommendedAsset,
      confidence: opts.confidence ?? "0.9",
      falsifiability: "f",
      createdRunId: `run:${S}`,
      lastObservedRunId: `run:${S}`,
    })
    .run();
  return id;
}

beforeAll(() => {
  db.insert(schema.surfaces)
    .values({
      id: S,
      kind: "site",
      // Policy override: brand-defense re-weighted from the 1.5 default to 0.5.
      configSnapshot: { policy: { "brand-defense": 0.5 } },
      onboardedAt: 1,
    })
    .run();
  db.insert(schema.runs)
    .values({ id: `run:${S}`, surfaceId: S, startedAt: 1, stationsRun: [], configSnapshot: {} })
    .run();
});

describe("decide scoring", () => {
  it("computes the full decomposed formula and stores every factor on the bet", () => {
    const claimId = seedClaim({ class: "technical", confidence: "0.9", recommendedAsset: "fix spec" });
    const [result] = decide(S);
    const sc = result.ranked.find((r) => r.claimId === claimId)!;
    // technical: impact 3 (default), class weight 1.2 (default, no override), prior 1.0
    // (no settlements), effort 2 (fix spec), confidence 0.9.
    expect(sc.impact).toBe(3);
    expect(sc.effort).toBe(2);
    expect(sc.confidence).toBe(0.9);
    expect(sc.classWeight).toBe(1.2);
    expect(sc.prior.multiplier).toBe(1.0);
    expect(sc.score).toBeCloseTo((3 * 0.9 * 1.2 * 1.0) / 2, 10);
    const bet = db.select().from(schema.bets).where(eq(schema.bets.claimId, claimId)).get()!;
    expect(bet.state).toBe("placed");
    expect(bet.impact).toBe(3);
    expect(bet.effort).toBe(2);
    expect(bet.confidence).toBe(0.9);
    expect(bet.classWeight).toBe(1.2);
    expect(bet.prior).toBe(1.0);
    expect(bet.score).toBeCloseTo(sc.score, 10);
    expect(bet.outcomeMetric).toBe("eligibility_pass_rate");
  });

  it("surface policy overrides the default class weight (brand-defense 1.5 -> 0.5)", () => {
    const claimId = seedClaim({ class: "brand-defense", confidence: "0.9", recommendedAsset: "owned answer page" });
    const [result] = decide(S);
    const sc = result.ranked.find((r) => r.claimId === claimId)!;
    expect(sc.classWeight).toBe(0.5);
    // brand-defense: impact 5, page => effort 3.
    expect(sc.score).toBeCloseTo((5 * 0.9 * 0.5) / 3, 10);
  });

  it("maps the effort rubric from the recommended asset (1-5 ladder)", () => {
    const cases: [string | null, number][] = [
      ["tool spec, then build on approval", 5], // tool build
      ["quick-answer (AEO) blocks + entity/structured-claims work", 4], // entity-level
      ["fix spec / robots policy", 1], // config-only (rung 1: robots policy)
      ["config change: crawl budget flag", 1], // config-only
      ["fix spec", 2], // technical fix spec
      ["comparison / alternative page", 3], // single content page
      [null, 3], // unknown -> neutral
    ];
    const ids = cases.map(([asset]) => seedClaim({ class: "content-keyword", recommendedAsset: asset }));
    const [result] = decide(S);
    cases.forEach(([, effort], i) => {
      expect(result.ranked.find((r) => r.claimId === ids[i])!.effort).toBe(effort);
    });
  });

  it("uses stored confidence values and falls back to 0.3 outside (0,1]", () => {
    const observed = seedClaim({ class: "competitor", confidence: "0.9" });
    const reported = seedClaim({ class: "competitor", confidence: "0.6" });
    const junk = seedClaim({ class: "competitor", confidence: "not-a-number" });
    const zero = seedClaim({ class: "competitor", confidence: "0" });
    const [result] = decide(S);
    const conf = (id: string) => result.ranked.find((r) => r.claimId === id)!.confidence;
    expect(conf(observed)).toBe(0.9);
    expect(conf(reported)).toBe(0.6);
    expect(conf(junk)).toBe(0.3);
    expect(conf(zero)).toBe(0.3);
  });

  it("only open claims are bet-eligible: answered/dismissed/falsified never ranked", () => {
    const answered = seedClaim({ class: "technical", status: "answered" });
    const dismissed = seedClaim({ class: "technical", status: "dismissed" });
    const falsified = seedClaim({ class: "technical", status: "falsified" });
    const [result] = decide(S);
    const rankedIds = result.ranked.map((r) => r.claimId);
    expect(rankedIds).not.toContain(answered);
    expect(rankedIds).not.toContain(dismissed);
    expect(rankedIds).not.toContain(falsified);
    for (const id of [answered, dismissed, falsified]) {
      expect(db.select().from(schema.bets).where(eq(schema.bets.claimId, id)).all()).toHaveLength(0);
    }
  });

  it("ranks by score descending and re-scores standing placed bets", () => {
    const [result] = decide(S);
    for (let i = 1; i < result.ranked.length; i++) {
      expect(result.ranked[i - 1].score).toBeGreaterThanOrEqual(result.ranked[i].score);
    }
    // Every previously placed bet on a still-open claim got re-scored this pass.
    const placedBets = db.select().from(schema.bets).where(eq(schema.bets.surfaceId, S)).all();
    const openBets = placedBets.filter((b) => b.state === "placed");
    expect(result.rescored.map((r) => r.betId).sort()).toEqual(
      openBets.map((b) => b.id).filter((id) => !result.placed.some((p) => p.betId === id)).sort(),
    );
  });

  it("throws for a surface that was never onboarded", () => {
    expect(() => decide("ghost-surface")).toThrowError(/not onboarded/);
  });
});
