// `answerable brand` — the only supported path to a second brand.
//
// THE DEFECT: `onboard` refuses a config naming a brand that does not exist, and
// `db:brands` no-ops its creation half once any brand row is present. Without these verbs
// there is no create path at all, so an operator who ran `db:brands` once could never
// onboard another declared brand, and a declared group whose configs named no domain was
// permanently unadvanceable.
//
// THE RULES THESE VERBS MUST NOT BEND: identity comes from a DOMAIN, never from the brand
// id and never from a display name (there is no display-name argument to give); the only
// way a bare token ever becomes matchable is an operator typing it into `alias`; and a
// create against an existing id is REFUSED, never merged over an identity the operator owns.

import "./helpers/testdb";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db";
import {
  addBrandAliases,
  createBrand,
  listBrands,
  setBrandNegativeTerms,
} from "../src/engine/lib/brands";
import { identityFromDomain, identityFromRow } from "../src/engine/lib/brand-identity";
import { extractEntities } from "../src/engine/sense/adapters/geo-panel";
import { parseSurface } from "../src/engine/lib/surface";

const lane = parseSurface(`
id: acme-geo
kind: assistant
target:
  engine: chatgpt
  prompt_set:
    version: discovery-v1
    prompts: ["what is the best invoicing tool?"]
observes: acme-com-en
audience: Freelancers choosing an invoicing tool
business_goal: share of answer
desired_conversion: signup
competitors: []
publishing:
  policy: review-required
  owner: operator
lanes:
  geo-panel:
    enabled: true
`);

function storedIdentity(id: string) {
  const row = db.select().from(schema.brands).where(eq(schema.brands.id, id)).get();
  return identityFromRow(row ?? null);
}

beforeEach(() => {
  db.delete(schema.brands).run();
});

describe("brand create", () => {
  it("seeds identity from the domain and nothing else", () => {
    const r = createBrand("acme", "www.Acme.com");
    expect(r.ok).toBe(true);
    expect(r.brandId).toBe("acme");
    expect(r.primaryDomain).toBe("acme.com"); // normalized: www stripped, lowercased
    // Exactly the two aliases db:brands seeds, and exactly what the domain-derived
    // fallback carries. The brand id "acme" is a key, not evidence: it is NOT an alias.
    expect(r.aliases).toEqual(["acme.com", "acme com"]);
    expect(r.negativeTerms).toEqual([]);
    expect(r.aliases).toEqual(identityFromDomain("derived:x", "acme.com")!.aliases);
  });

  it("does not make the bare brand id matchable", () => {
    createBrand("acme", "acme.com");
    const identity = storedIdentity("acme")!;
    expect(extractEntities("Acme is the best invoicing tool.", lane, identity).ownedHit).toBe(false);
    expect(extractEntities("acme.com is the best invoicing tool.", lane, identity).ownedHit).toBe(true);
  });

  it("refuses a duplicate id rather than merging over it", () => {
    createBrand("acme", "acme.com");
    addBrandAliases("acme", ["Acme"]);
    const r = createBrand("acme", "other.example");
    expect(r.ok).toBe(false);
    expect(r.note).toContain("already exists");
    // The refusal is total: the existing identity is byte-for-byte untouched.
    const identity = storedIdentity("acme")!;
    expect(identity.url).toBe("https://acme.com");
    expect(identity.aliases).toEqual(["acme.com", "acme com", "Acme"]);
  });

  it("refuses an unusable domain and an unusable id", () => {
    expect(createBrand("acme", "not a domain").ok).toBe(false);
    expect(createBrand("acme", "").ok).toBe(false);
    expect(createBrand("Acme Corp!", "acme.com").ok).toBe(false);
    expect(db.select().from(schema.brands).all()).toEqual([]);
  });

  it("refuses a dotless host, which would seed a bare token as an alias", () => {
    // `brand create acme acme` looks like a typo and behaves like a breach: the seeded
    // alias would be the bare word "acme", matching ordinary prose, without the operator
    // ever asking for it. identityFromDomain already refuses dotless hosts, so accepting
    // one here would also let a created brand match MORE than the fallback it displaces.
    // The trailing-dot and empty-label forms are the same breach wearing a disguise:
    // "localhost." satisfies a naive includes(".") test, and seeding turns dots into
    // spaces and trims, so the stored alias comes out as the bare word "localhost".
    for (const bad of ["acme", "localhost", "http://localhost:3000", "localhost.", "www.localhost.", "acme..com"]) {
      const r = createBrand("acme", bad);
      expect(r.ok).toBe(false);
      expect(r.note).toContain("not a usable domain");
    }
    expect(db.select().from(schema.brands).all()).toEqual([]);
  });

  it("treats a fully-qualified trailing dot as the same host, not as a reason to refuse", () => {
    // The guard above must not overshoot: "acme.com." IS acme.com.
    const r = createBrand("acme", "www.acme.com.");
    expect(r.ok).toBe(true);
    expect(r.primaryDomain).toBe("acme.com");
    expect(r.aliases).toEqual(["acme.com", "acme com"]);
  });
});

describe("the domain-derived fallback obeys the same rule as a created brand", () => {
  // REVIEWER FINDING: `brand create` refused dotless hosts, but identityFromDomain — the
  // fallback used for a surface with no brand row (observedSurfaceIdentity) — only tested
  // `includes(".")`. So a config with `domain: acme.` produced the bare alias "acme",
  // matchable in ordinary prose, with no operator having typed it and no brand row in
  // sight. Both paths now normalize through the same brandHost.
  it("returns no identity for a host that would seed a bare token", () => {
    for (const bad of ["localhost", "localhost.", "acme.", "www.localhost.", "acme..com", ""]) {
      expect(identityFromDomain("derived:x", bad)).toBeNull();
    }
  });

  it("still derives the ordinary identity, trailing dot and URL form included", () => {
    for (const good of ["www.acme.com", "acme.com.", "https://www.acme.com/pricing"]) {
      expect(identityFromDomain("derived:x", good)!.aliases).toEqual(["acme.com", "acme com"]);
    }
  });
});

describe("brand alias", () => {
  beforeEach(() => {
    createBrand("acme", "acme.com");
  });

  it("is the one way a bare name becomes matchable", () => {
    const before = storedIdentity("acme")!;
    expect(extractEntities("Acme is a solid invoicing tool.", lane, before).ownedHit).toBe(false);

    const r = addBrandAliases("acme", ["Acme"]);
    expect(r.ok).toBe(true);
    expect(r.aliases).toEqual(["acme.com", "acme com", "Acme"]);
    expect(extractEntities("Acme is a solid invoicing tool.", lane, storedIdentity("acme")!).ownedHit).toBe(true);
  });

  it("adds without dropping the seeded domain forms", () => {
    addBrandAliases("acme", ["Acme Billing"]);
    addBrandAliases("acme", ["acme.io"]);
    expect(storedIdentity("acme")!.aliases).toEqual(["acme.com", "acme com", "Acme Billing", "acme.io"]);
  });

  it("dedupes case-insensitively rather than storing a second copy", () => {
    const r = addBrandAliases("acme", ["ACME.COM"]);
    expect(r.aliases).toEqual(["acme.com", "acme com"]);
  });

  it("refuses an unknown brand, an empty list, and a blank term", () => {
    expect(addBrandAliases("nope", ["x"]).ok).toBe(false);
    expect(addBrandAliases("acme", []).ok).toBe(false);
    expect(addBrandAliases("acme", ["   "]).ok).toBe(false);
    expect(storedIdentity("acme")!.aliases).toEqual(["acme.com", "acme com"]);
  });
});

describe("brand negative", () => {
  beforeEach(() => {
    createBrand("acme", "acme.com");
    addBrandAliases("acme", ["Acme"]);
  });

  it("sets the veto list, and the veto reaches the matcher", () => {
    expect(extractEntities("Acme Corp filed for an IPO.", lane, storedIdentity("acme")!).ownedHit).toBe(true);
    const r = setBrandNegativeTerms("acme", ["Acme Corp"]);
    expect(r.ok).toBe(true);
    expect(r.negativeTerms).toEqual(["Acme Corp"]);
    expect(extractEntities("Acme Corp filed for an IPO.", lane, storedIdentity("acme")!).ownedHit).toBe(false);
  });

  it("replaces rather than accumulates, and clears with no terms", () => {
    setBrandNegativeTerms("acme", ["Acme Corp"]);
    expect(setBrandNegativeTerms("acme", ["Acme Bank"]).negativeTerms).toEqual(["Acme Bank"]);
    expect(setBrandNegativeTerms("acme", []).negativeTerms).toEqual([]);
  });

  it("never touches the alias list", () => {
    setBrandNegativeTerms("acme", ["Acme Corp"]);
    expect(storedIdentity("acme")!.aliases).toEqual(["acme.com", "acme com", "Acme"]);
  });
});

describe("brand list", () => {
  it("reads back every brand's id and what it matches on", () => {
    expect((listBrands().brands as unknown[]).length).toBe(0);
    createBrand("zeta", "zeta.example");
    createBrand("acme", "acme.com");
    setBrandNegativeTerms("acme", ["Acme Corp"]);
    expect(listBrands().brands).toEqual([
      {
        brandId: "acme",
        name: "acme",
        primaryDomain: "acme.com",
        aliases: ["acme.com", "acme com"],
        negativeTerms: ["Acme Corp"],
      },
      {
        brandId: "zeta",
        name: "zeta",
        primaryDomain: "zeta.example",
        aliases: ["zeta.example", "zeta example"],
        negativeTerms: [],
      },
    ]);
  });
});
