// The one derivation of a brand id from a domain, shared by every path that
// creates a brand (scripts/migrate-brands.ts).
// Kept dependency-free so the migration script can import it under tsx without
// dragging the engine's module graph (or better-sqlite3) along.
//
// The id is a slug of the WHOLE normalized hostname, not a short label: a short
// label merges brands that are not the same one — acme.com and acme.io are two
// businesses, and collapsing both to "acme" would silently fuse their rollups and
// identity data. The hostname itself cannot be the id because ids are file names,
// route segments, and database keys (SURFACE_ID_RE: lowercase alnum + dashes), so
// the dots become dashes: acme.com -> acme-com, www.acme.co.uk -> acme-co-uk.
//
// The human-readable brand name is stored separately as `name`; this is identity,
// never a display string.
//
// The id is capped at 64 chars (SURFACE_ID_RE / route-segment / db-key limits).
// A cap alone is not safe: two distinct hostnames whose slugs agree on the first
// 64 chars would truncate to the same id (a 63-char label under .com and under
// .net, for instance), silently merging two unrelated brands. When truncation
// would actually occur, reserve a few chars for a short hash of the FULL
// normalized host so distinct hosts can never collide; ids that already fit the
// cap are untouched — they are already stored and appear in routes.
import { createHash } from "node:crypto";

const ID_MAX = 64;
const HASH_LEN = 6; // 6 hex chars of a sha256 digest: negligible collision risk for this id space

// The one normalization of an operator-supplied domain into the host a brand's identity
// may be seeded from: lowercased, scheme/path/port stripped, leading "www." removed, or
// "" when the input cannot serve as identity at all.
//
// A DOT IS REQUIRED, and that is a matching rule, not a formatting preference. Seeding an
// identity from a dotless host ("localhost", or a plain "acme" typed where a domain was
// asked for) would put a BARE TOKEN in `aliases` — the exact thing this codebase never
// does on an operator's behalf, since a bare token matches ordinary prose. The
// domain-derived fallback (identityFromDomain) already refuses dotless hosts, so accepting
// one here would also let a created brand match MORE than the fallback it displaces.
// An operator who genuinely wants a bare token counted types it into `brand alias`.
export function brandHost(domain: string): string {
  const input = String(domain ?? "").trim().toLowerCase();
  if (!input) return "";

  let host: string;
  try {
    // The URL parser is the single source of truth for what counts as a host:
    // it strips scheme, path, query, and port and rejects genuinely malformed
    // input. Bare hosts (no scheme, the common case) need a scheme prepended
    // to parse at all.
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(input) ? input : `https://${input}`);
    host = url.hostname;
  } catch {
    return ""; // malformed input invents nothing
  }
  if (!host) return "";
  // A single trailing dot is the fully-qualified form of the SAME host ("acme.com." is
  // "acme.com"), so it is canonicalized away BEFORE the dot requirement is tested.
  // Otherwise "localhost." would satisfy `includes(".")` and seed the bare alias
  // "localhost", since seeding turns dots into spaces and trims — the dotless host
  // sneaking past the guard that exists to stop exactly that.
  host = host.replace(/\.$/, "");
  host = host.replace(/^www\./, "");
  if (!host.includes(".")) return "";
  // Every label must be non-empty: "acme..com" is not a host, and its spoken form
  // ("acme  com") is not a name anyone writes.
  if (host.split(".").some((label) => label.length === 0)) return "";
  return host;
}

export function brandIdForDomain(domain: string): string {
  const host = brandHost(domain);
  if (!host) return "";

  const full = host
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!full) return "";

  if (full.length <= ID_MAX) return full;

  const suffix = createHash("sha256").update(host).digest("hex").slice(0, HASH_LEN);
  const truncated = full.slice(0, ID_MAX - HASH_LEN - 1).replace(/-+$/, "");
  return `${truncated}-${suffix}`;
}

// Compose a child id ("<base>-<suffix>", e.g. a brand id plus "-geo-chatgpt") so
// the RESULT fits `maxLen`, reserving room for the suffix before truncating the
// base. A brand id can itself be up to 64 chars (see above), leaving no room for
// a naive append — two engines on a long-domain brand would then truncate to the
// same surface id and the second lane would be silently dropped as a name
// collision. The suffix is never truncated: it is what keeps siblings distinct.
export function composeChildId(base: string, suffix: string, maxLen = 64): string {
  const room = Math.max(0, maxLen - suffix.length);
  const truncatedBase = base.slice(0, room).replace(/-+$/, "");
  return `${truncatedBase}${suffix}`;
}
