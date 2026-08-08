// The fresh-operator honesty case for the AI-answer lane.
//
// The documented quickstart onboards a web surface and its geo surfaces WITHOUT
// creating a brand row (onboard refuses a config naming an unknown brand, and no
// CLI verb creates one). Before this behavior existed, that produced a confident,
// wrong zero: every observation landed owned_hit false, share of answer read 0%,
// and the infer step minted ai-visibility and brand-defense gap claims about a
// brand the engine had never learned the name of — including on answers that named
// the operator's domain outright.
//
// Two things fix it and both are asserted here:
//   1. A geo surface with no brand derives a domain-only identity from the web
//      surface it declares it OBSERVES, which already carries target.domain. A
//      mention of that domain is a real owned hit.
//   2. When nothing at all can ground the identity, the observation is UNGROUNDED
//      (owned_hit null), not a miss, and no claim about the brand's absence is
//      minted from it.

import "./helpers/testdb";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// Deterministic detectors only (the LLM interpretation lane must not run).
delete process.env.ANTHROPIC_API_KEY;
process.env.PATH = mkdtempSync(path.join(tmpdir(), "answerable-empty-path-"));

import { db, schema } from "../src/db";
import { parseSurface } from "../src/engine/lib/surface";
import { resolveBrandIdentity } from "../src/engine/sense";
import { extractEntities, promptSlug } from "../src/engine/sense/adapters/geo-panel";
import { infer } from "../src/engine/infer";

const WEB = "example-com-en";
const UNBRANDED_LANE = "example-geo-chatgpt"; // observes WEB, no brand row, no brand key
const ORPHAN_LANE = "orphan-geo-chatgpt"; // observes a surface that was never onboarded
const BRANDED_LANE = "acme-geo-chatgpt"; // surfaces.brand_id set, the pre-existing path
const BRAND = "acme-brand";

const webYaml = (id: string, domain: string) => `
id: ${id}
kind: site
target:
  domain: ${domain}
  path_prefix: /en
  locale: en
audience: freelancers
business_goal: signups
desired_conversion: signup
competitors: []
publishing:
  policy: review-required
  owner: operator
lanes:
  crawl: { enabled: true }
`;

const laneYaml = (id: string, observes: string) => `
id: ${id}
kind: assistant
target:
  engine: chatgpt
  prompt_set:
    version: discovery-v1
    prompts:
      - What is the best invoicing tool for freelancers?
      - Is example.com legit?
observes: ${observes}
audience: freelancers
business_goal: share of answer
desired_conversion: signup
competitors:
  - name: Northwind Books
    url: https://northwind.example
publishing:
  policy: review-required
  owner: operator
lanes:
  geo-panel:
    enabled: true
`;

const web = parseSurface(webYaml(WEB, "www.example.com"));
const unbranded = parseSurface(laneYaml(UNBRANDED_LANE, WEB));
const orphan = parseSurface(laneYaml(ORPHAN_LANE, "never-onboarded-surface"));
const branded = parseSurface(laneYaml(BRANDED_LANE, WEB));

const PROMPTS = [
  "What is the best invoicing tool for freelancers?",
  "Is example.com legit?",
];

function onboard(surface: ReturnType<typeof parseSurface>, brandId?: string): void {
  db.insert(schema.surfaces)
    .values({
      id: surface.id,
      kind: surface.kind,
      configSnapshot: surface as unknown as Record<string, unknown>,
      onboardedAt: 1,
      ...(brandId ? { brandId } : {}),
    })
    .run();
}

// One panel run on a lane, with the answers the engine actually returned. `identity`
// is whatever the sense station would have resolved, so this exercises the real
// matching path rather than hand-setting owned_hit.
function runLane(surface: ReturnType<typeof parseSurface>, runId: string, answers: string[]): void {
  db.insert(schema.runs)
    .values({
      id: runId,
      surfaceId: surface.id,
      startedAt: 100,
      stationsRun: ["sense", "infer"],
      configSnapshot: surface as unknown as Record<string, unknown>,
    })
    .run();
  const identity = resolveBrandIdentity(surface);
  answers.forEach((answer, i) => {
    const promptId = promptSlug(PROMPTS[i]);
    const { entities, ownedHit } = extractEntities(answer, surface, identity);
    db.insert(schema.evidence)
      .values({
        id: `${runId}:ev:${i}`,
        runId,
        surfaceId: surface.id,
        checkKey: `geo-panel/prompt@v1/${promptId}`,
        status: "pass",
        confidenceTag: "observed",
        value: { engine: "chatgpt", prompt: PROMPTS[i], owned_hit: ownedHit },
        provenance: { url: null, fetched_at: 100, method: "cli:codex" },
        cost: 0,
      })
      .run();
    db.insert(schema.panelObservations)
      .values({
        id: `${runId}:obs:${i}`,
        runId,
        surfaceId: surface.id,
        promptSetVersion: "discovery-v1",
        promptId,
        engine: "chatgpt",
        responseDigest: answer,
        entitiesCited: entities,
        ownedHit,
      })
      .run();
  });
}

// The answers the engine returned: the first names a competitor only, the second
// names the operator's own domain outright. Under the old behavior BOTH landed
// owned_hit false on an unbranded surface.
const ANSWERS = [
  "For freelancers, Northwind Books is a solid pick.",
  "Yes, example.com is a legitimate invoicing service used by many freelancers.",
];

beforeAll(() => {
  db.insert(schema.brands)
    .values({
      id: BRAND,
      name: "Example",
      primaryDomain: "www.example.com",
      createdAt: 1,
      aliases: ["example.com", "example com"],
      negativeTerms: [],
    })
    .run();
  onboard(web);
  onboard(unbranded);
  onboard(orphan);
  onboard(branded, BRAND);
  runLane(unbranded, "run-unbranded", ANSWERS);
  runLane(orphan, "run-orphan", ANSWERS);
  runLane(branded, "run-branded", ANSWERS);
});

describe("(a) unbranded geo surface: identity derived from the surface it observes", () => {
  it("derives a domain-only identity from the observed web surface's target domain", () => {
    const identity = resolveBrandIdentity(unbranded);
    expect(identity).not.toBeNull();
    // Nothing invented: the registrable domain and its spoken form, both readable
    // straight out of the config the operator already wrote.
    expect(identity!.aliases).toEqual(["example.com", "example com"]);
    // No bare token anywhere. The leading label of a registrable domain is often an
    // ordinary English word; no identity, derived or stored, matches it unless the
    // operator wrote it into aliases themselves.
    expect(identity!.aliases).not.toContain("example");
    expect(identity!.negativeTerms).toEqual([]);
  });

  it("registers a real owned hit when the answer names that domain", () => {
    const obs = db.select().from(schema.panelObservations).all().filter((o) => o.surfaceId === UNBRANDED_LANE);
    const byPrompt = new Map(obs.map((o) => [o.promptId, o]));
    expect(byPrompt.get(promptSlug(PROMPTS[1]))!.ownedHit).toBe(true);
    // And the competitor-only answer is a genuine, grounded miss — not ungrounded.
    expect(byPrompt.get(promptSlug(PROMPTS[0]))!.ownedHit).toBe(false);
  });

  it("still mints panel claims from those grounded observations", () => {
    const notes = infer(UNBRANDED_LANE)[0];
    expect(notes.claims.map((c) => c.class)).toContain("competitor");
  });
});

describe("(b) a geo surface with no identity at all is ungrounded, and mints nothing", () => {
  it("records owned_hit null, never false, on every observation", () => {
    expect(resolveBrandIdentity(orphan)).toBeNull();
    const obs = db.select().from(schema.panelObservations).all().filter((o) => o.surfaceId === ORPHAN_LANE);
    expect(obs).toHaveLength(2);
    expect(obs.every((o) => o.ownedHit === null)).toBe(true);
  });

  it("mints NO ai-visibility and NO brand-defense claim from ungrounded observations", () => {
    const result = infer(ORPHAN_LANE)[0];
    const classes = result.claims.map((c) => c.class);
    expect(classes).not.toContain("ai-visibility");
    expect(classes).not.toContain("brand-defense");
    // No claim of any kind: every panel claim is a statement about the brand not
    // being cited, and nothing here looked for the brand.
    expect(result.claims).toEqual([]);
    // The gap is stated, never silent.
    expect(result.notes.join(" ")).toMatch(/no brand identity to match against/);
  });
});

describe("(c) an explicitly branded surface behaves exactly as before", () => {
  it("matches against the stored brand identity, unchanged", () => {
    const identity = resolveBrandIdentity(branded);
    expect(identity!.id).toBe(BRAND);
    const obs = db.select().from(schema.panelObservations).all().filter((o) => o.surfaceId === BRANDED_LANE);
    const byPrompt = new Map(obs.map((o) => [o.promptId, o]));
    expect(byPrompt.get(promptSlug(PROMPTS[1]))!.ownedHit).toBe(true);
    expect(byPrompt.get(promptSlug(PROMPTS[0]))!.ownedHit).toBe(false);
  });

  it("mints its panel claims as it always did", () => {
    const result = infer(BRANDED_LANE)[0];
    expect(result.claims.map((c) => c.class)).toContain("competitor");
    expect(result.notes.join(" ")).not.toMatch(/no brand identity/);
  });
});
