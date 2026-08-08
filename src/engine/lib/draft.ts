// Draft onboarding (answerable draft <domain>): probe a live site with the crawl station's own
// polite fetch helpers and propose a surface config. Everything in the output is either
// observed on the site (locales from hreflang/paths, brand + description from
// title/JSON-LD/meta, competitors from comparison-page titles) or derived from the
// site's own claimed category (seeded discovery prompts). The result is a
// config/surfaces/<slug>.proposed.yaml full of `# proposed:` comments; a human promotes
// it. Probe failures degrade to smaller proposals, never a throw.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { safeFetch } from "./safe-fetch";
import { assertSurfaceId } from "./surface";
import {
  extractLinkTags,
  extractAttr,
  extractJsonLdTypes,
  stripToText,
  type FetchOutcome,
} from "../sense/adapters/crawl";

const CRAWL_PAGE_LIMIT = 12; // small crawl over sitemap URLs for comparison titles
const COMPARISON_RE = /\balternatives?\b|\bvs\.?\b|\bversus\b|\bcompare\b|\bcomparison\b/i;

export interface DraftProbe {
  domain: string;
  slug: string;
  brand: string;
  description: string | null;
  category: string | null;
  locales: string[]; // primary first
  localeSource: "hreflang" | "paths" | "none";
  competitors: { name: string; url: string }[];
  prompts: string[];
  pagesCrawled: number;
  notes: string[];
  yamlPath: string;
  yaml: string;
}

// Basic named/numeric entity decode: probe strings feed yaml text, not HTML.
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&(?:apos|#39);/g, "'");
}

export function titleOf(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? decodeEntities(stripToText(m[1])) : null;
}

// A <title> tag is ornament plus one segment that names the site — but which segment is
// the name is not fixed by position: "Brand | Tagline" and "Tagline | Brand" both occur in
// the wild (Mailchimp's own <title> is "Die E-Mail-Marketing-Plattform jetzt mit SMS |
// Mailchimp", brand last). The domain's registrable label is the one signal a site can't
// disguise, so prefer whichever segment matches it, regardless of position; when no
// segment matches, fall back to the label itself rather than guessing a position.
export function brandSegmentFromTitle(title: string, domainLabel: string): string {
  const segments = title
    .split(/\s*[|:•·]\s+|\s+[-–—]\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const normalize = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
  const target = normalize(domainLabel);
  const match = segments.find((s) => normalize(s) === target);
  return match ?? domainLabel;
}

export function metaDescription(html: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = extractAttr(tag, "name")?.toLowerCase();
    if (name === "description" || extractAttr(tag, "property")?.toLowerCase() === "og:description") {
      const content = extractAttr(tag, "content");
      if (content) return decodeEntities(content);
    }
  }
  return null;
}

// JSON-LD Organization/WebSite name + description, when the site declares one.
export function jsonLdIdentity(html: string): { name: string | null; description: string | null } {
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(m[1]);
      const nodes = Array.isArray(parsed) ? parsed : (parsed["@graph"] ?? [parsed]);
      for (const node of Array.isArray(nodes) ? nodes : [nodes]) {
        const t = node?.["@type"];
        const types = Array.isArray(t) ? t : [t];
        if (types.some((x) => x === "Organization" || x === "WebSite" || x === "SoftwareApplication")) {
          return {
            name: typeof node.name === "string" ? node.name : null,
            description: typeof node.description === "string" ? node.description : null,
          };
        }
      }
    } catch {
      // unparseable block: identity comes from title/meta instead
    }
  }
  return { name: null, description: null };
}

export function localesFromHreflang(html: string): string[] {
  const out: string[] = [];
  for (const tag of extractLinkTags(html, "alternate")) {
    const h = extractAttr(tag, "hreflang");
    if (h && h !== "x-default" && !out.includes(h)) out.push(h);
  }
  return out;
}

// Locale-shaped first path segments over the sitemap URLs (e.g. /fr/, /pt-br/).
export function localesFromPaths(urls: string[]): string[] {
  const counts = new Map<string, number>();
  for (const u of urls) {
    try {
      const seg = new URL(u).pathname.split("/").filter(Boolean)[0];
      if (seg && /^[a-z]{2}(-[a-z]{2})?$/i.test(seg)) counts.set(seg.toLowerCase(), (counts.get(seg.toLowerCase()) ?? 0) + 1);
    } catch {
      // unparseable URL: skip
    }
  }
  // A locale prefix appearing once is likely a page slug ("go", "us"); require 2+.
  return [...counts.entries()].filter(([, n]) => n >= 2).map(([l]) => l);
}

// The site's own claimed category: the phrase after the brand/separator in its title,
// or the leading noun phrase of its description.
export function claimedCategory(title: string | null, description: string | null, brand: string): string | null {
  if (title) {
    const brandLower = brand.toLowerCase();
    const afterSep = title.split(/\s*[|:•·]\s+|\s+[-–—]\s+/).map((s) => s.trim()).filter(Boolean);
    const usable = afterSep.filter((s) => s.toLowerCase() !== brandLower && s.length > 8);
    // A segment that merely restates the brand name ("Example Software" for brand "Example")
    // names the brand, not the category it competes in; prefer a segment that
    // carries neither, and settle for a name-carrying one only if that is all
    // the title offers.
    const candidate = usable.find((s) => !s.toLowerCase().includes(brandLower)) ?? usable[0];
    if (candidate) return candidate;
  }
  if (description) {
    const first = description.split(/[.!]/)[0].trim();
    if (first.length > 0) return first.length > 90 ? `${first.slice(0, 90)}…` : first;
  }
  return null;
}

// Competitor names out of a comparison-page title: "X vs Y", "N best X alternatives".
//
// The "vs" branch requires the BRAND ITSELF to be one side of the comparison, and that
// requirement is what makes the output a competitor list rather than a word list. Sites
// use "vs" constantly for two of their own concepts ("anonymous vs identified events",
// "churn rate vs retention rate"), and every such page was previously read as naming two
// rivals — names that then travel into comparison pages and outreach drafts as observed
// competitors. Requiring the brand to be a whole side (not merely present somewhere in
// the title, since most titles end in " - Brand") keeps "PostHog vs Mixpanel" and drops
// "Glue teams vs back-office teams - PostHog". Under-reading is the right error here:
// an operator fills a short list in by hand, but cannot see that a long one is fiction.
export function competitorsFromTitle(title: string, brand: string | string[]): string[] {
  const out: string[] = [];
  // The brand goes by several written forms on its own pages — the JSON-LD name
  // ("Plausible Analytics"), the domain label ("plausible"), the title segment — and a
  // page titled "Plausible vs Matomo" must be recognised whichever form the caller holds.
  // So the caller passes every form it knows, and each contributes its first word too.
  const forms = new Set<string>();
  for (const name of Array.isArray(brand) ? brand : [brand]) {
    const lower = name.trim().toLowerCase();
    if (!lower) continue;
    forms.add(lower);
    forms.add(lower.split(/\s+/)[0]);
  }
  const isBrand = (name: string): boolean => forms.has(name.trim().toLowerCase());
  const clean = (part: string): string =>
    part
      .replace(/^\s*\d+\s*/, "")
      .replace(/[|:•·].*$/, "")
      .replace(/\s+[-–—]\s+.*$/, "") // trailing " - Brand" / " — Docs - Brand" ornament
      .replace(/\(\s*\d{4}\s*\)/g, "")
      .replace(/\b(best|top|alternatives?|comparison|compare|review|in \d{4})\b/gi, "")
      .trim()
      .replace(/[,.]+$/, "");
  const vsParts = title.split(/\bvs\.?\b|\bversus\b/i);
  if (vsParts.length > 1) {
    const cleaned = vsParts.map(clean);
    if (cleaned.some(isBrand)) {
      for (const name of cleaned) {
        // "A vs B vs C" happens ("Cloudflare Web Analytics vs Plausible: a dedicated tool
        // vs a side feature"), and the trailing sides are prose, not names. A product name
        // does not open with an article, so those sides are dropped.
        if (/^(a|an|the)\s/i.test(name)) continue;
        if (name && !isBrand(name) && name.length < 40) out.push(name);
      }
    }
  }
  const altMatch = /(?:to|for)\s+([A-Z][\w.-]+(?:\s+[A-Z][\w.-]+)?)\s*(?:alternatives?|$)/.exec(title) ??
    /^([\w.-]+)\s+alternatives?\b/i.exec(title.trim());
  if (altMatch && !isBrand(altMatch[1])) out.push(altMatch[1].trim());
  return out;
}

// Sitemap URLs for one origin, via robots.txt's own pointer when it has one. Shared with
// the brand probe (brand-draft.ts), which needs the same page list to find comparison
// pages: two entry points reading the same site must read it the same way.
export async function fetchSitemapUrls(origin: string): Promise<{ urls: string[]; note: string | null }> {
  const robots = await safeFetch(`${origin}/robots.txt`);
  const sitemapPointer = robots.ok && robots.body ? /^sitemap:\s*(\S+)/im.exec(robots.body)?.[1] : undefined;
  const sitemapRes = await safeFetch(sitemapPointer ?? `${origin}/sitemap.xml`);
  if (!sitemapRes.ok || !sitemapRes.body) {
    return { urls: [], note: `sitemap not readable (${sitemapRes.error ?? `http ${sitemapRes.status}`})` };
  }
  let urls = [...sitemapRes.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
  // Sitemap index: follow the first child sitemap for real page URLs.
  if (/<sitemapindex/i.test(sitemapRes.body) && urls.length > 0) {
    const child = await safeFetch(urls[0]);
    if (child.ok && child.body) {
      urls = [...child.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
    }
  }
  return { urls, note: null };
}

// Small crawl for competitor names: comparison-shaped URLs first, then a general sample.
// A competitor list is not decoration — the comparison-page and outreach generators both
// key off competitor claims, so a config that ships with `competitors: []` produces
// strictly less than one that does not. Shared by `draft` and `brand add` for exactly
// that reason.
export async function discoverCompetitors(
  sitemapUrls: string[],
  brand: string | string[],
): Promise<{ competitors: { name: string; url: string }[]; pagesCrawled: number; note: string | null }> {
  const comparisonUrls = sitemapUrls.filter((u) => COMPARISON_RE.test(u));
  const crawlSet = [...comparisonUrls, ...sitemapUrls.filter((u) => !comparisonUrls.includes(u))].slice(0, CRAWL_PAGE_LIMIT);
  const competitorNames = new Map<string, string>(); // name -> first url seen on
  let pagesCrawled = 0;
  for (const url of crawlSet) {
    const page = await safeFetch(url);
    pagesCrawled += 1;
    if (!page.ok || !page.body) continue;
    const pageTitle = titleOf(page.body);
    if (!pageTitle || !COMPARISON_RE.test(pageTitle)) continue;
    for (const name of competitorsFromTitle(pageTitle, brand)) {
      if (!competitorNames.has(name)) competitorNames.set(name, url);
    }
  }
  return {
    competitors: [...competitorNames.entries()].map(([name, url]) => ({ name, url })),
    pagesCrawled,
    note:
      competitorNames.size === 0 && pagesCrawled > 0
        ? `no competitor names found in comparison-page titles over ${pagesCrawled} crawled page(s)`
        : null,
  };
}

// Competitors, rendered identically by `draft` and `brand add`.
//
// The NAME is what the probe observed; the URL is not. The only URL the probe holds is the
// brand's OWN comparison page, and `competitors[].url` is not provenance — the competitor
// lane FETCHES it as that competitor's homepage (src/engine/sense/adapters/competitor.ts),
// so writing the brand's page there would collect the brand's own content and file it as a
// rival's evidence. Neither is there a defensible way to guess a company's homepage from
// its name. So discovered competitors are emitted as commented-out entries citing the page
// they were read from, with the list left empty and valid: the operator pastes the ones
// that are real and supplies the URL only they can know.
export function renderCompetitors(competitors: { name: string; url: string }[], emptyAdvice: string): string[] {
  if (competitors.length === 0) {
    return [`competitors: []  # proposed: no comparison-page titles on the site named any; ${emptyAdvice}`];
  }
  const lines = [
    `competitors: []  # proposed: names below were read off comparison-page titles on the brand's own site.`,
    `  # proposed: uncomment the ones that are really competitors and give each its own homepage URL`,
    `  # proposed: (the competitor lane FETCHES that url, so it must be the competitor's site, not the page below).`,
  ];
  for (const c of competitors) {
    lines.push(`  # - name: ${yamlQuote(c.name)}`);
    lines.push(`  #   url: ""  # seen on ${c.url}`);
  }
  return lines;
}

export function yamlQuote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function renderProposedYaml(p: Omit<DraftProbe, "yaml" | "yamlPath">): string {
  const primary = p.locales[0] ?? "en";
  const nonPrimary = p.locales.slice(1);
  const lines: string[] = [
    `# proposed: drafted by \`answerable draft ${p.domain}\`, ${new Date().toISOString().slice(0, 10)}. Review every`,
    `# proposed: field, then rename to ${p.slug}.yaml and \`answerable onboard\` it.`,
    `id: ${p.slug}`,
    `kind: site`,
    `target:`,
    `  domain: ${p.domain}`,
    `  path_prefix: /  # proposed: adjust when the primary locale lives under /${primary}/`,
    `  locale: ${primary}  # proposed: primary locale, ${p.localeSource === "none" ? "no locale signals observed; defaulted to en" : `observed via ${p.localeSource}`}`,
  ];
  if (nonPrimary.length > 0) {
    lines.push(`  # proposed: non-primary locales observed on the site; each becomes its own`);
    lines.push(`  # proposed: site surface file when you want it tracked:`);
    for (const l of nonPrimary) lines.push(`  # locale: ${l}`);
  }
  lines.push(
    `audience: >-  # proposed: from the site's own description; replace with the real brief`,
    `  ${p.description ?? `Visitors of ${p.domain} (no meta description observed; write the audience by hand).`}`,
    `business_goal: >-  # proposed: placeholder; state the real goal`,
    `  Grow qualified search and AI-answer visibility for ${p.brand}.`,
    `desired_conversion: signup  # proposed: replace with the site's real conversion`,
    ...renderCompetitors(p.competitors, "fill by hand"),
  );
  lines.push(
    `publishing:`,
    `  policy: review-required`,
    `  owner: operator  # proposed: confirm the owner`,
    `  # repo: owner/name  # proposed: set to open real PRs on approve (directed and verified, never autonomous)`,
    `lanes:`,
    `  crawl:`,
    `    enabled: true`,
    `  community:`,
    `    enabled: false  # proposed: enable once query sets are chosen`,
    `# proposed: seeded discovery prompts from the site's claimed category` +
      (p.category ? ` ("${p.category.replace(/"/g, "'")}")` : " (category not observed)"),
    `# proposed: use these as the prompt_set of a companion assistant surface:`,
  );
  for (const prompt of p.prompts) lines.push(`#   - ${yamlQuote(prompt)}`);
  lines.push(
    `# cadence: weekly  # proposed: uncomment to put this surface on the tick schedule`,
    `policy: {}  # default class weights`,
  );
  return lines.join("\n") + "\n";
}

export async function draft(domain: string, projectRoot = process.cwd()): Promise<DraftProbe> {
  const notes: string[] = [];
  const cleanDomain = domain.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const origin = `https://${cleanDomain}`;
  const slug = cleanDomain.replace(/^www\./, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-+|-+$/g, "").slice(0, 64);
  assertSurfaceId(slug, `draft ${domain}`); // slug becomes a file name and surface id

  const home: FetchOutcome = await safeFetch(`${origin}/`);
  const html = home.ok && home.body ? home.body : "";
  if (!html) notes.push(`homepage fetch failed (${home.error ?? `http ${home.status}`}); proposal degrades to defaults`);

  const title = titleOf(html);
  const jsonLd = jsonLdIdentity(html);
  const domainLabel = cleanDomain.replace(/^www\./, "").split(".")[0];
  const brand = jsonLd.name ?? brandSegmentFromTitle(title ?? "", domainLabel);
  const description = metaDescription(html) ?? jsonLd.description;
  if (extractJsonLdTypes(html).length === 0) notes.push("no JSON-LD on the homepage; brand taken from the title tag");

  // Locales: hreflang first, sitemap path prefixes second.
  let locales = localesFromHreflang(html);
  let localeSource: DraftProbe["localeSource"] = locales.length > 0 ? "hreflang" : "none";

  // Sitemap for locale paths + the small comparison crawl.
  const sitemap = await fetchSitemapUrls(origin);
  const sitemapUrls = sitemap.urls;
  if (sitemap.note) notes.push(`${sitemap.note}; locale paths and comparison crawl limited`);
  if (locales.length === 0 && sitemapUrls.length > 0) {
    locales = localesFromPaths(sitemapUrls);
    if (locales.length > 0) localeSource = "paths";
  }

  const discovered = await discoverCompetitors(sitemapUrls, [brand, cleanDomain.replace(/^www\./, "").split(".")[0]]);
  const pagesCrawled = discovered.pagesCrawled;
  if (discovered.note) notes.push(discovered.note);

  const category = claimedCategory(title, description, brand);
  const categoryPhrase = category ?? `what ${cleanDomain.replace(/^www\./, "")} offers`;
  const prompts = [
    `best tools for ${categoryPhrase.toLowerCase()}`,
    `${brand} alternatives`,
    `is ${brand} worth it`,
    `${categoryPhrase.toLowerCase()}: which product should I use?`,
  ];

  const probe: Omit<DraftProbe, "yaml" | "yamlPath"> = {
    domain: cleanDomain,
    slug,
    brand,
    description,
    category,
    locales,
    localeSource,
    competitors: discovered.competitors,
    prompts,
    pagesCrawled,
    notes,
  };
  const yaml = renderProposedYaml(probe);
  const outDir = path.join(projectRoot, "config", "surfaces");
  mkdirSync(outDir, { recursive: true });
  const yamlPath = path.join(outDir, `${slug}.proposed.yaml`);
  writeFileSync(yamlPath, yaml);
  return { ...probe, yaml, yamlPath };
}
