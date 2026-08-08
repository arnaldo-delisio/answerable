// A shipped bet whose assets yield no check-key-shaped verification criteria is a
// legitimate state, not a crash. It used to throw, which turned `verify` into a raw Node
// stack trace on stderr (exit 1, even under --json) and left every bet on that surface
// permanently short of `outcome-assessed` — so `settle` was unreachable and the learn
// loop could never close.

import "./helpers/testdb";
import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "../src/db";
import { verifyExecution, shippedBets } from "../src/engine/verify/execution";

const S = "skip-surface";
const RUN = "skip-run";
const VERIFY_RUN = "skip-verify-run";

function seedBet(id: string): typeof schema.bets.$inferSelect {
  const claimId = `claim:${id}`;
  db.insert(schema.claims)
    .values({
      id: claimId,
      surfaceId: S,
      class: "brand-defense",
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
      actionClass: "page",
      impact: 5,
      effort: 3,
      confidence: 0.9,
      outcomeMetric: "brand_query_ownership",
      outcomeWindow: { minRuns: 2, minDays: 14 },
      state: "shipped",
      placedAt: 1,
      shippedAt: 2,
    })
    .run();
  return db.select().from(schema.bets).all().find((b) => b.id === id)!;
}

beforeAll(() => {
  db.insert(schema.surfaces)
    .values({ id: S, kind: "web-locale", configSnapshot: { target: { domain: "example.com" } }, onboardedAt: 1 })
    .run();
  for (const id of [RUN, VERIFY_RUN]) {
    db.insert(schema.runs)
      .values({ id, surfaceId: S, startedAt: id === RUN ? 1 : 2, stationsRun: [], configSnapshot: {} })
      .run();
  }
});

describe("execution verify on a bet with no derivable check_keys", () => {
  it("skips a prose-criteria-only asset with a structured note instead of throwing", () => {
    const bet = seedBet("bet:skip:prose");
    db.insert(schema.assets)
      .values({
        id: "asset:skip:prose",
        betId: bet.id,
        type: "page",
        state: "generated",
        body: `# Page

## Verification criteria

- Snapshot \`brand_query_ownership\` must improve over the window.
`,
      })
      .run();

    const result = verifyExecution(bet, VERIFY_RUN);
    expect(result.skipped).toBe(true);
    expect(result.skipNote).toContain(bet.id);
    expect(result.skipNote).toContain("not execution-verifiable");
    expect(result.pass).toBe(false);
    expect(result.applied).toBe(false);
    expect(result.targets).toEqual([]);
    // The bet is left exactly where it was: a skip is not a verdict.
    expect(db.select().from(schema.bets).all().find((b) => b.id === bet.id)!.state).toBe("shipped");
  });

  it("skips a bet with no assets at all, naming why", () => {
    const bet = seedBet("bet:skip:assetless");
    const result = verifyExecution(bet, VERIFY_RUN);
    expect(result.skipped).toBe(true);
    expect(result.skipNote).toContain("no assets");
  });

  it("lets the rest of the surface's shipped bets verify around the skipped one", () => {
    const bet = seedBet("bet:skip:real");
    db.insert(schema.assets)
      .values({
        id: "asset:skip:real",
        betId: bet.id,
        type: "fix-spec",
        state: "generated",
        body: `# Spec

## Verification criteria

- \`crawl/ssr@v1/https://example.com/\` must read \`pass\`.
`,
      })
      .run();
    db.insert(schema.evidence)
      .values({
        id: "ev:skip:ssr",
        runId: VERIFY_RUN,
        surfaceId: S,
        checkKey: "crawl/ssr@v1/https://example.com/",
        status: "pass",
        confidenceTag: "observed",
        value: { text_chars: 5000 },
        provenance: { url: "https://example.com/", fetched_at: 2, method: "GET" },
        cost: 0,
      })
      .run();

    // The whole surface, the way the CLI drives it: every shipped bet, none throwing.
    const results = shippedBets(S).map((b) => verifyExecution(b, VERIFY_RUN));
    expect(results.filter((r) => r.skipped).length).toBe(2);
    const verified = results.find((r) => r.betId === bet.id)!;
    expect(verified.skipped).toBe(false);
    expect(verified.pass).toBe(true);
    expect(verified.applied).toBe(true);
    expect(db.select().from(schema.bets).all().find((b) => b.id === bet.id)!.state).toBe("exec-verified");
  });
});
