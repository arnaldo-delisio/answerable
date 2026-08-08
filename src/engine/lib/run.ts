// Run journal: createRun opens the runs row with the surface's config snapshot;
// finishRun closes it by writing the applicable snapshot metric rows from the fixed
// class-to-metric catalog: applicable rows only for the surface's kind, never
// null-charted.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "../../db";
import { promptSlug } from "../sense/adapters/geo-panel";
import { laneEnabled } from "../sense";

// checkId groups every run of one Check-now / tick / CLI cycle under one uuid —
// the Engine strip reads all of a cycle's runs as one scope, never a mix.
export function createRun(
  surfaceId: string,
  checkId?: string,
): { id: string; configSnapshot: Record<string, unknown> } {
  const surface = db.select().from(schema.surfaces).where(eq(schema.surfaces.id, surfaceId)).get();
  if (!surface) throw new Error(`surface "${surfaceId}" not onboarded (answerable onboard <file> first)`);
  const id = randomUUID();
  db.insert(schema.runs)
    .values({
      id,
      surfaceId,
      startedAt: Date.now(),
      stationsRun: [],
      configSnapshot: surface.configSnapshot,
      checkId: checkId ?? null,
    })
    .run();
  return { id, configSnapshot: surface.configSnapshot };
}

export interface RunSummary {
  snapshots: Record<string, number>;
  costTotal: number;
}

// Eligibility pass-rate = per-bot access x SSR x sitemap x schema checks (metric catalog).
const ELIGIBILITY_CHECKS = /^crawl\/(bot-access|ssr|sitemap|json-ld)@/;

export function finishRun(runId: string, surfaceId: string, stationsRun: string[]): RunSummary {
  const rows = db.select().from(schema.evidence).where(eq(schema.evidence.runId, runId)).all();
  const snapshots: Record<string, number> = {};
  // Snapshot rows to write; metrics needing meta (engine lane) are collected here.
  const snapshotRows: { metric: string; value: number; meta: Record<string, unknown> | null }[] = [];
  const snapshotMeta: Record<string, Record<string, unknown>> = {};

  // eligibility_pass_rate: fraction of eligibility-class checks passing ("present" counts
  // for json-ld; spot checks belong to the sitemap family and count as pass/broken).
  const eligibility = rows.filter((r) => ELIGIBILITY_CHECKS.test(r.checkKey));
  if (eligibility.length > 0) {
    const passing = eligibility.filter((r) => r.status === "pass" || r.status === "present").length;
    snapshots.eligibility_pass_rate = passing / eligibility.length;
  }

  // sitemap_url_count: from the sitemap existence check's extracted fields.
  const sitemap = rows.find((r) => r.checkKey.startsWith("crawl/sitemap@"));
  if (sitemap) {
    const count = (sitemap.value as Record<string, unknown> | null)?.url_count;
    snapshots.sitemap_url_count = typeof count === "number" ? count : 0;
  }

  // hreflang_coverage: fraction of sampled pages carrying hreflang link tags.
  const hreflang = rows.filter((r) => r.checkKey.startsWith("crawl/hreflang@"));
  if (hreflang.length > 0) {
    snapshots.hreflang_coverage = hreflang.filter((r) => r.status === "present").length / hreflang.length;
  }

  // MEASURED VS CANDIDATE, for both mention lanes.
  //
  // A brand-query row carries the provider's own hit count for the whole result set, but
  // the adapters only ever INSPECT the first handful of hits — that is the set a brand's
  // negative terms are applied to. When a negative filter is active for a query, the
  // provider-wide count therefore includes an unknown number of hits the operator has
  // explicitly said are not them: an alias "Acme" with the negative term "Acme Corp" would
  // otherwise report every Acme Corp thread as an owned community mention, and would do so
  // while every hit anyone actually read had just been vetoed. That is a number asserted
  // with more confidence than the evidence supports, so it is not reported as one.
  //
  // The split follows the same vocabulary the rest of this file already uses for
  // measured-vs-not-measurable (share_of_answer's grounded rows, the pass-rows-only
  // guards on the keyed lanes): an unmeasurable quantity gets NO headline row rather than
  // a confident number, and what IS known lands under a name that says what it is.
  //   - `<lane>_mention_count`   — owned mentions, from unfiltered queries only.
  //   - `<lane>_mention_candidate_count` — provider-wide totals for filtered queries: an
  //     upper bound on mentions, containing an unknown share of vetoed look-alikes.
  // With every brand query filtered there is no honest headline, so none is written and
  // only the candidate row exists.
  const splitMentions = (
    mentionRows: typeof rows,
  ): { measured: number; measuredQueries: number; candidate: number; candidateQueries: number } => {
    let measured = 0;
    let measuredQueries = 0;
    let candidate = 0;
    let candidateQueries = 0;
    for (const r of mentionRows) {
      const v = r.value as Record<string, unknown> | null;
      const hits = typeof v?.hit_count === "number" ? v.hit_count : 0;
      if (v?.negative_filter === "active") {
        candidate += hits;
        candidateQueries++;
      } else {
        measured += hits;
        measuredQueries++;
      }
    }
    return { measured, measuredQueries, candidate, candidateQueries };
  };

  // community_mention_count: sum of exact brand-query hit counts (Reddit + HN); demand,
  // competitor, and brand-ambiguous (bare-token) hits stay out of the headline number,
  // meta breaks them out.
  const community = rows.filter(
    (r) => /^community\/(reddit-mentions|hn-mentions)@/.test(r.checkKey) && r.status === "pass",
  );
  if (community.length > 0) {
    // The breakdown splits the same way the headline does. A filtered query's provider
    // total must never appear under a plain `brand` key: that key reads as owned mentions
    // to anything consuming the metadata, which would reintroduce the exact number the
    // headline just refused to assert, one level down.
    const byKind: Record<string, number> = {};
    const byKindCandidate: Record<string, number> = {};
    for (const r of community) {
      const v = r.value as Record<string, unknown> | null;
      const kind = typeof v?.query_kind === "string" ? v.query_kind : "unknown";
      const hits = typeof v?.hit_count === "number" ? v.hit_count : 0;
      const target = v?.negative_filter === "active" ? byKindCandidate : byKind;
      target[kind] = (target[kind] ?? 0) + hits;
    }
    const brandRows = community.filter(
      (r) => (r.value as Record<string, unknown> | null)?.query_kind === "brand",
    );
    const split = splitMentions(brandRows);
    if (split.candidateQueries === 0 || split.measuredQueries > 0) {
      snapshots.community_mention_count = split.measured;
      snapshotMeta.community_mention_count = {
        by_query_kind: byKind,
        ...(split.candidateQueries > 0
          ? {
              negative_filter_queries: split.candidateQueries,
              candidate_mention_count: split.candidate,
              by_query_kind_candidate: byKindCandidate,
              note: "excludes queries under an active negative-term filter; their provider-wide totals are reported as community_mention_candidate_count",
            }
          : {}),
      };
    }
    if (split.candidateQueries > 0) {
      snapshots.community_mention_candidate_count = split.candidate;
      snapshotMeta.community_mention_candidate_count = {
        queries: split.candidateQueries,
        measured_queries: split.measuredQueries,
        by_query_kind: byKindCandidate,
        note: "provider-wide totals for brand queries under an active negative-term filter: an upper bound on owned mentions, not owned mentions",
      };
    }
  }

  // x_mention_count: only when the X lane ran live (pass rows), never from key-pending.
  // Same measured-vs-candidate split as the community lane above.
  const xRows = rows.filter((r) => r.checkKey.startsWith("x/recent-mentions@") && r.status === "pass");
  if (xRows.length > 0) {
    const split = splitMentions(xRows);
    if (split.candidateQueries === 0 || split.measuredQueries > 0) {
      snapshots.x_mention_count = split.measured;
      if (split.candidateQueries > 0) {
        snapshotMeta.x_mention_count = {
          negative_filter_queries: split.candidateQueries,
          candidate_mention_count: split.candidate,
          note: "excludes queries under an active negative-term filter; their provider-wide totals are reported as x_mention_candidate_count",
        };
      }
    }
    if (split.candidateQueries > 0) {
      snapshots.x_mention_candidate_count = split.candidate;
      snapshotMeta.x_mention_candidate_count = {
        queries: split.candidateQueries,
        measured_queries: split.measuredQueries,
        note: "provider-wide totals for brand queries under an active negative-term filter: an upper bound on owned mentions, not owned mentions",
      };
    }
  }

  // performance_score: mean PSI performance score over sampled pages/strategies,
  // only when the performance lane ran live (pass rows), never from key-pending.
  const perf = rows.filter((r) => /^performance\/cwv-/.test(r.checkKey) && r.status === "pass");
  const perfScores = perf
    .map((r) => (r.value as Record<string, unknown> | null)?.performance_score)
    .filter((s): s is number => typeof s === "number");
  if (perfScores.length > 0) {
    snapshots.performance_score = perfScores.reduce((a, b) => a + b, 0) / perfScores.length;
    snapshotMeta.performance_score = { sample_size: perfScores.length };
  }

  // gsc_clicks / gsc_impressions: window totals from the GSC search-analytics lane.
  const gscTotals = rows.find(
    (r) => r.checkKey.startsWith("gsc/search-analytics-totals@") && r.status === "pass",
  );
  if (gscTotals) {
    const v = gscTotals.value as Record<string, unknown> | null;
    snapshots.gsc_clicks = typeof v?.clicks === "number" ? v.clicks : 0;
    snapshots.gsc_impressions = typeof v?.impressions === "number" ? v.impressions : 0;
  }

  // indexation_coverage: indexed fraction over the URL-inspection sample.
  const inspections = rows.filter(
    (r) => r.checkKey.startsWith("gsc/url-inspection@") && r.status === "pass",
  );
  if (inspections.length > 0) {
    const indexed = inspections.filter(
      (r) => (r.value as Record<string, unknown> | null)?.indexed === true,
    ).length;
    snapshots.indexation_coverage = indexed / inspections.length;
    snapshotMeta.indexation_coverage = { sample_size: inspections.length };
  }

  // conversion_events: GA4 key events on tracked routes over the report window.
  const ga4 = rows.find((r) => r.checkKey.startsWith("analytics/ga4-report@") && r.status === "pass");
  if (ga4) {
    const v = ga4.value as Record<string, unknown> | null;
    snapshots.conversion_events = typeof v?.key_events_total === "number" ? v.key_events_total : 0;
    snapshotMeta.conversion_events = {
      sessions_total: typeof v?.sessions_total === "number" ? v.sessions_total : 0,
    };
  }

  // referring_domains: from the DataForSEO backlinks summary (metric catalog line).
  const backlinks = rows.find(
    (r) => r.checkKey.startsWith("dataforseo/backlinks-summary@") && r.status === "pass",
  );
  if (backlinks) {
    const v = backlinks.value as Record<string, unknown> | null;
    if (typeof v?.referring_domains === "number") snapshots.referring_domains = v.referring_domains;
  }

  // share_of_answer: owned hits over the prompts that could actually be JUDGED.
  // "Judged" means both OBSERVED (we collected an answer) and GROUNDED (the lane had
  // a brand identity to search for): judged = expected - failed - ungrounded, which is
  // the same thing as counting the grounded rows directly. A failed prompt and an
  // ungrounded answer are different facts — collection failure vs identity that
  // couldn't be grounded — but neither is evidence of a miss, so neither belongs in
  // the denominator: counting a failed prompt as a miss asserts "not cited" about an
  // answer we never saw, the same fabricated-negative error class as counting
  // ungrounded rows. Both stay in meta as coverage, never as share arithmetic.
  // Meta records {expected, observed, judged, failed_prompt_ids, ungrounded} as
  // coverage metadata; when every prompt failed the metric still writes (observed 0,
  // all_prompts_failed flag) so the collection gap is a real row, never silence.
  const panelRows = db
    .select()
    .from(schema.panelObservations)
    .where(eq(schema.panelObservations.runId, runId))
    .all();
  const run = db.select().from(schema.runs).where(eq(schema.runs.id, runId)).get();
  const runConfig = run?.configSnapshot as
    | {
        target?: { engine?: string; prompt_set?: { prompts?: unknown[] } };
        lanes?: Record<string, unknown>;
      }
    | undefined;
  const promptSet = runConfig?.target?.prompt_set?.prompts;
  const geoPanelLane = runConfig?.lanes?.["geo-panel"];
  const geoPanelEnabled = laneEnabled(geoPanelLane);
  if (
    Array.isArray(promptSet) &&
    promptSet.length > 0 &&
    geoPanelEnabled &&
    typeof runConfig?.target?.engine === "string"
  ) {
    const engine = runConfig.target.engine;
    const expectedIds = promptSet.map((p) => promptSlug(String(p)));
    const engineRows = panelRows.filter((p) => p.engine === engine);
    const observedIds = new Set(engineRows.map((p) => p.promptId));
    const failedPromptIds = expectedIds.filter((id) => !observedIds.has(id));
    // owned_hit null = ungrounded: the lane had no brand identity, so no answer was
    // ever searched for the operator. Those rows can neither be hits nor misses.
    // When NONE of the landed rows is grounded, share of answer is UNMEASURED and no
    // snapshot is written: a 0 here would be the engine asserting "you were never
    // mentioned" about answers it never read for a name. A missing share reads as
    // an explicit "not checked" state (pct null), which is the
    // truth. A partially grounded run still writes, over the judged denominator
    // (rows both observed and grounded), with failed and ungrounded counts kept in
    // meta as coverage, never folded into the share arithmetic.
    const groundedRows = engineRows.filter((p) => p.ownedHit !== null);
    if (groundedRows.length > 0 || engineRows.length === 0) {
      const hits = engineRows.filter((p) => p.ownedHit === true).length;
      const ungrounded = engineRows.length - groundedRows.length;
      const judged = groundedRows.length;
      const value = judged > 0 ? hits / judged : 0;
      snapshots[`share_of_answer:${engine}`] = value;
      const meta: Record<string, unknown> = {
        engine,
        expected: expectedIds.length,
        observed: engineRows.length,
        judged,
        failed_prompt_ids: failedPromptIds,
      };
      if (engineRows.length === 0) meta.all_prompts_failed = true;
      if (ungrounded > 0) meta.ungrounded = ungrounded;
      snapshotRows.push({ metric: "share_of_answer", value, meta });
    }
  } else {
    // No prompt-set membership in the run snapshot (non-panel surface): aggregate over
    // landed rows, the only denominator that exists here.
    const byEngine = new Map<string, { hits: number; total: number }>();
    for (const p of panelRows) {
      // Ungrounded rows join neither side of the ratio: an engine whose rows are all
      // ungrounded gets no metric at all rather than a fabricated 0.
      if (p.ownedHit === null) continue;
      const agg = byEngine.get(p.engine) ?? { hits: 0, total: 0 };
      agg.total += 1;
      if (p.ownedHit === true) agg.hits += 1;
      byEngine.set(p.engine, agg);
    }
    for (const [engine, agg] of byEngine) {
      const value = agg.hits / agg.total;
      snapshots[`share_of_answer:${engine}`] = value;
      snapshotRows.push({ metric: "share_of_answer", value, meta: { engine, sample_size: agg.total } });
    }
  }

  // lane_cost_total: always applicable (spend-per-insight feed).
  const costTotal = rows.reduce((sum, r) => sum + (r.cost ?? 0), 0);
  snapshots.lane_cost_total = costTotal;

  // Idempotent close: replace this run's snapshot rows, then stamp the runs row.
  db.delete(schema.snapshots).where(eq(schema.snapshots.runId, runId)).run();
  db.insert(schema.snapshots)
    .values([
      // Per-engine metrics live in snapshotRows (metric + meta); the summary's
      // "share_of_answer:<engine>" keys are report-only, not stored metric names.
      ...Object.entries(snapshots)
        .filter(([metric]) => !metric.startsWith("share_of_answer:"))
        .map(([metric, value]) => ({
          id: randomUUID(),
          runId,
          surfaceId,
          metric,
          value,
          meta: snapshotMeta[metric] ?? null,
        })),
      ...snapshotRows.map((s) => ({
        id: randomUUID(),
        runId,
        surfaceId,
        metric: s.metric,
        value: s.value,
        meta: s.meta,
      })),
    ])
    .run();
  db.update(schema.runs)
    .set({ stationsRun, costTotal, finishedAt: Date.now() })
    .where(eq(schema.runs.id, runId))
    .run();

  return { snapshots, costTotal };
}
