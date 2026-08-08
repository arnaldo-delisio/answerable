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
  brandSegmentFromTitle,
  fetchSitemapUrls,
  discoverCompetitors,
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
  // Competitor names read off the primary property's own comparison-page titles
  // ("X vs Y", "best X alternatives"). Observed, never guessed, and empty when the site
  // publishes no comparison pages.
  competitors: { name: string; url: string }[];
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

// A raw <title> or JSON-LD name can carry page ornament — icons rendered as
// glyphs ("</> htmx"), ASCII art, emoji, separator junk — that must never reach
// a prompt a human or an AI answer engine will read. Strip anything that isn't
// a letter, digit, or the handful of punctuation marks a real brand name can
// contain (&, ', ., -), collapse whitespace, and if nothing plausible survives
// fall back to the registrable domain's label: the domain is always defensible,
// where a "cleaned" guess at the operator's intent is not.
// A title with no separator at all (some marketing sites ship a <title> that is
// pure tagline, with the brand name absent from it entirely — trello.com's is
// "Capture, organize, and tackle your to-dos from anywhere") leaves the whole
// sentence as the "name" candidate once ornament is stripped. Brand names run
// short; a five-plus-word survivor reads as a sentence, not a name, so it falls
// back the same way an empty/ornament-only survivor does.
const MAX_NAME_WORDS = 5;

export function cleanBrandToken(raw: string, domainLabel: string): string {
  const stripped = raw
    .replace(/[^\p{L}\p{N}\s&'.-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped || !/[\p{L}\p{N}]/u.test(stripped)) return domainLabel;
  if (stripped.split(" ").length > MAX_NAME_WORDS) return domainLabel;
  return stripped;
}

// Hype/superlative words that mark a phrase as marketing copy ("high power
// tools", "the ultimate server") rather than a category name ("project
// management software"): a category names a class of thing; a tagline sells
// it. Checked anywhere in the phrase, not just the opening word — "the" alone
// is too common a word in genuine category names ("the developer platform")
// to blocklist, but "the ultimate X" is caught via "ultimate".
const HYPE_WORDS = new Set([
  "best", "high", "top", "leading", "powerful", "ultimate", "great", "amazing",
  "revolutionary", "innovative", "premium", "super", "world-class",
  "next-gen", "easy", "simple", "fast", "smart", "all-in-one", "simply",
]);
// Verbs that put a phrase in imperative/marketing-pitch shape ("power your
// workflow", "build anything") rather than noun-phrase shape ("workflow
// automation software").
const PITCH_VERBS = new Set([
  "get", "build", "create", "boost", "unlock", "simplify", "supercharge",
  "manage", "grow", "scale", "automate", "launch", "transform", "optimize",
  "empower", "power",
]);

// Judge whether an extracted title/description segment plausibly names a
// product category and is therefore safe to interpolate into a prompt, versus
// a slogan or tagline that would turn into a question nobody asks. Concrete,
// defensible signals only: short and noun-phrase shaped (word/length caps, no
// hype word or pitch verb anywhere in it), and free of marketing punctuation
// or leftover ornament.
// isPlausibleCategory judges by BLOCKLISTING English marketing language (HYPE_WORDS,
// PITCH_VERBS): it can only rule against text it recognizes as English prose. A category
// claimed in another language contains none of those English words either — not because
// it was judged a good category, but because the rule cannot read it — and waving it
// through on that technicality is a fail-open bug (observed live: `brand add stripe.com`
// run from a German-hosted box got served "Online-Bezahldienst und
// Zahlungsdienstleister" and it sailed past every English-only check). So before judging
// plausibility at all, require positive evidence the phrase is assessable: at least one
// word drawn from a small set of English function words and the category-shaped nouns a
// genuine category phrase almost always contains or ends in ("… software", "… platform",
// "… service"). Absence from this list is not proof the phrase is bad — only proof this
// rule cannot tell — and "cannot tell" fails closed exactly like "implausible" does,
// never open. This is a short allowlist, not a language-detection dependency: it trades
// a false degrade on a terse English category (rare, and only makes the proposal ask the
// operator to confirm) for never interpolating an unjudged phrase into a live prompt.
const ENGLISH_ASSESSABLE_WORDS = new Set([
  "the", "a", "an", "of", "for", "and", "or", "with", "your", "online",
  "software", "platform", "tool", "tools", "service", "services",
  "solution", "solutions", "app", "apps", "system", "systems",
  "management", "marketing", "analytics", "provider", "providers",
  "company", "product", "products", "store", "shop",
]);

// True when the phrase carries positive evidence of being assessable English (see
// ENGLISH_ASSESSABLE_WORDS above). Exported separately from isPlausibleCategory so the
// proposal's evidence comment can say WHY a category degraded — unassessable-language
// versus tagline-shaped — rather than collapsing both into one unexplained "implausible".
export function isAssessableCategory(candidate: string): boolean {
  const c = candidate.trim();
  if (!c || c.length > 60) return false;
  if (/[^\p{L}\p{N}\s&/,'-]/u.test(c)) return false; // ornament/symbols/emoji: unreadable either way
  const words = c
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[,.]+$/, ""))
    .filter(Boolean);
  return words.length > 0 && words.some((w) => ENGLISH_ASSESSABLE_WORDS.has(w));
}

export function isPlausibleCategory(candidate: string): boolean {
  const c = candidate.trim();
  if (!c || c.length > 60) return false;
  if (/[!™®©]|\.\.\.|--/.test(c)) return false; // marketing punctuation
  if (/[^\p{L}\p{N}\s&/,'-]/u.test(c)) return false; // ornament/symbols/emoji
  if (!isAssessableCategory(c)) return false; // cannot judge it: fail closed, not open
  const words = c
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[,.]+$/, "")) // trailing punctuation must not dodge the stoplist match
    .filter(Boolean);
  if (words.length === 0 || words.length > 6) return false;
  if (words.some((w) => HYPE_WORDS.has(w) || PITCH_VERBS.has(w))) return false;
  return true;
}

// The standard discovery prompt-set (same grammar as draft.ts's seeded prompts),
// seeded from the site's own claimed category — but only when that category
// passes isPlausibleCategory. An implausible or absent category degrades to
// fewer, brand-only prompts (alternatives / worth-it / what-is) rather than
// inventing a category-shaped question the site never claimed: fewer good
// prompts beat more bad ones.
export function discoveryPrompts(brand: string, category: string | null): string[] {
  const brandOnly = [`${brand} alternatives`, `is ${brand} worth it`, `what is ${brand}?`];
  if (!category || !isPlausibleCategory(category)) return brandOnly;
  const categoryPhrase = category.toLowerCase();
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
  const res = await safeFetch(url, { headers: { "Accept-Language": PROBE_ACCEPT_LANGUAGE } });
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

// The probe sent no Accept-Language, so a site that language-negotiates on the header
// (most do) served whatever the crawling box's network location implied — observed live:
// the same domain probed from a German-hosted box came back in German, and that leaked
// into the seeded prompts. Two operators running the identical command on the same brand
// must get the same result regardless of where their server happens to sit, so the probe
// now asks explicitly. This does not silently force English on a non-English brand: it
// makes the choice visible (recorded in the proposal's evidence below) so the operator
// can see what language the probe actually got and override the claimed category by hand
// if their market isn't English. No config surface exists yet to pass a different value
// in; the site config's own `locale:` field (brand-add.ts) is populated FROM what the
// probe observes (hreflang/sitemap paths), not a knob for driving the probe's request, so
// there is nothing existing to wire this to.
const PROBE_ACCEPT_LANGUAGE = "en";

export async function draftBrand(domain: string): Promise<BrandProposal> {
  const notes: string[] = [];
  const unreachable: UnreachableProbe[] = [];
  const seedHost = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
  const apex = registrableDomain(seedHost);
  const origin = `https://${seedHost}`;

  // 1. Homepage: identity + locales + links.
  const home = await safeFetch(`${origin}/`, { headers: { "Accept-Language": PROBE_ACCEPT_LANGUAGE } });
  const html = home.ok && home.body ? home.body : "";
  if (!html) {
    const error = home.error ?? `http ${home.status}`;
    unreachable.push({ target: `${origin}/`, error });
    notes.push(`homepage fetch failed (${error}); proposal degrades to the AI lanes and defaults`);
  }
  const title = titleOf(html);
  const jsonLd = jsonLdIdentity(html);
  const apexLabel = apex.split(".")[0];
  const rawName = jsonLd.name ?? brandSegmentFromTitle(title ?? "", apexLabel);
  const name = cleanBrandToken(rawName, apexLabel);
  const description = metaDescription(html) ?? jsonLd.description;
  const category = claimedCategory(title, description, name);
  const categoryUsable = category !== null && isPlausibleCategory(category);

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
  // Sitemap URLs of the primary property, kept for the competitor crawl below whether or
  // not the locale pass needed them.
  let sitemapUrls: string[] = [];
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
      sitemapUrls = urls;
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

  // 2b. Competitors, from the primary property's own comparison-page titles. The same
  // crawl `draft <domain>` runs, through the same shared helper: `brand add` is the
  // recommended entry point, and it used to write `competitors: []` while the
  // de-emphasised verb wrote a real list — so the headline path produced the weaker
  // config. Competitor claims are what the comparison-page and outreach generators key
  // off, so an empty list is a quieter product, not a neutral default. Primary property
  // only: the sibling subdomains are docs and apps, not where comparison pages live.
  let competitors: { name: string; url: string }[] = [];
  if (html) {
    if (sitemapUrls.length === 0) {
      const sitemap = await fetchSitemapUrls(origin);
      sitemapUrls = sitemap.urls;
      if (sitemap.note) notes.push(`${sitemap.note}; the comparison crawl found no pages to read`);
    }
    const discovered = await discoverCompetitors(sitemapUrls, [name, apexLabel]);
    competitors = discovered.competitors;
    if (discovered.note) notes.push(discovered.note);
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
  const prompts = discoveryPrompts(name, category);
  const laneEvidence: FacetEvidence[] = [
    {
      observed: categoryUsable
        ? `discovery prompts seeded from the site's claimed category ("${category}")`
        : category
          ? category !== null && isAssessableCategory(category)
            ? `discovery prompts seeded from brand-only questions — claimed category ("${category}") reads as a tagline, not a product category; supply a real one`
            : `discovery prompts seeded from brand-only questions — claimed category ("${category}") could not be assessed (probed with Accept-Language: ${PROBE_ACCEPT_LANGUAGE}; this does not read as English); supply a real category in the market's own language`
          : "discovery prompts seeded from brand-only questions (no category observed on the site)",
      where: `${origin}/`,
    },
    { observed: `site probed with Accept-Language: ${PROBE_ACCEPT_LANGUAGE}`, where: `${origin}/` },
  ];
  // Each lane owns its arrays, never a shared instance: serializers that dedupe
  // repeated objects into references corrupt the second lane on a round trip.
  const ai_lanes: AiLaneFacet[] = [
    { engine: "chatgpt", prompts: [...prompts], evidence: laneEvidence.map((e) => ({ ...e })) },
    { engine: "claude", prompts: [...prompts], evidence: laneEvidence.map((e) => ({ ...e })) },
  ];

  return {
    brand: { name, primaryDomain: primaryHost, description, category },
    competitors,
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
