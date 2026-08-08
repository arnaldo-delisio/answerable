// `answerable brand add <domain>` — the entry point — and the kind rename behind it.
//
// Two things are load-bearing here and neither is about the happy path (which needs a
// live network and is exercised by hand against a real domain):
//
//   1. A refusal writes NOTHING. `brand add` creates a brand row and writes config files;
//      an already-existing brand must be refused before the probe runs, or a retry after a
//      typo would spend a network pass and could half-write over an operator's own configs.
//   2. The kinds were renamed (`web-locale` -> `site`, `ai-engine-lane` -> `assistant`)
//      with no compatibility shim, so the validator's message on an old value is the ONLY
//      thing standing between a copied-from-the-internet example and a dead end.

import "./helpers/testdb";
import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { brandAdd } from "../src/engine/lib/brand-add";
import { createBrand, listBrands } from "../src/engine/lib/brands";
import { parseSurface, SurfaceConfigError } from "../src/engine/lib/surface";

function scratchRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "answerable-brand-add-"));
}

function proposedFiles(root: string): string[] {
  try {
    return readdirSync(path.join(root, "config", "surfaces"));
  } catch {
    return []; // the directory is only created when something is written
  }
}

describe("brand add: refusals write nothing", () => {
  it("refuses a dotless domain without probing or writing", async () => {
    const root = scratchRoot();
    const result = await brandAdd("localhost", root);
    expect(result.ok).toBe(false);
    expect(result.note).toContain("not a usable domain");
    expect(proposedFiles(root)).toEqual([]);
  });

  it("refuses a brand that already exists, and points at the verbs that do edit one", async () => {
    const root = scratchRoot();
    expect(createBrand("existing-example-com", "existing.example.com").ok).toBe(true);
    const before = (listBrands().brands as unknown[]).length;

    const result = await brandAdd("existing.example.com", root);
    expect(result.ok).toBe(false);
    expect(result.note).toContain("already exists");
    expect(result.note).toContain("brand alias");
    // No second row, no half-written proposal: the guard runs before the probe.
    expect((listBrands().brands as unknown[]).length).toBe(before);
    expect(proposedFiles(root)).toEqual([]);
  });
});

describe("surface kinds after the rename", () => {
  const config = (kind: string) => `
id: acme-site
kind: ${kind}
target:
  domain: acme.com
  path_prefix: /
  locale: en
audience: buyers
business_goal: growth
desired_conversion: signup
competitors: []
publishing:
  policy: review-required
  owner: operator
lanes:
  crawl:
    enabled: true
`;

  it("accepts the new names", () => {
    expect(parseSurface(config("site")).kind).toBe("site");
  });

  it.each([
    ["web-locale", "site"],
    ["ai-engine-lane", "assistant"],
  ])("tells a config still saying %s to write %s", (old, replacement) => {
    expect(() => parseSurface(config(old))).toThrow(SurfaceConfigError);
    expect(() => parseSurface(config(old))).toThrow(`kind: ${replacement}`);
  });

  it("still lists the valid set for a kind that was never a kind", () => {
    expect(() => parseSurface(config("newsletter"))).toThrow("is not one of site | assistant | community-platform");
  });
});
