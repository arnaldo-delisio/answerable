// Test database bootstrap. Import this module FIRST (before anything that pulls in
// src/db) in any suite that touches the database: it points ANSWERABLE_DB_PATH at a fresh
// temp file and creates the schema, so tests never read or write data/answerable.db.
// DDL mirrors the live schema (drizzle push output; see src/db/schema.ts).

import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Robust temp-dir creation: ensure the parent exists before mkdtemp (some sandboxes
// report a tmpdir that has not been created yet).
mkdirSync(tmpdir(), { recursive: true });
const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "answerable-test-")), "answerable-test.db");
process.env.ANSWERABLE_DB_PATH = dbPath;

const DDL = `
CREATE TABLE brands (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  primary_domain text NOT NULL,
  created_at integer NOT NULL,
  discovery text,
  aliases text,
  negative_terms text
);
CREATE TABLE surfaces (
  id text PRIMARY KEY NOT NULL,
  kind text NOT NULL,
  config_snapshot text NOT NULL,
  onboarded_at integer NOT NULL,
  lifecycle text DEFAULT 'active' NOT NULL,
  brand_id text REFERENCES brands(id),
  CONSTRAINT surfaces_lifecycle_enum CHECK (lifecycle IN ('active', 'paused', 'archived'))
);
CREATE TABLE runs (
  id text PRIMARY KEY NOT NULL,
  surface_id text NOT NULL REFERENCES surfaces(id),
  started_at integer NOT NULL,
  stations_run text NOT NULL,
  config_snapshot text NOT NULL,
  cost_total real,
  check_id text,
  finished_at integer
);
CREATE TABLE evidence (
  id text PRIMARY KEY NOT NULL,
  run_id text NOT NULL REFERENCES runs(id),
  surface_id text NOT NULL REFERENCES surfaces(id),
  check_key text NOT NULL,
  status text NOT NULL,
  confidence_tag text NOT NULL,
  value text,
  provenance text NOT NULL,
  cost real
);
CREATE UNIQUE INDEX evidence_surface_run_check_key ON evidence (surface_id, run_id, check_key);
CREATE TABLE panel_observations (
  id text PRIMARY KEY NOT NULL,
  run_id text NOT NULL REFERENCES runs(id),
  surface_id text NOT NULL REFERENCES surfaces(id),
  prompt_set_version text NOT NULL,
  prompt_id text NOT NULL,
  engine text NOT NULL,
  response_digest text NOT NULL,
  entities_cited text NOT NULL,
  owned_hit integer
);
CREATE TABLE claims (
  id text PRIMARY KEY NOT NULL,
  surface_id text NOT NULL REFERENCES surfaces(id),
  class text NOT NULL,
  status text NOT NULL,
  title text NOT NULL,
  query_topic text,
  intent text,
  recommended_asset text,
  priority text,
  brief_status text,
  confidence text NOT NULL,
  falsifiability text NOT NULL,
  created_run_id text NOT NULL REFERENCES runs(id),
  last_observed_run_id text NOT NULL REFERENCES runs(id),
  narration text
);
CREATE TABLE claim_evidence (
  claim_id text NOT NULL REFERENCES claims(id),
  evidence_id text NOT NULL REFERENCES evidence(id),
  PRIMARY KEY(claim_id, evidence_id)
);
CREATE TABLE bets (
  id text PRIMARY KEY NOT NULL,
  claim_id text NOT NULL REFERENCES claims(id),
  surface_id text NOT NULL REFERENCES surfaces(id),
  action_class text NOT NULL,
  impact real NOT NULL,
  effort real NOT NULL,
  confidence real NOT NULL,
  outcome_metric text NOT NULL,
  outcome_window text NOT NULL,
  state text NOT NULL,
  placed_at integer NOT NULL,
  shipped_at integer,
  exec_verified_at integer,
  outcome_assessed_at integer,
  settled_at integer,
  exec_verify_run_id text REFERENCES runs(id),
  settlement text,
  outcome_note text,
  class_weight real,
  prior real,
  score real,
  narration text,
  CONSTRAINT bets_exec_verified_requires_shipped_at CHECK (state NOT IN ('exec-verified', 'outcome-assessed', 'settled') OR shipped_at IS NOT NULL),
  CONSTRAINT bets_settled_requires_outcome_assessed_at CHECK (state != 'settled' OR outcome_assessed_at IS NOT NULL)
);
CREATE TABLE assets (
  id text PRIMARY KEY NOT NULL,
  bet_id text NOT NULL REFERENCES bets(id),
  type text NOT NULL,
  body text,
  route text,
  state text NOT NULL,
  approved_by text,
  published_at integer,
  skip_reason text,
  rejected_reason text,
  covered_claim_ids text,
  CONSTRAINT assets_rejected_requires_reason CHECK (state != 'rejected' OR rejected_reason IS NOT NULL)
);
CREATE TABLE snapshots (
  id text PRIMARY KEY NOT NULL,
  run_id text NOT NULL REFERENCES runs(id),
  surface_id text NOT NULL REFERENCES surfaces(id),
  metric text NOT NULL,
  value real NOT NULL,
  meta text
);
`;

const raw = new Database(dbPath);
raw.exec(DDL);
raw.close();

export const TEST_DB_PATH = dbPath;
