// `npm run db:brands` (scripts/migrate-brands.ts), end to end against a real temp db.
//
// THE INVARIANT UNDER TEST: an operator is never worse off for having run db:brands than
// for not having run it. Three separate defects have broken it. The script once created
// brand rows with aliases NULL, and the resolver treats an alias-less row as no identity
// at all, so the stored row displaced the domain-derived fallback and grounded nothing.
// Then it seeded the DECLARED BRAND NAME as an alias, so a config reading `brand: acme`
// with target domain billing.io taught the engine to match the bare word "Acme" in
// ordinary prose, and a domainless AI lane processed first could mint a brand row with a
// primary domain nobody had verified. These tests assert the invariant directly rather
// than asserting a rule that is supposed to imply it.

import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { identityFromDomain, identityFromRow, type BrandIdentityRow } from "../src/engine/lib/brand-identity";
import { extractEntities } from "../src/engine/sense/adapters/geo-panel";
import { parseSurface, type Surface } from "../src/engine/lib/surface";

const REPO = path.resolve(__dirname, "..");

// A geo lane whose prompt sits squarely in the category the ordinary-prose sentence
// below is about: the hard case, where nothing but the matching rule itself prevents a
// fabricated hit.
const lane: Surface = parseSurface(`
id: example-com-en-geo
kind: assistant
target:
  engine: chatgpt
  prompt_set:
    version: discovery-v1
    prompts: ["what is the best invoicing tool?"]
observes: example-com-en
audience: Freelancers and the clients who hire them
business_goal: signups
desired_conversion: signup
competitors: []
publishing:
  policy: review-required
  owner: operator
lanes:
  geo-panel:
    enabled: true
`);

interface StoredBrand {
  id: string;
  name: string;
  primary_domain: string;
  created_at: number;
  aliases: string | null;
  negative_terms: string | null;
}

interface SurfaceSeed {
  id: string;
  kind: string;
  config: unknown;
}

// Build a temp db carrying exactly `surfaces`, run the real script against it, and read
// back what it wrote. `surfaces` is inserted in the order given, which is how the
// ordering-sensitivity tests below flip the processing order.
function runMigration(
  surfaces: SurfaceSeed[],
  existingBrands: { id: string; name: string; primary_domain: string; aliases: string[] }[] = [],
): { brands: StoredBrand[]; grouping: Record<string, string | null> } {
  mkdirSync(tmpdir(), { recursive: true });
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "answerable-brands-")), "seed.db");
  const raw = new Database(dbPath);
  // Minimum the script needs: a surfaces table whose stored configs name what they name.
  // Nothing else in the schema is touched by db:brands.
  raw.exec(`CREATE TABLE surfaces (
    id text PRIMARY KEY NOT NULL,
    kind text NOT NULL,
    config_snapshot text NOT NULL,
    onboarded_at integer NOT NULL,
    lifecycle text DEFAULT 'active' NOT NULL
  )`);
  const ins = raw.prepare("INSERT INTO surfaces (id, kind, config_snapshot, onboarded_at) VALUES (?, ?, ?, ?)");
  surfaces.forEach((s, i) => ins.run(s.id, s.kind, JSON.stringify(s.config), i + 1));
  // A db that ALREADY has brands is the non-virgin case: the script's scope narrows to
  // explicitly declared surfaces there, so these tests need to be able to set it up.
  if (existingBrands.length > 0) {
    raw.exec(`CREATE TABLE brands (
      id text PRIMARY KEY NOT NULL,
      name text NOT NULL,
      primary_domain text NOT NULL,
      created_at integer NOT NULL,
      discovery text,
      aliases text,
      negative_terms text
    )`);
    const insB = raw.prepare(
      "INSERT INTO brands (id, name, primary_domain, created_at, aliases) VALUES (?, ?, ?, ?, ?)",
    );
    for (const b of existingBrands) insB.run(b.id, b.name, b.primary_domain, 1, JSON.stringify(b.aliases));
  }
  raw.close();

  // The real script, exactly as `npm run db:brands` invokes it.
  execFileSync("npx", ["tsx", "scripts/migrate-brands.ts"], {
    cwd: REPO,
    env: { ...process.env, ANSWERABLE_DB_PATH: dbPath },
    stdio: "pipe",
    timeout: 120_000,
  });

  const check = new Database(dbPath);
  const brands = check.prepare("SELECT * FROM brands ORDER BY id").all() as StoredBrand[];
  const rows = check.prepare("SELECT id, brand_id FROM surfaces").all() as { id: string; brand_id: string | null }[];
  check.close();
  return { brands, grouping: Object.fromEntries(rows.map((r) => [r.id, r.brand_id])) };
}

function toIdentityRow(row: StoredBrand): BrandIdentityRow {
  return {
    id: row.id,
    name: row.name,
    primaryDomain: row.primary_domain,
    aliases: row.aliases ? (JSON.parse(row.aliases) as string[]) : null,
    negativeTerms: row.negative_terms ? (JSON.parse(row.negative_terms) as string[]) : null,
  };
}

const WEB = { id: "example-com-en", kind: "site", config: { target: { domain: "www.example.com" } } };

let brandRow: BrandIdentityRow;

beforeAll(() => {
  brandRow = toIdentityRow(runMigration([WEB]).brands[0]);
}, 180_000);

describe("db:brands seeds an identity that actually grounds a mention", () => {
  it("writes aliases derived from the domain, and no invented terms", () => {
    expect(brandRow.aliases).toEqual(["example.com", "example com"]);
    // Nothing guessed: no product names, and no negative terms the config never stated.
    expect(brandRow.negativeTerms ?? []).toEqual([]);
  });

  it("the stored row resolves to a real identity, not to null", () => {
    // This is the first failure: identityFromRow returns null without aliases, so the
    // pre-fix row was "no identity at all" and every brand matcher matched nothing.
    expect(identityFromRow(brandRow)).not.toBeNull();
  });

  it("grounds an owned hit in an answer that names the domain", () => {
    const identity = identityFromRow(brandRow)!;
    const r = extractEntities("For invoicing, example.com is a solid choice for freelancers.", lane, identity);
    expect(r.ownedHit).toBe(true);
    expect(r.entities.map((e) => e.entity)).toContain(identity.name);
  });
});

describe("running db:brands never leaves the operator worse off than not running it", () => {
  const derived = identityFromDomain("derived:example-com-en", "www.example.com")!;

  it("matches exactly what the domain-derived fallback it displaces matched", () => {
    expect(identityFromRow(brandRow)!.aliases).toEqual(derived.aliases);
  });

  it("reads no owned hit from the bare label in ordinary category prose", () => {
    const stored = identityFromRow(brandRow)!;
    const prose = "For example, invoicing software can chase late invoices for freelancers automatically.";
    expect(extractEntities(prose, lane, stored).ownedHit).toBe(false);
    expect(extractEntities(prose, lane, derived).ownedHit).toBe(false);
  });

  it("does not enable the bare label just because the row has an unrelated negative term", () => {
    // The proxy that used to gate bare matching: negativeTerms.length > 0. A term about
    // a DIFFERENT domain says nothing about whether "example" is safe to match, and it
    // cannot veto the sentence below either — so the sentence was fabricated as a hit.
    const unrelated = identityFromRow({ ...brandRow, negativeTerms: ["example.org"] })!;
    expect(
      extractEntities("For example, invoicing software can chase late invoices.", lane, unrelated).ownedHit,
    ).toBe(false);
    expect(extractEntities("Example is an invoicing tool for freelancers.", lane, unrelated).ownedHit).toBe(false);
  });

  it("still matches the bare name for an operator who explicitly listed it as an alias", () => {
    // The opt-in, and the only one: it is an alias, matched like any other alias, with
    // no negative term required to unlock it and none able to unlock it by itself.
    const opted = identityFromRow({ ...brandRow, aliases: ["example.com", "Example"] })!;
    expect(extractEntities("Example is a solid invoicing tool for freelancers.", lane, opted).ownedHit).toBe(true);
  });
});

describe("a migrated brand's identity comes from a web target domain, never from its name", () => {
  // The defect: `brand: acme` on a config targeting billing.io seeded the alias "acme",
  // so the stored identity matched the bare word "Acme" in prose while the billing.io
  // identity it displaced would not. The declared key groups surfaces; it is not evidence.
  const declaredWeb = {
    id: "billing-io-en",
    kind: "site",
    config: { brand: "acme", target: { domain: "billing.io" } },
  };

  it("seeds the target domain's forms, not the declared brand key", () => {
    const { brands } = runMigration([declaredWeb]);
    expect(brands).toHaveLength(1);
    expect(brands[0].id).toBe("acme"); // grouping intent is honoured
    expect(brands[0].primary_domain).toBe("billing.io"); // identity is not
    expect(brands[0].name).toBe("billing");
    expect(JSON.parse(brands[0].aliases!)).toEqual(["billing.io", "billing io"]);
  });

  it("reads no owned hit from the declared name in ordinary prose", () => {
    const { brands } = runMigration([declaredWeb]);
    const identity = identityFromRow(toIdentityRow(brands[0]))!;
    expect(extractEntities("Acme is a household name in invoicing.", lane, identity).ownedHit).toBe(false);
    expect(extractEntities("billing.io handles invoicing.", lane, identity).ownedHit).toBe(true);
  });
}, 180_000);

describe("the result does not depend on which surface is processed first", () => {
  // The second defect: a domainless AI-engine lane carrying `brand: acme` could be
  // processed FIRST and create the brand row with the alias "acme" and a primary domain
  // it never verified. The canonical domain is now chosen across the whole set first.
  const aiLane = {
    id: "acme-geo-chatgpt",
    kind: "assistant",
    config: { brand: "acme", target: { engine: "chatgpt" } },
  };
  const web = { id: "acme-site-en", kind: "site", config: { brand: "acme", target: { domain: "billing.io" } } };

  it("produces the same brands and the same grouping in either order", () => {
    const laneFirst = runMigration([aiLane, web]);
    const webFirst = runMigration([web, aiLane]);
    // created_at is wall-clock, the one field that legitimately differs between runs.
    const shape = (r: ReturnType<typeof runMigration>) => ({
      brands: r.brands.map(({ created_at, ...rest }) => rest),
      grouping: r.grouping,
    });
    expect(shape(laneFirst)).toEqual(shape(webFirst));
    expect(laneFirst.brands).toHaveLength(1);
    expect(laneFirst.brands[0].primary_domain).toBe("billing.io");
    expect(JSON.parse(laneFirst.brands[0].aliases!)).toEqual(["billing.io", "billing io"]);
    expect(laneFirst.grouping).toEqual({ "acme-geo-chatgpt": "acme", "acme-site-en": "acme" });
  });

  it("leaves a domainless brand ungrouped rather than minting one from its name", () => {
    const { brands, grouping } = runMigration([aiLane]);
    expect(brands).toEqual([]);
    expect(grouping).toEqual({ "acme-geo-chatgpt": null });
  });
}, 300_000);

describe("grouping never costs a surface a domain it already matched", () => {
  // THE DEFECT: the script picked ONE canonical domain per declared group (the
  // lexicographically smallest) and seeded only that domain's two aliases. A brand row
  // displaces the domain-derived fallback of every surface under it, so for a group
  // spanning zeta.example and alpha.example the stored identity matched alpha and stopped
  // matching zeta — an answer naming zeta.example was an owned hit BEFORE db:brands and a
  // miss after. That is the invariant broken directly, by the script meant to preserve it.
  const alphaWeb = {
    id: "alpha-en",
    kind: "site",
    config: { brand: "multi", target: { domain: "alpha.example" } },
  };
  const zetaWeb = {
    id: "zeta-en",
    kind: "site",
    config: { brand: "multi", target: { domain: "www.zeta.example" } },
  };
  // The lane whose observed domain is the NON-canonical one: it resolves the stored group
  // identity ahead of its observed-domain fallback, so the stored identity is the only
  // thing standing between it and a fabricated miss.
  const zetaLane = {
    id: "zeta-geo-chatgpt",
    kind: "assistant",
    config: { brand: "multi", observes: "zeta-en", target: { engine: "chatgpt" } },
  };

  it("seeds aliases from EVERY domain in the group, deterministically ordered", () => {
    const { brands } = runMigration([zetaWeb, alphaWeb, zetaLane]);
    expect(brands).toHaveLength(1);
    expect(JSON.parse(brands[0].aliases!)).toEqual([
      "alpha.example",
      "alpha example",
      "zeta.example",
      "zeta example",
    ]);
    // primary_domain stays a presentation default: an arbitrary but deterministic pick.
    expect(brands[0].primary_domain).toBe("alpha.example");
  });

  it("still matches the non-canonical domain a lane observes", () => {
    const { brands, grouping } = runMigration([zetaWeb, alphaWeb, zetaLane]);
    expect(grouping["zeta-geo-chatgpt"]).toBe("multi");
    const stored = identityFromRow(toIdentityRow(brands[0]))!;
    // The exact regression: an answer naming the group's other domain.
    expect(extractEntities("zeta.example is a solid invoicing tool.", lane, stored).ownedHit).toBe(true);
    expect(extractEntities("alpha.example is a solid invoicing tool.", lane, stored).ownedHit).toBe(true);
  });

  it("matches everything the fallback it displaces matched, for every member domain", () => {
    const { brands } = runMigration([zetaWeb, alphaWeb, zetaLane]);
    const stored = identityFromRow(toIdentityRow(brands[0]))!;
    for (const domain of ["alpha.example", "www.zeta.example"]) {
      const derived = identityFromDomain(`derived:${domain}`, domain)!;
      for (const alias of derived.aliases) expect(stored.aliases).toContain(alias);
    }
  });

  it("seeds no bare label from any member domain", () => {
    const { brands } = runMigration([zetaWeb, alphaWeb, zetaLane]);
    const stored = identityFromRow(toIdentityRow(brands[0]))!;
    expect(stored.aliases).not.toContain("alpha");
    expect(stored.aliases).not.toContain("zeta");
    expect(stored.aliases).not.toContain("multi"); // nor the declared group key
    expect(extractEntities("For example, Alpha handles invoicing.", lane, stored).ownedHit).toBe(false);
  });

  it("does not depend on the order the domains are seen in", () => {
    const shape = (r: ReturnType<typeof runMigration>) => ({
      brands: r.brands.map(({ created_at, ...rest }) => rest),
      grouping: r.grouping,
    });
    expect(shape(runMigration([zetaWeb, alphaWeb, zetaLane]))).toEqual(
      shape(runMigration([zetaLane, alphaWeb, zetaWeb])),
    );
  });
}, 300_000);

describe("on a db that already has brands, only explicitly declared surfaces are touched", () => {
  // THE DEFECT: the script no-opped ENTIRELY once any brand row existed. Combined with
  // `onboard` refusing a config that names a brand which does not exist, and with no CLI
  // create verb, a declared group that had been left behind could never advance. The scope
  // now narrows instead of closing: an explicit `brand:` key is the operator saying where
  // a surface belongs, so it is honoured; a surface with no `brand:` key is left alone.
  const existing = {
    id: "incumbent",
    name: "incumbent",
    primary_domain: "incumbent.example",
    aliases: ["incumbent.example", "incumbent example"],
  };
  const declaredWeb = {
    id: "newco-en",
    kind: "site",
    config: { brand: "newco", target: { domain: "newco.example" } },
  };
  const declaredLane = {
    id: "newco-geo-chatgpt",
    kind: "assistant",
    config: { brand: "newco", observes: "newco-en", target: { engine: "chatgpt" } },
  };
  const undeclared = {
    id: "stranger-en",
    kind: "site",
    config: { target: { domain: "stranger.example" } },
  };

  it("creates the missing declared brand and groups its surfaces", () => {
    const { brands, grouping } = runMigration([declaredWeb, declaredLane, undeclared], [existing]);
    expect(brands.map((b) => b.id)).toEqual(["incumbent", "newco"]);
    const newco = brands.find((b) => b.id === "newco")!;
    expect(newco.primary_domain).toBe("newco.example");
    expect(JSON.parse(newco.aliases!)).toEqual(["newco.example", "newco example"]);
    expect(grouping["newco-en"]).toBe("newco");
    expect(grouping["newco-geo-chatgpt"]).toBe("newco");
  });

  it("leaves an undeclared ungrouped surface exactly where it was", () => {
    const { brands, grouping } = runMigration([declaredWeb, declaredLane, undeclared], [existing]);
    expect(grouping["stranger-en"]).toBeNull();
    expect(brands.map((b) => b.id)).not.toContain("stranger-example");
  });

  it("never rewrites an existing brand's identity from a config", () => {
    // A declared surface pointing at a brand that already exists is ASSIGNED to it — the
    // grouping the operator asked for — and its identity is left completely alone. That
    // assignment is what lets a group created with `answerable brand create` pick up the
    // domainless lane that was waiting for it.
    const laneForIncumbent = {
      id: "incumbent-geo-chatgpt",
      kind: "assistant",
      config: { brand: "incumbent", target: { engine: "chatgpt" } },
    };
    const otherDomain = {
      id: "incumbent-alt",
      kind: "site",
      config: { brand: "incumbent", target: { domain: "hijack.example" } },
    };
    const { brands, grouping } = runMigration([laneForIncumbent, otherDomain], [existing]);
    expect(brands).toHaveLength(1);
    expect(brands[0].primary_domain).toBe("incumbent.example");
    expect(JSON.parse(brands[0].aliases!)).toEqual(existing.aliases);
    expect(grouping["incumbent-geo-chatgpt"]).toBe("incumbent");
  });

  it("leaves a declared group with no domain ungrouped rather than minting a name", () => {
    const domainlessLane = {
      id: "ghost-geo-chatgpt",
      kind: "assistant",
      config: { brand: "ghost", target: { engine: "chatgpt" } },
    };
    const { brands, grouping } = runMigration([domainlessLane], [existing]);
    expect(brands.map((b) => b.id)).toEqual(["incumbent"]);
    expect(grouping["ghost-geo-chatgpt"]).toBeNull();
  });
}, 300_000);

describe("an out-of-scope surface contributes no domain to a brand's identity", () => {
  // REVIEWER FINDING (high): the domain set was collected from every ungrouped surface
  // before the declared-only scope was applied, and the scope was checked only when
  // ASSIGNING. So on a non-virgin db, an operator declaring `brand: acme-com` on a config
  // targeting other.example would pull an unrelated acme.com surface's domain into that
  // brand's aliases while leaving the acme.com surface itself ungrouped — an identity the
  // operator never asked for, matching a domain that is not in the group.
  const existing = {
    id: "incumbent",
    name: "incumbent",
    primary_domain: "incumbent.example",
    aliases: ["incumbent.example", "incumbent example"],
  };
  // Undeclared, and its domain-derived group id collides with the declared key below.
  const undeclared = {
    id: "stranger-en",
    kind: "site",
    config: { target: { domain: "acme.com" } },
  };
  const declared = {
    id: "newco-en",
    kind: "site",
    config: { brand: "acme-com", target: { domain: "other.example" } },
  };

  it("seeds only the declared surfaces' domains", () => {
    const { brands, grouping } = runMigration([undeclared, declared], [existing]);
    const acme = brands.find((b) => b.id === "acme-com")!;
    expect(JSON.parse(acme.aliases!)).toEqual(["other.example", "other example"]);
    expect(acme.primary_domain).toBe("other.example");
    // The surface whose domain was borrowed is still exactly where it was.
    expect(grouping["stranger-en"]).toBeNull();
  });

  it("reads no owned hit from the borrowed domain", () => {
    const { brands } = runMigration([undeclared, declared], [existing]);
    const identity = identityFromRow(toIdentityRow(brands.find((b) => b.id === "acme-com")!))!;
    expect(extractEntities("acme.com is a solid invoicing tool.", lane, identity).ownedHit).toBe(false);
    expect(extractEntities("other.example is a solid invoicing tool.", lane, identity).ownedHit).toBe(true);
  });
}, 300_000);

describe("a URL-form target domain is normalized to the host it denotes", () => {
  // REVIEWER FINDING: `target.domain` is never shape-checked at onboard (surface.ts
  // requires the key, not a hostname), so a stored config can carry a full URL. The
  // migration used to hand-trim that string, which seeded the URL ITSELF as the brand's
  // primary domain and as an alias — an identity matching nothing real, in place of the
  // acme.com identity the surface had.
  const urlForm = {
    id: "acme-en",
    kind: "site",
    config: { target: { domain: "https://www.ACME.com:8443/pricing" } },
  };

  it("seeds the host, never the URL string", () => {
    const { brands } = runMigration([urlForm]);
    expect(brands).toHaveLength(1);
    expect(brands[0].primary_domain).toBe("acme.com");
    expect(JSON.parse(brands[0].aliases!)).toEqual(["acme.com", "acme com"]);
  });

  it("grounds a mention of the host", () => {
    const { brands } = runMigration([urlForm]);
    const identity = identityFromRow(toIdentityRow(brands[0]))!;
    expect(extractEntities("acme.com is a solid invoicing tool.", lane, identity).ownedHit).toBe(true);
  });
}, 300_000);
