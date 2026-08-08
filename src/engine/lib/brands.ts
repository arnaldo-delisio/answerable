// Brand verbs: create | alias | negative | list. The CLI is the whole operator surface,
// so brand creation and identity editing are verbs here or they do not exist at all —
// and `onboard` refuses a config naming a brand that does not exist, which without these
// verbs makes a second declared brand unreachable on an install that already has one.
//
// THE MATCHING RULE IS UNCHANGED AND IS NOT NEGOTIATED HERE. An identity matches its
// `aliases`; `negativeTerms` veto a match; nothing else. These verbs move exactly those
// two lists, and they invent nothing on the operator's behalf:
//
//   - `create` seeds identity from the DOMAIN and nothing else — the registrable domain
//     and its spoken form, byte-identical to what `npm run db:brands` seeds and to what
//     the domain-derived fallback carries. The brand ID is a key, never evidence: a bare
//     token like "acme" matches ordinary prose, so it is never seeded as an alias. Nor is
//     any display name, which is why there is no display-name argument to give.
//   - `alias` is the ONLY way a bare name ever becomes matchable, and it happens because
//     the operator typed that name, not because the engine guessed it was safe.
//   - `negative` sets the veto list.
//
// Guards are refusals with a note (CLI exits 1), never a silent write: creating a brand
// whose id already exists is refused rather than merged, because a merge would rewrite an
// identity the operator owns from an argument that was meant to create a new one.

import { eq } from "drizzle-orm";
import { db, schema } from "../../db";
import { brandHost } from "./brand-id";
import { SURFACE_ID_RE } from "./surface";
import {
  IDENTITY_LIST_MAX,
  IDENTITY_TERM_MAX,
  normalizeTerms,
  seedAliasesForDomains,
} from "./brand-identity";
import type { VerbResult } from "./verbs";

// A brand id is a database key, a route segment and a config value, exactly like a
// surface id (see src/engine/lib/brand-id.ts, which derives ids to this same shape).
const BRAND_ID_RE = SURFACE_ID_RE;

interface BrandRow {
  id: string;
  name: string;
  primaryDomain: string;
  aliases: string[] | null;
  negativeTerms: string[] | null;
}

// Every result echoes the resulting identity in full, so an operator reads back exactly
// what the engine will now match on rather than trusting that the edit did what was meant.
function identityResult(row: BrandRow): VerbResult {
  return {
    ok: true,
    note: null,
    brandId: row.id,
    name: row.name,
    primaryDomain: row.primaryDomain,
    aliases: normalizeTerms(row.aliases),
    negativeTerms: normalizeTerms(row.negativeTerms),
  };
}

function getBrand(id: string): BrandRow | undefined {
  return db.select().from(schema.brands).where(eq(schema.brands.id, id)).get();
}

// Validate a list of operator-typed terms BEFORE storing it. normalizeTerms silently
// drops what it cannot keep (blank, over-long, past the list cap); silence is the wrong
// answer for a term the operator explicitly asked to match on, so each rejection is
// surfaced as a refusal naming the term instead.
function validateTerms(terms: string[], existing: string[]): { note: string } | { terms: string[] } {
  for (const raw of terms) {
    if (raw.trim().length === 0) return { note: "a term cannot be blank" };
    if (raw.trim().length > IDENTITY_TERM_MAX) {
      return { note: `term "${raw.trim().slice(0, 40)}..." is longer than ${IDENTITY_TERM_MAX} characters` };
    }
  }
  const merged = normalizeTerms([...existing, ...terms]);
  // Every term is now non-blank and within the length cap, so the ONLY thing that can
  // still make normalizeTerms return fewer entries than the deduped input is the list
  // cap. Refuse rather than store a list quietly missing its tail.
  const deduped = new Set([...existing, ...terms].map((t) => t.trim().toLowerCase()).filter(Boolean));
  if (merged.length < deduped.size) {
    return { note: `that would exceed the ${IDENTITY_LIST_MAX}-term cap (${deduped.size} terms); remove some first` };
  }
  return { terms: merged };
}

// create: a brand row with an id and a primary domain, seeded exactly as `db:brands`
// seeds one. No display name is taken, because a display name is a bare token and bare
// tokens are never identity here.
export function createBrand(id: string, domain: string): VerbResult {
  const brandId = id.trim().toLowerCase();
  if (!BRAND_ID_RE.test(brandId)) {
    return { ok: false, note: `brand id "${id}" must be lowercase alphanumeric with dashes, 1-64 chars` };
  }
  // brandHost is the one normalizer, shared with the migration: it returns "" for
  // anything that cannot serve as identity, DOTLESS HOSTS INCLUDED. Without that rule
  // `brand create acme acme` would seed the bare token "acme" as an alias, which is
  // precisely the identity-from-a-bare-token this engine never does on its own.
  const primaryDomain = brandHost(domain);
  if (!primaryDomain) {
    return { ok: false, note: `"${domain}" is not a usable domain (expected a hostname like acme.com)` };
  }
  if (getBrand(brandId)) {
    return { ok: false, note: `brand "${brandId}" already exists (edit it with \`brand alias\` / \`brand negative\`)` };
  }
  const name = primaryDomain.split(".")[0] || primaryDomain;
  const aliases = seedAliasesForDomains([primaryDomain]);
  db.insert(schema.brands)
    .values({ id: brandId, name, primaryDomain, createdAt: Date.now(), aliases })
    .run();
  return identityResult({ id: brandId, name, primaryDomain, aliases, negativeTerms: null });
}

// alias: ADD to the alias list (union, order preserved, case-insensitively deduped).
// Additive rather than replacing, because the seeded domain forms are what keeps a brand
// row matching everything the fallback it displaced matched — silently dropping them
// behind a `set` would reintroduce exactly that regression.
export function addBrandAliases(id: string, terms: string[]): VerbResult {
  if (terms.length === 0) return { ok: false, note: "at least one alias is required" };
  const row = getBrand(id);
  if (!row) return { ok: false, note: `brand "${id}" not found` };
  const checked = validateTerms(terms, normalizeTerms(row.aliases));
  if ("note" in checked) return { ok: false, note: checked.note };
  db.update(schema.brands).set({ aliases: checked.terms }).where(eq(schema.brands.id, id)).run();
  return identityResult({ ...row, aliases: checked.terms });
}

// negative: SET the veto list wholesale (no terms clears it). Replacing rather than
// adding, because a negative term is a correction the operator revises as they learn what
// the look-alike traffic actually is, and there is no seeded content here to protect.
export function setBrandNegativeTerms(id: string, terms: string[]): VerbResult {
  const row = getBrand(id);
  if (!row) return { ok: false, note: `brand "${id}" not found` };
  const checked = validateTerms(terms, []);
  if ("note" in checked) return { ok: false, note: checked.note };
  db.update(schema.brands).set({ negativeTerms: checked.terms }).where(eq(schema.brands.id, id)).run();
  return identityResult({ ...row, negativeTerms: checked.terms });
}

// list: the read side. Without it an operator returning to an install has no CLI way to
// see which brand ids exist to put in a config's `brand:` key, or what a brand currently
// matches on.
export function listBrands(): VerbResult {
  const rows = db.select().from(schema.brands).all();
  return {
    ok: true,
    note: null,
    brands: rows
      .map((r) => ({
        brandId: r.id,
        name: r.name,
        primaryDomain: r.primaryDomain,
        aliases: normalizeTerms(r.aliases),
        negativeTerms: normalizeTerms(r.negativeTerms),
      }))
      .sort((a, b) => a.brandId.localeCompare(b.brandId)),
  };
}
