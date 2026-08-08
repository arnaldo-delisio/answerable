// Preview verb: reading a generated asset's body back is a CLI read, since the engine
// serves nothing. The properties under test are that the body comes back verbatim (no
// truncation, no re-rendering) and that an asset with no body says so instead of
// printing an empty string as if it were content.

import "./helpers/testdb";
import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "../src/db";
import { previewAsset } from "../src/engine/lib/verbs";

const S = "preview-surface";
const RUN = "preview-run";
const CLAIM = "preview-claim";
const BET = "preview-bet";
const BODY = "# Answer page\n\nFirst line.\n\nSecond line with a trailing newline issue.\n";

beforeAll(() => {
  db.insert(schema.surfaces)
    .values({ id: S, kind: "web-locale", configSnapshot: { target: { domain: "example.com" } }, onboardedAt: 1 })
    .run();
  db.insert(schema.runs)
    .values({ id: RUN, surfaceId: S, startedAt: 1, stationsRun: [], configSnapshot: {} })
    .run();
  db.insert(schema.claims)
    .values({
      id: CLAIM,
      surfaceId: S,
      createdRunId: RUN,
      lastObservedRunId: RUN,
      class: "brand-defense",
      title: "a claim",
      confidence: "0.5",
      status: "open",
      falsifiability: "would be wrong if the page ranked",
    })
    .run();
  db.insert(schema.bets)
    .values({
      id: BET,
      claimId: CLAIM,
      surfaceId: S,
      actionClass: "answer page",
      impact: 3,
      effort: 2,
      confidence: 0.5,
      outcomeMetric: "share_of_answer",
      outcomeWindow: { minRuns: 2, minDays: 14 },
      state: "placed",
      placedAt: 1,
    })
    .run();
  db.insert(schema.assets)
    .values({ id: "asset-with-body", betId: BET, type: "page", body: BODY, route: "/is-example-legit", state: "generated" })
    .run();
  db.insert(schema.assets)
    .values({
      id: "asset-skipped",
      betId: BET,
      type: "outreach-draft",
      body: null,
      state: "skipped",
      skipReason: "no genuinely helpful draft possible",
    })
    .run();
});

describe("preview", () => {
  it("returns the asset body verbatim, with its identity", () => {
    const r = previewAsset("asset-with-body");
    expect(r.ok).toBe(true);
    expect(r.note).toBeNull();
    expect(r.body).toBe(BODY);
    expect(r.type).toBe("page");
    expect(r.state).toBe("generated");
    expect(r.route).toBe("/is-example-legit");
  });

  it("reports an unknown asset instead of printing nothing", () => {
    const r = previewAsset("no-such-asset");
    expect(r.ok).toBe(false);
    expect(r.note).toContain("not found");
    expect(r.body).toBeUndefined();
  });

  it("reports a bodyless asset with its skip reason, never an empty body", () => {
    const r = previewAsset("asset-skipped");
    expect(r.ok).toBe(false);
    expect(r.note).toContain("no body");
    expect(r.note).toContain("no genuinely helpful draft possible");
    expect(r.body).toBeUndefined();
  });
});
