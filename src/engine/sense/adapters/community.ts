// Community sense adapter: keyless demand/sentiment signals.
// Reddit via the public search JSON endpoint, Hacker News via the Algolia API.
// Polite: sequential fetches with 2s gaps, honest "fail" rows on any error
// (429 included); collect never throws for a network-level problem.

import { randomUUID } from "node:crypto";
import type { CommunityPlatformTarget, Surface, WebLocaleTarget } from "../../lib/surface";
import type { CollectResult, EvidenceRow } from "./crawl";
import { wordIndex, type BrandIdentity } from "../../lib/brand-identity";

const GAP_MS = 2_000;
const TIMEOUT_MS = 10_000;
const TOP_HITS_LIMIT = 5;
const USER_AGENT = "answerable/1.0 (research; polite; single-run)";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface TopHit {
  title: string;
  url: string;
  score: number;
  created: string;
}

// "brand-ambiguous" = the bare brand token (e.g. "example"), which also matches
// unrelated strings (ordinary prose, spam); tracked for the meta breakdown but
// excluded from community_mention_count.
export type QueryKind = "brand" | "brand-ambiguous" | "competitor" | "demand";

export interface DerivedQuery {
  query: string;
  kind: QueryKind;
}

export function slugify(q: string): string {
  // Quoted exact-phrase queries get a "phrase-" prefix so they never collide with the
  // unquoted form's slug (e.g. `"example com"` vs `example.com`).
  const prefix = q.startsWith('"') ? "phrase-" : "";
  return (
    prefix +
    q
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
  );
}

// Queries derived from surface config: brand name + domain + the brand's stored
// aliases + competitors' names + any demand clusters the lane config declares
// (lanes.community.demand_queries; customer-specifics live in config and the db,
// never in src).
//
// Alias queries are pushed AFTER the domain-derived ones and through the same
// dedupe, so a brand whose aliases are the domain forms (the seeded case) comes
// out with a query set identical to the domain-only derivation.
export function deriveQueries(surface: Surface, identity: BrandIdentity | null = null): DerivedQuery[] {
  const queries: DerivedQuery[] = [];
  const seen = new Set<string>();
  const push = (query: string, kind: QueryKind) => {
    const key = slugify(query);
    if (!key || seen.has(key)) return;
    seen.add(key);
    queries.push({ query, kind });
  };

  const domain = (surface.target as Partial<WebLocaleTarget>).domain;
  if (typeof domain === "string" && domain.length > 0) {
    const bare = domain.replace(/^www\./, "");
    push(bare, "brand"); // full domain, e.g. "example.com"
    push(`"${bare.replace(/\./g, " ")}"`, "brand"); // exact phrase, e.g. "example com"
    push(bare.split(".")[0], "brand-ambiguous"); // bare token, e.g. "example"
  }
  for (const alias of identity?.aliases ?? []) push(alias, "brand");
  for (const c of surface.competitors) push(c.name, "competitor");

  const laneConfig = surface.lanes.community;
  if (laneConfig !== null && typeof laneConfig === "object") {
    const demand = (laneConfig as Record<string, unknown>).demand_queries;
    if (Array.isArray(demand)) {
      for (const q of demand) if (typeof q === "string" && q.length > 0) push(q, "demand");
    }
  }
  return queries;
}

interface FetchOutcome {
  ok: boolean;
  status: number | null;
  json: unknown;
  error: string | null;
  fetchedAt: number;
}

async function politeJsonFetch(url: string): Promise<FetchOutcome> {
  await sleep(GAP_MS);
  const fetchedAt = Date.now();
  try {
    const res = await fetch(url, {
      headers: { "user-agent": USER_AGENT },
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, status: res.status, json: null, error: null, fetchedAt };
    return { ok: true, status: res.status, json: await res.json(), error: null, fetchedAt };
  } catch (e) {
    return { ok: false, status: null, json: null, error: e instanceof Error ? e.message : String(e), fetchedAt };
  }
}

function failValue(out: FetchOutcome): Record<string, unknown> {
  return out.error !== null
    ? { error: out.error }
    : { http_status: out.status, ...(out.status === 429 ? { reason: "rate-limited" } : {}) };
}

// ---- per-platform extraction ---------------------------------------------

function extractReddit(json: unknown): { hit_count: number; top_hits: TopHit[] } {
  const data = (json as { data?: { dist?: number; children?: unknown[] } })?.data;
  const children = Array.isArray(data?.children) ? data.children : [];
  const top_hits: TopHit[] = children.slice(0, TOP_HITS_LIMIT).map((c) => {
    const d = (c as { data?: Record<string, unknown> })?.data ?? {};
    return {
      title: typeof d.title === "string" ? d.title : "",
      url: typeof d.permalink === "string" ? `https://www.reddit.com${d.permalink}` : String(d.url ?? ""),
      score: typeof d.score === "number" ? d.score : 0,
      created: typeof d.created_utc === "number" ? new Date(d.created_utc * 1000).toISOString() : "",
    };
  });
  return { hit_count: typeof data?.dist === "number" ? data.dist : children.length, top_hits };
}

function extractHn(json: unknown): { hit_count: number; top_hits: TopHit[] } {
  const body = json as { nbHits?: number; hits?: unknown[] };
  const hits = Array.isArray(body?.hits) ? body.hits : [];
  const top_hits: TopHit[] = hits.slice(0, TOP_HITS_LIMIT).map((h) => {
    const d = h as Record<string, unknown>;
    return {
      title: typeof d.title === "string" ? d.title : String(d.story_title ?? ""),
      url:
        typeof d.url === "string" && d.url.length > 0
          ? d.url
          : `https://news.ycombinator.com/item?id=${String(d.objectID ?? "")}`,
      score: typeof d.points === "number" ? d.points : 0,
      created: typeof d.created_at === "string" ? d.created_at : "",
    };
  });
  return { hit_count: typeof body?.nbHits === "number" ? body.nbHits : hits.length, top_hits };
}

// ---- negative-term filtering ---------------------------------------------

// A brand query matches text the platform decided was relevant; the brand's
// negative terms say which of those are really about something else (a thread
// about a look-alike token is not a brand mention). The filter is applied to the hits
// this adapter actually INSPECTS — the returned items — and the count of what it
// dropped is recorded on the evidence row. The platform-reported hit_count is
// left as the platform reported it: it covers matches beyond the returned page,
// which this adapter never saw and therefore cannot honestly re-count.
//
// That asymmetry is why a row under an active filter carries `negative_filter: "active"`
// (see `screen` below, and the same flag on the X lane). The flag says the provider-wide
// hit_count is a CANDIDATE count for this query, not an owned-mention count: some unknown
// share of it is exactly what the filter just vetoed among the hits anyone read. The
// snapshot layer (src/engine/lib/run.ts) reads the flag and refuses to fold such a count
// into the owned-mention headline.
export function dropNegativeHits(
  hits: TopHit[],
  identity: BrandIdentity | null,
): { kept: TopHit[]; excluded: number } {
  if (!identity || identity.negativeTerms.length === 0) return { kept: hits, excluded: 0 };
  const kept = hits.filter((h) => !identity.negativeTerms.some((t) => wordIndex(h.title, t) >= 0));
  return { kept, excluded: hits.length - kept.length };
}

// Negative terms speak about the brand, so they apply to the brand queries only —
// never to competitor or demand queries, which are about other things by design.
export function isBrandQuery(kind: QueryKind): boolean {
  return kind === "brand" || kind === "brand-ambiguous";
}

// ---- collect -------------------------------------------------------------

export async function collect(
  surface: Surface,
  runId: string,
  identity: BrandIdentity | null = null,
): Promise<CollectResult> {
  const rows: EvidenceRow[] = [];
  const queries = deriveQueries(surface, identity);

  const row = (
    checkKey: string,
    status: string,
    value: Record<string, unknown>,
    url: string,
    fetchedAt: number,
  ): void => {
    rows.push({
      id: randomUUID(),
      runId,
      surfaceId: surface.id,
      checkKey,
      status,
      confidenceTag: "observed",
      value,
      provenance: { url, fetched_at: fetchedAt, method: "GET" },
      cost: 0,
    });
  };

  // Per-query negative filter: brand queries are screened against the brand's
  // negative terms, everything else passes through untouched. When the filter is ACTIVE
  // the row says so even if it excluded nothing this time — what makes the provider-wide
  // hit_count a candidate count is that a veto applies to this query at all, not that it
  // happened to fire within the handful of hits this adapter read.
  const filterActive = (identity?.negativeTerms.length ?? 0) > 0;
  const screen = (kind: QueryKind, top_hits: TopHit[]): Record<string, unknown> => {
    if (!isBrandQuery(kind) || !filterActive) return { top_hits };
    const { kept, excluded } = dropNegativeHits(top_hits, identity);
    return {
      top_hits: kept,
      negative_filter: "active",
      inspected: top_hits.length,
      excluded_by_negative_terms: excluded,
    };
  };

  // A `community` surface names ONE platform in its target, and this lane honours it:
  // a surface that says reddit collects reddit, and nothing else. A `site` surface has no
  // platform field at all (the loader refuses fields outside the kind's target shape), so
  // its community lane keeps sweeping both platforms, which is what it has always done.
  // Platform `x` is served by the X adapter, not this one; saying so on a row is better
  // than a lane that ran and quietly wrote nothing.
  const platform = (surface.target as Partial<CommunityPlatformTarget>).platform;
  const wantReddit = platform === undefined || platform === "reddit";
  const wantHn = platform === undefined || platform === "hacker-news";
  if (!wantReddit && !wantHn) {
    row(
      "community/lane-status@v1",
      "skip",
      { platform, reason: `platform "${platform}" is collected by the x lane, not the community lane` },
      "",
      Date.now(),
    );
    return { evidence: rows, panelObservations: [], cost: 0 };
  }

  for (const { query, kind } of queries) {
    const slug = slugify(query);

    // Reddit public search JSON
    const redditUrl = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=new&t=month`;
    const reddit = wantReddit ? await politeJsonFetch(redditUrl) : null;
    if (reddit === null) {
      // platform-scoped surface: not this platform, no row
    } else if (!reddit.ok) {
      row(`community/reddit-mentions@v1/${slug}`, "fail", { query, query_kind: kind, ...failValue(reddit) }, redditUrl, reddit.fetchedAt);
    } else {
      const { hit_count, top_hits } = extractReddit(reddit.json);
      row(`community/reddit-mentions@v1/${slug}`, "pass", { query, query_kind: kind, hit_count, ...screen(kind, top_hits) }, redditUrl, reddit.fetchedAt);
    }

    // Hacker News via Algolia. Entity queries (brand/competitor) go as quoted phrases:
    // Algolia's advancedSyntax honors them, and the unquoted form matched loose tokens
    // (a competitor whose name is a common word counted every story containing it). Demand queries stay unquoted, they
    // are topical, not entities.
    const hnQuery = kind === "demand" || query.startsWith('"') ? query : `"${query}"`;
    const hnUrl = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(hnQuery)}`;
    const hn = wantHn ? await politeJsonFetch(hnUrl) : null;
    if (hn === null) {
      // platform-scoped surface: not this platform, no row
    } else if (!hn.ok) {
      row(`community/hn-mentions@v1/${slug}`, "fail", { query, query_kind: kind, ...failValue(hn) }, hnUrl, hn.fetchedAt);
    } else {
      const { hit_count, top_hits } = extractHn(hn.json);
      row(`community/hn-mentions@v1/${slug}`, "pass", { query, query_kind: kind, hit_count, ...screen(kind, top_hits) }, hnUrl, hn.fetchedAt);
    }
  }

  return { evidence: rows, panelObservations: [], cost: 0 };
}
