// Deterministic run ordering (verify/diff.ts): when two runs share started_at, "the
// last two runs" is decided by the documented tiebreak (started_at, then id), never by
// insertion order.

import "./helpers/testdb";
import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "../src/db";
import { diffLastTwoRuns } from "../src/engine/verify/diff";

const S = "order-surface";
const T = 5_000;

function seedRun(id: string, startedAt: number): void {
  db.insert(schema.runs).values({ id, surfaceId: S, startedAt, stationsRun: [], configSnapshot: {} }).run();
}

beforeAll(() => {
  db.insert(schema.surfaces).values({ id: S, kind: "web-locale", configSnapshot: {}, onboardedAt: 1 }).run();
  // Inserted out of id order on purpose; both share the same timestamp.
  seedRun("run-b", T);
  seedRun("run-a", T);
  seedRun("run-old", T - 1000);
});

describe("equal-timestamp run ordering", () => {
  it("breaks started_at ties by run id, deterministically", () => {
    const diff = diffLastTwoRuns(S)!;
    // Tiebreak desc(started_at), desc(id): current = run-b, previous = run-a.
    expect(diff.currRunId).toBe("run-b");
    expect(diff.prevRunId).toBe("run-a");
  });
});
