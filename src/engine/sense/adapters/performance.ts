// Performance sense adapter: full PageSpeed Insights v5 client (real CWV, field +
// lab metrics, mobile + desktop) for the surface's sampled pages. Credential-gated:
// without PAGESPEED_API_KEY it writes exactly one honest key-pending row; with the
// key it makes real calls. Fixture-tested; live-API pending credentials. Every
// request failure writes an honest "fail" row; collect never throws.

import { randomUUID } from "node:crypto";
import type { Surface, WebLocaleTarget } from "../../lib/surface";
import type { CollectResult, EvidenceRow } from "./crawl";
import type { FetchLike } from "./google-auth";

const ENV_VAR = "PAGESPEED_API_KEY";
const API_URL = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const STRATEGIES = ["mobile", "desktop"] as const;
const TIMEOUT_MS = 60_000; // PSI runs a full Lighthouse pass; it is slow.
const GAP_MS = 500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Sampled pages: the surface root page (domain + path_prefix), plus the bare domain
// root when the prefix is deeper. Small on purpose: PSI is one Lighthouse run per call.
export function sampledPages(surface: Surface): string[] {
  const t = surface.target as WebLocaleTarget;
  const prefix = t.path_prefix.startsWith("/") ? t.path_prefix : `/${t.path_prefix}`;
  const pages = [`https://${t.domain}${prefix}`];
  if (prefix !== "/") pages.push(`https://${t.domain}/`);
  return pages;
}

interface PsiResponse {
  loadingExperience?: {
    overall_category?: string;
    metrics?: Record<string, { percentile?: number; category?: string }>;
  };
  lighthouseResult?: {
    categories?: { performance?: { score?: number } };
    audits?: Record<string, { numericValue?: number; displayValue?: string }>;
  };
}

function extract(json: PsiResponse): Record<string, unknown> {
  const field = json.loadingExperience;
  const lab = json.lighthouseResult;
  const fieldMetric = (key: string) => field?.metrics?.[key] ?? null;
  const labAudit = (key: string) => lab?.audits?.[key]?.numericValue ?? null;
  const score = lab?.categories?.performance?.score;
  return {
    performance_score: typeof score === "number" ? Math.round(score * 100) : null,
    field: {
      overall_category: field?.overall_category ?? null,
      lcp: fieldMetric("LARGEST_CONTENTFUL_PAINT_MS"),
      inp: fieldMetric("INTERACTION_TO_NEXT_PAINT"),
      cls: fieldMetric("CUMULATIVE_LAYOUT_SHIFT_SCORE"),
    },
    lab: {
      lcp_ms: labAudit("largest-contentful-paint"),
      cls: labAudit("cumulative-layout-shift"),
      tbt_ms: labAudit("total-blocking-time"),
      fcp_ms: labAudit("first-contentful-paint"),
    },
  };
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
      `performance/lane-status@v1/credentials`,
      "key-pending",
      {
        env_var: ENV_VAR,
        unlock: "Google API key with the PageSpeed Insights API enabled",
        price: "API free; self-hosted Lighthouse alternative ~$12-24/mo VPS",
        reason: `${ENV_VAR} not set`,
      },
      { url: null, fetched_at: Date.now(), method: "none" },
    );
    return { evidence: rows, panelObservations: [], cost: 0 };
  }

  for (const page of sampledPages(surface)) {
    for (const strategy of STRATEGIES) {
      await sleep(GAP_MS);
      const url = `${API_URL}?url=${encodeURIComponent(page)}&strategy=${strategy}&category=performance&key=${encodeURIComponent(key)}`;
      const fetchedAt = Date.now();
      // Provenance never carries the key.
      const prov = {
        url: `${API_URL}?url=${encodeURIComponent(page)}&strategy=${strategy}`,
        fetched_at: fetchedAt,
        method: "GET",
      };
      const checkKey = `performance/cwv-${strategy}@v1/${page}`;
      try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!res.ok) {
          row(checkKey, "fail", { page, strategy, http_status: res.status }, prov);
          continue;
        }
        row(checkKey, "pass", { page, strategy, ...extract((await res.json()) as PsiResponse) }, prov);
      } catch (e) {
        row(checkKey, "fail", { page, strategy, error: e instanceof Error ? e.message : String(e) }, prov);
      }
    }
  }

  return { evidence: rows, panelObservations: [], cost: 0 };
}
