// Adopted legacy surfaces must sense WITH their brand identity. Adoption
// (brands/actions.ts activateOrAdopt) sets surfaces.brand_id only, deliberately
// leaving the operator's config untouched — so a surface adopted before the brands
// layer has the column and NO "brand" key in its config. Identity resolution must
// therefore read the relational column first and fall back to the config key.

import "./helpers/testdb";
import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "../src/db";
import { parseSurface } from "../src/engine/lib/surface";
import { resolveBrandIdentity } from "../src/engine/sense";

const BRAND = "acme-brand";

const yaml = (id: string, brandKey: string) => `
id: ${id}
kind: web-locale
target:
  domain: www.acme.example
  path_prefix: /
  locale: en
audience: buyers
business_goal: signups
desired_conversion: signup
competitors: []
publishing:
  policy: review-required
  owner: operator
${brandKey}lanes:
  community: { enabled: true }
`;

// Adopted legacy surface: no "brand" key in the config at all.
const adopted = parseSurface(yaml("adopted-legacy-en", ""));
// Config-key surface: declares its brand the modern way, row unassigned.
const declared = parseSurface(yaml("declared-en", `brand: ${BRAND}\n`));
// Neither: no row assignment, no config key.
const orphan = parseSurface(yaml("orphan-en", ""));

beforeAll(() => {
  db.insert(schema.brands)
    .values({
      id: BRAND,
      name: "Acme",
      primaryDomain: "www.acme.example",
      createdAt: 1,
      aliases: ["acme.example", "acme corp"],
      negativeTerms: ["acme anvil"],
    })
    .run();
  db.insert(schema.surfaces)
    .values({ id: adopted.id, kind: "web-locale", configSnapshot: {}, onboardedAt: 1, brandId: BRAND })
    .run();
  db.insert(schema.surfaces)
    .values({ id: declared.id, kind: "web-locale", configSnapshot: {}, onboardedAt: 1 })
    .run();
  db.insert(schema.surfaces)
    .values({ id: orphan.id, kind: "web-locale", configSnapshot: {}, onboardedAt: 1 })
    .run();
});

describe("brand identity resolution at sense time", () => {
  it("resolves an adopted legacy surface from surfaces.brand_id, with no config brand key", () => {
    expect(adopted.brand).toBeUndefined();
    const identity = resolveBrandIdentity(adopted);
    expect(identity).not.toBeNull();
    expect(identity!.aliases).toEqual(["acme.example", "acme corp"]);
  });

  it("still resolves from the config brand key when the row carries no assignment", () => {
    expect(declared.brand).toBe(BRAND);
    expect(resolveBrandIdentity(declared)?.aliases).toEqual(["acme.example", "acme corp"]);
  });

  it("is null when neither the row nor the config names a brand: no guessing", () => {
    expect(resolveBrandIdentity(orphan)).toBeNull();
  });
});
