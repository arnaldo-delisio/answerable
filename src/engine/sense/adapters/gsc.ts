// GSC sense adapter: full Search Console API client. Search analytics (clicks,
// impressions, position by query, path-prefix filtered) plus index coverage via a
// URL inspection sample. Credential-gated: without Google credentials
// (GOOGLE_APPLICATION_CREDENTIALS service account, or GSC_OAUTH_REFRESH_TOKEN +
// client id/secret) it writes exactly one honest key-pending row; with them it
// makes real calls. Free after property verification, ground-truth layer underneath
// the paid data lanes.
// Fixture-tested; live-API pending credentials. Failures write honest "fail" rows;
// collect never throws.

import { randomUUID } from "node:crypto";
import type { Surface, WebLocaleTarget } from "../../lib/surface";
import type { CollectResult, EvidenceRow } from "./crawl";
import {
  GOOGLE_ENV_VARS,
  getGoogleAccessToken,
  googleCredentialsPresent,
  type FetchLike,
} from "./google-auth";

const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const TIMEOUT_MS = 30_000;
const QUERY_ROW_LIMIT = 100;
const WINDOW_DAYS = 28;
const WINDOW_LAG_DAYS = 2; // GSC data lags; end the window two days back.

function isoDate(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString().slice(0, 10);
}

interface SearchAnalyticsRow {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
}

async function post(
  fetchImpl: FetchLike,
  url: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number | null; json: unknown; error: string | null }> {
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, status: res.status, json: null, error: null };
    return { ok: true, status: res.status, json: await res.json(), error: null };
  } catch (e) {
    return { ok: false, status: null, json: null, error: e instanceof Error ? e.message : String(e) };
  }
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

  if (!googleCredentialsPresent()) {
    row(
      `gsc/lane-status@v1/credentials`,
      "key-pending",
      {
        env_vars: GOOGLE_ENV_VARS,
        unlock:
          "verify domain ownership in Google Search Console, then a service account with property access (GOOGLE_APPLICATION_CREDENTIALS) or an OAuth refresh token + client (GSC_OAUTH_*)",
        price: "free after verification",
        reason: "no Google credential env set",
      },
      { url: null, fetched_at: Date.now(), method: "none" },
    );
    return { evidence: rows, panelObservations: [], cost: 0 };
  }

  const { token, error: tokenError } = await getGoogleAccessToken(SCOPE, fetchImpl);
  if (!token) {
    row(
      `gsc/lane-status@v1/credentials`,
      "fail",
      { env_vars: GOOGLE_ENV_VARS, reason: `credential present but token exchange failed: ${tokenError}` },
      { url: "https://oauth2.googleapis.com/token", fetched_at: Date.now(), method: "POST" },
    );
    return { evidence: rows, panelObservations: [], cost: 0 };
  }

  const t = surface.target as WebLocaleTarget;
  const prefix = t.path_prefix.startsWith("/") ? t.path_prefix : `/${t.path_prefix}`;
  const siteUrl = process.env.GSC_SITE_URL ?? `sc-domain:${t.domain.replace(/^www\./, "")}`;
  const day = 86_400_000;
  const startDate = isoDate((WINDOW_DAYS + WINDOW_LAG_DAYS) * day);
  const endDate = isoDate(WINDOW_LAG_DAYS * day);
  const pageFilter =
    prefix === "/"
      ? {}
      : {
          dimensionFilterGroups: [
            { filters: [{ dimension: "page", operator: "contains", expression: prefix }] },
          ],
        };
  const saUrl = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;

  // Totals over the window (no dimensions: one aggregate row).
  const totals = await post(fetchImpl, saUrl, token, { startDate, endDate, ...pageFilter });
  const totalsProv = { url: saUrl, fetched_at: Date.now(), method: "POST" };
  if (!totals.ok) {
    row(
      `gsc/search-analytics-totals@v1/${prefix}`,
      "fail",
      totals.error !== null
        ? { site_url: siteUrl, error: totals.error }
        : { site_url: siteUrl, http_status: totals.status },
      totalsProv,
    );
  } else {
    const agg = ((totals.json as { rows?: SearchAnalyticsRow[] }).rows ?? [])[0] ?? {};
    row(
      `gsc/search-analytics-totals@v1/${prefix}`,
      "pass",
      {
        site_url: siteUrl,
        start_date: startDate,
        end_date: endDate,
        clicks: agg.clicks ?? 0,
        impressions: agg.impressions ?? 0,
        ctr: agg.ctr ?? 0,
        position: agg.position ?? null,
      },
      totalsProv,
    );
  }

  // Top queries over the window.
  const byQuery = await post(fetchImpl, saUrl, token, {
    startDate,
    endDate,
    dimensions: ["query"],
    rowLimit: QUERY_ROW_LIMIT,
    ...pageFilter,
  });
  const queriesProv = { url: saUrl, fetched_at: Date.now(), method: "POST" };
  if (!byQuery.ok) {
    row(
      `gsc/search-analytics-queries@v1/${prefix}`,
      "fail",
      byQuery.error !== null
        ? { site_url: siteUrl, error: byQuery.error }
        : { site_url: siteUrl, http_status: byQuery.status },
      queriesProv,
    );
  } else {
    const qRows = (byQuery.json as { rows?: SearchAnalyticsRow[] }).rows ?? [];
    row(
      `gsc/search-analytics-queries@v1/${prefix}`,
      "pass",
      {
        site_url: siteUrl,
        start_date: startDate,
        end_date: endDate,
        row_count: qRows.length,
        queries: qRows.map((r) => ({
          query: r.keys?.[0] ?? "",
          clicks: r.clicks ?? 0,
          impressions: r.impressions ?? 0,
          position: r.position ?? null,
        })),
      },
      queriesProv,
    );
  }

  // Index coverage via URL inspection sample: surface root page + domain root.
  const samplePages = [`https://${t.domain}${prefix}`];
  if (prefix !== "/") samplePages.push(`https://${t.domain}/`);
  const inspectUrl = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";
  for (const page of samplePages) {
    const out = await post(fetchImpl, inspectUrl, token, { inspectionUrl: page, siteUrl });
    const prov = { url: inspectUrl, fetched_at: Date.now(), method: "POST" };
    if (!out.ok) {
      row(
        `gsc/url-inspection@v1/${page}`,
        "fail",
        out.error !== null
          ? { page, site_url: siteUrl, error: out.error }
          : { page, site_url: siteUrl, http_status: out.status },
        prov,
      );
      continue;
    }
    const result = (out.json as {
      inspectionResult?: {
        indexStatusResult?: {
          verdict?: string;
          coverageState?: string;
          robotsTxtState?: string;
          lastCrawlTime?: string;
        };
      };
    }).inspectionResult?.indexStatusResult;
    row(
      `gsc/url-inspection@v1/${page}`,
      "pass",
      {
        page,
        verdict: result?.verdict ?? null,
        coverage_state: result?.coverageState ?? null,
        indexed: result?.verdict === "PASS",
        robots_txt_state: result?.robotsTxtState ?? null,
        last_crawl_time: result?.lastCrawlTime ?? null,
      },
      prov,
    );
  }

  return { evidence: rows, panelObservations: [], cost: 0 };
}
