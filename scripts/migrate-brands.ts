// Additive brands migration (brands layer over surfaces; the existing surface model is untouched).
// Idempotent by construction: safe to run repeatedly, and kept in-repo so the
// same script applies to the live db at merge time (built and verified here
// against the worktree copy db only).
//
//   ANSWERABLE_DB_PATH=/path/to/answerable.db npx tsx scripts/migrate-brands.ts
//
// Steps: create the brands table if absent, add surfaces.brand_id if absent,
// then backfill each ungrouped surface under the brand its own config declares
// (surfaces.config_snapshot.brand, falling back to the normalized hostname of its
// domain), creating the brand row where it is missing.
//
// SCOPE NARROWS ONCE ANY BRAND EXISTS. On a virgin install (no brand rows) every
// ungrouped surface is backfilled, declared or domain-derived. Afterwards only surfaces
// carrying an EXPLICIT `brand:` key are touched: that key is the operator saying which
// group this surface belongs to, so honouring it is obedience, not inference, and it is
// what lets a group that was left behind (no config supplied a domain yet, or the group
// was declared after the first run) advance on a later pass. Surfaces with NO declared
// brand keep their domain-derived grouping only on the virgin pass; after that they are
// left alone, because sweeping them into a brand behind their back is exactly the
// regrouping this guard exists to prevent.
//
// The brand row's IDENTITY (name, primary domain, aliases) comes from the group's VALID
// WEB TARGET DOMAINS or the row is not created at all — see identityOf below. An
// already-existing brand row is never rewritten here: its identity is the operator's own
// data, edited with `answerable brand`, which is also the ongoing path for creating a
// brand this script leaves unmade.

import Database from "better-sqlite3";
import path from "node:path";
import { brandHost, brandIdForDomain } from "../src/engine/lib/brand-id";
import { seedAliasesForDomains } from "../src/engine/lib/brand-identity";

const DB_PATH = process.env.ANSWERABLE_DB_PATH ?? path.join(process.cwd(), "data", "answerable.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`CREATE TABLE IF NOT EXISTS brands (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  primary_domain TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  discovery TEXT,
  aliases TEXT,
  negative_terms TEXT
)`);

// Brand identity profile columns on an ALREADY-EXISTING brands table (the
// CREATE above only covers a virgin install). Same PRAGMA guard style as
// surfaces.brand_id below, so a re-run is a no-op.
const brandCols = (db.prepare("PRAGMA table_info(brands)").all() as { name: string }[]).map(
  (c) => c.name,
);
if (!brandCols.includes("aliases")) {
  db.exec("ALTER TABLE brands ADD COLUMN aliases TEXT");
}
if (!brandCols.includes("negative_terms")) {
  db.exec("ALTER TABLE brands ADD COLUMN negative_terms TEXT");
}

const surfaceCols = (db.prepare("PRAGMA table_info(surfaces)").all() as { name: string }[]).map(
  (c) => c.name,
);
if (!surfaceCols.includes("brand_id")) {
  db.exec("ALTER TABLE surfaces ADD COLUMN brand_id TEXT REFERENCES brands(id)");
}

// Backfill: group every ungrouped surface under the brand its own config names.
// See the scope note at the top of this file: virgin install = every ungrouped surface;
// afterwards = explicitly declared surfaces only.
const brandCount = (db.prepare("SELECT count(*) AS n FROM brands").get() as { n: number }).n;
const declaredOnly = brandCount > 0;
const ungrouped = db.prepare("SELECT id, config_snapshot FROM surfaces WHERE brand_id IS NULL").all() as {
  id: string;
  config_snapshot: string;
}[];

// What a stored config says about brand membership: the GROUP it belongs to (its
// declared `brand`, else the id brandIdForDomain derives from the domain it targets)
// and the web target domain it names, if any.
//
// A declared `brand` decides GROUPING ONLY. It is an operator-chosen string — two
// configs carrying the same one are deliberately grouped, which is intent, not a
// collision — but it is not evidence about the brand's identity, and it is never
// allowed to become one. brandIdForDomain returns "" for anything it cannot parse,
// so a snapshot with an unparseable domain and no declared brand has no group at all.
function readConfig(configSnapshot: string): { group: string; domain: string; declared: boolean } | null {
  let config: { brand?: unknown; target?: { domain?: unknown } };
  try {
    config = JSON.parse(configSnapshot) as typeof config;
  } catch {
    return null;
  }
  const rawDomain = typeof config.target?.domain === "string" ? config.target.domain : "";
  // brandHost is both the validity test and the normalization, in one call: a config's
  // `target.domain` is never shape-checked at onboard (surface.ts requires the key, not a
  // hostname), so a stored snapshot can legitimately carry "https://www.acme.com/pricing".
  // Trimming that string by hand would seed the URL ITSELF as the primary domain and as an
  // alias; brandHost returns the host it actually denotes, or "" when it denotes none.
  const domain = brandHost(rawDomain);
  const declared = typeof config.brand === "string" && config.brand.length > 0 ? config.brand : "";
  const group = declared || brandIdForDomain(rawDomain);
  return group ? { group, domain, declared: declared.length > 0 } : null;
}

// The identity of a brand row is derived from a VALID WEB TARGET DOMAIN and nothing
// else: never the declared `brand:` key, never the brand id, never a display name an
// operator typed. Both are bare tokens, and a bare token seeded as an alias matches
// ordinary prose — `brand: acme` on a config targeting billing.io would otherwise seed
// the alias "acme" and a primary domain the migration never saw.
//
// A group's identity is seeded from EVERY valid domain its surfaces name, not just one.
// One brand row displaces the domain-derived fallback of every surface under it, so a
// group spanning alpha.example and zeta.example that seeded only alpha's forms would stop
// matching answers naming zeta.example — a surface would be worse off for being grouped,
// which is the one thing this script must never do.
//
// primary_domain is a PRESENTATION DEFAULT only (the brand's canonical URL and display
// name): the lexicographically smallest of the group's domains, an arbitrary but
// deterministic choice among equals. Smallest, not first-seen, because the result must
// not depend on the order sqlite happens to return rows in: an AI-engine lane carrying
// `brand: acme` and no domain of its own must resolve identically whether it is processed
// before or after the web surface that supplies the domain. An operator who wants a
// different primary creates the brand explicitly with `answerable brand create <id>
// <domain>` before running this script; MATCHING is unaffected either way, since every
// domain in the group is an alias.
function identityOf(domains: string[]): { name: string; domain: string; aliases: string[] } {
  const sorted = [...new Set(domains)].sort();
  const primary = sorted[0];
  const name = primary.split(".")[0] || primary;
  // seedAliasesForDomains seeds each domain under its own leading label, so the result is
  // exactly every domain and its spoken form — the same aliases the domain-derived
  // fallbacks carried between them, and not one token more.
  return { name, domain: primary, aliases: seedAliasesForDomains(sorted) };
}

const insertBrand = db.prepare(
  "INSERT INTO brands (id, name, primary_domain, created_at, aliases) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
);
const assign = db.prepare("UPDATE surfaces SET brand_id = ? WHERE id = ?");
const existingBrandIds = new Set(
  (db.prepare("SELECT id FROM brands").all() as { id: string }[]).map((r) => r.id),
);

// Pass 1 (order-insensitive): read every ungrouped surface, then collect each group's
// full domain set from the whole batch before writing anything.
//
// The declared-only scope applies HERE TOO, not just when assigning. A surface this pass
// is not allowed to group must not be allowed to contribute an alias either: an undeclared
// surface's group is derived from its own domain, so an operator who declares
// `brand: acme-com` on a config targeting other.example would otherwise silently pull an
// unrelated acme.com surface's domain into that brand's identity while leaving the surface
// itself ungrouped. Same rule, one place earlier: nothing enters a brand's identity that
// the operator did not put in the group.
const parsed = ungrouped.map((row) => ({ id: row.id, config: readConfig(row.config_snapshot) }));
const inScope = (config: { declared: boolean } | null): boolean =>
  config !== null && (!declaredOnly || config.declared);
const domainsByGroup = new Map<string, Set<string>>();
for (const p of parsed) {
  if (!p.config?.domain || !inScope(p.config)) continue;
  const set = domainsByGroup.get(p.config.group) ?? new Set<string>();
  set.add(p.config.domain);
  domainsByGroup.set(p.config.group, set);
}

// Pass 2: create each group's brand row from its domains, and point its surfaces at it.
// A group no surface supplies a domain for gets NO brand row: it waits for one rather
// than minting an identity out of a bare name. A group whose brand row ALREADY exists is
// only assigned to — its identity is the operator's, never rewritten from configs.
let grouped = 0;
let noBrandKey = 0;
let skippedUndeclared = 0;
const domainless = new Set<string>();
for (const p of parsed) {
  if (!p.config) {
    noBrandKey++;
    continue;
  }
  if (!inScope(p.config)) {
    skippedUndeclared++;
    continue;
  }
  if (!existingBrandIds.has(p.config.group)) {
    const domains = domainsByGroup.get(p.config.group);
    if (!domains || domains.size === 0) {
      domainless.add(p.config.group);
      continue;
    }
    const identity = identityOf([...domains]);
    insertBrand.run(p.config.group, identity.name, identity.domain, Date.now(), JSON.stringify(identity.aliases));
    existingBrandIds.add(p.config.group);
  }
  assign.run(p.config.group, p.id);
  grouped++;
}
console.log(
  `migrate-brands: grouped ${grouped} surface(s) under the brand their config declares` +
    (noBrandKey > 0 ? `, left ${noBrandKey} with no declared brand and no parseable domain alone` : "") +
    (skippedUndeclared > 0
      ? `, left ${skippedUndeclared} ungrouped surface(s) with no declared brand alone (${brandCount} brand(s) already exist, so grouping is yours: add a \`brand:\` key and re-onboard)`
      : "") +
    (domainless.size > 0
      ? `, left the surfaces of ${domainless.size} declared brand(s) ungrouped because no config supplies a web target domain to derive their identity from: ${[...domainless].sort().join(", ")} (create them with \`answerable brand create <id> <domain>\`)`
      : "") +
    ` (${DB_PATH})`,
);

// Identity profiles: ALIASES are seeded above, from the group's valid web target domains
// and nothing else — each registrable domain and its spoken form, which is exactly what
// those surfaces' domain-derived fallbacks carried. NEGATIVE TERMS are not seeded, because the config
// states none and this script invents nothing. Neither the declared `brand:` key nor
// any display name ever becomes an alias: those are bare tokens, and a bare token
// matches ordinary prose. A seeded brand therefore matches exactly what the fallback it
// displaces matched, so running this script can only add grouping, never subtract
// precision. Richer identity is the operator's own data, edited on the row.
