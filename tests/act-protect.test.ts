// Act-station protections: regeneration never mutates an asset beyond `generated`
// (fix-spec skip-with-note), and tool-spec asset ids are injective over the originating
// claim with route collisions reported, never silently merged.

import "./helpers/testdb";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db";
import { generateFixSpec, generateSurfaceFixSpecs } from "../src/engine/act/fix-spec";
import { generateToolSpecs } from "../src/engine/act/tool-spec";
import { cancelBet } from "../src/engine/lib/verbs";

const S = "protect-surface";
const RUN = "protect-run";

beforeAll(() => {
  db.insert(schema.surfaces)
    .values({ id: S, kind: "web-locale", configSnapshot: { target: { domain: "example.com" } }, onboardedAt: 1 })
    .run();
  db.insert(schema.runs)
    .values({ id: RUN, surfaceId: S, startedAt: 1, stationsRun: [], configSnapshot: {} })
    .run();
  db.insert(schema.evidence)
    .values({
      id: "ev-hreflang",
      runId: RUN,
      surfaceId: S,
      checkKey: "crawl/hreflang@v1/https://example.com/en",
      status: "missing",
      confidenceTag: "observed",
      value: { entries: [] },
      provenance: { url: null, fetched_at: 1, method: "test" },
      cost: 0,
    })
    .run();
});

describe("fix-spec regeneration protection", () => {
  it("skips with a note instead of mutating a published asset", () => {
    const first = generateFixSpec(S, "hreflang");
    expect(first.assetNote).toBeNull();

    // Human gate acted: asset published.
    db.update(schema.assets)
      .set({ state: "published", publishedAt: 123, body: "PUBLISHED BODY" })
      .where(eq(schema.assets.id, first.assetId))
      .run();

    const second = generateFixSpec(S, "hreflang");
    expect(second.assetNote).toContain("published");
    expect(second.assetNote).toContain("refused");
    const stored = db.select().from(schema.assets).where(eq(schema.assets.id, first.assetId)).get()!;
    expect(stored.state).toBe("published");
    expect(stored.body).toBe("PUBLISHED BODY"); // byte-identical: regeneration touched nothing
  });
});

function seedToolBet(n: number, title: string): { claimId: string; betId: string } {
  const claimId = `claim:${S}:tool:${n}`;
  const betId = `bet:${S}:tool:${n}`;
  db.insert(schema.claims)
    .values({
      id: claimId,
      surfaceId: S,
      class: "tool-opportunity",
      status: "open",
      title,
      queryTopic: "how much to charge; rate help",
      confidence: "0.6",
      falsifiability: "f",
      createdRunId: RUN,
      lastObservedRunId: RUN,
    })
    .run();
  db.insert(schema.bets)
    .values({
      id: betId,
      claimId,
      surfaceId: S,
      actionClass: "tool",
      impact: 3,
      effort: 5,
      confidence: 0.6,
      outcomeMetric: "tool_engagement",
      outcomeWindow: { minRuns: 2, minDays: 14 },
      state: "placed",
      placedAt: 1,
    })
    .run();
  return { claimId, betId };
}

describe("act's fix-spec pass and the cancelled bet", () => {
  it("regenerates nothing for a bet the operator cancelled", () => {
    const betId = "bet:protect-surface:hreflang";
    expect(db.select().from(schema.bets).all().find((b) => b.id === betId)!.state).toBe("placed");
    expect(cancelBet(betId, "shipping a different hreflang plan").ok).toBe(true);

    const result = generateSurfaceFixSpecs(S);
    expect(result.assets.some((a) => a.betId === betId)).toBe(false);
    expect(result.notes.some((n) => n.includes(betId) && n.includes("cancelled"))).toBe(true);
  });
});

describe("tool-spec id injectivity + route uniqueness", () => {
  it("asset ids embed the claim id; same-route claims collide with a note, never merge", () => {
    const a = seedToolBet(1, "free-tool opportunity #1: Rate Calculator (freelancer audience)");
    seedToolBet(2, "free-tool opportunity #2: Rate Calculator (brand audience)");
    const b2 = seedToolBet(3, "free-tool opportunity #3: Bio Generator (freelancer audience)");

    const result = generateToolSpecs(S);
    // Two distinct routes speced; the duplicate Rate Calculator claim got a collision note.
    expect(result.assets).toHaveLength(2);
    const ids = result.assets.map((x) => x.assetId);
    expect(new Set(ids).size).toBe(2);
    // Injective over the claim: the claim id travels inside the asset id.
    const rateAsset = result.assets.find((x) => x.route === "/tools/rate-calculator")!;
    expect(rateAsset.claimId).toBe(a.claimId);
    expect(rateAsset.assetId).toContain("claim-protect-surface-tool-1");
    const bioAsset = result.assets.find((x) => x.route === "/tools/bio-generator")!;
    expect(bioAsset.claimId).toBe(b2.claimId);
    expect(result.notes.some((n) => n.includes("route collision") && n.includes("/tools/rate-calculator"))).toBe(true);
  });

  it("never mutates a tool asset beyond generated", () => {
    const before = db.select().from(schema.assets).all().filter((x) => x.type === "tool");
    const target = before[0];
    db.update(schema.assets).set({ state: "approved", body: "APPROVED BODY" }).where(eq(schema.assets.id, target.id)).run();
    const result = generateToolSpecs(S);
    expect(result.notes.some((n) => n.includes(target.id) && n.includes("past the review gate"))).toBe(true);
    const stored = db.select().from(schema.assets).where(eq(schema.assets.id, target.id)).get()!;
    expect(stored.state).toBe("approved");
    expect(stored.body).toBe("APPROVED BODY");
  });
});
