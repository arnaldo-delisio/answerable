// Credential-gated API clients (performance, gsc, bing, analytics, dataforseo) against
// their recorded fixtures in src/engine/sense/adapters/__fixtures__/ via the fetch
// injection seam. Three behaviors per client where applicable: honest key-pending row
// without credentials, correct extraction on the live-call path, and no credential
// leaking into provenance. Dataforseo adds the pre-call budget guardrail.

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPairSync } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Surface } from "../src/engine/lib/surface";
import type { FetchLike } from "../src/engine/sense/adapters/google-auth";
import * as performance from "../src/engine/sense/adapters/performance";
import * as gsc from "../src/engine/sense/adapters/gsc";
import * as bing from "../src/engine/sense/adapters/bing";
import * as analytics from "../src/engine/sense/adapters/analytics";
import * as dataforseo from "../src/engine/sense/adapters/dataforseo";

const FIXTURE_DIR = join(__dirname, "../src/engine/sense/adapters/__fixtures__");

interface FixtureEntry {
  status: number;
  json: unknown;
}

// Fixture keys are "<url substring>" or "<url substring>|<body substring>"; longest
// matching key wins (same contract as scripts/verify-adapter-fixtures.ts).
function fixtureFetch(file: string): FetchLike {
  const fixtures = JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8")) as Record<string, FixtureEntry>;
  return (async (input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : (init?.body?.toString() ?? "");
    const match = Object.keys(fixtures)
      .filter((key) => {
        const [urlPart, bodyPart] = key.split("|");
        return url.includes(urlPart) && (bodyPart === undefined || body.includes(bodyPart));
      })
      .sort((a, b) => b.length - a.length)[0];
    if (!match) throw new Error(`no fixture in ${file} matches ${url}`);
    const entry = fixtures[match];
    return new Response(JSON.stringify(entry.json), {
      status: entry.status,
      headers: { "content-type": "application/json" },
    });
  }) as FetchLike;
}

const surface: Surface = {
  id: "example-com-en",
  kind: "web-locale",
  target: { domain: "example.com", path_prefix: "/", locale: "en" },
  audience: "fixture",
  business_goal: "fixture",
  desired_conversion: "fixture",
  competitors: [],
  publishing: { policy: "review-required", owner: "operator" },
  lanes: {},
  policy: {},
};
const RUN_ID = "fixture-run";

const CRED_VARS = [
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GSC_OAUTH_REFRESH_TOKEN",
  "GSC_OAUTH_CLIENT_ID",
  "GSC_OAUTH_CLIENT_SECRET",
  "PAGESPEED_API_KEY",
  "BING_WEBMASTER_KEY",
  "GA4_PROPERTY_ID",
  "DATAFORSEO_LOGIN",
  "DATAFORSEO_PASSWORD",
  "GSC_SITE_URL",
];

let fakeServiceAccount: string;

beforeAll(() => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  fakeServiceAccount = join(mkdtempSync(join(tmpdir(), "answerable-fixture-")), "sa.json");
  writeFileSync(
    fakeServiceAccount,
    JSON.stringify({
      type: "service_account",
      client_email: "fixture@fixture.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    }),
  );
});

beforeEach(() => {
  for (const v of CRED_VARS) delete process.env[v];
});

describe("performance (PSI v5)", () => {
  it("without a key writes exactly one honest key-pending row", async () => {
    const r = await performance.collect(surface, RUN_ID);
    expect(r.evidence).toHaveLength(1);
    expect(r.evidence[0].status).toBe("key-pending");
  });

  it("extracts lab and field CWV per strategy and never leaks the key", async () => {
    process.env.PAGESPEED_API_KEY = "fixture-key";
    const r = await performance.collect(surface, RUN_ID, { fetch: fixtureFetch("performance.json") });
    expect(r.evidence).toHaveLength(2);
    expect(r.evidence.every((e) => e.status === "pass")).toBe(true);
    const mobile = r.evidence.find((e) => e.checkKey === "performance/cwv-mobile@v1/https://example.com/");
    expect((mobile?.value as { performance_score?: number })?.performance_score).toBe(82);
    expect((mobile?.value as { field?: { lcp?: { percentile?: number } } })?.field?.lcp?.percentile).toBe(2350);
    expect(JSON.stringify(r.evidence.map((e) => e.provenance))).not.toContain("fixture-key");
  });
});

describe("gsc (Search Console)", () => {
  it("without credentials writes exactly one key-pending row", async () => {
    const r = await gsc.collect(surface, RUN_ID);
    expect(r.evidence).toHaveLength(1);
    expect(r.evidence[0].status).toBe("key-pending");
  });

  it("extracts totals, query rows, and URL inspection from the fixture", async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = fakeServiceAccount;
    const r = await gsc.collect(surface, RUN_ID, { fetch: fixtureFetch("gsc.json") });
    const totals = r.evidence.find((e) => e.checkKey.startsWith("gsc/search-analytics-totals@"));
    const queries = r.evidence.find((e) => e.checkKey.startsWith("gsc/search-analytics-queries@"));
    const inspection = r.evidence.find((e) => e.checkKey.startsWith("gsc/url-inspection@"));
    expect(totals?.status).toBe("pass");
    expect((totals?.value as { clicks?: number })?.clicks).toBe(412);
    expect((totals?.value as { impressions?: number })?.impressions).toBe(18750);
    expect(queries?.status).toBe("pass");
    expect((queries?.value as { row_count?: number })?.row_count).toBe(3);
    expect(inspection?.status).toBe("pass");
    expect((inspection?.value as { indexed?: boolean })?.indexed).toBe(true);
  });
});

describe("bing (Webmaster API)", () => {
  it("without a key writes exactly one key-pending row", async () => {
    const r = await bing.collect(surface, RUN_ID);
    expect(r.evidence).toHaveLength(1);
    expect(r.evidence[0].status).toBe("key-pending");
  });

  it("extracts quota and 28-day rank/traffic window, no key in provenance", async () => {
    process.env.BING_WEBMASTER_KEY = "fixture-key";
    const r = await bing.collect(surface, RUN_ID, { fetch: fixtureFetch("bing.json") });
    const quota = r.evidence.find((e) => e.checkKey.startsWith("bing/url-submission-quota@"));
    const traffic = r.evidence.find((e) => e.checkKey.startsWith("bing/rank-traffic@"));
    expect(quota?.status).toBe("pass");
    expect((quota?.value as { daily_quota?: number })?.daily_quota).toBe(100);
    expect(traffic?.status).toBe("pass");
    expect((traffic?.value as { impressions?: number })?.impressions).toBe(2550); // recent days only
    expect(JSON.stringify(r.evidence.map((e) => e.provenance))).not.toContain("fixture-key");
  });
});

describe("analytics (GA4 Data API)", () => {
  it("without credentials writes exactly one key-pending row", async () => {
    const r = await analytics.collect(surface, RUN_ID);
    expect(r.evidence).toHaveLength(1);
    expect(r.evidence[0].status).toBe("key-pending");
  });

  it("extracts sessions and key events from the report fixture", async () => {
    process.env.GA4_PROPERTY_ID = "123456789";
    process.env.GOOGLE_APPLICATION_CREDENTIALS = fakeServiceAccount;
    const r = await analytics.collect(surface, RUN_ID, { fetch: fixtureFetch("analytics.json") });
    const report = r.evidence.find((e) => e.checkKey.startsWith("analytics/ga4-report@"));
    const value = report?.value as { sessions_total?: number; key_events_total?: number } | undefined;
    expect(report?.status).toBe("pass");
    expect(value?.sessions_total).toBe(5630);
    expect(value?.key_events_total).toBe(152);
  });
});

describe("dataforseo (backlinks + LLM mentions, budget guardrail)", () => {
  it("without credentials writes exactly one key-pending row", async () => {
    const r = await dataforseo.collect(surface, RUN_ID);
    expect(r.evidence).toHaveLength(1);
    expect(r.evidence[0].status).toBe("key-pending");
  });

  it("extracts backlinks and LLM mentions, journaling the actual API cost", async () => {
    process.env.DATAFORSEO_LOGIN = "fixture-login";
    process.env.DATAFORSEO_PASSWORD = "fixture-password";
    const r = await dataforseo.collect(surface, RUN_ID, { fetch: fixtureFetch("dataforseo.json") });
    const backlinks = r.evidence.find((e) => e.checkKey.startsWith("dataforseo/backlinks-summary@"));
    const mentions = r.evidence.find((e) => e.checkKey.startsWith("dataforseo/llm-mentions@"));
    expect(backlinks?.status).toBe("pass");
    expect((backlinks?.value as { referring_domains?: number })?.referring_domains).toBe(96);
    expect(mentions?.status).toBe("pass");
    expect((mentions?.value as { mention_count?: number })?.mention_count).toBe(2);
    expect(r.cost).toBeCloseTo(0.16603, 9);
  });

  it("pre-call budget guardrail: a tight max_cost_per_run refuses both calls at zero spend", async () => {
    process.env.DATAFORSEO_LOGIN = "fixture-login";
    process.env.DATAFORSEO_PASSWORD = "fixture-password";
    const tight: Surface = { ...surface, lanes: { dataforseo: { enabled: true, max_cost_per_run: 0.01 } } };
    const r = await dataforseo.collect(tight, RUN_ID, { fetch: fixtureFetch("dataforseo.json") });
    expect(r.evidence).toHaveLength(2);
    expect(r.evidence.every((e) => e.status === "refused")).toBe(true);
    expect(r.cost).toBe(0);
  });
});
