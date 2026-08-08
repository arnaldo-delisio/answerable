// The review gate, from both ends.
//
// 1. Identity: an asset id is unique to the thing that produced it. Two AI-answer
//    surfaces observing ONE web surface act on their own claims, and used to collide on
//    a single asset id derived from the OBSERVED surface — so acting on the second
//    surface silently reset an approved-and-published page to `generated`, re-pointed its
//    bet, and replaced its body.
// 2. Enforcement: no write path may modify an asset past the gate, whichever generator
//    or re-run reaches it (src/engine/act/asset-write.ts).
//
// The LLM lane is mocked unavailable (rather than emptying PATH, which couples the test
// to the box it runs on): the generators take their honest draft-pending branch and
// nothing shells out. The placeholder predicate stays real, so the approval gate behaves
// exactly as it does in production.

import "./helpers/testdb";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/engine/act/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/engine/act/llm")>();
  return {
    ...actual,
    claudeCliAvailable: () => false,
    llmText: (_prompt: string, subject: string, notes: string[]) => {
      notes.push(`llm: mocked unavailable; ${subject} created draft-pending`);
      return { text: actual.DRAFT_PENDING, pending: true };
    },
    llmJson: (_prompt: string, subject: string, notes: string[]) => {
      notes.push(`llm: mocked unavailable; ${subject} created draft-pending`);
      return null;
    },
  };
});

import { eq } from "drizzle-orm";
import { db, schema } from "../src/db";
import { upsertAsset, isGated, GATED_ASSET_STATES } from "../src/engine/act/asset-write";
import { generateBrandDefensePages } from "../src/engine/act/brand-defense";
import { approve } from "../src/engine/act/publish";
import { reject } from "../src/engine/lib/verbs";

const WEB = "gate-web-en";
const GEO = "gate-geo-chatgpt";
const RUN = "gate-run";

function seedClaimAndBet(surfaceId: string, slug: string): { claimId: string; betId: string } {
  const claimId = `claim:${surfaceId}:${slug}`;
  const betId = `bet:${surfaceId}:${slug}`;
  db.insert(schema.claims)
    .values({
      id: claimId,
      surfaceId,
      class: "brand-defense",
      status: "open",
      title: `brand answer gap on ${surfaceId}`,
      confidence: "0.9",
      falsifiability: "Falsified when the owned answer page ranks for the brand query.",
      createdRunId: RUN,
      lastObservedRunId: RUN,
    })
    .run();
  db.insert(schema.bets)
    .values({
      id: betId,
      claimId,
      surfaceId,
      actionClass: "page",
      impact: 5,
      effort: 3,
      confidence: 0.9,
      outcomeMetric: "brand_query_ownership",
      outcomeWindow: { minRuns: 2, minDays: 14 },
      state: "placed",
      placedAt: 1,
    })
    .run();
  return { claimId, betId };
}

beforeAll(() => {
  db.insert(schema.surfaces)
    .values({
      id: WEB,
      kind: "web-locale",
      configSnapshot: { target: { domain: "example.com" } },
      onboardedAt: 1,
    })
    .run();
  db.insert(schema.surfaces)
    .values({
      id: GEO,
      kind: "ai-engine-lane",
      configSnapshot: {
        observes: WEB,
        target: { engine: "chatgpt", prompt_set: { prompts: ["Is example.com legit?"] } },
      },
      onboardedAt: 1,
    })
    .run();
  db.insert(schema.runs)
    .values({ id: RUN, surfaceId: WEB, startedAt: 1, stationsRun: [], configSnapshot: {} })
    .run();
  seedClaimAndBet(WEB, "brand-defense");
  seedClaimAndBet(GEO, "brand-defense");
});

describe("asset identity across an observed web surface", () => {
  it("acting on an observing surface never touches the observed surface's approved, published asset", () => {
    // Act on the web surface: its pass covers its own claim AND the observer's.
    const first = generateBrandDefensePages(WEB);
    expect(first.assets).toHaveLength(1);
    const webAssetId = first.assets[0].assetId;
    const webBetId = first.assets[0].betId;

    // The operator approves and publishes it: it is now past the gate.
    db.update(schema.assets)
      .set({
        state: "published",
        approvedBy: "operator",
        publishedAt: 42,
        body: "PUBLISHED BODY",
      })
      .where(eq(schema.assets.id, webAssetId))
      .run();

    // Now act on the AI-answer surface that observes it.
    const second = generateBrandDefensePages(GEO);
    expect(second.assets).toHaveLength(1);
    const geoAssetId = second.assets[0].assetId;

    // Different producers, different asset rows.
    expect(geoAssetId).not.toBe(webAssetId);
    expect(geoAssetId).toContain(GEO);

    // The published asset is byte-identical and still published, on its original bet.
    const stored = db.select().from(schema.assets).where(eq(schema.assets.id, webAssetId)).get()!;
    expect(stored.state).toBe("published");
    expect(stored.body).toBe("PUBLISHED BODY");
    expect(stored.publishedAt).toBe(42);
    expect(stored.betId).toBe(webBetId);
  });

  it("re-running the same generator refuses to rewrite its own published asset, with a note", () => {
    const published = db
      .select()
      .from(schema.assets)
      .all()
      .find((a) => a.state === "published")!;
    const again = generateBrandDefensePages(WEB);
    expect(again.notes.some((n) => n.includes(published.id) && n.includes("published"))).toBe(true);
    const stored = db.select().from(schema.assets).where(eq(schema.assets.id, published.id)).get()!;
    expect(stored.body).toBe("PUBLISHED BODY");
    expect(stored.state).toBe("published");
  });
});

describe("the single asset write path", () => {
  it("names every state the human gate has acted on", () => {
    expect([...GATED_ASSET_STATES]).toEqual(["approved", "published", "skipped", "rejected"]);
    expect(isGated("generated")).toBe(false);
    expect(isGated("approved")).toBe(true);
    expect(isGated("published")).toBe(true);
  });

  it("refuses a write against every state the gate has acted on", () => {
    const betId = "bet:gate-web-en:brand-defense";
    for (const state of GATED_ASSET_STATES) {
      const id = `asset:gate:${state}`;
      db.insert(schema.assets)
        .values({
          id,
          betId,
          type: "page",
          body: "GATED BODY",
          state,
          route: "/gated",
          skipReason: state === "skipped" ? "ethics gate" : null,
          rejectedReason: state === "rejected" ? "off-brand" : null,
        })
        .run();
      const result = upsertAsset({
        id,
        betId,
        type: "page",
        body: "OVERWRITTEN",
        state: "generated",
        route: "/rewritten",
      });
      expect(result.written).toBe(false);
      expect(result.note).toContain(state);
      const stored = db.select().from(schema.assets).where(eq(schema.assets.id, id)).get()!;
      expect(stored.body).toBe("GATED BODY");
      expect(stored.state).toBe(state);
      expect(stored.route).toBe("/gated");
      // Gate metadata survives too: a refused write never clears why the gate acted.
      if (state === "skipped") expect(stored.skipReason).toBe("ethics gate");
      if (state === "rejected") expect(stored.rejectedReason).toBe("off-brand");
    }
  });

  it("writes through for an asset still awaiting review", () => {
    const betId = "bet:gate-web-en:brand-defense";
    const id = "asset:gate:generated";
    db.insert(schema.assets)
      .values({ id, betId, type: "page", body: "FIRST", state: "generated" })
      .run();
    const result = upsertAsset({ id, betId, type: "page", body: "SECOND", state: "generated" });
    expect(result.written).toBe(true);
    expect(result.note).toBeNull();
    expect(db.select().from(schema.assets).where(eq(schema.assets.id, id)).get()!.body).toBe("SECOND");
  });
});

describe("rejection is terminal at the review gate", () => {
  it("refuses to approve a rejected asset back into the pipeline", () => {
    const betId = "bet:gate-web-en:brand-defense";
    const id = "asset:gate:approve-after-reject";
    db.insert(schema.assets)
      .values({ id, betId, type: "page", body: "A COMPLETE BODY", state: "generated" })
      .run();
    expect(reject(id, "off-brand and unfixable").ok).toBe(true);

    const result = approve(id);
    expect(result.note).toContain("rejected");
    expect(result.state).toBe("rejected");
    expect(db.select().from(schema.assets).where(eq(schema.assets.id, id)).get()!.state).toBe("rejected");
  });
});
