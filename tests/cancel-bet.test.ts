// A placed bet must always have a transition available. `dismiss` closes a claim but
// leaves its bet standing, which stranded the bet in `placed` forever; `cancel` is the
// off-ramp to the terminal `cancelled` state.

import "./helpers/testdb";
import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "../src/db";
import { cancelBet, dismissClaim } from "../src/engine/lib/verbs";
import { publish } from "../src/engine/act/publish";
import { listOutbox, markSent } from "../src/engine/act/outbox";

const S = "cancel-surface";
const RUN = "cancel-run";

function seedBet(id: string, state: "placed" | "shipped"): string {
  const claimId = `claim:${id}`;
  db.insert(schema.claims)
    .values({
      id: claimId,
      surfaceId: S,
      class: "eligibility",
      status: "open",
      title: `claim for ${id}`,
      confidence: "0.9",
      falsifiability: "f",
      createdRunId: RUN,
      lastObservedRunId: RUN,
    })
    .run();
  db.insert(schema.bets)
    .values({
      id,
      claimId,
      surfaceId: S,
      actionClass: "fix spec",
      impact: 4,
      effort: 2,
      confidence: 0.9,
      outcomeMetric: "eligibility_pass_rate",
      outcomeWindow: { minRuns: 2, minDays: 14 },
      state,
      placedAt: 1,
      shippedAt: state === "shipped" ? 2 : null,
    })
    .run();
  return claimId;
}

beforeAll(() => {
  db.insert(schema.surfaces)
    .values({ id: S, kind: "web-locale", configSnapshot: { target: { domain: "example.com" } }, onboardedAt: 1 })
    .run();
  db.insert(schema.runs)
    .values({ id: RUN, surfaceId: S, startedAt: 1, stationsRun: [], configSnapshot: {} })
    .run();
});

describe("cancel: the placed bet's off-ramp", () => {
  it("moves a placed bet whose claim was dismissed to the terminal cancelled state", () => {
    const claimId = seedBet("bet:cancel:placed", "placed");
    expect(dismissClaim(claimId).ok).toBe(true);
    // Dismissing the claim alone leaves the bet placed: that was the strand.
    expect(db.select().from(schema.bets).all().find((b) => b.id === "bet:cancel:placed")!.state).toBe("placed");

    const result = cancelBet("bet:cancel:placed", "not worth the engineering time");
    expect(result.ok).toBe(true);
    expect(result.state).toBe("cancelled");
    const stored = db.select().from(schema.bets).all().find((b) => b.id === "bet:cancel:placed")!;
    expect(stored.state).toBe("cancelled");
    expect(stored.outcomeNote).toContain("not worth the engineering time");
  });

  it("is terminal: a cancelled bet cannot be cancelled again", () => {
    const again = cancelBet("bet:cancel:placed", "again");
    expect(again.ok).toBe(false);
    expect(again.note).toContain("cannot move to \"cancelled\" from \"cancelled\"");
  });

  it("refuses a shipped bet (already in the world: it gets judged, not withdrawn)", () => {
    seedBet("bet:cancel:shipped", "shipped");
    const result = cancelBet("bet:cancel:shipped", "changed my mind");
    expect(result.ok).toBe(false);
    expect(result.note).toContain("requires \"placed\"");
    expect(db.select().from(schema.bets).all().find((b) => b.id === "bet:cancel:shipped")!.state).toBe("shipped");
  });

  it("requires a reason, and reports an unknown bet honestly", () => {
    seedBet("bet:cancel:reasonless", "placed");
    expect(cancelBet("bet:cancel:reasonless", "   ").ok).toBe(false);
    expect(cancelBet("bet:cancel:reasonless", "   ").note).toContain("reason is required");
    expect(db.select().from(schema.bets).all().find((b) => b.id === "bet:cancel:reasonless")!.state).toBe("placed");
    expect(cancelBet("bet:nope", "x").note).toContain("not found");
  });
});

// Cancellation means "will not ship". An asset approved before the cancellation must not
// still travel out of the engine through any delivery door.
describe("nothing a cancelled bet produced is deliverable", () => {
  it("refuses publish, hides the draft from the outbox, and refuses mark-sent", async () => {
    seedBet("bet:cancel:delivery", "placed");
    db.insert(schema.assets)
      .values({
        id: "asset:cancel:spec",
        betId: "bet:cancel:delivery",
        type: "fix-spec",
        state: "approved",
        approvedBy: "operator",
        body: "# Spec\n\nA complete, approved spec body.\n",
      })
      .run();
    db.insert(schema.assets)
      .values({
        id: "asset:cancel:outreach",
        betId: "bet:cancel:delivery",
        type: "outreach-draft",
        state: "approved",
        approvedBy: "operator",
        route: "https://example.com/best-tools",
        body: `# Outreach draft

- Page title: Best tools
- Page URL: https://example.com/best-tools
- Competitors the page cites: Northwind Books

## Draft email body

Hello, a complete draft.
`,
      })
      .run();

    // The outbox offers it while the bet still stands.
    expect(listOutbox().some((e) => e.assetId === "asset:cancel:outreach")).toBe(true);

    expect(cancelBet("bet:cancel:delivery", "descoped").ok).toBe(true);

    const published = await publish("asset:cancel:spec");
    expect(published.state).toBe("approved"); // unchanged
    expect(published.notes.some((n) => n.includes("cancelled") && n.includes("not deliverable"))).toBe(true);
    expect(db.select().from(schema.assets).all().find((a) => a.id === "asset:cancel:spec")!.state).toBe("approved");

    expect(listOutbox().some((e) => e.assetId === "asset:cancel:outreach")).toBe(false);

    const sent = markSent("asset:cancel:outreach");
    expect(sent.note).toContain("cancelled");
    expect(db.select().from(schema.assets).all().find((a) => a.id === "asset:cancel:outreach")!.state).toBe("approved");
  });
});
