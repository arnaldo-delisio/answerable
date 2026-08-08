// Crawl sense adapter: robots per-bot, sitemap, hreflang, canonicals, schema, SSR,
// AI-bot access probes, Content-Signal + noai. This lane runs live for every
// web-locale surface; crawl-class checks do not apply to ai-engine-lane or
// community-platform surfaces.
// Polite: sequential fetches with 300ms gaps, 10s timeouts. Every fetch failure writes
// an honest "fail" evidence row; collect never throws for a network-level problem.

import { randomUUID } from "node:crypto";
import type { Surface, WebLocaleTarget } from "../../lib/surface";

// One adapter interface: collect(surface, run) -> {evidence[], panelObservations[], cost}.
export interface EvidenceRow {
  id: string;
  runId: string;
  surfaceId: string;
  checkKey: string; // adapter / check-name @ check-version / subject
  status: string;
  confidenceTag: "observed";
  value: Record<string, unknown> | null;
  provenance: Record<string, unknown>;
  cost: number;
}

export interface CollectResult {
  evidence: EvidenceRow[];
  panelObservations: unknown[];
  cost: number;
}

export const BOTS = ["GPTBot", "PerplexityBot", "ClaudeBot", "OAI-SearchBot", "Googlebot"] as const;

const GAP_MS = 300;
const TIMEOUT_MS = 10_000;
const SITEMAP_SPOT_CHECK_LIMIT = 5;
const SSR_MIN_TEXT_CHARS = 200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface FetchOutcome {
  ok: boolean;
  status: number | null;
  body: string | null;
  error: string | null;
  fetchedAt: number;
  location?: string | null; // Location header, set when redirect: "manual" hits a 3xx
}

// Sequential, polite fetch: waits the gap before every request, never throws.
// Exported for reuse by the draft prober (answerable draft <domain>) via safe-fetch.ts.
export async function politeFetch(
  url: string,
  opts: { method?: string; userAgent?: string; redirect?: "follow" | "manual" } = {},
): Promise<FetchOutcome> {
  await sleep(GAP_MS);
  const fetchedAt = Date.now();
  try {
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: opts.userAgent ? { "user-agent": opts.userAgent } : undefined,
      redirect: opts.redirect ?? "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = opts.method === "HEAD" ? null : await res.text();
    return { ok: res.ok, status: res.status, body, error: null, fetchedAt, location: res.headers.get("location") };
  } catch (e) {
    return { ok: false, status: null, body: null, error: e instanceof Error ? e.message : String(e), fetchedAt };
  }
}

function provenance(url: string, fetchedAt: number, method: string): Record<string, unknown> {
  return { url, fetched_at: fetchedAt, method };
}

// ---- robots.txt parsing --------------------------------------------------

interface BotRules {
  matchedGroup: string | null; // the user-agent token whose group applies (specific or "*")
  allow: string[];
  disallow: string[];
  rootBlocked: boolean;
}

interface ParsedRobots {
  groups: Map<string, { allow: string[]; disallow: string[] }>;
  contentSignal: string[];
  sitemaps: string[];
}

function parseRobots(body: string): ParsedRobots {
  const groups = new Map<string, { allow: string[]; disallow: string[] }>();
  const contentSignal: string[] = [];
  const sitemaps: string[] = [];
  let currentAgents: string[] = [];
  let inGroup = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const sep = line.indexOf(":");
    if (sep < 0) continue;
    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();

    if (field === "user-agent") {
      if (inGroup) currentAgents = []; // rules seen since the last UA line: start a new group
      inGroup = false;
      const agent = value.toLowerCase();
      currentAgents.push(agent);
      if (!groups.has(agent)) groups.set(agent, { allow: [], disallow: [] });
    } else if (field === "allow" || field === "disallow") {
      inGroup = true;
      for (const agent of currentAgents) {
        const g = groups.get(agent);
        if (g) g[field].push(value);
      }
    } else if (field === "content-signal") {
      contentSignal.push(value);
    } else if (field === "sitemap") {
      sitemaps.push(value);
    }
  }
  return { groups, contentSignal, sitemaps };
}

function rulesForBot(robots: ParsedRobots, bot: string): BotRules {
  const specific = robots.groups.get(bot.toLowerCase());
  const wildcard = robots.groups.get("*");
  const matched = specific ? bot.toLowerCase() : wildcard ? "*" : null;
  const rules = specific ?? wildcard ?? { allow: [], disallow: [] };
  const rootBlocked = rules.disallow.some((p) => p === "/" || p === "/*") && !rules.allow.some((p) => p === "/");
  return { matchedGroup: matched, allow: rules.allow, disallow: rules.disallow, rootBlocked };
}

// ---- html extraction -----------------------------------------------------

export function stripToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractLinkTags(html: string, rel: string): string[] {
  const out: string[] = [];
  const re = /<link\b[^>]*>/gi;
  for (const m of html.match(re) ?? []) {
    const relMatch = /rel=["']?([^"'\s>]+)["']?/i.exec(m);
    if (relMatch && relMatch[1].toLowerCase() === rel.toLowerCase()) out.push(m);
  }
  return out;
}

export function extractAttr(tag: string, attr: string): string | null {
  const m = new RegExp(`${attr}=["']([^"']*)["']`, "i").exec(tag);
  return m ? m[1] : null;
}

export function extractJsonLdTypes(html: string): string[] {
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

function extractNoaiMeta(html: string): { robotsContent: string[]; noai: boolean; noimageai: boolean } {
  const robotsContent: string[] = [];
  const re = /<meta\b[^>]*>/gi;
  for (const tag of html.match(re) ?? []) {
    const name = extractAttr(tag, "name")?.toLowerCase();
    if (name === "robots" || name === "googlebot") {
      const content = extractAttr(tag, "content");
      if (content) robotsContent.push(content);
    }
  }
  const all = robotsContent.join(",").toLowerCase();
  return { robotsContent, noai: all.includes("noai"), noimageai: all.includes("noimageai") };
}

// ---- page sampling -------------------------------------------------------

const PAGE_SAMPLE_COUNT = 4; // sitemap URLs sampled alongside the homepage/locale root
const DEEP_MIN_SLOTS = 2;

// A deep content page has at least two path segments (e.g. /en/blog/post), i.e. it is
// not a locale root or single-level page.
function isDeep(url: string): boolean {
  try {
    return new URL(url).pathname.split("/").filter(Boolean).length >= 2;
  } catch {
    return false;
  }
}

// Stratified sample: up to PAGE_SAMPLE_COUNT sitemap URLs with at least DEEP_MIN_SLOTS
// deep content pages when the sitemap has them, /blog/ paths preferred for deep slots.
export function samplePages(sitemapUrls: string[], homepage: string): string[] {
  const norm = (u: string) => u.replace(/\/$/, "");
  const candidates = sitemapUrls.filter((u) => norm(u) !== norm(homepage));
  const blog = candidates.filter((u) => u.includes("/blog/"));
  const deepNonBlog = candidates.filter((u) => !u.includes("/blog/") && isDeep(u));
  const shallow = candidates.filter((u) => !u.includes("/blog/") && !isDeep(u));

  const picked: string[] = [];
  const take = (pool: string[], n: number) => {
    for (const u of pool) {
      if (picked.length >= PAGE_SAMPLE_COUNT || n <= 0) break;
      if (!picked.includes(u)) {
        picked.push(u);
        n--;
      }
    }
  };
  take(blog, DEEP_MIN_SLOTS); // deep slots, blog first
  take(deepNonBlog, DEEP_MIN_SLOTS - picked.length); // top up deep slots
  take(shallow, PAGE_SAMPLE_COUNT - picked.length); // rest shallow
  // Backfill from any remaining candidates when a stratum ran short.
  take(candidates, PAGE_SAMPLE_COUNT - picked.length);
  return picked;
}

// ---- collect -------------------------------------------------------------

export async function collect(surface: Surface, runId: string): Promise<CollectResult> {
  const target = surface.target as WebLocaleTarget;
  const origin = `https://${target.domain}`;
  const homepage = origin + target.path_prefix;
  const rows: EvidenceRow[] = [];

  const row = (
    checkKey: string,
    status: string,
    value: Record<string, unknown> | null,
    prov: Record<string, unknown>,
  ): void => {
    rows.push({
      id: randomUUID(),
      runId,
      surfaceId: surface.id,
      checkKey,
      status,
      confidenceTag: "observed",
      value,
      provenance: prov,
      cost: 0,
    });
  };

  // -- robots.txt: per-bot rules + Content-Signal --------------------------
  const robotsUrl = `${origin}/robots.txt`;
  const robotsRes = await politeFetch(robotsUrl);
  const robotsProv = provenance(robotsUrl, robotsRes.fetchedAt, "GET");
  let robots: ParsedRobots | null = null;
  if (robotsRes.error !== null) {
    for (const bot of BOTS) {
      row(`crawl/robots-bot-rules@v1/${bot}`, "fail", { error: robotsRes.error }, robotsProv);
    }
    row(`crawl/robots-content-signal@v1/${target.domain}`, "fail", { error: robotsRes.error }, robotsProv);
  } else if (!robotsRes.ok || robotsRes.body === null) {
    // Absent robots.txt: every bot is unrestricted; a real observation, not a failure.
    for (const bot of BOTS) {
      row(
        `crawl/robots-bot-rules@v1/${bot}`,
        "pass",
        { robots_txt_present: false, http_status: robotsRes.status, root_blocked: false },
        robotsProv,
      );
    }
    row(
      `crawl/robots-content-signal@v1/${target.domain}`,
      "absent",
      { robots_txt_present: false, http_status: robotsRes.status },
      robotsProv,
    );
  } else {
    robots = parseRobots(robotsRes.body);
    for (const bot of BOTS) {
      const rules = rulesForBot(robots, bot);
      row(
        `crawl/robots-bot-rules@v1/${bot}`,
        rules.rootBlocked ? "blocked" : "pass",
        {
          robots_txt_present: true,
          matched_group: rules.matchedGroup,
          allow: rules.allow,
          disallow: rules.disallow,
          root_blocked: rules.rootBlocked,
        },
        robotsProv,
      );
    }
    row(
      `crawl/robots-content-signal@v1/${target.domain}`,
      robots.contentSignal.length > 0 ? "present" : "absent",
      { directives: robots.contentSignal },
      robotsProv,
    );
  }

  // -- sitemap: exists, valid XML, URL count, spot checks -------------------
  const sitemapUrl = robots?.sitemaps[0] ?? `${origin}/sitemap.xml`;
  const sitemapRes = await politeFetch(sitemapUrl);
  const sitemapProv = provenance(sitemapUrl, sitemapRes.fetchedAt, "GET");
  let sitemapUrls: string[] = [];
  if (sitemapRes.error !== null) {
    row(`crawl/sitemap@v1/${sitemapUrl}`, "fail", { error: sitemapRes.error }, sitemapProv);
  } else if (!sitemapRes.ok || sitemapRes.body === null) {
    row(`crawl/sitemap@v1/${sitemapUrl}`, "absent", { exists: false, http_status: sitemapRes.status }, sitemapProv);
  } else {
    const looksXml = /^\s*<\?xml|<urlset|<sitemapindex/i.test(sitemapRes.body);
    sitemapUrls = [...sitemapRes.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
    row(
      `crawl/sitemap@v1/${sitemapUrl}`,
      looksXml && sitemapUrls.length > 0 ? "pass" : "invalid",
      { exists: true, valid_xml: looksXml, url_count: sitemapUrls.length },
      sitemapProv,
    );
    for (const url of sitemapUrls.slice(0, SITEMAP_SPOT_CHECK_LIMIT)) {
      const spot = await politeFetch(url, { method: "HEAD" });
      row(
        `crawl/sitemap-spot-check@v1/${url}`,
        spot.error !== null ? "fail" : spot.ok ? "pass" : "broken",
        spot.error !== null ? { error: spot.error } : { http_status: spot.status },
        provenance(url, spot.fetchedAt, "HEAD"),
      );
    }
  }

  // -- pages: homepage/locale root + 4 sitemap URLs, stratified so at least 2 are deep
  // content pages (locale-root-only sampling read hreflang_coverage as 1.0 while deep
  // pages like /en/blog/* had zero hreflang). Prefers /blog/ paths for the deep slots.
  const pages = [homepage, ...samplePages(sitemapUrls, homepage)];
  for (const pageUrl of pages) {
    const page = await politeFetch(pageUrl);
    const pageProv = provenance(pageUrl, page.fetchedAt, "GET");
    if (page.error !== null || !page.ok || page.body === null) {
      const failValue =
        page.error !== null ? { error: page.error } : { http_status: page.status };
      for (const check of ["ssr", "hreflang", "canonical", "json-ld", "noai-meta"]) {
        row(`crawl/${check}@v1/${pageUrl}`, "fail", failValue, pageProv);
      }
      continue;
    }
    const html = page.body;

    // SSR: is the content present without JS? Text extracted from raw HTML.
    const text = stripToText(html);
    row(
      `crawl/ssr@v1/${pageUrl}`,
      text.length >= SSR_MIN_TEXT_CHARS ? "pass" : "thin",
      { text_chars: text.length, html_chars: html.length, min_text_chars: SSR_MIN_TEXT_CHARS },
      pageProv,
    );

    // hreflang link tags
    const hreflangs = extractLinkTags(html, "alternate")
      .map((tag) => ({ hreflang: extractAttr(tag, "hreflang"), href: extractAttr(tag, "href") }))
      .filter((h) => h.hreflang !== null);
    row(
      `crawl/hreflang@v1/${pageUrl}`,
      hreflangs.length > 0 ? "present" : "absent",
      { count: hreflangs.length, entries: hreflangs },
      pageProv,
    );

    // canonical
    const canonicalTags = extractLinkTags(html, "canonical");
    const canonicalHref = canonicalTags.length > 0 ? extractAttr(canonicalTags[0], "href") : null;
    row(
      `crawl/canonical@v1/${pageUrl}`,
      canonicalHref ? "present" : "absent",
      { href: canonicalHref, tag_count: canonicalTags.length },
      pageProv,
    );

    // JSON-LD schema types
    const schemaTypes = extractJsonLdTypes(html);
    row(
      `crawl/json-ld@v1/${pageUrl}`,
      schemaTypes.length > 0 ? "present" : "absent",
      { types: schemaTypes },
      pageProv,
    );

    // noai / noimageai meta
    const noai = extractNoaiMeta(html);
    row(
      `crawl/noai-meta@v1/${pageUrl}`,
      noai.noai || noai.noimageai ? "present" : "absent",
      { robots_meta: noai.robotsContent, noai: noai.noai, noimageai: noai.noimageai },
      pageProv,
    );
  }

  // -- per-bot access probes on the homepage --------------------------------
  for (const bot of BOTS) {
    const ua = `Mozilla/5.0 (compatible; ${bot}/1.0)`;
    let probe = await politeFetch(homepage, { method: "HEAD", userAgent: ua });
    let method = "HEAD";
    if (probe.error === null && probe.status !== null && probe.status === 405) {
      probe = await politeFetch(homepage, { method: "GET", userAgent: ua });
      method = "GET";
    }
    row(
      `crawl/bot-access@v1/${bot}`,
      probe.error !== null ? "fail" : probe.ok ? "pass" : "blocked",
      probe.error !== null
        ? { error: probe.error, user_agent: ua }
        : { http_status: probe.status, user_agent: ua },
      provenance(homepage, probe.fetchedAt, method),
    );
  }

  return { evidence: rows, panelObservations: [], cost: 0 };
}
