// Brand network discovery: fetch every candidate surface directly rather than trust
// search-snippet inference, since a direct fetch confirms a surface actually exists and
// belongs to the brand, where a snippet only confirms a search engine indexed something
// that looked related. Given a domain, probe the brand's own site — through the same
// SSRF-guarded fetch
// the draft prober uses — and propose the brand's whole discoverable network as a
// BrandProposal: web properties with their locale clusters, app-store listings and
// social profiles from the site's own header/footer links, and the two AI-answer
// lanes (always proposed — every brand competes in AI answers whether or not it
// knows it). Everything carries per-facet evidence (what was observed where);
// unreachable probes are reported honestly, never guessed at.

import { lookup } from "node:dns/promises";
import { safeFetch } from "./safe-fetch";
import {
  titleOf,
  metaDescription,
  jsonLdIdentity,
  localesFromHreflang,
  localesFromPaths,
  claimedCategory,
} from "./draft";
import { extractAttr } from "../sense/adapters/crawl";

// Modest candidate probe: the well-known subdomain set, plus any same-registrable-domain
// hosts found in the homepage's own links (a direct-fetch audit surfaces subdomains
// like go/api that this candidate list alone would miss).
const SUBDOMAIN_CANDIDATES = ["www", "app", "api", "blog", "docs", "shop", "go", "cdn"];

// Known host patterns for store listings and social profiles.
const STORE_HOSTS: Record<string, string> = {
  "apps.apple.com": "Apple App Store",
  "play.google.com": "Google Play",
};
// Content paths on social hosts (a reel, post, or video link is not a profile).
const SOCIAL_CONTENT_RE = /\/(reel|reels|p|posts|watch|shorts|status|video|videos)\//i;

const SOCIAL_HOSTS: Record<string, string> = {
  "linkedin.com": "LinkedIn",
  "x.com": "X",
  "twitter.com": "X",
  "instagram.com": "Instagram",
  "youtube.com": "YouTube",
  "github.com": "GitHub",
};

export interface FacetEvidence {
  observed: string; // what was seen
  where: string; // on what URL / via what probe
}

// Linkage strength of a discovered facet: how the probe tied it to the brand.
// Strong = a machine-checkable tie (a DNS record under the brand's own domain, a
// canonical declaration, or a link on the brand's own page). Weak = the facet
// merely looks like the brand by name, which is a guess and must be confirmed by
// a human before it is offered for monitoring.
//
// The predicates key off the exact `observed` strings this file emits:
// "DNS resolves", "declares <host> canonical — …", "linked from the site's own
// page", "profile linked from the site's own page", "name similarity: …".
export function isStrongLinkageEvidence(e: FacetEvidence): boolean {
  const o = e.observed.toLowerCase();
  return (
    o.startsWith("dns resolves") ||
    /^declares \S+ canonical\b/.test(o) ||
    o.includes("linked from the site's own page")
  );
}

export function facetLinkage(evidence: FacetEvidence[]): "strong" | "weak" {
  return evidence.some(isStrongLinkageEvidence) ? "strong" : "weak";
}

export interface WebsiteFacet {
  host: string; // full hostname, e.g. app.example.com
  url: string;
  primary: boolean; // the seed domain's own property
  reachable: boolean;
  title: string | null;
  locales: string[]; // this property's locale cluster (primary first), [] = none observed
  localeSource: "hreflang" | "paths" | "none";
  // Other hostnames observed serving this same property (today: the www/apex
  // sibling). One property is one facet, so the sibling is an alias here rather
  // than a second website the operator is invited to "discover".
  aliases: string[];
  evidence: FacetEvidence[];
}

export interface StoreListingFacet {
  store: string; // Apple App Store | Google Play
  url: string;
  evidence: FacetEvidence[];
}

export interface SocialProfileFacet {
  network: string;
  url: string;
  evidence: FacetEvidence[];
}

export interface AiLaneFacet {
  engine: "chatgpt" | "claude";
  prompts: string[]; // standard discovery set seeded from the site's claimed category
  evidence: FacetEvidence[];
}

export interface UnreachableProbe {
  target: string;
  error: string;
}

export interface BrandProposal {
  brand: {
    name: string;
    primaryDomain: string; // the seed host as served (www kept if it serves)
    description: string | null;
    category: string | null;
  };
  facets: {
    websites: WebsiteFacet[];
    store_listings: StoreListingFacet[];
    social_profiles: SocialProfileFacet[];
    ai_lanes: AiLaneFacet[];
  };
  unreachable: UnreachableProbe[]; // probes attempted and failed — reported, never guessed
  notes: string[];
}

// example.com from app.example.com — naive registrable-domain: last two labels.
// Good enough for the candidate probe (multi-label public suffixes would only
// widen the candidate set, and every candidate is DNS-checked before use).
export function registrableDomain(host: string): string {
  const parts = host.toLowerCase().split(".").filter(Boolean);
  return parts.slice(-2).join(".");
}

// www.example.com and example.com are two addresses of one web property, never
// two properties.
export function bareHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

export function sameProperty(a: string, b: string): boolean {
  return bareHost(a) === bareHost(b);
}

// The page's own declared canonical hostname, when it declares one. This is how
// the site says it wants to be addressed, which is what the property's facet
// should be named.
export function canonicalHost(html: string, baseUrl: string): string | null {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = extractAttr(tag, "rel")?.toLowerCase();
    if (rel !== "canonical") continue;
    const href = extractAttr(tag, "href");
    if (!href) continue;
    try {
      return new URL(href, baseUrl).hostname.toLowerCase();
    } catch {
      return null;
    }
  }
  return null;
}

// All href values in a page, absolute against the page URL.
export function extractHrefs(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  for (const tag of html.match(/<a\b[^>]*>/gi) ?? []) {
    const href = extractAttr(tag, "href");
    if (!href) continue;
    try {
      const abs = new URL(href, baseUrl);
      if (abs.protocol === "http:" || abs.protocol === "https:") out.push(abs.toString());
    } catch {
      // unparseable href: skip
    }
  }
  return out;
}

// The standard discovery prompt-set (same grammar as draft.ts's seeded prompts),
// seeded from the site's own claimed category.
export function discoveryPrompts(brand: string, category: string | null, domain: string): string[] {
  const categoryPhrase = (category ?? `what ${domain.replace(/^www\./, "")} offers`).toLowerCase();
  return [
    `best tools for ${categoryPhrase}`,
    `${brand} alternatives`,
    `is ${brand} worth it`,
    `${categoryPhrase}: which product should I use?`,
  ];
}

async function resolves(host: string): Promise<boolean> {
  try {
    return (await lookup(host, { all: true })).length > 0;
  } catch {
    return false;
  }
}

// Probe one web property: fetch its homepage, read title + hreflang locales.
async function probeProperty(
  host: string,
  primary: boolean,
  unreachable: UnreachableProbe[],
): Promise<WebsiteFacet> {
  const url = `https://${host}/`;
  const res = await safeFetch(url);
  const evidence: FacetEvidence[] = [];
  if (!res.ok || !res.body) {
    const error = res.error ?? `http ${res.status}`;
    unreachable.push({ target: url, error });
    evidence.push({ observed: `probe failed (${error})`, where: url });
    return { host, url, primary, reachable: false, title: null, locales: [], localeSource: "none", aliases: [], evidence };
  }
  const title = titleOf(res.body);
  evidence.push({ observed: title ? `serves "${title}"` : "serves a page (no title tag)", where: url });
  const locales = localesFromHreflang(res.body);
  if (locales.length > 0) {
    evidence.push({ observed: `${locales.length} hreflang locale(s): ${locales.join(", ")}`, where: url });
  }
  return {
    host,
    url,
    primary,
    reachable: true,
    title,
    locales,
    localeSource: locales.length > 0 ? "hreflang" : "none",
    aliases: [],
    evidence,
  };
}

export async function draftBrand(domain: string): Promise<BrandProposal> {
  const notes: string[] = [];
  const unreachable: UnreachableProbe[] = [];
  const seedHost = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
  const apex = registrableDomain(seedHost);
  const origin = `https://${seedHost}`;

  // 1. Homepage: identity + locales + links.
  const home = await safeFetch(`${origin}/`);
  const html = home.ok && home.body ? home.body : "";
  if (!html) {
    const error = home.error ?? `http ${home.status}`;
    unreachable.push({ target: `${origin}/`, error });
    notes.push(`homepage fetch failed (${error}); proposal degrades to the AI lanes and defaults`);
  }
  const title = titleOf(html);
  const jsonLd = jsonLdIdentity(html);
  const name =
    jsonLd.name ??
    title?.split(/\s*[|:•·]\s+|\s+[-–—]\s+/)[0]?.trim() ??
    apex.split(".")[0];
  const description = metaDescription(html) ?? jsonLd.description;
  const category = claimedCategory(title, description, name);

  // One property, one facet: if the site declares the www/apex sibling of the
  // seed canonical, that is the form it wants to be addressed by (and the form
  // an existing monitored surface will already be named after). Adopt it as the
  // property's host and keep the seed as an observed alias — never emit the
  // sibling as a second "discovered" website.
  const declaredCanonical = canonicalHost(html, `${origin}/`);
  const primaryHost =
    declaredCanonical && sameProperty(declaredCanonical, seedHost) ? declaredCanonical : seedHost;
  const aliases = primaryHost === seedHost ? [] : [seedHost];

  // 2. Primary property locales: hreflang first, sitemap path patterns second.
  let primaryLocales = localesFromHreflang(html);
  let localeSource: WebsiteFacet["localeSource"] = primaryLocales.length > 0 ? "hreflang" : "none";
  const primaryEvidence: FacetEvidence[] = html
    ? [{ observed: title ? `serves "${title}"` : "serves a page (no title tag)", where: `${origin}/` }]
    : [{ observed: `probe failed (${home.error ?? `http ${home.status}`})`, where: `${origin}/` }];
  if (primaryLocales.length > 0) {
    primaryEvidence.push({
      observed: `${primaryLocales.length} hreflang locale(s): ${primaryLocales.join(", ")}`,
      where: `${origin}/`,
    });
  }
  if (html && primaryLocales.length === 0) {
    const robots = await safeFetch(`${origin}/robots.txt`);
    if (!robots.ok || !robots.body) {
      unreachable.push({
        target: `${origin}/robots.txt`,
        error: robots.error ?? `http ${robots.status}`,
      });
    }
    const sitemapPointer = robots.ok && robots.body ? /^sitemap:\s*(\S+)/im.exec(robots.body)?.[1] : undefined;
    const sitemapUrl = sitemapPointer ?? `${origin}/sitemap.xml`;
    const sitemapRes = await safeFetch(sitemapUrl);
    if (sitemapRes.ok && sitemapRes.body) {
      let urls = [...sitemapRes.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
      if (/<sitemapindex/i.test(sitemapRes.body) && urls.length > 0) {
        const child = await safeFetch(urls[0]);
        if (child.ok && child.body) {
          urls = [...child.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
        } else {
          unreachable.push({ target: urls[0], error: child.error ?? `http ${child.status}` });
        }
      }
      primaryLocales = localesFromPaths(urls);
      if (primaryLocales.length > 0) {
        localeSource = "paths";
        primaryEvidence.push({
          observed: `${primaryLocales.length} locale path pattern(s): ${primaryLocales.join(", ")}`,
          where: sitemapUrl,
        });
      }
    } else {
      unreachable.push({ target: sitemapUrl, error: sitemapRes.error ?? `http ${sitemapRes.status}` });
    }
  }

  // 3. Link extraction: store listings, social profiles, and same-brand hosts.
  const hrefs = html ? extractHrefs(html, `${origin}/`) : [];
  const storeByUrl = new Map<string, StoreListingFacet>();
  const socialByUrl = new Map<string, SocialProfileFacet>();
  const linkedHosts = new Set<string>();
  for (const href of hrefs) {
    const u = new URL(href);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const cleanUrl = `${u.origin}${u.pathname}`;
    if (STORE_HOSTS[host]) {
      if (!storeByUrl.has(cleanUrl)) {
        storeByUrl.set(cleanUrl, {
          store: STORE_HOSTS[host],
          url: cleanUrl,
          evidence: [{ observed: `linked from the site's own page`, where: `${origin}/` }],
        });
      }
    } else if (SOCIAL_HOSTS[host] && u.pathname.length > 1 && !SOCIAL_CONTENT_RE.test(u.pathname)) {
      if (!socialByUrl.has(cleanUrl)) {
        socialByUrl.set(cleanUrl, {
          network: SOCIAL_HOSTS[host],
          url: cleanUrl,
          evidence: [{ observed: `profile linked from the site's own page`, where: `${origin}/` }],
        });
      }
    } else if (registrableDomain(u.hostname) === apex && u.hostname.toLowerCase() !== seedHost) {
      linkedHosts.add(u.hostname.toLowerCase());
    }
  }

  // 4. Subdomain candidate probe: well-known set + link-discovered hosts, DNS
  // resolution first, HTTP probe only on hosts that resolve.
  const candidates = new Set<string>(linkedHosts);
  for (const sub of SUBDOMAIN_CANDIDATES) {
    const host = `${sub}.${apex}`;
    if (host !== seedHost) candidates.add(host);
  }
  if (aliases.length > 0) {
    primaryEvidence.push({
      observed: `declares ${primaryHost} canonical — ${seedHost} and ${primaryHost} serve the same property`,
      where: `${origin}/`,
    });
  }
  const websites: WebsiteFacet[] = [
    {
      host: primaryHost,
      url: `https://${primaryHost}/`,
      primary: true,
      reachable: html.length > 0,
      title,
      locales: primaryLocales,
      localeSource,
      aliases,
      evidence: primaryEvidence,
    },
  ];
  for (const host of [...candidates].sort()) {
    if (sameProperty(host, primaryHost)) continue; // an alias of the primary, not a second property
    if (!(await resolves(host))) continue; // no DNS record: not part of the network, not a failed probe
    const facet = await probeProperty(host, false, unreachable);
    facet.evidence.unshift({ observed: "DNS resolves", where: host });
    websites.push(facet);
  }

  // 5. AI-answer lanes: ALWAYS proposed — the brand competes in AI answers
  // regardless of what the probe reached (a real GEO panel run found zero
  // discovery-share for a comparable brand across two AI-answer lanes; that zero
  // is a finding worth surfacing, not an absence to skip proposing).
  const prompts = discoveryPrompts(name, category, seedHost);
  const laneEvidence: FacetEvidence[] = [
    {
      observed: category
        ? `discovery prompts seeded from the site's claimed category ("${category}")`
        : "discovery prompts seeded from the domain (no category observed on the site)",
      where: `${origin}/`,
    },
  ];
  // Each lane owns its arrays, never a shared instance: serializers that dedupe
  // repeated objects into references corrupt the second lane on a round trip.
  const ai_lanes: AiLaneFacet[] = [
    { engine: "chatgpt", prompts: [...prompts], evidence: laneEvidence.map((e) => ({ ...e })) },
    { engine: "claude", prompts: [...prompts], evidence: laneEvidence.map((e) => ({ ...e })) },
  ];

  return {
    brand: { name, primaryDomain: primaryHost, description, category },
    facets: {
      websites,
      store_listings: [...storeByUrl.values()],
      social_profiles: [...socialByUrl.values()],
      ai_lanes,
    },
    unreachable,
    notes,
  };
}
