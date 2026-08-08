// Bing sense adapter: full Bing Webmaster API client (url submission quota + rank
// and traffic stats). Credential-
// gated: without BING_WEBMASTER_KEY it writes exactly one honest key-pending row;
// with it, real calls. Free after site verification, and worth doing everywhere
// because ChatGPT's retrieval draws from Bing's index.
// Fixture-tested; live-API pending credentials. Failures write honest "fail" rows;
// nothing here ever throws for a network or auth problem.

import { randomUUID } from "node:crypto";
import type { Surface, WebLocaleTarget } from "../../lib/surface";
import type { CollectResult, EvidenceRow } from "./crawl";
import type { FetchLike } from "./google-auth";

const ENV_VAR = "BING_WEBMASTER_KEY";
const API_BASE = "https://ssl.bing.com/webmaster/api.svc/json";
const TIMEOUT_MS = 30_000;
const TRAFFIC_WINDOW_DAYS = 28;

async function get(
  fetchImpl: FetchLike,
  url: string,
): Promise<{ ok: boolean; status: number | null; json: unknown; error: string | null }> {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { ok: false, status: res.status, json: null, error: null };
    return { ok: true, status: res.status, json: await res.json(), error: null };
  } catch (e) {
    return { ok: false, status: null, json: null, error: e instanceof Error ? e.message : String(e) };
  }
}

// Parse Bing's "/Date(1690000000000)/" wire format; epoch ms or null.
function bingDate(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = v.match(/\/Date\((\d+)/);
  return m ? Number(m[1]) : null;
}

export async function collect(
  surface: Surface,
  runId: string,
  deps: { fetch?: FetchLike } = {},
): Promise<CollectResult> {
  const fetchImpl = deps.fetch ?? fetch;
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

  const key = process.env[ENV_VAR];
  if (!key) {
    row(
      `bing/lane-status@v1/credentials`,
      "key-pending",
      {
        env_vars: [ENV_VAR],
        unlock: "verify the site in Bing Webmaster Tools, then generate an API key",
        price: "free after verification; ChatGPT retrieval draws from Bing's index",
        reason: `${ENV_VAR} not set / site not verified`,
      },
      { url: null, fetched_at: Date.now(), method: "none" },
    );
    return { evidence: rows, panelObservations: [], cost: 0 };
  }

  const t = surface.target as WebLocaleTarget;
  const siteUrl = `https://${t.domain}/`;
  const domain = t.domain.replace(/^www\./, "");
  // Provenance never carries the key.
  const call = (method: string) =>
    `${API_BASE}/${method}?siteUrl=${encodeURIComponent(siteUrl)}&apikey=${encodeURIComponent(key)}`;
  const provUrl = (method: string) => `${API_BASE}/${method}?siteUrl=${encodeURIComponent(siteUrl)}`;

  // URL submission quota.
  const quota = await get(fetchImpl, call("GetUrlSubmissionQuota"));
  const quotaProv = { url: provUrl("GetUrlSubmissionQuota"), fetched_at: Date.now(), method: "GET" };
  if (!quota.ok) {
    row(
      `bing/url-submission-quota@v1/${domain}`,
      "fail",
      quota.error !== null ? { site_url: siteUrl, error: quota.error } : { site_url: siteUrl, http_status: quota.status },
      quotaProv,
    );
  } else {
    const d = (quota.json as { d?: { DailyQuota?: number; MonthlyQuota?: number } }).d ?? {};
    row(
      `bing/url-submission-quota@v1/${domain}`,
      "pass",
      { site_url: siteUrl, daily_quota: d.DailyQuota ?? null, monthly_quota: d.MonthlyQuota ?? null },
      quotaProv,
    );
  }

  // Rank and traffic stats (Bing's index-side impressions/clicks series).
  const stats = await get(fetchImpl, call("GetRankAndTrafficStats"));
  const statsProv = { url: provUrl("GetRankAndTrafficStats"), fetched_at: Date.now(), method: "GET" };
  if (!stats.ok) {
    row(
      `bing/rank-traffic@v1/${domain}`,
      "fail",
      stats.error !== null ? { site_url: siteUrl, error: stats.error } : { site_url: siteUrl, http_status: stats.status },
      statsProv,
    );
  } else {
    const series = ((stats.json as { d?: unknown[] }).d ?? []).map((entry) => {
      const e = entry as Record<string, unknown>;
      return {
        date: bingDate(e.Date),
        impressions: typeof e.Impressions === "number" ? e.Impressions : 0,
        clicks: typeof e.Clicks === "number" ? e.Clicks : 0,
      };
    });
    const cutoff = Date.now() - TRAFFIC_WINDOW_DAYS * 86_400_000;
    const window = series.filter((s) => s.date !== null && s.date >= cutoff);
    row(
      `bing/rank-traffic@v1/${domain}`,
      "pass",
      {
        site_url: siteUrl,
        window_days: TRAFFIC_WINDOW_DAYS,
        impressions: window.reduce((sum, s) => sum + s.impressions, 0),
        clicks: window.reduce((sum, s) => sum + s.clicks, 0),
        days_reported: window.length,
      },
      statsProv,
    );
  }

  return { evidence: rows, panelObservations: [], cost: 0 };
}
