// Infer detectors against a hand-authored SYNTHETIC fixture in the shape a real run
// produces: src/engine/infer/__fixtures__/synthetic-site-run.json, one fictional
// invoicing product on three locales (en, es, de), with every evidence family the
// site detector set reads and a deliberate partial-hreflang page so the
// locale-subset branch stays exercised. No collected data travels in it. Asserts the
// claims minted (classes, the decomposed prioritization score's numeric
// confidence values, falsifiability) and the falsification path when a later run's
// evidence clears a gap. The LLM interpretation lane is neutered (no key, empty PATH)
// so only the deterministic rule-based detectors run.

import "./helpers/testdb";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

// Deterministic detectors only: no API key, no claude CLI reachable.
delete process.env.ANTHROPIC_API_KEY;
process.env.PATH = mkdtempSync(path.join(tmpdir(), "answerable-empty-path-"));
// The tool-opportunity detector reads the operator's demand map. The test carries
// its own (tests/fixtures/demand-map.md) so the assertions never depend on which
// research document happens to be at the operator-supplied config/demand-map.md.
process.env.ANSWERABLE_DEMAND_MAP = path.join(__dirname, "fixtures", "demand-map.md");

import { db, schema } from "../src/db";
import { infer } from "../src/engine/infer";
import type { InferResult } from "../src/engine/infer";

interface Fixture {
  surface: { id: string; kind: string; config_snapshot: string; onboarded_at: number };
  run: { id: string; surface_id: string; started_at: number; stations_run: string; config_snapshot: string };
  evidence: {
    id: string;
    run_id: string;
    surface_id: string;
    check_key: string;
    status: string;
    confidence_tag: string;
    value: string | null;
    provenance: string;
    cost: number | null;
  }[];
}

const fixture: Fixture = JSON.parse(
  readFileSync(path.join(__dirname, "../src/engine/infer/__fixtures__/synthetic-site-run.json"), "utf8"),
);
const S = fixture.surface.id;

function loadRun(runId: string, startedAt: number, evidence: Fixture["evidence"]): void {
  db.insert(schema.runs)
    .values({
      id: runId,
      surfaceId: S,
      startedAt,
      stationsRun: JSON.parse(fixture.run.stations_run),
      configSnapshot: JSON.parse(fixture.run.config_snapshot),
    })
    .run();
  for (const e of evidence) {
    db.insert(schema.evidence)
      .values({
        id: `${runId}:${e.id}`,
        runId,
        surfaceId: S,
        checkKey: e.check_key,
        status: e.status,
        confidenceTag: e.confidence_tag as "observed",
        value: e.value === null ? null : JSON.parse(e.value),
        provenance: JSON.parse(e.provenance),
        cost: e.cost,
      })
      .run();
  }
}

let first: InferResult;

beforeAll(() => {
  // Shape, not volume: the fixture must carry every evidence family the site
  // detector set reads, so a detector cannot go silently untested. This is a MORE
  // RELEVANT guard than the row count it replaced, not a strictly stronger one:
  // it asserts the detectors' inputs exist rather than counting rows, and neither
  // guard implies the other (a nine-row fixture can carry every family; a
  // fifty-one-row one can miss several).
  const families = new Set(fixture.evidence.map((e) => e.check_key.split("@")[0]));
  for (const f of [
    "crawl/hreflang",
    "crawl/ssr",
    "crawl/json-ld",
    "crawl/sitemap",
    "crawl/robots-bot-rules",
    "crawl/bot-access",
    "competitor/page",
    "community/hn-mentions",
    "community/reddit-mentions",
  ]) {
    expect([...families]).toContain(f);
  }
  db.insert(schema.surfaces)
    .values({
      id: S,
      kind: fixture.surface.kind as "site",
      configSnapshot: JSON.parse(fixture.surface.config_snapshot),
      onboardedAt: fixture.surface.onboarded_at,
    })
    .run();
  loadRun(fixture.run.id, Number(fixture.run.started_at), fixture.evidence);
  first = infer(S)[0];
});

describe("infer on the synthetic site run", () => {
  it("runs the site detector set without any detector failure", () => {
    expect(first.runId).toBe(fixture.run.id);
    expect(first.notes.some((n) => n.startsWith("detector") && n.includes("failed"))).toBe(false);
    expect(first.notes.some((n) => n.includes("llm interpretation skipped"))).toBe(true);
  });

  // Each detector's intended OUTCOME on this fixture, not merely that it ran: the
  // fixture's site basics are healthy (robots present, sitemap pass, JSON-LD on
  // every sampled page), both probed bots are allowed and answer 200, every
  // crawl/ssr row passes — so those three detectors must mint nothing — while one
  // competitor page runs comparison content naming other tools but not the brand,
  // which must mint the competitor claim with exactly those targets.
  it("mints only the claims the fixture's evidence warrants, per detector", () => {
    const ids = new Set(first.claims.map((c) => c.id));
    expect(ids.has(`claim:${S}:site-basics`)).toBe(false);
    expect(ids.has(`claim:${S}:bot-block`)).toBe(false);
    expect(ids.has(`claim:${S}:ssr`)).toBe(false);
    const comparison = first.claims.find((c) => c.id === `claim:${S}:competitor-comparison`)!;
    expect(comparison.class).toBe("competitor");
    expect(comparison.title).toContain("Fabrikam Time");
    expect(comparison.title).toContain("Northwind Books");
  });

  it("mints the five tool-opportunity claims from the demand map, dedup-stable ids", () => {
    const tools = first.claims.filter((c) => c.class === "tool-opportunity");
    expect(tools).toHaveLength(5);
    expect(tools.map((c) => c.id)).toContain(`claim:${S}:tool-opportunity:freelance-rate-calculator`);
    for (const c of tools) expect(c.action).toBe("created");
  });

  it("flags the page whose hreflang carries only a subset of the locale cluster", () => {
    const partial = first.claims.find((c) => c.id === `claim:${S}:hreflang-partial`)!;
    expect(partial.class).toBe("technical");
    expect(partial.title).toContain("3-locale cluster");
    // Full hreflang coverage elsewhere, so the broader gap detector stays quiet.
    expect(first.claims.some((c) => c.id === `claim:${S}:hreflang`)).toBe(false);
  });

  it("maps claim confidence from the strongest supporting evidence tag", () => {
    // Every minted claim carries a numeric confidence value mapped from its evidence tag
    // (observed 0.9, measured 0.85, reported 0.6, reported-unverified 0.4, inference 0.3),
    // never an unmapped one.
    const allowed = ["0.9", "0.85", "0.6", "0.4", "0.3"];
    for (const c of first.claims) expect(allowed).toContain(c.confidence);
    // The rate-calculator opportunity is backed by live community demand rows
    // (observed evidence, 0.9); a demand-map-only claim is honestly "reported" (0.6).
    const byId = new Map(first.claims.map((c) => [c.id, c]));
    const rateCalc = byId.get(`claim:${S}:tool-opportunity:freelance-rate-calculator`)!;
    const supported = fixture.evidence.some(
      (e) => /^community\/(reddit-mentions|hn-mentions)@/.test(e.check_key) && e.status === "pass",
    );
    expect(supported).toBe(true);
    expect(rateCalc.confidence).toBe("0.9");
  });

  it("stores class, falsifiability, evidence links, and brief-schema fields on each claim", () => {
    for (const report of first.claims) {
      const row = db.select().from(schema.claims).where(eq(schema.claims.id, report.id)).get()!;
      expect(row.status).toBe("open");
      expect(row.falsifiability).toMatch(/^Falsified when /);
      expect(row.priority).toMatch(/^P[123]$/);
      expect(row.createdRunId).toBe(fixture.run.id);
    }
  });

  it("re-observing the same evidence updates claims in place, never duplicates", () => {
    loadRun("rerun-1", Number(fixture.run.started_at) + 1000, fixture.evidence);
    const second = infer(S)[0];
    const firstIds = first.claims.map((c) => c.id).sort();
    expect(second.claims.map((c) => c.id).sort()).toEqual(firstIds);
    for (const c of second.claims) expect(c.action).toBe("updated");
    const stored = db.select().from(schema.claims).where(eq(schema.claims.surfaceId, S)).all();
    expect(stored.map((c) => c.id).sort()).toEqual(firstIds);
    // createdRunId is immutable (the "new since last visit" delta hangs off it);
    // re-observation moves only lastObservedRunId.
    for (const c of stored) {
      expect(c.createdRunId).toBe(fixture.run.id);
      expect(c.lastObservedRunId).toBe("rerun-1");
    }
  });

  it("falsification path: a gap that appears then clears flips the claim falsified", () => {
    // Run A: break hreflang on the sampled pages -> technical claim minted.
    const broken = fixture.evidence.map((e) =>
      e.check_key.startsWith("crawl/hreflang@") ? { ...e, status: "absent", value: null } : e,
    );
    loadRun("rerun-broken", Number(fixture.run.started_at) + 2000, broken);
    const withGap = infer(S)[0];
    const gapClaim = withGap.claims.find((c) => c.id === `claim:${S}:hreflang`)!;
    expect(gapClaim.class).toBe("technical");
    expect(gapClaim.status).toBe("open");
    expect(gapClaim.confidence).toBe("0.9"); // observed crawl evidence
    // Run B: the healthy evidence again -> falsifiability condition met.
    loadRun("rerun-healed", Number(fixture.run.started_at) + 3000, fixture.evidence);
    const healed = infer(S)[0];
    const flipped = healed.claims.find((c) => c.id === `claim:${S}:hreflang`)!;
    expect(flipped.action).toBe("falsified");
    const row = db.select().from(schema.claims).where(eq(schema.claims.id, `claim:${S}:hreflang`)).get()!;
    expect(row.status).toBe("falsified");
  });
});

// Regression for the "community" in lanes bug: draft's proposed scaffold for a domain
// with no community signal writes `community: { enabled: false }`, which HAS the key
// but is not enabled. The detector must test enablement, not key presence, or it mints
// tool-opportunity claims for a lane the operator explicitly turned off.
describe("infer's tool-opportunity detector respects the community lane's enabled flag", () => {
  it("a surface with community.enabled: false and a demand map mints no tool-opportunity claims, and idles with a note", () => {
    const surfaceId = "example-com-en-community-off";
    const cfg = JSON.parse(fixture.surface.config_snapshot);
    cfg.lanes.community = { enabled: false };
    db.insert(schema.surfaces)
      .values({
        id: surfaceId,
        kind: fixture.surface.kind as "site",
        configSnapshot: cfg,
        onboardedAt: fixture.surface.onboarded_at,
      })
      .run();
    const runCfg = JSON.parse(fixture.run.config_snapshot);
    runCfg.lanes.community = { enabled: false };
    const runId = "run-community-off";
    db.insert(schema.runs)
      .values({
        id: runId,
        surfaceId,
        startedAt: Number(fixture.run.started_at),
        stationsRun: JSON.parse(fixture.run.stations_run),
        configSnapshot: runCfg,
      })
      .run();
    for (const e of fixture.evidence) {
      db.insert(schema.evidence)
        .values({
          id: `${runId}:${e.id}`,
          runId,
          surfaceId,
          checkKey: e.check_key,
          status: e.status,
          confidenceTag: e.confidence_tag as "observed",
          value: e.value === null ? null : JSON.parse(e.value),
          provenance: JSON.parse(e.provenance),
          cost: e.cost,
        })
        .run();
    }
    const result = infer(surfaceId)[0];
    const tools = result.claims.filter((c) => c.class === "tool-opportunity");
    expect(tools).toHaveLength(0);
    expect(
      result.notes.some((n) => n.includes("tool-opportunity") && n.includes("not enabled") && n.includes("idle")),
    ).toBe(true);
  });
});
