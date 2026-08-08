// X sense adapter: X API v2 recent search for brand mentions.
// Credential ladder: X_BEARER_TOKEN env -> xurl CLI on PATH -> one honest
// "key-pending" lane-status row. Never throws for a network or auth problem.

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { CommunityPlatformTarget, Surface } from "../../lib/surface";
import type { CollectResult, EvidenceRow } from "./crawl";
import { deriveQueries, dropNegativeHits, slugify, type TopHit } from "./community";
import type { BrandIdentity } from "../../lib/brand-identity";

const GAP_MS = 2_000;
const TIMEOUT_MS = 15_000;
const TOP_HITS_LIMIT = 5;
const ENV_VAR = "X_BEARER_TOKEN";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface XOutcome {
  ok: boolean;
  status: number | null;
  json: unknown;
  error: string | null;
  fetchedAt: number;
  method: string;
}

function searchPath(query: string): string {
  return `/2/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=10&tweet.fields=created_at,public_metrics`;
}

async function viaBearer(query: string, token: string): Promise<XOutcome> {
  await sleep(GAP_MS);
  const fetchedAt = Date.now();
  const url = `https://api.x.com${searchPath(query)}`;
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, status: res.status, json: null, error: null, fetchedAt, method: "GET (bearer)" };
    return { ok: true, status: res.status, json: await res.json(), error: null, fetchedAt, method: "GET (bearer)" };
  } catch (e) {
    return { ok: false, status: null, json: null, error: e instanceof Error ? e.message : String(e), fetchedAt, method: "GET (bearer)" };
  }
}

function xurlOnPath(): boolean {
  const which = spawnSync("which", ["xurl"], { encoding: "utf8" });
  return which.status === 0;
}

async function viaXurl(query: string): Promise<XOutcome> {
  await sleep(GAP_MS);
  const fetchedAt = Date.now();
  const res = spawnSync("xurl", [searchPath(query)], { encoding: "utf8", timeout: TIMEOUT_MS });
  if (res.error) return { ok: false, status: null, json: null, error: res.error.message, fetchedAt, method: "xurl" };
  if (res.status !== 0) {
    return { ok: false, status: null, json: null, error: (res.stderr || res.stdout || "xurl exited non-zero").trim().slice(0, 500), fetchedAt, method: "xurl" };
  }
  try {
    return { ok: true, status: 200, json: JSON.parse(res.stdout), error: null, fetchedAt, method: "xurl" };
  } catch {
    return { ok: false, status: null, json: null, error: "xurl output was not JSON", fetchedAt, method: "xurl" };
  }
}

function extractTweets(json: unknown): { hit_count: number; top_hits: TopHit[] } {
  const body = json as { data?: unknown[]; meta?: { result_count?: number } };
  const tweets = Array.isArray(body?.data) ? body.data : [];
  const top_hits: TopHit[] = tweets.slice(0, TOP_HITS_LIMIT).map((t) => {
    const d = t as Record<string, unknown>;
    const metrics = (d.public_metrics ?? {}) as Record<string, unknown>;
    return {
      title: typeof d.text === "string" ? d.text.slice(0, 200) : "",
      url: `https://x.com/i/status/${String(d.id ?? "")}`,
      score: typeof metrics.like_count === "number" ? metrics.like_count : 0,
      created: typeof d.created_at === "string" ? d.created_at : "",
    };
  });
  return { hit_count: typeof body?.meta?.result_count === "number" ? body.meta.result_count : tweets.length, top_hits };
}

export async function collect(
  surface: Surface,
  runId: string,
  identity: BrandIdentity | null = null,
): Promise<CollectResult> {
  const rows: EvidenceRow[] = [];
  const row = (
    checkKey: string,
    status: string,
    value: Record<string, unknown>,
    provenance: Record<string, unknown>,
  ): void => {
    rows.push({
      id: randomUUID(),
      runId,
      surfaceId: surface.id,
      checkKey,
      status,
      confidenceTag: "observed",
      value,
      provenance,
      cost: 0,
    });
  };

  // Same one-surface/one-place contract the community lane honours: a `community` surface
  // names ONE platform in its target, so the X lane collects only where that platform is
  // `x`. A `site` surface has no platform field at all (the loader refuses fields outside
  // the kind's target shape), so its X lane is untouched.
  const platform = (surface.target as Partial<CommunityPlatformTarget>).platform;
  if (platform !== undefined && platform !== "x") {
    row(
      `x/lane-status@v1/platform`,
      "skip",
      { platform, reason: `this surface tracks "${platform}"; the x lane collects only a surface whose platform is x` },
      { url: null, fetched_at: Date.now(), method: "none" },
    );
    return { evidence: rows, panelObservations: [], cost: 0 };
  }

  const token = process.env[ENV_VAR];
  const haveXurl = !token && xurlOnPath();
  if (!token && !haveXurl) {
    // Honest lane status: no credential lane available on this box.
    row(
      `x/lane-status@v1/credentials`,
      "key-pending",
      { env_var: ENV_VAR, alternative: "xurl CLI on PATH", reason: "no X API credential available" },
      { url: null, fetched_at: Date.now(), method: "none" },
    );
    return { evidence: rows, panelObservations: [], cost: 0 };
  }

  // Brand queries only: X recent search is about mentions of the property.
  const brandQueries = deriveQueries(surface, identity).filter((q) => q.kind === "brand");
  const filterActive = (identity?.negativeTerms.length ?? 0) > 0;
  for (const { query } of brandQueries) {
    const slug = slugify(query);
    const out = token ? await viaBearer(query, token) : await viaXurl(query);
    const prov = { url: `https://api.x.com${searchPath(query)}`, fetched_at: out.fetchedAt, method: out.method };
    if (!out.ok) {
      const value =
        out.error !== null
          ? { query, error: out.error }
          : { query, http_status: out.status, ...(out.status === 429 ? { reason: "rate-limited" } : {}) };
      row(`x/recent-mentions@v1/${slug}`, "fail", value, prov);
    } else {
      const { hit_count, top_hits } = extractTweets(out.json);
      // Same negative-term treatment as the community adapter (dropNegativeHits):
      // every query here is a brand query, the filter reads the post text, and
      // the platform-reported hit_count is left as reported — flagged
      // `negative_filter: "active"` when a veto applies, so the snapshot layer treats
      // that unfiltered provider total as a candidate count rather than owned mentions.
      const { kept, excluded } = dropNegativeHits(top_hits, identity);
      row(
        `x/recent-mentions@v1/${slug}`,
        "pass",
        {
          query,
          query_kind: "brand",
          hit_count,
          top_hits: kept,
          ...(filterActive
            ? { negative_filter: "active", inspected: top_hits.length, excluded_by_negative_terms: excluded }
            : {}),
        },
        prov,
      );
    }
  }

  return { evidence: rows, panelObservations: [], cost: 0 };
}
