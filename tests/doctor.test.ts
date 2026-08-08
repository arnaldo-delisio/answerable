// Doctor is an instrument, so what it calls "latest" has to be latest. Run ids are
// uuids: ordering key-pending rows by run id picks a random one and reports stale text
// about what a missing key unlocks. The property under test is chronological selection
// per check_key, by the row's run start time.

import "./helpers/testdb";
import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "../src/db";
import { doctor } from "../src/engine/lib/doctor";

const S = "doctor-surface";
// Deliberately ordered so that the chronologically LATER run has the alphabetically
// SMALLER id: an id-ordered implementation picks the older row and fails.
const OLD_RUN = "zzzz-old-run";
const NEW_RUN = "aaaa-new-run";

beforeAll(() => {
  db.insert(schema.surfaces)
    .values({ id: S, kind: "web-locale", configSnapshot: { target: { domain: "example.com" } }, onboardedAt: 1 })
    .run();
  db.insert(schema.runs)
    .values({ id: OLD_RUN, surfaceId: S, startedAt: 1_000, stationsRun: [], configSnapshot: {} })
    .run();
  db.insert(schema.runs)
    .values({ id: NEW_RUN, surfaceId: S, startedAt: 2_000, stationsRun: [], configSnapshot: {} })
    .run();
  for (const [id, runId, reason] of [
    ["ev-old", OLD_RUN, "stale reason"],
    ["ev-new", NEW_RUN, "current reason"],
  ] as const) {
    db.insert(schema.evidence)
      .values({
        id,
        runId,
        surfaceId: S,
        checkKey: "bing/lane-status@v1/credentials",
        status: "key-pending",
        confidenceTag: "observed",
        value: { reason, unlock: `unlock for ${reason}`, price: "free" },
        provenance: { url: null, fetched_at: 1, method: "test" },
        cost: 0,
      })
      .run();
  }
});

describe("doctor key-pending reporting", () => {
  it("reports the chronologically latest row per check key, not the largest run id", () => {
    const pending = doctor().keyPending.filter((k) => k.checkKey === "bing/lane-status@v1/credentials");
    expect(pending).toHaveLength(1);
    expect(pending[0].reason).toBe("current reason");
    expect(pending[0].unlock).toBe("unlock for current reason");
  });
});
