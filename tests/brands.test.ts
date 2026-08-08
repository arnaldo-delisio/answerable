// Brands layer: the surface loader's optional brand field, the brand-draft
// prober's pure extraction helpers, and the additive migration's idempotency.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { assertSurfaceId, parseSurface, SurfaceConfigError } from "../src/engine/lib/surface";
import { brandIdForDomain, composeChildId } from "../src/engine/lib/brand-id";
import {
  registrableDomain,
  extractHrefs,
  discoveryPrompts,
  bareHost,
  sameProperty,
  canonicalHost,
} from "../src/engine/lib/brand-draft";
import { claimedCategory } from "../src/engine/lib/draft";

const base = `
id: example-com-en
kind: web-locale
target:
  domain: www.example.com
  path_prefix: /
  locale: en
audience: Freelancers and the clients who hire them
business_goal: freelancer signups
desired_conversion: signup
competitors: []
publishing:
  policy: review-required
  owner: operator
lanes:
  crawl: { enabled: true }
`;

describe("surface loader: optional brand field", () => {
  it("accepts a brand id and returns it", () => {
    const s = parseSurface(`${base}brand: example\n`);
    expect(s.brand).toBe("example");
  });
  it("omits brand when absent", () => {
    expect(parseSurface(base).brand).toBeUndefined();
  });
  it("rejects a non-id brand value", () => {
    expect(() => parseSurface(`${base}brand: "Not A Slug!"\n`)).toThrow(SurfaceConfigError);
    expect(() => parseSurface(`${base}brand: 42\n`)).toThrow(SurfaceConfigError);
  });
});

describe("brand-draft pure helpers", () => {
  it("registrableDomain strips subdomains", () => {
    expect(registrableDomain("app.example.com")).toBe("example.com");
    expect(registrableDomain("example.com")).toBe("example.com");
    expect(registrableDomain("WWW.Example.COM")).toBe("example.com");
  });
  it("extractHrefs absolutizes and keeps only http(s)", () => {
    const html =
      '<a href="/pricing">p</a> <a href="https://apps.apple.com/app/id1">a</a> <a href="mailto:x@y.z">m</a>';
    expect(extractHrefs(html, "https://example.com/")).toEqual([
      "https://example.com/pricing",
      "https://apps.apple.com/app/id1",
    ]);
  });
  it("discoveryPrompts seeds from the claimed category, domain fallback otherwise", () => {
    const withCat = discoveryPrompts("Acme", "Invoicing Software", "www.acme.com");
    expect(withCat).toContain("best tools for invoicing software");
    expect(withCat).toContain("Acme alternatives");
    const noCat = discoveryPrompts("Acme", null, "www.acme.com");
    expect(noCat[0]).toBe("best tools for what acme.com offers");
  });

  // www.example.com and example.com are one property: the probe must not offer
  // the operator their own site back as an undiscovered second website.
  it("treats www and apex as one property", () => {
    expect(bareHost("WWW.Example.com")).toBe("example.com");
    expect(sameProperty("www.example.com", "example.com")).toBe(true);
    expect(sameProperty("app.example.com", "example.com")).toBe(false);
  });

  it("canonicalHost reads the page's declared canonical hostname", () => {
    expect(
      canonicalHost('<link rel="canonical" href="https://www.example.com/en"/>', "https://example.com/"),
    ).toBe("www.example.com");
    expect(canonicalHost('<link rel="alternate" href="/x"/>', "https://example.com/")).toBeNull();
    expect(canonicalHost("<p>no links</p>", "https://example.com/")).toBeNull();
  });
});

describe("claimedCategory: brand name is not a category", () => {
  it("prefers the title segment that does not restate the brand name", () => {
    expect(
      claimedCategory("Example Software | Invoicing Built for Freelancers", "Example bills clients for you.", "Example"),
    ).toBe("Invoicing Built for Freelancers");
  });
  it("still takes the only usable segment when every one carries the name", () => {
    expect(claimedCategory("Acme | Acme Analytics Platform", null, "Acme")).toBe(
      "Acme Analytics Platform",
    );
  });
  it("falls back to the description when the title offers nothing", () => {
    expect(claimedCategory("Acme", "Video analytics for teams. More.", "Acme")).toBe(
      "Video analytics for teams",
    );
  });
});

// Activation must never adopt a surface that merely shares the generated id.
// isSameFacet is the guard; it is exercised here through the same shape the
// action passes it (kind + canonical target identity).
describe("facet identity guard", () => {
  const sameFacet = (
    existing: { kind: string; configSnapshot: Record<string, unknown> },
    want: { kind: string; domain?: string; engine?: string },
  ): boolean => {
    if (existing.kind !== want.kind) return false;
    const t = (existing.configSnapshot.target ?? {}) as { domain?: string; engine?: string };
    if (want.domain) return !!t.domain && sameProperty(t.domain, want.domain);
    if (want.engine) return t.engine === want.engine;
    return false;
  };

  it("adopts only the same web property, www/apex insensitively", () => {
    const s = { kind: "web-locale", configSnapshot: { target: { domain: "www.example.com" } } };
    expect(sameFacet(s, { kind: "web-locale", domain: "example.com" })).toBe(true);
    expect(sameFacet(s, { kind: "web-locale", domain: "other.com" })).toBe(false);
  });
  it("refuses a kind mismatch", () => {
    const s = { kind: "ai-engine-lane", configSnapshot: { target: { engine: "chatgpt" } } };
    expect(sameFacet(s, { kind: "web-locale", domain: "example.com" })).toBe(false);
  });
  it("refuses a different AI engine", () => {
    const s = { kind: "ai-engine-lane", configSnapshot: { target: { engine: "chatgpt" } } };
    expect(sameFacet(s, { kind: "ai-engine-lane", engine: "claude" })).toBe(false);
    expect(sameFacet(s, { kind: "ai-engine-lane", engine: "chatgpt" })).toBe(true);
  });
});

describe("migrate-brands script", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "answerable-brands-"));
  const dbPath = path.join(dir, "answerable.db");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("is additive and idempotent, grouping each surface under the brand its config declares", () => {
    const db = new Database(dbPath);
    db.exec(
      "CREATE TABLE surfaces (id TEXT PRIMARY KEY, kind TEXT NOT NULL, config_snapshot TEXT NOT NULL, onboarded_at INTEGER NOT NULL, lifecycle TEXT NOT NULL DEFAULT 'active')",
    );
    db.prepare("INSERT INTO surfaces VALUES ('a', 'web-locale', ?, 1, 'active')").run(
      JSON.stringify({ brand: "example", target: { domain: "www.example.com" } }),
    );
    db.close();
    const run = () =>
      execFileSync("npx", ["tsx", path.join(__dirname, "..", "scripts", "migrate-brands.ts")], {
        env: { ...process.env, ANSWERABLE_DB_PATH: dbPath },
        encoding: "utf8",
      });
    run();
    run(); // second run must be a no-op, not a failure
    const check = new Database(dbPath);
    expect(check.prepare("SELECT id FROM brands").all()).toEqual([{ id: "example" }]);
    expect(check.prepare("SELECT brand_id FROM surfaces WHERE id = 'a'").get()).toEqual({
      brand_id: "example",
    });
    check.close();
  });

  // Nothing is invented: a surface whose stored config names neither a brand nor a
  // domain stays ungrouped, and an install with no surfaces gets no brand rows.
  it("creates no brand on an empty database, and skips a surface with nothing to read", () => {
    const dir2 = mkdtempSync(path.join(tmpdir(), "answerable-brands-empty-"));
    const empty = path.join(dir2, "answerable.db");
    const db = new Database(empty);
    db.exec(
      "CREATE TABLE surfaces (id TEXT PRIMARY KEY, kind TEXT NOT NULL, config_snapshot TEXT NOT NULL, onboarded_at INTEGER NOT NULL, lifecycle TEXT NOT NULL DEFAULT 'active')",
    );
    db.prepare("INSERT INTO surfaces VALUES ('bare', 'web-locale', '{}', 1, 'active')").run();
    db.close();
    execFileSync("npx", ["tsx", path.join(__dirname, "..", "scripts", "migrate-brands.ts")], {
      env: { ...process.env, ANSWERABLE_DB_PATH: empty },
      encoding: "utf8",
    });
    const check = new Database(empty);
    expect(check.prepare("SELECT id FROM brands").all()).toEqual([]);
    expect(check.prepare("SELECT brand_id FROM surfaces WHERE id = 'bare'").get()).toEqual({
      brand_id: null,
    });
    check.close();
    rmSync(dir2, { recursive: true, force: true });
  });

  // Two businesses sharing a label on different TLDs are two brands: the derived id
  // is a slug of the whole normalized hostname (dots become dashes, so it stays a
  // legal file name and route segment), and acme.com and acme.io never fuse into
  // one rollup. www/case normalization still applies.
  it("keeps same-label different-TLD domains as separate brands", () => {
    const dir3 = mkdtempSync(path.join(tmpdir(), "answerable-brands-collide-"));
    const collide = path.join(dir3, "answerable.db");
    const db3 = new Database(collide);
    db3.exec(
      "CREATE TABLE surfaces (id TEXT PRIMARY KEY, kind TEXT NOT NULL, config_snapshot TEXT NOT NULL, onboarded_at INTEGER NOT NULL, lifecycle TEXT NOT NULL DEFAULT 'active')",
    );
    db3.prepare("INSERT INTO surfaces VALUES ('com', 'web-locale', ?, 1, 'active')").run(
      JSON.stringify({ target: { domain: "www.acme.com" } }),
    );
    db3.prepare("INSERT INTO surfaces VALUES ('io', 'web-locale', ?, 1, 'active')").run(
      JSON.stringify({ target: { domain: "ACME.io" } }),
    );
    db3.close();
    execFileSync("npx", ["tsx", path.join(__dirname, "..", "scripts", "migrate-brands.ts")], {
      env: { ...process.env, ANSWERABLE_DB_PATH: collide },
      encoding: "utf8",
    });
    const check = new Database(collide);
    expect(check.prepare("SELECT id, name FROM brands ORDER BY id").all()).toEqual([
      { id: "acme-com", name: "acme" },
      { id: "acme-io", name: "acme" },
    ]);
    expect(check.prepare("SELECT id, brand_id FROM surfaces ORDER BY id").all()).toEqual([
      { id: "com", brand_id: "acme-com" },
      { id: "io", brand_id: "acme-io" },
    ]);
    check.close();
    rmSync(dir3, { recursive: true, force: true });
  });

  // Re-running after the install has grown a second brand must never sweep a
  // deliberately ungrouped surface into an existing brand.
  it("leaves ungrouped surfaces alone once any brand exists", () => {
    const db2 = new Database(dbPath);
    db2
      .prepare("INSERT INTO brands (id, name, primary_domain, created_at) VALUES (?,?,?,?)")
      .run("acme", "Acme", "acme.com", Date.now());
    db2.prepare("INSERT INTO surfaces VALUES ('b', 'web-locale', '{}', 1, 'active', NULL)").run();
    db2.close();
    execFileSync("npx", ["tsx", path.join(__dirname, "..", "scripts", "migrate-brands.ts")], {
      env: { ...process.env, ANSWERABLE_DB_PATH: dbPath },
      encoding: "utf8",
    });
    const check = new Database(dbPath);
    expect(check.prepare("SELECT brand_id FROM surfaces WHERE id = 'b'").get()).toEqual({
      brand_id: null,
    });
    check.close();
  });
});

// The one brand-id derivation, used by every path that creates a brand: a slug of
// the whole normalized hostname, legal as a file name and route segment, and never
// merging two businesses that share a label.
describe("brandIdForDomain", () => {
  it("slugs the full normalized hostname", () => {
    expect(brandIdForDomain("acme.com")).toBe("acme-com");
    expect(brandIdForDomain("acme.io")).toBe("acme-io");
    expect(brandIdForDomain("www.acme.co.uk")).toBe("acme-co-uk");
    expect(brandIdForDomain("ACME.io")).toBe("acme-io");
    expect(brandIdForDomain("https://www.acme.com/pricing")).toBe("acme-com");
  });

  it("produces a legal surface id", () => {
    for (const d of ["acme.com", "www.acme.co.uk", "sub.domain.example"]) {
      expect(() => assertSurfaceId(brandIdForDomain(d), "brand")).not.toThrow();
    }
  });

  it("leaves an id that already fits the cap byte-identical (stored ids, routes)", () => {
    expect(brandIdForDomain("acme.com")).toBe("acme-com");
  });

  it("never truncates two distinct long hostnames to the same id", () => {
    const label = "a".repeat(63);
    const idCom = brandIdForDomain(`${label}.com`);
    const idNet = brandIdForDomain(`${label}.net`);
    expect(idCom).not.toBe(idNet);
    expect(idCom.length).toBeLessThanOrEqual(64);
    expect(idNet.length).toBeLessThanOrEqual(64);
    expect(() => assertSurfaceId(idCom, "brand")).not.toThrow();
    expect(() => assertSurfaceId(idNet, "brand")).not.toThrow();
  });

  it("drops the port and treats a ported and bare host as the same property", () => {
    expect(brandIdForDomain("https://www.example.com:443/path")).toBe(
      brandIdForDomain("example.com"),
    );
    expect(brandIdForDomain("example.com:8080")).toBe("example-com");
  });

  it("returns empty on malformed input, inventing nothing", () => {
    expect(brandIdForDomain("")).toBe("");
    expect(brandIdForDomain("not a domain at all!!")).toBe("");
    expect(brandIdForDomain("http://")).toBe("");
  });
});

describe("composeChildId", () => {
  it("reserves suffix room so two long-brand AI lanes stay distinct", () => {
    const brandId = brandIdForDomain(`${"b".repeat(63)}.com`); // a full 64-char brand id
    expect(brandId.length).toBe(64);
    const chatgpt = composeChildId(brandId, "-geo-chatgpt");
    const claude = composeChildId(brandId, "-geo-claude");
    expect(chatgpt).not.toBe(claude);
    expect(chatgpt.length).toBeLessThanOrEqual(64);
    expect(claude.length).toBeLessThanOrEqual(64);
    expect(chatgpt.endsWith("-geo-chatgpt")).toBe(true);
    expect(claude.endsWith("-geo-claude")).toBe(true);
  });

  it("leaves a short base untouched", () => {
    expect(composeChildId("acme-com", "-geo-chatgpt")).toBe("acme-com-geo-chatgpt");
  });
});
