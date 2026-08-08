// Analytics sense adapter: full GA4 Data API client, sessions + conversions (GA4
// key events) on the surface's tracked routes. Credential-gated: needs the shared
// Google credential (google-auth.ts) plus GA4_PROPERTY_ID; without them it writes
// exactly one honest key-pending row; with them, real runReport calls. Free with
// property access. Fixture-tested; live-API pending
// credentials. Failures write honest "fail" rows; collect never throws.

import { randomUUID } from "node:crypto";
import type { Surface, WebLocaleTarget } from "../../lib/surface";
import type { CollectResult, EvidenceRow } from "./crawl";
import {
  GOOGLE_ENV_VARS,
  getGoogleAccessToken,
  googleCredentialsPresent,
  type FetchLike,
} from "./google-auth";

const ENV_PROPERTY = "GA4_PROPERTY_ID";
const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const TIMEOUT_MS = 30_000;
const ROUTE_ROW_LIMIT = 50;
const WINDOW_DAYS = 28;

interface Ga4Row {
  dimensionValues?: { value?: string }[];
  metricValues?: { value?: string }[];
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

  const propertyId = process.env[ENV_PROPERTY];
  if (!propertyId || !googleCredentialsPresent()) {
    row(
      `analytics/lane-status@v1/credentials`,
      "key-pending",
      {
        env_vars: [ENV_PROPERTY, ...GOOGLE_ENV_VARS],
        unlock:
          "GA4 property id plus the shared Google credential (service account or OAuth refresh token) with Analytics read access",
        price: "free with property access",
        reason: !propertyId ? `${ENV_PROPERTY} not set` : "no Google credential env set",
      },
      { url: null, fetched_at: Date.now(), method: "none" },
    );
    return { evidence: rows, panelObservations: [], cost: 0 };
  }

  const { token, error: tokenError } = await getGoogleAccessToken(SCOPE, fetchImpl);
  if (!token) {
    row(
      `analytics/lane-status@v1/credentials`,
      "fail",
      { env_vars: [ENV_PROPERTY, ...GOOGLE_ENV_VARS], reason: `credential present but token exchange failed: ${tokenError}` },
      { url: "https://oauth2.googleapis.com/token", fetched_at: Date.now(), method: "POST" },
    );
    return { evidence: rows, panelObservations: [], cost: 0 };
  }

  const t = surface.target as WebLocaleTarget;
  const prefix = t.path_prefix.startsWith("/") ? t.path_prefix : `/${t.path_prefix}`;
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}:runReport`;
  const body: Record<string, unknown> = {
    dateRanges: [{ startDate: `${WINDOW_DAYS}daysAgo`, endDate: "today" }],
    dimensions: [{ name: "pagePath" }],
    // keyEvents is GA4's current name for conversions.
    metrics: [{ name: "sessions" }, { name: "keyEvents" }],
    limit: ROUTE_ROW_LIMIT,
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    ...(prefix === "/"
      ? {}
      : {
          dimensionFilter: {
            filter: { fieldName: "pagePath", stringFilter: { matchType: "BEGINS_WITH", value: prefix } },
          },
        }),
  };

  const prov = { url, fetched_at: Date.now(), method: "POST" };
  const checkKey = `analytics/ga4-report@v1/${prefix}`;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      row(checkKey, "fail", { property_id: propertyId, http_status: res.status }, prov);
      return { evidence: rows, panelObservations: [], cost: 0 };
    }
    const json = (await res.json()) as { rows?: Ga4Row[] };
    const routes = (json.rows ?? []).map((r) => ({
      path: r.dimensionValues?.[0]?.value ?? "",
      sessions: Number(r.metricValues?.[0]?.value ?? 0),
      key_events: Number(r.metricValues?.[1]?.value ?? 0),
    }));
    row(
      checkKey,
      "pass",
      {
        property_id: propertyId,
        window_days: WINDOW_DAYS,
        sessions_total: routes.reduce((sum, r) => sum + r.sessions, 0),
        key_events_total: routes.reduce((sum, r) => sum + r.key_events, 0),
        route_count: routes.length,
        top_routes: routes.slice(0, 10),
      },
      prov,
    );
  } catch (e) {
    row(checkKey, "fail", { property_id: propertyId, error: e instanceof Error ? e.message : String(e) }, prov);
  }

  return { evidence: rows, panelObservations: [], cost: 0 };
}
