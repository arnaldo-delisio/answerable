// Fixture verification for the credential-gated sense adapters (performance, gsc,
// bing, analytics, dataforseo). No credentials exist on this box, so each client is
// exercised against recorded fixtures (src/engine/sense/adapters/__fixtures__/,
// shapes from the vendors' documented schemas) through the adapters' fetch
// injection seam: key-pending path first, then the live-call path, then the
// dataforseo budget refusal. Run: npx tsx scripts/verify-adapter-fixtures.ts
// Exit 0 = all assertions hold. This is fixture testing, not live verification.

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPairSync } from "node:crypto";
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

// Fixture keys are "<url substring>" or "<url substring>|<body substring>"; the
// longest key matching both wins, so body-discriminated variants override.
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

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail !== undefined ? `: ${JSON.stringify(detail)}` : ""}`);
  }
}

const GOOGLE_VARS = [
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GSC_OAUTH_REFRESH_TOKEN",
  "GSC_OAUTH_CLIENT_ID",
  "GSC_OAUTH_CLIENT_SECRET",
];
function clearEnv(): void {
  for (const v of [
    ...GOOGLE_VARS,
    "PAGESPEED_API_KEY",
    "BING_WEBMASTER_KEY",
    "GA4_PROPERTY_ID",
    "DATAFORSEO_LOGIN",
    "DATAFORSEO_PASSWORD",
    "GSC_SITE_URL",
  ]) {
    delete process.env[v];
  }
}

// Throwaway service-account file so the JWT-signing path runs end to end.
function writeFakeServiceAccount(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const path = join(mkdtempSync(join(tmpdir(), "answerable-fixture-")), "sa.json");
  writeFileSync(
    path,
    JSON.stringify({
      type: "service_account",
      client_email: "fixture@fixture.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    }),
  );
  return path;
}

async function main(): Promise<void> {
  // ---- performance ----
  console.log("performance (PSI v5)");
  clearEnv();
  let r = await performance.collect(surface, RUN_ID);
  check("key-pending: exactly one row", r.evidence.length === 1 && r.evidence[0].status === "key-pending");
  process.env.PAGESPEED_API_KEY = "fixture-key";
  r = await performance.collect(surface, RUN_ID, { fetch: fixtureFetch("performance.json") });
  check("two strategy rows, all pass", r.evidence.length === 2 && r.evidence.every((e) => e.status === "pass"));
  const mobile = r.evidence.find((e) => e.checkKey === "performance/cwv-mobile@v1/https://example.com/");
  check("mobile performance_score 82", (mobile?.value as { performance_score?: number })?.performance_score === 82);
  check(
    "field LCP percentile extracted",
    ((mobile?.value as { field?: { lcp?: { percentile?: number } } })?.field?.lcp?.percentile ?? 0) === 2350,
  );
  check("no key in provenance", !JSON.stringify(r.evidence.map((e) => e.provenance)).includes("fixture-key"));

  // ---- gsc ----
  console.log("gsc (Search Console)");
  clearEnv();
  r = await gsc.collect(surface, RUN_ID);
  check("key-pending: exactly one row", r.evidence.length === 1 && r.evidence[0].status === "key-pending");
  process.env.GOOGLE_APPLICATION_CREDENTIALS = writeFakeServiceAccount();
  r = await gsc.collect(surface, RUN_ID, { fetch: fixtureFetch("gsc.json") });
  const totals = r.evidence.find((e) => e.checkKey.startsWith("gsc/search-analytics-totals@"));
  const queries = r.evidence.find((e) => e.checkKey.startsWith("gsc/search-analytics-queries@"));
  const inspection = r.evidence.find((e) => e.checkKey.startsWith("gsc/url-inspection@"));
  check("totals pass with clicks 412", totals?.status === "pass" && (totals.value as { clicks?: number }).clicks === 412);
  check("totals impressions 18750", (totals?.value as { impressions?: number })?.impressions === 18750);
  check(
    "queries pass with 3 rows",
    queries?.status === "pass" && (queries.value as { row_count?: number }).row_count === 3,
  );
  check(
    "inspection pass, indexed true",
    inspection?.status === "pass" && (inspection.value as { indexed?: boolean }).indexed === true,
  );

  // ---- bing ----
  console.log("bing (Webmaster API)");
  clearEnv();
  r = await bing.collect(surface, RUN_ID);
  check("key-pending: exactly one row", r.evidence.length === 1 && r.evidence[0].status === "key-pending");
  process.env.BING_WEBMASTER_KEY = "fixture-key";
  r = await bing.collect(surface, RUN_ID, { fetch: fixtureFetch("bing.json") });
  const quota = r.evidence.find((e) => e.checkKey.startsWith("bing/url-submission-quota@"));
  const traffic = r.evidence.find((e) => e.checkKey.startsWith("bing/rank-traffic@"));
  check("quota pass, daily 100", quota?.status === "pass" && (quota.value as { daily_quota?: number }).daily_quota === 100);
  check(
    "traffic pass, 28d window sums recent days only (2550 impressions)",
    traffic?.status === "pass" && (traffic.value as { impressions?: number }).impressions === 2550,
    traffic?.value,
  );
  check("no key in provenance", !JSON.stringify(r.evidence.map((e) => e.provenance)).includes("fixture-key"));

  // ---- analytics ----
  console.log("analytics (GA4 Data API)");
  clearEnv();
  r = await analytics.collect(surface, RUN_ID);
  check("key-pending: exactly one row", r.evidence.length === 1 && r.evidence[0].status === "key-pending");
  process.env.GA4_PROPERTY_ID = "123456789";
  process.env.GOOGLE_APPLICATION_CREDENTIALS = writeFakeServiceAccount();
  r = await analytics.collect(surface, RUN_ID, { fetch: fixtureFetch("analytics.json") });
  const report = r.evidence.find((e) => e.checkKey.startsWith("analytics/ga4-report@"));
  const reportValue = report?.value as { sessions_total?: number; key_events_total?: number } | undefined;
  check("report pass, sessions 5630", report?.status === "pass" && reportValue?.sessions_total === 5630, reportValue);
  check("key events 152", reportValue?.key_events_total === 152);

  // ---- dataforseo ----
  console.log("dataforseo (backlinks + LLM mentions, budget guardrail)");
  clearEnv();
  r = await dataforseo.collect(surface, RUN_ID);
  check("key-pending: exactly one row", r.evidence.length === 1 && r.evidence[0].status === "key-pending");
  process.env.DATAFORSEO_LOGIN = "fixture-login";
  process.env.DATAFORSEO_PASSWORD = "fixture-password";
  r = await dataforseo.collect(surface, RUN_ID, { fetch: fixtureFetch("dataforseo.json") });
  const backlinks = r.evidence.find((e) => e.checkKey.startsWith("dataforseo/backlinks-summary@"));
  const mentions = r.evidence.find((e) => e.checkKey.startsWith("dataforseo/llm-mentions@"));
  check(
    "backlinks pass, referring_domains 96",
    backlinks?.status === "pass" && (backlinks.value as { referring_domains?: number }).referring_domains === 96,
  );
  check(
    "llm mentions pass, count 2",
    mentions?.status === "pass" && (mentions.value as { mention_count?: number }).mention_count === 2,
  );
  check("actual cost journaled (0.16603)", Math.abs(r.cost - 0.16603) < 1e-9, r.cost);
  const tightSurface: Surface = { ...surface, lanes: { dataforseo: { enabled: true, max_cost_per_run: 0.01 } } };
  r = await dataforseo.collect(tightSurface, RUN_ID, { fetch: fixtureFetch("dataforseo.json") });
  check(
    "budget 0.01: both calls refused, zero spend",
    r.evidence.length === 2 && r.evidence.every((e) => e.status === "refused") && r.cost === 0,
    r.evidence.map((e) => e.status),
  );

  clearEnv();
  console.log(failures === 0 ? "\nall fixture checks passed" : `\n${failures} fixture check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
