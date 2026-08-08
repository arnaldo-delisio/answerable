// Publish modes after the engine lost its web server: there are exactly two outcomes,
// PR and spec-handoff, and nothing is ever reported as live. Tool assets are build specs
// like fix-specs, so they take the spec path (they used to be "route-live", which only
// meant anything while the repo shipped an app that served the route). The handoff path
// is exercised here because it touches no network; the PR path needs the gh CLI.

import "./helpers/testdb";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db";
import { approve, publish } from "../src/engine/act/publish";
import { listOutbox, markSent } from "../src/engine/act/outbox";
import { tick } from "../src/engine/lib/tick";

const S = "publish-surface";
const RUN = "publish-run";

function seedAsset(id: string, type: "fix-spec" | "page" | "tool", surfaceId = S, runId = RUN): void {
  const claimId = `${id}-claim`;
  const betId = `${id}-bet`;
  db.insert(schema.claims)
    .values({
      id: claimId,
      surfaceId: surfaceId,
      createdRunId: runId,
      lastObservedRunId: runId,
      class: "technical",
      title: `claim for ${id}`,
      confidence: "0.9",
      status: "open",
      falsifiability: "f",
    })
    .run();
  db.insert(schema.bets)
    .values({
      id: betId,
      claimId,
      surfaceId: surfaceId,
      actionClass: "fix spec",
      impact: 3,
      effort: 2,
      confidence: 0.9,
      outcomeMetric: "eligibility_pass_rate",
      outcomeWindow: { minRuns: 2, minDays: 14 },
      state: "placed",
      placedAt: 1,
    })
    .run();
  db.insert(schema.assets)
    .values({ id, betId, type, body: `body of ${id}`, route: "/a-route", state: "generated" })
    .run();
}

beforeAll(() => {
  db.insert(schema.surfaces)
    .values({
      id: S,
      kind: "site",
      // No publishing.repo: the spec-handoff branch, which opens no PR.
      configSnapshot: { target: { domain: "example.com" }, publishing: { policy: "review-required", owner: "op" } },
      onboardedAt: 1,
    })
    .run();
  db.insert(schema.runs)
    .values({ id: RUN, surfaceId: S, startedAt: 1, stationsRun: [], configSnapshot: {} })
    .run();
  seedAsset("asset-tool", "tool");
  seedAsset("asset-fix", "fix-spec");
  seedAsset("asset-page", "page");
});

describe("publish modes", () => {
  it("a tool asset is a build spec: spec-handoff, never reported live", async () => {
    approve("asset-tool");
    const r = await publish("asset-tool");
    expect(r.mode).toBe("spec-handoff");
    expect(r.state).toBe("published");
    expect(r.betShipped).toBe(true);
    const row = db.select().from(schema.assets).where(eq(schema.assets.id, "asset-tool")).get();
    expect(row!.body).toContain("spec-handoff:");
  });

  it("a fix-spec takes the same path", async () => {
    approve("asset-fix");
    const r = await publish("asset-fix");
    expect(r.mode).toBe("spec-handoff");
  });

  it("a page is staged, never live", async () => {
    approve("asset-page");
    const r = await publish("asset-page");
    expect(r.mode).toBe("staged");
    expect(r.prUrl).toBeNull();
  });

  it("a configured repo that fails to deliver is not a publish", async () => {
    // A surface whose publishing.repo is malformed: gh rejects it locally and
    // immediately, so this exercises the delivery-failure branch without a network.
    db.insert(schema.surfaces)
      .values({
        id: "publish-surface-repo",
        kind: "site",
        configSnapshot: {
          target: { domain: "example.com" },
          publishing: { policy: "review-required", owner: "op", repo: "///invalid///" },
        },
        onboardedAt: 1,
      })
      .run();
    db.insert(schema.runs)
      .values({ id: "run-repo", surfaceId: "publish-surface-repo", startedAt: 1, stationsRun: [], configSnapshot: {} })
      .run();
    seedAsset("asset-page-pr", "page", "publish-surface-repo", "run-repo");
    approve("asset-page-pr");
    const r = await publish("asset-page-pr");
    expect(r.mode).toBe("none");
    expect(r.prUrl).toBeNull();
    expect(r.notes.join(" ")).toContain("PR creation failed");
    const row = db.select().from(schema.assets).where(eq(schema.assets.id, "asset-page-pr")).get();
    expect(row!.state).toBe("approved");
    const bet = db.select().from(schema.bets).where(eq(schema.bets.id, "asset-page-pr-bet")).get();
    expect(bet!.state).toBe("placed");
  });

  it("the review gate refuses a draft still carrying engine placeholders", async () => {
    seedAsset("asset-incomplete", "page");
    db.update(schema.assets)
      .set({ body: "Positioning | [NEEDS SOURCE] | still unfilled" })
      .where(eq(schema.assets.id, "asset-incomplete"))
      .run();
    const a = approve("asset-incomplete");
    expect(a.state).toBe("generated");
    expect(a.note).toContain("placeholders");

    // And again at publish, for a body edited back into placeholders after approve.
    db.update(schema.assets).set({ state: "approved" }).where(eq(schema.assets.id, "asset-incomplete")).run();
    const r = await publish("asset-incomplete");
    expect(r.mode).toBe("none");
    expect(r.notes.join(" ")).toContain("publish refused");
    const row = db.select().from(schema.assets).where(eq(schema.assets.id, "asset-incomplete")).get();
    expect(row!.state).toBe("approved");
  });

  it("the review gate holds: an unapproved asset does not publish", async () => {
    seedAsset("asset-ungated", "tool");
    const r = await publish("asset-ungated");
    expect(r.mode).toBe("none");
    expect(r.state).toBe("generated");
    expect(r.notes.join(" ")).toContain("not approved");
  });

  // The send path is the third door out of the review gate, and a legacy row approved
  // before the gate existed is exactly the case a filter at approve-time cannot catch.
  it("an incomplete approved outreach draft is neither listed nor markable as sent", () => {
    seedAsset("asset-outreach", "fix-spec");
    db.update(schema.assets)
      .set({ type: "outreach-draft", state: "approved", body: "Hi — draft-pending: LLM unavailable" })
      .where(eq(schema.assets.id, "asset-outreach"))
      .run();
    expect(listOutbox().map((e) => e.assetId)).not.toContain("asset-outreach");
    const r = markSent("asset-outreach");
    expect(r.note).toContain("placeholders");
    expect(r.state).toBe("approved");
  });

  it("a complete approved outreach draft still lists and marks sent", () => {
    seedAsset("asset-outreach-ok", "fix-spec");
    db.update(schema.assets)
      .set({ type: "outreach-draft", state: "approved", body: "Hi — a real, complete draft body." })
      .where(eq(schema.assets.id, "asset-outreach-ok"))
      .run();
    expect(listOutbox().map((e) => e.assetId)).toContain("asset-outreach-ok");
    expect(markSent("asset-outreach-ok").state).toBe("published");
  });

  // The summary is an instrument: it must count the same rows the outbox hands out,
  // or it reports work nobody can retrieve.
  it("the tick summary counts the outbox, not every approved row", async () => {
    // Both seeded above: one incomplete (never listed), one already marked sent.
    seedAsset("asset-outreach-pending", "fix-spec");
    db.update(schema.assets)
      .set({ type: "outreach-draft", state: "approved", body: "Hi — another complete draft." })
      .where(eq(schema.assets.id, "asset-outreach-pending"))
      .run();
    const r = await tick();
    expect(r.outboxPending).toBe(listOutbox().length);
    expect(r.outboxPending).toBe(1);
  });
});
