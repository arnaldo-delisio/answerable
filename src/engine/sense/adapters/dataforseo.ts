// DataForSEO sense adapter: full client behind the provider port. Runs backlinks
// summary (rank + referring domains) and LLM-mentions search, with a PRE-CALL
// budget guardrail: projected cost is estimated from the component pricing below
// before every call, and a call that would push the run past maxCostPerRun
// (default $1, overridable per surface via lanes.dataforseo.max_cost_per_run) is
// refused with an honest "refused" row, never silently made. Credential-gated:
// without DATAFORSEO_LOGIN/DATAFORSEO_PASSWORD it writes exactly one honest
// key-pending row. Fixture-tested; live-API pending credentials. Failures write
// honest "fail" rows; collect never throws.

import { randomUUID } from "node:crypto";
import type { Surface, WebLocaleTarget } from "../../lib/surface";
import type { CollectResult, EvidenceRow } from "./crawl";
import type { FetchLike } from "./google-auth";

const ENV_LOGIN = "DATAFORSEO_LOGIN";
const ENV_PASSWORD = "DATAFORSEO_PASSWORD";
const API_BASE = "https://api.dataforseo.com/v3";
const TIMEOUT_MS = 60_000;
const LLM_MENTIONS_ROW_LIMIT = 100;

// Budget guardrail default: a collect() call must never spend more than this (USD).
// Overridable per surface via lanes.dataforseo.max_cost_per_run.
export const maxCostPerRun = 1.0;

// Pre-call cost estimates (reported vendor pricing), conservative side of each range.
// Backlinks: summary endpoint, ~$0.05/1,000 rows table line -> flat summary estimate.
// LLM Mentions: $0.10 per request + $0.001 per row at our row limit.
export const COST_ESTIMATES = {
  backlinksSummary: 0.05,
  llmMentions: 0.1 + 0.001 * LLM_MENTIONS_ROW_LIMIT,
} as const;

// Provider port: the shape any DataForSEO backend fills. Each method returns
// extracted rows plus the actual cost charged, so the adapter can journal lane
// cost honestly and enforce the guardrail against real spend.
export interface DataForSeoPort {
  backlinksSummary(domain: string): Promise<{ rows: Record<string, unknown>[]; cost: number }>;
  llmMentions(brand: string): Promise<{ rows: Record<string, unknown>[]; cost: number }>;
}

interface DfsTask {
  status_code?: number;
  status_message?: string;
  result?: unknown[];
}
interface DfsResponse {
  status_code?: number;
  status_message?: string;
  cost?: number;
  tasks?: DfsTask[];
}

// Live client over the DataForSEO REST API (basic auth). POST .../live endpoints
// return results synchronously with the actual cost on the response envelope.
export class LiveDataForSeoClient implements DataForSeoPort {
  constructor(
    private login: string,
    private password: string,
    private fetchImpl: FetchLike = fetch,
  ) {}

  private async post(path: string, task: Record<string, unknown>): Promise<{ result: unknown[]; cost: number }> {
    const res = await this.fetchImpl(`${API_BASE}${path}`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${this.login}:${this.password}`).toString("base64")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify([task]),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`DataForSEO ${path}: HTTP ${res.status}`);
    const json = (await res.json()) as DfsResponse;
    const t = json.tasks?.[0];
    if (!t || (t.status_code !== undefined && t.status_code >= 40000)) {
      throw new Error(`DataForSEO ${path}: task error ${t?.status_code ?? "?"} ${t?.status_message ?? ""}`.trim());
    }
    return { result: t.result ?? [], cost: typeof json.cost === "number" ? json.cost : 0 };
  }

  async backlinksSummary(domain: string): Promise<{ rows: Record<string, unknown>[]; cost: number }> {
    const { result, cost } = await this.post("/backlinks/summary/live", {
      target: domain,
      include_subdomains: true,
    });
    return { rows: result as Record<string, unknown>[], cost };
  }

  async llmMentions(brand: string): Promise<{ rows: Record<string, unknown>[]; cost: number }> {
    const { result, cost } = await this.post("/ai_optimization/llm_mentions/search/live", {
      keyword: brand,
      limit: LLM_MENTIONS_ROW_LIMIT,
    });
    // result items carry an items[] array of mention rows.
    const items = (result as { items?: unknown[] }[]).flatMap((r) => r.items ?? []);
    return { rows: items as Record<string, unknown>[], cost };
  }
}

function laneBudget(surface: Surface): number {
  const lane = surface.lanes.dataforseo;
  if (lane !== null && typeof lane === "object") {
    const v = (lane as Record<string, unknown>).max_cost_per_run;
    if (typeof v === "number" && v > 0) return v;
  }
  return maxCostPerRun;
}

function brandTerm(surface: Surface): string {
  const domain = (surface.target as Partial<WebLocaleTarget>).domain;
  if (typeof domain === "string" && domain.length > 0) return domain.replace(/^www\./, "");
  return surface.id;
}

export async function collect(
  surface: Surface,
  runId: string,
  deps: { fetch?: FetchLike; port?: DataForSeoPort } = {},
): Promise<CollectResult> {
  const rows: EvidenceRow[] = [];
  let spent = 0;
  const row = (
    checkKey: string,
    status: string,
    value: Record<string, unknown>,
    provenance: Record<string, unknown>,
    cost = 0,
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
      cost,
    });
  };

  const login = process.env[ENV_LOGIN];
  const password = process.env[ENV_PASSWORD];
  if (!deps.port && (!login || !password)) {
    row(
      `dataforseo/lane-status@v1/credentials`,
      "key-pending",
      {
        env_vars: [ENV_LOGIN, ENV_PASSWORD],
        unlock: "DataForSEO account credentials (login + password, API access)",
        price:
          "backlinks ~$0.05 per 1,000 rows; LLM Mentions $0.10/request + $0.001/row (reported vendor pricing; keyword-data pricing unverified against a primary pricing page)",
        max_cost_per_run: maxCostPerRun,
        reason: `${ENV_LOGIN}/${ENV_PASSWORD} not set`,
      },
      { url: null, fetched_at: Date.now(), method: "none" },
    );
    return { evidence: rows, panelObservations: [], cost: 0 };
  }

  const port = deps.port ?? new LiveDataForSeoClient(login as string, password as string, deps.fetch ?? fetch);
  const budget = laneBudget(surface);
  const domain = brandTerm(surface);

  // Pre-call guardrail: refuse (honest "refused" row) instead of calling when the
  // estimate would push spend past the budget.
  const overBudget = (call: string, estimate: number): boolean => {
    if (spent + estimate <= budget) return false;
    row(
      `dataforseo/budget-refusal@v1/${call}`,
      "refused",
      {
        call,
        estimated_cost: estimate,
        spent_so_far: spent,
        budget,
        reason: "projected cost exceeds max_cost_per_run; call not made",
      },
      { url: null, fetched_at: Date.now(), method: "none" },
    );
    return true;
  };

  // Backlinks summary: rank + referring domains.
  if (!overBudget("backlinks-summary", COST_ESTIMATES.backlinksSummary)) {
    const prov = { url: `${API_BASE}/backlinks/summary/live`, fetched_at: Date.now(), method: "POST" };
    try {
      const { rows: result, cost } = await port.backlinksSummary(domain);
      spent += cost;
      const summary = result[0] ?? {};
      row(
        `dataforseo/backlinks-summary@v1/${domain}`,
        "pass",
        {
          target: domain,
          rank: summary.rank ?? null,
          backlinks: summary.backlinks ?? null,
          referring_domains: summary.referring_domains ?? null,
          referring_main_domains: summary.referring_main_domains ?? null,
        },
        prov,
        cost,
      );
    } catch (e) {
      row(
        `dataforseo/backlinks-summary@v1/${domain}`,
        "fail",
        { target: domain, error: e instanceof Error ? e.message : String(e) },
        prov,
      );
    }
  }

  // LLM mentions: where AI answers cite or mention the brand.
  if (!overBudget("llm-mentions", COST_ESTIMATES.llmMentions)) {
    const prov = {
      url: `${API_BASE}/ai_optimization/llm_mentions/search/live`,
      fetched_at: Date.now(),
      method: "POST",
    };
    try {
      const { rows: mentions, cost } = await port.llmMentions(domain);
      spent += cost;
      row(
        `dataforseo/llm-mentions@v1/${domain}`,
        "pass",
        {
          brand: domain,
          mention_count: mentions.length,
          top_mentions: mentions.slice(0, 10),
        },
        prov,
        cost,
      );
    } catch (e) {
      row(
        `dataforseo/llm-mentions@v1/${domain}`,
        "fail",
        { brand: domain, error: e instanceof Error ? e.message : String(e) },
        prov,
      );
    }
  }

  return { evidence: rows, panelObservations: [], cost: spent };
}
