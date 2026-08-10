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

// The two endpoints this lane reads, built in one place: `brand add`'s mention probe
// (probeMentions below) asks the same questions of the same URLs the lane will ask once
// the surface is onboarded, so a proposal is never evidence of something collect cannot
// see. Reddit's window is the lane's own (`t=month`): what matters for proposing a
// surface is whether the brand is discussed NOW, not whether it ever was.
function redditSearchUrl(query: string): string {
  return `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=new&t=month`;
}
function hnSearchUrl(query: string): string {
  return `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}`;
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

// A 200 is not an answer. A proxy, a status page, an error payload, or a changed API all
// arrive as a successful response carrying a body that is not a search listing, and
// permissive extraction turns every one of them into `hit_count: 0` — a metric nobody
// measured, recorded as a real zero. Both callers below depend on telling those apart, so
// extraction VALIDATES the shape each platform promises and returns null when the body is
// not one: the probe reports "could not check" and the lane writes a fail row, exactly as
// each already does for a response that never arrived.
//
// The validation is deliberately about the RESPONSE ENVELOPE (the results array and the
// platform's own total), never about the individual results: a well-formed listing with an
// empty array and a zero total is a genuine checked zero and must stay one — that
// distinction is the whole point. Field-level permissiveness inside a hit is unchanged;
// a hit missing a title is still a hit.
//
// WHAT IS OBSERVED AND WHAT IS INFERRED, since a later reader will need to know which:
// the Hacker News envelope is observed (Algolia answers this box directly, and the live
// probe against htmx.org returned nbHits 1106 beside a full hits array). Reddit's is NOT
// observed here — its search JSON returns 403 to this box with and without a User-Agent —
// so the reddit rules are reasoned from the documented listing shape. That asymmetry is
// deliberately resolved toward strictness: a false "could not check" costs one proposal
// and says so out loud, where a false zero costs the truth and is silent about it.
type Extraction = { hit_count: number; top_hits: TopHit[] } | null;

// A total of zero beside a page that has results in it is a self-contradicting envelope:
// neither platform can produce it, so whatever produced it was not the platform answering
// the question. It is refused rather than believed, because believing the count would
// store an unmeasured zero and believing the array would invent a count nobody reported.
// This is the ONLY cross-field rule: the count is deliberately never required to match the
// array's length, since HN's nbHits totals every page and Reddit hands back one page — a
// large count beside a short page is the normal, correct shape and must keep working.
function contradictsItself(hit_count: number, results: unknown[]): boolean {
  return hit_count === 0 && results.length > 0;
}

export const MALFORMED_REASON: Record<ProbePlatform, string> = {
  "reddit": "responded 200 with a body that is not a reddit search listing",
  "hacker-news": "responded 200 with a body that is not an algolia result set",
};

function extractReddit(json: unknown): Extraction {
  const data = (json as { data?: unknown } | null)?.data as { dist?: unknown; children?: unknown } | undefined;
  if (data === null || typeof data !== "object") return null;
  const children = data.children;
  // `dist` is the listing's own count of what it matched. Without it the only count
  // available is the length of the page we were handed, which is a count of what we
  // received rather than of what exists — and reporting that as the brand's mention
  // total is the false zero this guard exists to refuse.
  if (!Array.isArray(children) || typeof data.dist !== "number") return null;
  if (contradictsItself(data.dist, children)) return null;
  const top_hits: TopHit[] = children.slice(0, TOP_HITS_LIMIT).map((c) => {
    const d = (c as { data?: Record<string, unknown> })?.data ?? {};
    return {
      title: typeof d.title === "string" ? d.title : "",
      url: typeof d.permalink === "string" ? `https://www.reddit.com${d.permalink}` : String(d.url ?? ""),
      score: typeof d.score === "number" ? d.score : 0,
      created: typeof d.created_utc === "number" ? new Date(d.created_utc * 1000).toISOString() : "",
    };
  });
  return { hit_count: data.dist, top_hits };
}

function extractHn(json: unknown): Extraction {
  const body = json as { nbHits?: unknown; hits?: unknown } | null;
  if (body === null || typeof body !== "object") return null;
  const hits = body.hits;
  if (!Array.isArray(hits) || typeof body.nbHits !== "number") return null;
  if (contradictsItself(body.nbHits, hits)) return null;
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
  return { hit_count: body.nbHits, top_hits };
}

// ---- keyless mention probe -----------------------------------------------

// The evidence gate behind `brand add`'s community proposals. A Reddit surface for every
// brand would be coverage theatre, so a community surface is proposed only where this
// probe found the brand actually being discussed — one query per platform, the same
// endpoints and the same extraction the lane above uses, so nothing is ever proposed on
// evidence the lane itself could not see.
//
// `checked` is the honest half: a platform that did not answer reports "could not check",
// which is a different fact from "checked, none found", and neither one is a proposal.
// politeJsonFetch never throws (network error, timeout, and 429 all come back as an
// outcome), so a platform being down degrades this probe rather than failing the command.
export type ProbePlatform = "reddit" | "hacker-news";

export interface MentionProbe {
  platform: ProbePlatform;
  query: string;
  hitCount: number;
  checked: boolean;
  reason: string | null; // why it could not be checked, when it could not
}

export async function probeMentions(platform: ProbePlatform, query: string): Promise<MentionProbe> {
  const out = await politeJsonFetch(platform === "reddit" ? redditSearchUrl(query) : hnSearchUrl(`"${query}"`));
  if (!out.ok) {
    return {
      platform,
      query,
      hitCount: 0,
      checked: false,
      reason: out.error ?? `http ${out.status}${out.status === 429 ? " (rate-limited)" : ""}`,
    };
  }
  // A 200 carrying something other than a search listing is a platform that did not
  // answer the question, not a platform that answered "nobody mentions them".
  const extracted = platform === "reddit" ? extractReddit(out.json) : extractHn(out.json);
  if (extracted === null) {
    return { platform, query, hitCount: 0, checked: false, reason: MALFORMED_REASON[platform] };
  }
  return { platform, query, hitCount: extracted.hit_count, checked: true, reason: null };
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
    const redditUrl = redditSearchUrl(query);
    const reddit = wantReddit ? await politeJsonFetch(redditUrl) : null;
    if (reddit === null) {
      // platform-scoped surface: not this platform, no row
    } else if (!reddit.ok) {
      row(`community/reddit-mentions@v1/${slug}`, "fail", { query, query_kind: kind, ...failValue(reddit) }, redditUrl, reddit.fetchedAt);
    } else {
      // A 200 whose body is not a listing is a fail row, never a zero: a count nobody
      // measured must not be stored as a measurement (see extractReddit).
      const extracted = extractReddit(reddit.json);
      if (extracted === null) {
        row(`community/reddit-mentions@v1/${slug}`, "fail", { query, query_kind: kind, error: MALFORMED_REASON["reddit"] }, redditUrl, reddit.fetchedAt);
      } else {
        row(`community/reddit-mentions@v1/${slug}`, "pass", { query, query_kind: kind, hit_count: extracted.hit_count, ...screen(kind, extracted.top_hits) }, redditUrl, reddit.fetchedAt);
      }
    }

    // Hacker News via Algolia. Entity queries (brand/competitor) go as quoted phrases:
    // Algolia's advancedSyntax honors them, and the unquoted form matched loose tokens
    // (a competitor whose name is a common word counted every story containing it). Demand queries stay unquoted, they
    // are topical, not entities.
    const hnQuery = kind === "demand" || query.startsWith('"') ? query : `"${query}"`;
    const hnUrl = hnSearchUrl(hnQuery);
    const hn = wantHn ? await politeJsonFetch(hnUrl) : null;
    if (hn === null) {
      // platform-scoped surface: not this platform, no row
    } else if (!hn.ok) {
      row(`community/hn-mentions@v1/${slug}`, "fail", { query, query_kind: kind, ...failValue(hn) }, hnUrl, hn.fetchedAt);
    } else {
      const extracted = extractHn(hn.json);
      if (extracted === null) {
        row(`community/hn-mentions@v1/${slug}`, "fail", { query, query_kind: kind, error: MALFORMED_REASON["hacker-news"] }, hnUrl, hn.fetchedAt);
      } else {
        row(`community/hn-mentions@v1/${slug}`, "pass", { query, query_kind: kind, hit_count: extracted.hit_count, ...screen(kind, extracted.top_hits) }, hnUrl, hn.fetchedAt);
      }
    }
  }

  return { evidence: rows, panelObservations: [], cost: 0 };
}
