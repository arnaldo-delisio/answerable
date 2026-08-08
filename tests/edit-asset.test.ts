// Edit verb + the placeholder gate, together. The comparison-page generator deliberately
// emits literal "[NEEDS SOURCE]" cells rather than inventing facts, and `approve` refuses
// any body carrying one. Without an edit path that combination is a dead end: the page can
// be generated and previewed and never completed. `edit` is the way to SATISFY the gate,
// never to weaken it, so these tests assert both halves — an edited body that removes the
// placeholder approves, and one that still carries it is still refused.

import "./helpers/testdb";
import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "../src/db";
import { editAsset } from "../src/engine/lib/verbs";
import { approve } from "../src/engine/act/publish";
import { renderPage } from "../src/engine/act/comparison";

const S = "edit-surface";
const RUN = "edit-run";
const BET = "edit-bet";
const COMPLETE = "# Answerable vs Acme\n\n| | Answerable | Acme |\n|---|---|---|\n| Pricing | $0 | $99 |\n";

function seedAsset(id: string, state: "generated" | "approved" | "published", body: string): void {
  db.insert(schema.assets).values({ id, betId: BET, type: "page", body, route: `/${id}`, state }).run();
}

beforeAll(() => {
  db.insert(schema.surfaces)
    .values({ id: S, kind: "web-locale", configSnapshot: { target: { domain: "example.com" } }, onboardedAt: 1 })
    .run();
  db.insert(schema.runs)
    .values({ id: RUN, surfaceId: S, startedAt: 1, stationsRun: [], configSnapshot: {} })
    .run();
  db.insert(schema.claims)
    .values({
      id: "edit-claim",
      surfaceId: S,
      createdRunId: RUN,
      lastObservedRunId: RUN,
      class: "comparison",
      title: "no comparison page against Acme",
      confidence: "0.8",
      status: "open",
      falsifiability: "would be wrong if the page already ranked",
    })
    .run();
  db.insert(schema.bets)
    .values({
      id: BET,
      claimId: "edit-claim",
      surfaceId: S,
      actionClass: "comparison page",
      impact: 3,
      effort: 2,
      confidence: 0.8,
      outcomeMetric: "share_of_answer",
      outcomeWindow: { minRuns: 2, minDays: 14 },
      state: "placed",
      placedAt: 1,
    })
    .run();
});

describe("edit guards", () => {
  it("refuses an unknown asset", () => {
    const r = editAsset("no-such-asset", "body");
    expect(r.ok).toBe(false);
    expect(r.note).toContain("not found");
  });

  it("refuses an empty replacement body", () => {
    seedAsset("edit-empty", "generated", "original");
    const r = editAsset("edit-empty", "   \n  ");
    expect(r.ok).toBe(false);
    expect(db.select().from(schema.assets).all().find((a) => a.id === "edit-empty")!.body).toBe("original");
  });

  it("refuses to edit an asset that already passed the human gate", () => {
    seedAsset("edit-approved", "approved", "approved body");
    seedAsset("edit-published", "published", "published body");
    for (const id of ["edit-approved", "edit-published"]) {
      const r = editAsset(id, "rewritten underneath the approval");
      expect(r.ok).toBe(false);
      expect(r.note).toContain("only awaiting-review drafts can be edited");
    }
    expect(db.select().from(schema.assets).all().find((a) => a.id === "edit-approved")!.body).toBe("approved body");
    expect(db.select().from(schema.assets).all().find((a) => a.id === "edit-published")!.body).toBe("published body");
  });
});

describe("the comparison dead end, opened without weakening the gate", () => {
  // The real generator output, not a hand-written stand-in: this is the body an operator
  // actually gets, placeholders and all.
  let generated: string;
  beforeAll(() => {
    generated = renderPage(
      "Answerable",
      "Acme",
      db.select().from(schema.claims).all().find((c) => c.id === "edit-claim")!,
      [],
      "An honest, evidence-gated comparison.",
    );
  });

  it("the generator really does emit the blocking placeholder", () => {
    expect(generated).toContain("[NEEDS SOURCE]");
  });

  it("approve refuses the generated comparison page (the gate, intact)", () => {
    seedAsset("cmp-blocked", "generated", generated);
    const r = approve("cmp-blocked");
    expect(r.note).toContain("[NEEDS SOURCE]");
    expect(r.state).toBe("generated");
    expect(db.select().from(schema.assets).all().find((a) => a.id === "cmp-blocked")!.state).toBe("generated");
  });

  it("an edit that removes the placeholder lets the page finally approve", () => {
    seedAsset("cmp-fixed", "generated", generated);
    const e = editAsset("cmp-fixed", COMPLETE);
    expect(e.ok).toBe(true);
    expect(e.draftIncomplete).toBe(false);
    expect(db.select().from(schema.assets).all().find((a) => a.id === "cmp-fixed")!.body).toBe(COMPLETE);

    const a = approve("cmp-fixed");
    expect(a.note).toBeNull();
    expect(a.state).toBe("approved");
  });

  it("an edit that leaves a placeholder in is still refused at the gate", () => {
    seedAsset("cmp-still-blocked", "generated", generated);
    const e = editAsset("cmp-still-blocked", "# Answerable vs Acme\n\n| Pricing | $0 | [NEEDS SOURCE] |\n");
    // The edit itself is honest about what it stored: partial progress is allowed, and
    // the operator is told the gate will still refuse it rather than being told it is done.
    expect(e.ok).toBe(true);
    expect(e.draftIncomplete).toBe(true);

    const a = approve("cmp-still-blocked");
    expect(a.note).toContain("[NEEDS SOURCE]");
    expect(a.state).toBe("generated");
  });

  it("an edit cannot smuggle a draft-pending body past the gate either", () => {
    seedAsset("cmp-pending", "generated", generated);
    expect(editAsset("cmp-pending", "draft-pending: LLM unavailable").draftIncomplete).toBe(true);
    expect(approve("cmp-pending").note).toContain("draft-pending");
  });
});
