// Brand identity as DATA. What text identifies a brand used
// to be hard-coded in the sense adapters (the operator's brand token, its domain,
// and the exclusions that keep look-alike tokens out), which broke the portability
// boundary: nothing customer-specific belongs in src/. It now lives on the brands row (aliases,
// negative_terms), is seeded from the domain when the brand row is created
// (`answerable brand create`, or `npm run db:brands` for a backfill), and is editable
// thereafter as data on that row (`answerable brand alias` / `brand negative`).
//
// This module is deliberately PURE — no database import — because the sense
// adapters import it and they are database-free by construction. The single db
// read that turns a brand id into an identity lives in the sense station
// (src/engine/sense/index.ts), which already owns the db, and the resolved value
// is passed down to the adapters as a parameter.
//
// ONE MATCHING RULE, NO INFERENCE. An identity matches its `aliases` and nothing
// else; `negativeTerms` veto a match. There is no second class of "ambiguous"
// token that the code decides is safe under some condition. Every previous
// attempt to infer that condition (the domain's leading label counts when there
// is category context / when the row carries negative terms / when the row is
// stored rather than derived) shipped a defect, because the condition was always
// a proxy for a judgment only the operator can make. So the operator makes it:
// if you want bare "Example" to count, write `Example` in aliases. If you did
// not write it, nothing matches it on your behalf.

import { brandHost } from "./brand-id";

// Resolved identity handed to a matcher. `aliases` identify the brand: the
// presence of any one of them in a text IS the match. `negativeTerms` veto it.
export interface BrandIdentity {
  id: string;
  name: string;
  url: string;
  aliases: string[];
  negativeTerms: string[];
}

// Shape of the brands row this module needs (structural, so callers can pass a
// drizzle row or a test fixture without a cast).
export interface BrandIdentityRow {
  id: string;
  name: string;
  primaryDomain: string;
  aliases?: string[] | null;
  negativeTerms?: string[] | null;
}

// Longest a single alias / negative term may be. These are names and tokens, not
// prose; the cap keeps a pathological value out of a regex built per response.
export const IDENTITY_TERM_MAX = 120;
export const IDENTITY_LIST_MAX = 50;

function bare(host: string): string {
  return host.toLowerCase().replace(/^www\./, "").replace(/\/+$/, "");
}

// Trimmed, non-empty, deduped (case-insensitively), capped. Used both by the
// save action and when reading a row back, so a hand-edited database value can
// never reach a matcher in a shape the write path would have refused.
export function normalizeTerms(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const t = raw.trim();
    if (!t || t.length > IDENTITY_TERM_MAX) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= IDENTITY_LIST_MAX) break;
  }
  return out;
}

// A row becomes an identity only when it actually carries aliases. No aliases =
// no profile: the engine does not know this brand's names, and says so by
// matching nothing, rather than falling back to another brand's hard-coded ones.
//
// The row's aliases are the whole matching surface. The registrable domain's leading
// label ("example" from example.com) is NOT added here: it is frequently an ordinary
// English word, and adding it would match "For example, invoicing software can..." as
// an owned mention the operator never earned. An operator who wants that token counted
// writes it into `aliases`, where it matches like every other alias. That is the only
// way it is ever enabled, which is what keeps a stored row from matching MORE than the
// domain-derived fallback it displaces.
export function identityFromRow(row: BrandIdentityRow | null | undefined): BrandIdentity | null {
  if (!row) return null;
  const aliases = normalizeTerms(row.aliases);
  if (aliases.length === 0) return null;
  return {
    id: row.id,
    name: row.name,
    url: `https://${row.primaryDomain}`,
    aliases,
    negativeTerms: normalizeTerms(row.negativeTerms),
  };
}

// Domain-only identity, derived from a surface config the operator already wrote
// (an assistant's `observes` target and that web surface's `target.domain`).
// It exists so an operator who has onboarded surfaces but not yet created a brand
// row still gets REAL matching instead of a fabricated zero: the domain and its
// spoken form are unambiguous aliases, and there are no negative terms because the
// config states none.
// Nothing is invented here that the config does not already say. A stored brand
// identity is richer and always wins; this is the fallback, never the replacement.
//
// The bare label is absent for the same reason it is absent from a stored identity:
// a registrable domain's leading label is frequently an ordinary English word
// ("example", "monday", "square", "apple"), and an answer reading "For example,
// invoicing software can..." would be recorded as an owned hit the operator never
// earned. The shipped sample domain IS example.com, so a fresh install is the
// likeliest place to hit it.
//
// The tradeoff is accepted deliberately: this identity MISSES an answer that says
// "Example is great" without naming the domain. Under-claiming is the correct failure
// direction for this product — a missed hit understates a real position, a false hit
// fabricates one. An operator who wants the bare name counted creates the brand row
// and lists it in `aliases`; the config alone never says it.
export function identityFromDomain(id: string, domain: string): BrandIdentity | null {
  // brandHost is the one normalizer, shared with `brand create` and the migration. Its
  // own dot requirement is not decoration: a naive `includes(".")` test lets "localhost."
  // and "acme." through, and seeding turns the trailing dot into a space and trims it,
  // so the fallback would hand back the bare alias "localhost" / "acme" — a bare token
  // matchable in ordinary prose that no operator ever typed.
  const host = brandHost(domain);
  if (!host) return null;
  const token = host.split(".")[0] ?? "";
  const name = token ? token.charAt(0).toUpperCase() + token.slice(1) : host;
  return identityFromRow({
    id,
    name,
    primaryDomain: host,
    aliases: seedAliases({ name, primaryDomain: host }),
    negativeTerms: [],
  });
}

// First index of `term` in `text` as a whole word (alnum-boundary,
// case-insensitive, regex metachars escaped), or -1. Keeps a brand token like
// "example" from firing inside "counterexample".
export function wordIndex(text: string, term: string): number {
  if (!term) return -1;
  const re = new RegExp(`(?<![a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`, "i");
  const m = re.exec(text);
  return m ? m.index : -1;
}

// True when any of the brand's negative terms appears as a whole word in `text`:
// the text is talking about something else that merely shares the brand's token.
export function hasNegativeContext(text: string, identity: BrandIdentity | null): boolean {
  if (!identity) return false;
  return identity.negativeTerms.some((t) => wordIndex(text, t) >= 0);
}

// ---- seeding from the probe -------------------------------------------------

// The aliases a newly probed brand starts with: the primary domain as written,
// the same domain spoken (dots as spaces — how people write it in a post), plus
// the sibling hostnames the probe actually observed serving the same property.
// Nothing invented: the brand NAME is added only when it is not just the
// domain's leading label. That bare label is an ordinary English word often enough
// that seeding it would silently enable exactly the fabricated match this module
// refuses to infer — so it is never seeded, only ever typed by the operator.
export function seedAliases(brand: { name: string; primaryDomain: string }, observedAliases: string[] = []): string[] {
  const domain = bare(brand.primaryDomain);
  const token = domain.split(".")[0] ?? "";
  const candidates = [domain, domain.replace(/\./g, " "), ...observedAliases.map(bare)];
  const name = brand.name.trim();
  if (name && name.toLowerCase() !== token) candidates.push(name);
  return normalizeTerms(candidates);
}

// The aliases a brand spanning SEVERAL domains starts with: every domain's own two
// forms, and nothing else. One brand row displaces the domain-derived fallback of every
// surface grouped under it, so seeding only one of the group's domains would silently
// STOP matching answers that name a sibling domain — a surface's own domain-derived
// fallback must never be lost by grouping. Each domain is seeded under its own leading
// label, so no group member's bare token is ever seeded as a name (seedAliases drops a
// name equal to the domain's leading label). Ordering is by normalized domain, so the
// result does not depend on the order the callers happened to collect them in.
export function seedAliasesForDomains(domains: string[]): string[] {
  const sorted = [...new Set(domains.map(brandHost))].filter(Boolean).sort();
  return normalizeTerms(
    sorted.flatMap((d) => seedAliases({ name: d.split(".")[0] ?? "", primaryDomain: d })),
  );
}
