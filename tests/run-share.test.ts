// share_of_answer denominator (panel_observations aggregate into snapshots): rows that
// were both OBSERVED (an answer landed) and GROUNDED (a brand identity existed to search
// it for). A failed prompt (no observation row at all) and an ungrounded row (owned_hit
// null) are different facts — collection failure vs identity that could not be grounded —
// but neither is evidence the engine wasn't cited, so neither counts as a miss and neither
// enters the denominator. `expected`, `observed`, `judged`, `ungrounded`, and
// `failed_prompt_ids` all survive as coverage metadata; total failure still writes a real
// row (observed 0, all_prompts_failed) instead of silence.

import "./helpers/testdb";
import { beforeAll, describe, expect, it } from "vitest";
import { eq, and } from "drizzle-orm";
import { db, schema } from "../src/db";
import { finishRun } from "../src/engine/lib/run";
import { promptSlug } from "../src/engine/sense/adapters/geo-panel";

const S = "share-surface";
const PROMPTS = ["best invoicing tool", "top freelance billing app", "is example.com legit"];

const runConfig = {
  target: { engine: "claude", prompt_set: { version: "v1", prompts: PROMPTS } },
  lanes: { "geo-panel": { enabled: true } },
};

function seedRun(runId: string): void {
  db.insert(schema.runs)
    .values({ id: runId, surfaceId: S, startedAt: Date.now(), stationsRun: [], configSnapshot: runConfig })
    .run();
}

function panelRow(runId: string, prompt: string, ownedHit: boolean | null) {
  db.insert(schema.panelObservations)
    .values({
      id: `${runId}:${promptSlug(prompt)}`,
      runId,
      surfaceId: S,
      promptSetVersion: "v1",
      promptId: promptSlug(prompt),
      engine: "claude",
      responseDigest: "d",
      entitiesCited: [],
      ownedHit,
    })
    .run();
}

function shareRow(runId: string) {
  return db
    .select()
    .from(schema.snapshots)
    .where(and(eq(schema.snapshots.runId, runId), eq(schema.snapshots.metric, "share_of_answer")))
    .all();
}

beforeAll(() => {
  db.insert(schema.surfaces)
    .values({ id: S, kind: "assistant", configSnapshot: runConfig, onboardedAt: 1 })
    .run();
});

describe("share_of_answer denominator", () => {
  it("partial prompt failure: the failed prompt leaves the denominator too, its id lands in meta", () => {
    seedRun("run-partial");
    panelRow("run-partial", PROMPTS[0], true);
    panelRow("run-partial", PROMPTS[1], false);
    // PROMPTS[2] failed: no observation row landed.
    finishRun("run-partial", S, ["sense"]);
    const rows = shareRow("run-partial");
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBeCloseTo(1 / 2, 10); // 1 owned hit over 2 observed-and-grounded rows
    const meta = rows[0].meta as Record<string, unknown>;
    expect(meta.expected).toBe(3);
    expect(meta.observed).toBe(2);
    expect(meta.judged).toBe(2);
    expect(meta.failed_prompt_ids).toEqual([promptSlug(PROMPTS[2])]);
    expect(meta.all_prompts_failed).toBeUndefined();
  });

  it("total prompt failure: writes observed 0 with the flag, never nothing", () => {
    seedRun("run-total-fail");
    finishRun("run-total-fail", S, ["sense"]);
    const rows = shareRow("run-total-fail");
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(0);
    const meta = rows[0].meta as Record<string, unknown>;
    expect(meta.expected).toBe(3);
    expect(meta.observed).toBe(0);
    expect(meta.judged).toBe(0);
    expect(meta.failed_prompt_ids).toEqual(PROMPTS.map(promptSlug));
    expect(meta.all_prompts_failed).toBe(true);
  });

  // owned_hit null = ungrounded: the lane had no brand identity, so no answer was
  // ever searched for the operator's names. A 0 here would be the engine asserting
  // "you were never mentioned" about answers it never read for a name — the exact
  // fake zero a fresh, brandless install used to produce. No row at all is the
  // honest output; a missing share reads as an explicit "not checked" state.
  it("fully ungrounded run: writes NO share row rather than a fabricated 0", () => {
    seedRun("run-ungrounded");
    panelRow("run-ungrounded", PROMPTS[0], null);
    panelRow("run-ungrounded", PROMPTS[1], null);
    panelRow("run-ungrounded", PROMPTS[2], null);
    finishRun("run-ungrounded", S, ["sense"]);
    expect(shareRow("run-ungrounded")).toHaveLength(0);
  });

  // 3 prompts, 1 grounded hit, 1 ungrounded answer, 1 failed prompt. Both the
  // ungrounded row and the failed prompt leave the denominator: it is neither of
  // them, only the one grounded row that was actually observed AND judgeable. So
  // 1/1 = 100%, not 1/2 (old ungrounded-only rule) and not 1/3 (raw expected).
  it("hit + ungrounded + failed: only the observed-and-grounded row is the denominator", () => {
    seedRun("run-mixed");
    panelRow("run-mixed", PROMPTS[0], true);
    panelRow("run-mixed", PROMPTS[1], null);
    // PROMPTS[2] failed: no observation row landed.
    finishRun("run-mixed", S, ["sense"]);
    const rows = shareRow("run-mixed");
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(1);
    // Neither the previous (ungrounded-only) nor the raw-expected figure.
    expect(rows[0].value).not.toBeCloseTo(1 / 2, 10);
    expect(rows[0].value).not.toBeCloseTo(1 / 3, 10);
    const meta = rows[0].meta as Record<string, unknown>;
    expect(meta.ungrounded).toBe(1);
    // Coverage metadata survives: it just is not the share arithmetic.
    expect(meta.expected).toBe(3);
    expect(meta.observed).toBe(2);
    expect(meta.judged).toBe(1);
    expect(meta.failed_prompt_ids).toEqual([promptSlug(PROMPTS[2])]);
  });

  // The plain two-prompt case, stated on its own because it is the one an operator
  // meets first: one grounded hit, one ungrounded answer, nothing failed.
  // 100% of what could be judged, never 50%.
  it("one grounded hit plus one ungrounded answer reports 100%, not 50%", () => {
    db.insert(schema.runs)
      .values({
        id: "run-two",
        surfaceId: S,
        startedAt: Date.now(),
        stationsRun: [],
        configSnapshot: {
          target: { engine: "claude", prompt_set: { version: "v1", prompts: PROMPTS.slice(0, 2) } },
          lanes: { "geo-panel": { enabled: true } },
        },
      })
      .run();
    panelRow("run-two", PROMPTS[0], true);
    panelRow("run-two", PROMPTS[1], null);
    finishRun("run-two", S, ["sense"]);
    const rows = shareRow("run-two");
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(1);
    const meta = rows[0].meta as Record<string, unknown>;
    expect(meta.expected).toBe(2);
    expect(meta.judged).toBe(1);
    expect(meta.ungrounded).toBe(1);
  });
});
