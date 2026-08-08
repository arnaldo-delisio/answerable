// Competitor sense adapter: per competitor (surface config name+url), politely fetch
// the homepage plus up to 2 obvious tool/comparison pages discovered in the homepage
// HTML (/tools links, /blog links whose href contains "alternatives" or "vs"); max 3
// fetches per competitor, 500ms gaps. Plus answer-space ownership computed from the
// db's existing panel_observations (latest run of each ai-engine-lane surface that
// observes this surface). Honest fail/pending rows; collect never throws.

import { randomUUID } from "node:crypto";
import { desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../../../db";
import type { Surface } from "../../lib/surface";
import type { CollectResult, EvidenceRow } from "./crawl";
import { slugify } from "./community";

const GAP_MS = 500;
const TIMEOUT_MS = 10_000;
const MAX_FETCHES_PER_COMPETITOR = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface FetchOutcome {
  ok: boolean;
  status: number | null;
  body: string | null;
  error: string | null;
  fetchedAt: number;
}

async function politeFetch(url: string): Promise<FetchOutcome> {
  await sleep(GAP_MS);
  const fetchedAt = Date.now();
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { ok: res.ok, status: res.status, body: await res.text(), error: null, fetchedAt };
  } catch (e) {
    return { ok: false, status: null, body: null, error: e instanceof Error ? e.message : String(e), fetchedAt };
  }
}

// ---- html extraction -----------------------------------------------------

function extractTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
}

function extractH1s(html: string): string[] {
  const out: string[] = [];
  const re = /<h1[^>]*>([\s\S]*?)<\/h1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const text = m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (text) out.push(text);
  }
  return out;
}

function extractJsonLdTypes(html: string): string[] {
  const types: string[] = [];
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(m[1]);
      const nodes = Array.isArray(parsed) ? parsed : parsed["@graph"] ?? [parsed];
      for (const node of Array.isArray(nodes) ? nodes : [nodes]) {
        const t = node?.["@type"];
        if (typeof t === "string") types.push(t);
        else if (Array.isArray(t)) types.push(...t.filter((x): x is string => typeof x === "string"));
      }
    } catch {
      types.push("(unparseable JSON-LD block)");
    }
  }
  return types;
}

function extractHrefs(html: string): string[] {
  const hrefs: string[] = [];
  const re = /<a\b[^>]*href=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) hrefs.push(m[1]);
  return hrefs;
}

// has_free_tools: the page links to a /tools path or its text mentions a free tool.
export function hasFreeTools(html: string): boolean {
  if (extractHrefs(html).some((h) => /\/tools(\/|$|\?|#)/i.test(h))) return true;
  return /free\s+tools?/i.test(html.replace(/<[^>]+>/g, " "));
}

// comparison_targets: brand names from the surface's competitor list (the fetched
// competitor excluded) found in the page's title or h1 text as whole words
// (alnum-boundary, case-insensitive, metachars escaped): bare substring matching let
// "Trend" fire inside "trending".
export function comparisonTargets(title: string | null, h1s: string[], surface: Surface, self: string): string[] {
  const haystack = [title ?? "", ...h1s].join(" ");
  return surface.competitors
    .map((c) => c.name)
    .filter((name) => name.toLowerCase() !== self.toLowerCase())
    .filter((name) =>
      new RegExp(`(?<![a-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`, "i").test(haystack),
    );
}

// Discover up to `limit` tool/comparison page URLs in the homepage HTML: /tools links,
// and /blog links whose href contains "alternatives" or a hyphenated "vs" segment.
export function discoverPages(html: string, baseUrl: string, limit: number): string[] {
  const picked: string[] = [];
  const seen = new Set<string>();
  const resolve = (href: string): string | null => {
    try {
      return new URL(href, baseUrl).toString();
    } catch {
      return null;
    }
  };
  const isTools = (h: string) => /\/tools(\/|$|\?|#)/i.test(h);
  const isComparison = (h: string) =>
    /\/blog/i.test(h) && (/alternatives?/i.test(h) || /(^|[-/])vs([-/]|$)/i.test(h));
  for (const test of [isTools, isComparison]) {
    for (const href of extractHrefs(html)) {
      if (picked.length >= limit) return picked;
      if (!test(href)) continue;
      const abs = resolve(href);
      if (!abs || seen.has(abs)) continue;
      seen.add(abs);
      picked.push(abs);
    }
  }
  return picked;
}

// ---- answer ownership (from existing panel_observations) ------------------

interface AnswerOwnership {
  available: boolean;
  observingSurfaces: string[];
  runIds: string[];
  promptTotal: number;
  citedFraction: Map<string, number>; // competitor name (lowercase) -> fraction
}

// Panel rows from the latest run of each ai-engine-lane surface that observes this
// surface; ownership = fraction of those prompts citing the competitor.
function loadAnswerOwnership(surface: Surface): AnswerOwnership {
  const observing = db
    .select()
    .from(schema.surfaces)
    .where(eq(schema.surfaces.kind, "ai-engine-lane"))
    .all()
    .filter((s) => (s.configSnapshot as Record<string, unknown>).observes === surface.id);

  const runIds: string[] = [];
  for (const s of observing) {
    // Latest run of this observing surface that actually has panel rows.
    const runs = db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.surfaceId, s.id))
      .orderBy(desc(schema.runs.startedAt), desc(schema.runs.id))
      .all();
    for (const r of runs) {
      const has = db
        .select()
        .from(schema.panelObservations)
        .where(eq(schema.panelObservations.runId, r.id))
        .limit(1)
        .all();
      if (has.length > 0) {
        runIds.push(r.id);
        break;
      }
    }
  }

  const citedFraction = new Map<string, number>();
  if (runIds.length === 0) {
    return { available: false, observingSurfaces: observing.map((s) => s.id), runIds, promptTotal: 0, citedFraction };
  }

  const rows = db
    .select()
    .from(schema.panelObservations)
    .where(inArray(schema.panelObservations.runId, runIds))
    .all();
  const counts = new Map<string, number>();
  for (const obs of rows) {
    const cited = new Set(obs.entitiesCited.map((e) => e.entity.toLowerCase()));
    for (const c of surface.competitors) {
      const key = c.name.toLowerCase();
      if (cited.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  for (const c of surface.competitors) {
    const key = c.name.toLowerCase();
    citedFraction.set(key, (counts.get(key) ?? 0) / rows.length);
  }
  return {
    available: true,
    observingSurfaces: observing.map((s) => s.id),
    runIds,
    promptTotal: rows.length,
    citedFraction,
  };
}

// ---- collect -------------------------------------------------------------

export async function collect(surface: Surface, runId: string): Promise<CollectResult> {
  const rows: EvidenceRow[] = [];
  const row = (
    checkKey: string,
    status: string,
    value: Record<string, unknown> | null,
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

  const ownership = loadAnswerOwnership(surface);

  for (const competitor of surface.competitors) {
    const compSlug = slugify(competitor.name);

    // -- pages: homepage + up to 2 discovered tool/comparison pages ---------
    const home = await politeFetch(competitor.url);
    const homeProv = { url: competitor.url, fetched_at: home.fetchedAt, method: "GET" };
    let pages: string[] = [];
    if (home.error !== null || !home.ok || home.body === null) {
      row(
        `competitor/page@v1/${compSlug}-homepage`,
        "fail",
        home.error !== null ? { error: home.error } : { http_status: home.status },
        homeProv,
      );
    } else {
      const title = extractTitle(home.body);
      row(
        `competitor/page@v1/${compSlug}-homepage`,
        "pass",
        {
          title,
          has_free_tools: hasFreeTools(home.body),
          comparison_targets: comparisonTargets(title, extractH1s(home.body), surface, competitor.name),
          jsonld_types: extractJsonLdTypes(home.body),
        },
        homeProv,
      );
      pages = discoverPages(home.body, competitor.url, MAX_FETCHES_PER_COMPETITOR - 1);
    }

    for (const pageUrl of pages) {
      const pageSlug = slugify(new URL(pageUrl).pathname.split("/").filter(Boolean).join("-") || "root");
      const page = await politeFetch(pageUrl);
      const prov = { url: pageUrl, fetched_at: page.fetchedAt, method: "GET" };
      if (page.error !== null || !page.ok || page.body === null) {
        row(
          `competitor/page@v1/${compSlug}-${pageSlug}`,
          "fail",
          page.error !== null ? { error: page.error } : { http_status: page.status },
          prov,
        );
        continue;
      }
      const title = extractTitle(page.body);
      row(
        `competitor/page@v1/${compSlug}-${pageSlug}`,
        "pass",
        {
          title,
          has_free_tools: hasFreeTools(page.body),
          comparison_targets: comparisonTargets(title, extractH1s(page.body), surface, competitor.name),
          jsonld_types: extractJsonLdTypes(page.body),
        },
        prov,
      );
    }

    // -- answer ownership ---------------------------------------------------
    const dbProv = { url: null, fetched_at: Date.now(), method: "db:panel_observations" };
    if (!ownership.available) {
      row(
        `competitor/answer-ownership@v1/${compSlug}`,
        "pending",
        {
          competitor: competitor.name,
          reason: "no panel_observations yet from any ai-engine-lane surface observing this surface",
          dependency: "geo-panel lane run on an observing ai-engine-lane surface",
          observing_surfaces: ownership.observingSurfaces,
        },
        dbProv,
      );
    } else {
      row(
        `competitor/answer-ownership@v1/${compSlug}`,
        "pass",
        {
          competitor: competitor.name,
          cited_fraction: ownership.citedFraction.get(competitor.name.toLowerCase()) ?? 0,
          prompt_total: ownership.promptTotal,
          observing_surfaces: ownership.observingSurfaces,
          source_run_ids: ownership.runIds,
        },
        dbProv,
      );
    }
  }

  return { evidence: rows, panelObservations: [], cost: 0 };
}
