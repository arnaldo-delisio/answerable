// Fixture: a SECOND brand ("acme") in this worktree's db copy, so brand
// scoping in queues and rollups has two brands' data to separate. Fixture only —
// this script exists on the brand-coherence branch and is not part of the product.
//
//   ANSWERABLE_DB_PATH=$PWD/data/answerable.db npx tsx scripts/fixture-second-brand.ts
//
// ANSWERABLE_DB_PATH is mandatory and must resolve inside this worktree: see
// scripts/lib/fixture-db-guard.ts.
//
// Product paths are used wherever they exist: the brand row goes in through the
// brands schema, surfaces come from `answerable onboard` (run separately, config files
// are the source of truth), runs open/close through engine/lib/run
// (createRun/finishRun writes the real snapshot metrics), and claims/bets/assets
// come from the real infer/decide/spec stations. Only the sense layer is
// substituted: its adapters hit the live network, so this script writes the
// evidence + panel rows a crawl/geo-panel pass would have landed.

// SAFETY: this script writes evidence and panel rows that no adapter collected.
// They are honestly stamped (provenance.fixture true) but they are still not
// observations, so they may never reach a database an operator reads as real.
// The guard below refuses to run unless ANSWERABLE_DB_PATH is set explicitly AND
// resolves inside this worktree — a bare `npx tsx scripts/fixture-second-brand.ts`
// (which would fall through to the default ./data/answerable.db of whatever tree it is
// run from), or any path pointing at the main checkout or the live service,
// exits non-zero having created nothing, not even an empty database file.
//
// It is imported FIRST on purpose: it guards at import time, and "../src/db"
// below opens (and creates) the configured sqlite file as soon as IT is imported.
import "./lib/fixture-db-guard";

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db";
import { createRun, finishRun } from "../src/engine/lib/run";
import { promptSlug } from "../src/engine/sense/adapters/geo-panel";

const BRAND_ID = "acme";
const WEB = "acme-example";
const GEO = "acme-geo-chatgpt";
const ORIGIN = "https://acme.example";

// ---- brand row -------------------------------------------------------------

function ensureBrand(): void {
  const existing = db.select().from(schema.brands).where(eq(schema.brands.id, BRAND_ID)).get();
  if (existing) {
    console.log(`brand ${BRAND_ID} already present`);
    return;
  }
  db.insert(schema.brands)
    .values({
      id: BRAND_ID,
      name: "Acme Labs",
      primaryDomain: "acme.example",
      createdAt: Date.now(),
      aliases: ["acme.example", "Acme Labs"],
      negativeTerms: [],
    })
    .run();
  console.log(`brand ${BRAND_ID} created`);
}

// ---- sense substitute: crawl evidence --------------------------------------

interface Ev {
  checkKey: string;
  status: string;
  value: Record<string, unknown>;
}

const PAGES = [`${ORIGIN}/`, `${ORIGIN}/pricing`, `${ORIGIN}/blog/scheduling-field-crews`];
const BOTS = ["GPTBot", "PerplexityBot", "ClaudeBot", "OAI-SearchBot", "Googlebot"];

// Run 1 and run 2 differ, so the run-over-run differ has something real to read.
// Deliberate failures give infer's deterministic detectors something to detect:
// hreflang absent on two pages (technical), GPTBot blocked (eligibility), thin
// SSR on the pricing page (technical).
function crawlEvidence(variant: 1 | 2): Ev[] {
  const rows: Ev[] = [];
  for (const bot of BOTS) {
    const blocked = bot === "GPTBot";
    rows.push({
      checkKey: `crawl/robots-bot-rules@v1/${bot}`,
      status: blocked ? "blocked" : "pass",
      value: {
        robots_txt_present: true,
        matched_group: blocked ? "GPTBot" : "*",
        allow: blocked ? [] : ["/"],
        disallow: blocked ? ["/"] : [],
        root_blocked: blocked,
      },
    });
    rows.push({
      checkKey: `crawl/bot-access@v1/${bot}`,
      status: blocked ? "blocked" : "pass",
      value: {
        http_status: blocked ? 403 : 200,
        user_agent: `Mozilla/5.0 (compatible; ${bot}/1.0)`,
      },
    });
  }
  rows.push({
    checkKey: `crawl/sitemap@v1/${ORIGIN}/sitemap.xml`,
    status: "pass",
    value: { exists: true, valid_xml: true, url_count: variant === 1 ? 128 : 134 },
  });
  for (const page of PAGES) {
    const thin = page.endsWith("/pricing");
    rows.push({
      checkKey: `crawl/ssr@v1/${page}`,
      status: thin ? "thin" : "pass",
      value: {
        text_chars: thin ? 84 : 6200 + variant * 40,
        html_chars: 120_000,
        min_text_chars: 200,
      },
    });
    // Home carries hreflang; the other two don't (the gap the detector reads).
    const hasHreflang = page === `${ORIGIN}/`;
    rows.push({
      checkKey: `crawl/hreflang@v1/${page}`,
      status: hasHreflang ? "present" : "absent",
      value: hasHreflang
        ? { count: 2, entries: [{ hreflang: "en", href: page }, { hreflang: "x-default", href: page }] }
        : { count: 0, entries: [] },
    });
    rows.push({
      checkKey: `crawl/canonical@v1/${page}`,
      status: "present",
      value: { href: page, tag_count: 1 },
    });
    rows.push({
      checkKey: `crawl/json-ld@v1/${page}`,
      status: page === `${ORIGIN}/` ? "present" : "absent",
      value: page === `${ORIGIN}/` ? { types: ["Organization", "WebSite"] } : { types: [] },
    });
  }
  return rows;
}

function writeEvidence(runId: string, surfaceId: string, rows: Ev[], fetchedAt: number): void {
  for (const r of rows) {
    db.insert(schema.evidence)
      .values({
        id: randomUUID(),
        runId,
        surfaceId,
        checkKey: r.checkKey,
        status: r.status as never,
        confidenceTag: "observed",
        value: r.value,
        provenance: { url: ORIGIN, fetched_at: fetchedAt, method: "GET", fixture: true },
        cost: 0,
      })
      .run();
  }
}

// ---- sense substitute: geo panel observations ------------------------------

function writePanel(runId: string, surfaceId: string, prompts: string[]): void {
  prompts.forEach((prompt, i) => {
    const ownedHit = i === 2; // one prompt of four cites the brand
    const promptId = promptSlug(prompt);
    // entities_cited is a list of {entity,url,rank} records, the shape the
    // geo-panel adapter lands and the panel detector reads.
    const entities = ownedHit
      ? [
          { entity: "Fabrikam Time", url: "https://fabrikam.example", rank: 1 },
          { entity: "Acme Labs", url: "https://acme.example", rank: 2 },
        ]
      : [
          { entity: "Fabrikam Time", url: "https://fabrikam.example", rank: 1 },
          { entity: "Litware Ledger", url: "https://litware.example", rank: 2 },
        ];
    const digest = ownedHit
      ? "Lists Acme Labs among crew-scheduling tools alongside Fabrikam Time."
      : "Names Fabrikam Time and Litware Ledger; Acme Labs not mentioned.";
    db.insert(schema.panelObservations)
      .values({
        id: randomUUID(),
        runId,
        surfaceId,
        promptSetVersion: "discovery-v1",
        promptId,
        engine: "chatgpt",
        responseDigest: digest,
        entitiesCited: entities,
        ownedHit,
      })
      .run();
    // The per-prompt evidence row a real panel pass lands alongside the
    // observation: claims link their evidence through these.
    db.insert(schema.evidence)
      .values({
        id: randomUUID(),
        runId,
        surfaceId,
        checkKey: `geo-panel/prompt@v1/${promptId}`,
        status: "pass",
        confidenceTag: "observed",
        value: {
          engine: "chatgpt",
          prompt,
          response_chars: digest.length,
          entities_cited: entities.map((e) => e.entity),
          owned_hit: ownedHit,
        },
        provenance: { engine: "chatgpt", fetched_at: Date.now(), fixture: true },
        cost: 0,
      })
      .run();
  });
}

// ---- runs ------------------------------------------------------------------

function webRun(variant: 1 | 2): string {
  const { id } = createRun(WEB, randomUUID());
  writeEvidence(id, WEB, crawlEvidence(variant), Date.now());
  const summary = finishRun(id, WEB, ["sense"]);
  console.log(`run ${id} (${WEB}, variant ${variant}) snapshots: ${JSON.stringify(summary.snapshots)}`);
  return id;
}

function geoRun(): string {
  const { id, configSnapshot } = createRun(GEO, randomUUID());
  const prompts = (
    configSnapshot as { target?: { prompt_set?: { prompts?: string[] } } }
  ).target?.prompt_set?.prompts;
  if (!prompts) throw new Error(`${GEO}: no prompt_set in the run config snapshot`);
  writePanel(id, GEO, prompts);
  const summary = finishRun(id, GEO, ["sense"]);
  console.log(`run ${id} (${GEO}) snapshots: ${JSON.stringify(summary.snapshots)}`);
  return id;
}

function main(): void {
  ensureBrand();
  for (const id of [WEB, GEO]) {
    const s = db.select().from(schema.surfaces).where(eq(schema.surfaces.id, id)).get();
    if (!s) throw new Error(`surface "${id}" not onboarded yet — run \`npm run answerable -- onboard config/surfaces/${id}.yaml\` first`);
    if (s.brandId !== BRAND_ID) throw new Error(`surface "${id}" is not grouped under "${BRAND_ID}"`);
  }
  webRun(1);
  webRun(2);
  geoRun();
}

main();
