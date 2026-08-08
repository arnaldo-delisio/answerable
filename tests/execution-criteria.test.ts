// Verification-criteria parsing (verify/execution.ts): both generator phrasings parse
// ("must read" and "must remain"); a check-key-shaped criterion the parser cannot read
// fails loudly (parser note + pass false), never silently passes; prose snapshot
// criteria are reported but stay outcome-leg territory.

import "./helpers/testdb";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db";
import { extractCriteria, verifyExecution } from "../src/engine/verify/execution";

const S = "exec-surface";
const VERIFY_RUN = "exec-verify-run";

const SPEC_OK = `# spec

## Verification criteria

- \`crawl/hreflang@v1/https://x/en\` must read \`present\` with entries.
- \`crawl/canonical@v1/https://x/en\` must remain \`present\` and self-referencing.
- Snapshot \`hreflang_coverage\` must read 1.0 for the run.
`;

const SPEC_UNPARSED = `# spec

## Verification criteria

- \`crawl/robots-bot-rules@v1/GPTBot\` must hold \`pass\` going forward.
`;

function seedBet(betId: string, specBody: string): typeof schema.bets.$inferSelect {
  const claimId = `claim:${betId}`;
  db.insert(schema.claims)
    .values({
      id: claimId,
      surfaceId: S,
      class: "technical",
      status: "open",
      title: "t",
      confidence: "0.9",
      falsifiability: "f",
      createdRunId: VERIFY_RUN,
      lastObservedRunId: VERIFY_RUN,
    })
    .run();
  db.insert(schema.bets)
    .values({
      id: betId,
      claimId,
      surfaceId: S,
      actionClass: "fix spec",
      impact: 3,
      effort: 2,
      confidence: 0.9,
      outcomeMetric: "eligibility_pass_rate",
      outcomeWindow: { minRuns: 2, minDays: 14 },
      state: "shipped",
      placedAt: 1,
      shippedAt: 2,
    })
    .run();
  db.insert(schema.assets)
    .values({ id: `asset:${betId}`, betId, type: "fix-spec", body: specBody, state: "published" })
    .run();
  return db.select().from(schema.bets).where(eq(schema.bets.id, betId)).get()!;
}

function seedVerifyEvidence(checkKey: string, status: string): void {
  db.insert(schema.evidence)
    .values({
      id: `ev:${checkKey}`,
      runId: VERIFY_RUN,
      surfaceId: S,
      checkKey,
      status,
      confidenceTag: "observed",
      value: null,
      provenance: { url: null, fetched_at: 1, method: "test" },
      cost: 0,
    })
    .run();
}

beforeAll(() => {
  db.insert(schema.surfaces).values({ id: S, kind: "site", configSnapshot: {}, onboardedAt: 1 }).run();
  db.insert(schema.runs)
    .values({ id: VERIFY_RUN, surfaceId: S, startedAt: 1, stationsRun: [], configSnapshot: {} })
    .run();
});

describe("criteria parsing", () => {
  it("parses both 'must read' and 'must remain'; prose lines stay outcome-leg", () => {
    const c = extractCriteria(SPEC_OK);
    expect(c.targets).toEqual([
      { checkKey: "crawl/hreflang@v1/https://x/en", requiredStatus: "present" },
      { checkKey: "crawl/canonical@v1/https://x/en", requiredStatus: "present" },
    ]);
    expect(c.unparsedTargets).toEqual([]);
    expect(c.proseLines).toHaveLength(1);
  });

  it("lists check-key-shaped lines it could not parse", () => {
    const c = extractCriteria(SPEC_UNPARSED);
    expect(c.targets).toEqual([]);
    expect(c.unparsedTargets).toHaveLength(1);
    expect(c.unparsedTargets[0]).toContain("must hold");
  });
});

describe("verifyExecution with the new phrasings", () => {
  it("a 'must remain' criterion verifies and transitions the shipped bet", () => {
    const bet = seedBet("bet:exec-ok", SPEC_OK);
    seedVerifyEvidence("crawl/hreflang@v1/https://x/en", "present");
    seedVerifyEvidence("crawl/canonical@v1/https://x/en", "present");
    const result = verifyExecution(bet, VERIFY_RUN);
    expect(result.pass).toBe(true);
    expect(result.applied).toBe(true);
    expect(result.parserNotes).toEqual([]);
    const after = db.select().from(schema.bets).where(eq(schema.bets.id, bet.id)).get()!;
    expect(after.state).toBe("exec-verified");
  });

  it("an unparsed check-key criterion fails loudly and blocks the transition", () => {
    const bet = seedBet("bet:exec-unparsed", SPEC_UNPARSED);
    seedVerifyEvidence("crawl/robots-bot-rules@v1/GPTBot", "pass"); // even a passing row cannot rescue it
    const result = verifyExecution(bet, VERIFY_RUN);
    expect(result.pass).toBe(false);
    expect(result.applied).toBe(false);
    expect(result.parserNotes).toHaveLength(1);
    expect(result.parserNotes[0]).toContain("unparsed verification criterion");
    const after = db.select().from(schema.bets).where(eq(schema.bets.id, bet.id)).get()!;
    expect(after.state).toBe("shipped");
  });
});
