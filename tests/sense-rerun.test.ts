// Lineage-safe sense re-run (sense/index.ts replaceRunEvidence): after infer has linked
// claim_evidence rows to evidence ids, re-running sense for the same run must keep those
// ids stable (UPDATE in place), insert genuinely new keys, delete unreferenced vanished
// rows, and keep referenced vanished rows as status "superseded".

import "./helpers/testdb";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db";
import { replaceRunEvidence } from "../src/engine/sense";

const S = "rerun-surface";
const RUN = "rerun-run";

function row(id: string, checkKey: string, status: string) {
  return {
    id,
    runId: RUN,
    surfaceId: S,
    checkKey,
    status,
    confidenceTag: "observed" as const,
    value: { status },
    provenance: { url: null, fetched_at: 1, method: "test" },
    cost: 0,
  };
}

beforeAll(() => {
  db.insert(schema.surfaces).values({ id: S, kind: "web-locale", configSnapshot: {}, onboardedAt: 1 }).run();
  db.insert(schema.runs)
    .values({ id: RUN, surfaceId: S, startedAt: 1, stationsRun: [], configSnapshot: {} })
    .run();
});

describe("sense re-run after infer", () => {
  it("keeps FK lineage: matched keys update in place, new keys insert, vanished keys resolve by reference", () => {
    // First sense pass: k1, k2, k3.
    replaceRunEvidence(RUN, [row("e1", "crawl/a@v1/x", "fail"), row("e2", "crawl/b@v1/x", "pass"), row("e3", "crawl/c@v1/x", "pass")], []);

    // Infer links a claim to e1 and e3.
    db.insert(schema.claims)
      .values({
        id: "claim:rerun",
        surfaceId: S,
        class: "technical",
        status: "open",
        title: "t",
        confidence: "0.9",
        falsifiability: "f",
        createdRunId: RUN,
        lastObservedRunId: RUN,
      })
      .run();
    db.insert(schema.claimEvidence).values({ claimId: "claim:rerun", evidenceId: "e1" }).run();
    db.insert(schema.claimEvidence).values({ claimId: "claim:rerun", evidenceId: "e3" }).run();

    // Re-run: k1 re-observed (new id, new status), k2 and k3 vanish, k4 is new.
    replaceRunEvidence(RUN, [row("e1-new", "crawl/a@v1/x", "pass"), row("e4", "crawl/d@v1/x", "pass")], []);

    const all = db.select().from(schema.evidence).where(eq(schema.evidence.runId, RUN)).all();
    const byId = new Map(all.map((r) => [r.id, r]));

    // Matched key kept its ORIGINAL id (claim_evidence FK intact) with the new status.
    expect(byId.get("e1")?.status).toBe("pass");
    expect(byId.has("e1-new")).toBe(false);
    // Vanished + unreferenced: deleted.
    expect(byId.has("e2")).toBe(false);
    // Vanished + referenced by claim_evidence: kept, marked superseded.
    expect(byId.get("e3")?.status).toBe("superseded");
    // Genuinely new key: inserted.
    expect(byId.get("e4")?.status).toBe("pass");
    // No dangling claim_evidence rows.
    const links = db.select().from(schema.claimEvidence).all();
    for (const l of links) expect(byId.has(l.evidenceId)).toBe(true);
  });
});
