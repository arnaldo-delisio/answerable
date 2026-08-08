// F1 regression: `verify --json` on a surface with fewer than two runs used to collect a
// fresh run internally by forcing jsonMode on the CLI's `run` command, which PRINTS in
// json mode — landing the inner run's document on stdout before verify's own, so
// `JSON.parse` on the combined stream failed with "Extra data". The fix (runSurface())
// returns the fresh run's result to the caller instead of printing it, folding it into
// verify's own single document under `freshRun`. This test drives the real CLI as a
// subprocess (the actual stdout contract), not the in-process engine functions.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const DDL = `
CREATE TABLE brands (
  id text PRIMARY KEY NOT NULL, name text NOT NULL, primary_domain text NOT NULL,
  created_at integer NOT NULL, discovery text, aliases text, negative_terms text
);
CREATE TABLE surfaces (
  id text PRIMARY KEY NOT NULL, kind text NOT NULL, config_snapshot text NOT NULL,
  onboarded_at integer NOT NULL, lifecycle text DEFAULT 'active' NOT NULL,
  brand_id text REFERENCES brands(id),
  CONSTRAINT surfaces_lifecycle_enum CHECK (lifecycle IN ('active', 'paused', 'archived'))
);
CREATE TABLE runs (
  id text PRIMARY KEY NOT NULL, surface_id text NOT NULL REFERENCES surfaces(id),
  started_at integer NOT NULL, stations_run text NOT NULL, config_snapshot text NOT NULL,
  cost_total real, check_id text, finished_at integer
);
CREATE TABLE evidence (
  id text PRIMARY KEY NOT NULL, run_id text NOT NULL REFERENCES runs(id),
  surface_id text NOT NULL REFERENCES surfaces(id), check_key text NOT NULL,
  status text NOT NULL, confidence_tag text NOT NULL, value text,
  provenance text NOT NULL, cost real
);
CREATE UNIQUE INDEX evidence_surface_run_check_key ON evidence (surface_id, run_id, check_key);
CREATE TABLE panel_observations (
  id text PRIMARY KEY NOT NULL, run_id text NOT NULL REFERENCES runs(id),
  surface_id text NOT NULL REFERENCES surfaces(id), prompt_set_version text NOT NULL,
  prompt_id text NOT NULL, engine text NOT NULL, response_digest text NOT NULL,
  entities_cited text NOT NULL, owned_hit integer
);
CREATE TABLE claims (
  id text PRIMARY KEY NOT NULL, surface_id text NOT NULL REFERENCES surfaces(id),
  class text NOT NULL, status text NOT NULL, title text NOT NULL, query_topic text,
  intent text, recommended_asset text, priority text, brief_status text,
  confidence text NOT NULL, falsifiability text NOT NULL,
  created_run_id text NOT NULL REFERENCES runs(id),
  last_observed_run_id text NOT NULL REFERENCES runs(id), narration text
);
CREATE TABLE claim_evidence (
  claim_id text NOT NULL REFERENCES claims(id), evidence_id text NOT NULL REFERENCES evidence(id),
  PRIMARY KEY(claim_id, evidence_id)
);
CREATE TABLE bets (
  id text PRIMARY KEY NOT NULL, claim_id text NOT NULL REFERENCES claims(id),
  surface_id text NOT NULL REFERENCES surfaces(id), action_class text NOT NULL,
  impact real NOT NULL, effort real NOT NULL, confidence real NOT NULL,
  outcome_metric text NOT NULL, outcome_window text NOT NULL, state text NOT NULL,
  placed_at integer NOT NULL, shipped_at integer, exec_verified_at integer,
  outcome_assessed_at integer, settled_at integer, exec_verify_run_id text REFERENCES runs(id),
  settlement text, outcome_note text, class_weight real, prior real, score real, narration text,
  CONSTRAINT bets_exec_verified_requires_shipped_at CHECK (state NOT IN ('exec-verified', 'outcome-assessed', 'settled') OR shipped_at IS NOT NULL),
  CONSTRAINT bets_settled_requires_outcome_assessed_at CHECK (state != 'settled' OR outcome_assessed_at IS NOT NULL)
);
CREATE TABLE assets (
  id text PRIMARY KEY NOT NULL, bet_id text NOT NULL REFERENCES bets(id), type text NOT NULL,
  body text, route text, state text NOT NULL, approved_by text, published_at integer,
  skip_reason text, rejected_reason text, covered_claim_ids text,
  CONSTRAINT assets_rejected_requires_reason CHECK (state != 'rejected' OR rejected_reason IS NOT NULL)
);
CREATE TABLE snapshots (
  id text PRIMARY KEY NOT NULL, run_id text NOT NULL REFERENCES runs(id),
  surface_id text NOT NULL REFERENCES surfaces(id), metric text NOT NULL,
  value real NOT NULL, meta text
);
`;

const REPO_ROOT = path.resolve(__dirname, "..");

function freshDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "answerable-cli-test-"));
  const dbPath = path.join(dir, "answerable-test.db");
  const raw = new Database(dbPath);
  raw.exec(DDL);
  const surfaceId = "cli-single-doc-surface";
  raw
    .prepare(
      "INSERT INTO surfaces (id, kind, config_snapshot, onboarded_at) VALUES (?, ?, ?, ?)",
    )
    .run(surfaceId, "web-locale", JSON.stringify({ id: surfaceId, kind: "web-locale", lanes: {} }), Date.now());
  // Exactly one prior run: `diffLastTwoRuns` needs two, so verify must collect a fresh
  // one to reach two total — this is what exercises the "collect internally" path.
  raw
    .prepare(
      "INSERT INTO runs (id, surface_id, started_at, stations_run, config_snapshot, finished_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run("prior-run", surfaceId, Date.now() - 60_000, "[]", "{}", Date.now() - 60_000);
  raw.close();
  return dbPath;
}

describe("verify --json single-document contract (CLI subprocess)", () => {
  it("emits exactly one parseable JSON document when fewer than two runs exist", () => {
    const dbPath = freshDb();
    const stdout = execFileSync(
      "npx",
      ["tsx", "src/cli.ts", "verify", "cli-single-doc-surface", "--json"],
      { cwd: REPO_ROOT, env: { ...process.env, ANSWERABLE_DB_PATH: dbPath }, encoding: "utf8" },
    );

    // Strict single-document check: JSON.parse throws on trailing data, unlike a
    // raw-decode loop that would happily find two documents back to back.
    const parsed = JSON.parse(stdout);
    expect(parsed.surfaceId).toBe("cli-single-doc-surface");
    expect(parsed.freshRun).toBeTruthy();
    expect(parsed.freshRun.runId).toBeTruthy();
    expect(parsed.diff).toBeTruthy();
  });

  it("prints no raw JSON blob in human mode", () => {
    const dbPath = freshDb();
    const stdout = execFileSync(
      "npx",
      ["tsx", "src/cli.ts", "verify", "cli-single-doc-surface"],
      { cwd: REPO_ROOT, env: { ...process.env, ANSWERABLE_DB_PATH: dbPath }, encoding: "utf8" },
    );
    expect(stdout).not.toMatch(/^\{/m);
    expect(stdout).not.toContain('"runId":');
  });
});
