// The negative-term veto has to reach the METRIC, not only the handful of hits the
// adapter printed.
//
// THE DEFECT: `dropNegativeHits` filters the five inspected titles, but the row also
// carries the provider's own count for the entire result set, and that provider-wide
// number fed community_mention_count untouched. A brand whose alias is "Acme" and whose
// negative term is "Acme Corp" could therefore report 100 owned community mentions while
// every hit anyone actually read had just been vetoed as somebody else. Same structure on
// the X lane.
//
// THE RULE UNDER TEST: when a negative filter is active for a query, the provider-wide
// count is a CANDIDATE count, never an owned-mention count. It is reported under a name
// that says so, and the headline metric is derived only from queries no veto applies to —
// and when every brand query is filtered there is no honest headline at all, so none is
// written. That is the same measured-vs-not-measurable vocabulary share_of_answer already
// uses for ungrounded rows: silence over a confident wrong number.

import "./helpers/testdb";
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db";
import { finishRun } from "../src/engine/lib/run";
import { collect as collectCommunity } from "../src/engine/sense/adapters/community";
import { identityFromRow } from "../src/engine/lib/brand-identity";
import { parseSurface } from "../src/engine/lib/surface";

const S = "mention-surface";

const surfaceYaml = `
id: ${S}
kind: site
target:
  domain: acme.com
  path_prefix: /
  locale: en
audience: Buyers comparing invoicing tools
business_goal: signups
desired_conversion: signup
competitors: []
publishing:
  policy: review-required
  owner: operator
lanes:
  community:
    enabled: true
    demand_queries: ["how to invoice a client"]
`;

beforeEach(() => {
  db.delete(schema.snapshots).run();
  db.delete(schema.evidence).run();
  db.delete(schema.runs).run();
  db.delete(schema.surfaces).run();
  db.insert(schema.surfaces)
    .values({
      id: S,
      kind: "site",
      configSnapshot: { target: { domain: "acme.com" } },
      onboardedAt: Date.now(),
    })
    .run();
});

function seedRun(): string {
  const runId = randomUUID();
  db.insert(schema.runs)
    .values({ id: runId, surfaceId: S, startedAt: Date.now(), stationsRun: [], configSnapshot: {} })
    .run();
  return runId;
}

function evidenceRow(runId: string, checkKey: string, value: Record<string, unknown>): void {
  db.insert(schema.evidence)
    .values({
      id: randomUUID(),
      runId,
      surfaceId: S,
      checkKey,
      status: "pass",
      confidenceTag: "observed",
      value,
      provenance: { url: "https://example", fetched_at: Date.now(), method: "GET" },
      cost: 0,
    })
    .run();
}

function snapshotsOf(runId: string): Record<string, { value: number; meta: Record<string, unknown> | null }> {
  const rows = db.select().from(schema.snapshots).where(eq(schema.snapshots.runId, runId)).all();
  return Object.fromEntries(rows.map((r) => [r.metric, { value: r.value, meta: r.meta }]));
}

describe("a provider-wide count under an active negative filter is never an owned-mention count", () => {
  it("omits the headline metric entirely when every brand query is filtered", () => {
    const runId = seedRun();
    // The defect in one row: 100 matches the provider found, a veto the operator wrote,
    // and every hit this engine actually read excluded by it.
    evidenceRow(runId, "community/reddit-mentions@v1/acme", {
      query: "acme",
      query_kind: "brand",
      hit_count: 100,
      negative_filter: "active",
      inspected: 5,
      excluded_by_negative_terms: 5,
      top_hits: [],
    });
    finishRun(runId, S, ["sense"]);
    const snaps = snapshotsOf(runId);

    // The number the defect reported as owned mentions is gone from the headline.
    expect(snaps.community_mention_count).toBeUndefined();
    // What IS known survives, under a name that says what it is.
    expect(snaps.community_mention_candidate_count.value).toBe(100);
    expect(snaps.community_mention_candidate_count.meta).toMatchObject({ queries: 1, measured_queries: 0 });
  });

  it("derives the headline from unfiltered queries only, and reports the rest as candidates", () => {
    const runId = seedRun();
    evidenceRow(runId, "community/reddit-mentions@v1/acme-com", {
      query: "acme.com",
      query_kind: "brand",
      hit_count: 7,
      top_hits: [],
    });
    evidenceRow(runId, "community/reddit-mentions@v1/acme", {
      query: "acme",
      query_kind: "brand",
      hit_count: 100,
      negative_filter: "active",
      inspected: 5,
      excluded_by_negative_terms: 5,
      top_hits: [],
    });
    finishRun(runId, S, ["sense"]);
    const snaps = snapshotsOf(runId);

    expect(snaps.community_mention_count.value).toBe(7); // 7, not 107
    expect(snaps.community_mention_count.meta).toMatchObject({
      negative_filter_queries: 1,
      candidate_mention_count: 100,
    });
    expect(snaps.community_mention_candidate_count.value).toBe(100);
  });

  it("keeps the filtered total out of the metadata breakdown too", () => {
    // The headline can refuse the number and the metadata still hand it back: a plain
    // `brand` key in by_query_kind reads as owned mentions to anything consuming the
    // snapshot, so the breakdown has to split exactly where the headline splits.
    const runId = seedRun();
    evidenceRow(runId, "community/reddit-mentions@v1/acme-com", {
      query: "acme.com",
      query_kind: "brand",
      hit_count: 7,
      top_hits: [],
    });
    evidenceRow(runId, "community/reddit-mentions@v1/acme", {
      query: "acme",
      query_kind: "brand",
      hit_count: 100,
      negative_filter: "active",
      inspected: 5,
      excluded_by_negative_terms: 5,
      top_hits: [],
    });
    finishRun(runId, S, ["sense"]);
    const meta = snapshotsOf(runId).community_mention_count.meta!;

    expect(meta.by_query_kind).toEqual({ brand: 7 }); // 7, not 107
    expect(meta.by_query_kind_candidate).toEqual({ brand: 100 });
  });

  it("is unchanged for a brand with no negative terms (no filter, no candidate row)", () => {
    const runId = seedRun();
    evidenceRow(runId, "community/reddit-mentions@v1/acme-com", {
      query: "acme.com",
      query_kind: "brand",
      hit_count: 7,
      top_hits: [],
    });
    evidenceRow(runId, "community/hn-mentions@v1/acme-com", {
      query: "acme.com",
      query_kind: "brand",
      hit_count: 3,
      top_hits: [],
    });
    // Non-brand kinds stay out of the headline exactly as before.
    evidenceRow(runId, "community/reddit-mentions@v1/invoicing", {
      query: "invoicing software",
      query_kind: "demand",
      hit_count: 900,
      top_hits: [],
    });
    finishRun(runId, S, ["sense"]);
    const snaps = snapshotsOf(runId);

    expect(snaps.community_mention_count.value).toBe(10);
    expect(snaps.community_mention_count.meta).toMatchObject({ by_query_kind: { brand: 10, demand: 900 } });
    expect(snaps.community_mention_count.meta).not.toHaveProperty("candidate_mention_count");
    expect(snaps.community_mention_candidate_count).toBeUndefined();
  });

  it("applies the same rule to the X lane", () => {
    const runId = seedRun();
    evidenceRow(runId, "x/recent-mentions@v1/acme", {
      query: "acme",
      query_kind: "brand",
      hit_count: 42,
      negative_filter: "active",
      inspected: 5,
      excluded_by_negative_terms: 4,
      top_hits: [],
    });
    finishRun(runId, S, ["sense"]);
    const snaps = snapshotsOf(runId);

    expect(snaps.x_mention_count).toBeUndefined();
    expect(snaps.x_mention_candidate_count.value).toBe(42);
    expect(snaps.x_mention_candidate_count.meta).toMatchObject({ queries: 1, measured_queries: 0 });
  });

  it("leaves the X headline intact when no negative terms are set", () => {
    const runId = seedRun();
    evidenceRow(runId, "x/recent-mentions@v1/acme-com", {
      query: "acme.com",
      query_kind: "brand",
      hit_count: 42,
      top_hits: [],
    });
    finishRun(runId, S, ["sense"]);
    const snaps = snapshotsOf(runId);

    expect(snaps.x_mention_count.value).toBe(42);
    expect(snaps.x_mention_candidate_count).toBeUndefined();
  });
});

describe("the collector marks the rows the metric layer reads", () => {
  const surface = parseSurface(surfaceYaml);
  const withNegatives = identityFromRow({
    id: "acme",
    name: "Acme",
    primaryDomain: "acme.com",
    aliases: ["acme.com", "acme com", "Acme"],
    negativeTerms: ["Acme Corp"],
  })!;

  it("flags brand rows as filtered when a veto applies, even when nothing was excluded", async () => {
    // One fetch stub for every polite request the adapter makes: a result set the
    // provider says is large, of which the inspected page is entirely clean.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: { dist: 100, children: [] }, nbHits: 100, hits: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    try {
      const { evidence } = await collectCommunity(surface, "run-x", withNegatives);
      const brandRows = evidence.filter(
        (r) => (r.value as Record<string, unknown>).query_kind === "brand",
      );
      expect(brandRows.length).toBeGreaterThan(0);
      for (const r of brandRows) {
        const v = r.value as Record<string, unknown>;
        // Zero excluded among the inspected hits, and the row still says the count is
        // candidate-only: what makes it candidate is that a veto APPLIES to the query,
        // not that it happened to fire in the five hits this adapter read.
        expect(v.excluded_by_negative_terms).toBe(0);
        expect(v.negative_filter).toBe("active");
      }
      // Non-brand queries are untouched: negative terms speak about the brand only.
      for (const r of evidence.filter((x) => (x.value as Record<string, unknown>).query_kind === "demand")) {
        expect(r.value).not.toHaveProperty("negative_filter");
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  }, 120_000);
});
