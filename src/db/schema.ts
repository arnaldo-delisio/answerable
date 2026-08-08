// Data model: SQLite via Drizzle, Postgres-shaped (portable to Postgres later without
// a redesign).
// Text ids, integer timestamps as epoch ms, JSON columns as text with $type<>.

import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  real,
  primaryKey,
  uniqueIndex,
  check,
} from "drizzle-orm/sqlite-core";

// ---- shared JSON shapes -------------------------------------------------

export type SurfaceKind = "web-locale" | "ai-engine-lane" | "community-platform";

export type ConfidenceTag =
  | "observed"
  | "measured"
  | "reported"
  | "reported-unverified"
  | "inference";

export interface EntityCited {
  entity: string;
  url: string;
  rank: number;
}

// ---- tables -------------------------------------------------------------

// Brands (grouping layer over surfaces, additive): a brand is an umbrella —
// surfaces keep their own identity and lifecycle, which stays untouched; brand_id on
// surfaces is nullable so pre-brand rows stay valid. `discovery` stores the last
// brand-draft proposal (facets + per-facet evidence + activation notes) so a brand's
// found-but-unmonitored surfaces can be reported honestly instead of silently dropped.
export const brands = sqliteTable("brands", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  primaryDomain: text("primary_domain").notNull(),
  createdAt: integer("created_at").notNull(), // epoch ms
  discovery: text("discovery", { mode: "json" }).$type<Record<string, unknown>>(),
  // Brand identity profile: what text identifies this brand, as DATA.
  // aliases = unambiguous name/domain variants that count as this brand;
  // negative_terms = tokens whose presence marks a match as NOT this brand
  // (e.g. "for example" for a brand whose token is "example"). Both nullable: a row without them has no
  // profile, and the matchers treat "no profile" as "this brand's own names are
  // unknown", never as a hard-coded guess.
  aliases: text("aliases", { mode: "json" }).$type<string[]>(),
  negativeTerms: text("negative_terms", { mode: "json" }).$type<string[]>(),
});

export const surfaces = sqliteTable(
  "surfaces",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<SurfaceKind>().notNull(),
    configSnapshot: text("config_snapshot", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull(),
    onboardedAt: integer("onboarded_at").notNull(), // epoch ms
    // Operator lifecycle: paused and archived surfaces both skip tick cadence (archived
    // is the retired-for-good form, paused the temporary one). History is never deleted
    // either way, and every station verb still runs on demand for any lifecycle.
    lifecycle: text("lifecycle")
      .$type<"active" | "paused" | "archived">()
      .notNull()
      .default("active"),
    // Nullable grouping pointer (brands layer): null = not yet assigned to a brand.
    brandId: text("brand_id").references(() => brands.id),
  },
  (t) => [check("surfaces_lifecycle_enum", sql`${t.lifecycle} IN ('active', 'paused', 'archived')`)],
);

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  surfaceId: text("surface_id")
    .notNull()
    .references(() => surfaces.id),
  startedAt: integer("started_at").notNull(), // epoch ms
  stationsRun: text("stations_run", { mode: "json" }).$type<string[]>().notNull(),
  // Full surface config used for this run, prompt-set membership included.
  configSnapshot: text("config_snapshot", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull(),
  costTotal: real("cost_total"),
  // Cycle identity: one uuid per Check-now / tick / CLI-run cycle, shared by every
  // run that cycle opens across surfaces. Nullable: runs recorded before this
  // column existed carry null and are grouped by a time-window heuristic for
  // display by a time-window heuristic.
  checkId: text("check_id"),
  // Stamped by finishRun when the run's stations complete. Nullable: legacy rows
  // and runs that died mid-cycle carry null and are excluded from the cycle-
  // duration median any honest ETA derives from.
  finishedAt: integer("finished_at"),
});

export const evidence = sqliteTable(
  "evidence",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    surfaceId: text("surface_id")
      .notNull()
      .references(() => surfaces.id),
    // adapter / check-name @ check-version / subject
    checkKey: text("check_key").notNull(),
    status: text("status").notNull(),
    confidenceTag: text("confidence_tag").$type<ConfidenceTag>().notNull(),
    // Normalized extracted fields, not page dumps.
    value: text("value", { mode: "json" }).$type<Record<string, unknown>>(),
    provenance: text("provenance", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull(),
    cost: real("cost"),
  },
  (t) => [uniqueIndex("evidence_surface_run_check_key").on(t.surfaceId, t.runId, t.checkKey)],
);

export const panelObservations = sqliteTable("panel_observations", {
  id: text("id").primaryKey(),
  runId: text("run_id")
    .notNull()
    .references(() => runs.id),
  surfaceId: text("surface_id")
    .notNull()
    .references(() => surfaces.id),
  promptSetVersion: text("prompt_set_version").notNull(),
  promptId: text("prompt_id").notNull(),
  engine: text("engine").notNull(),
  responseDigest: text("response_digest").notNull(),
  entitiesCited: text("entities_cited", { mode: "json" })
    .$type<EntityCited[]>()
    .notNull(),
  // NULLABLE on purpose: null = ungrounded (no brand identity was resolvable for
  // this surface, so the answer was never searched for the operator's names).
  // false means searched-and-absent. See geo-panel.ts PanelObservationRow.
  ownedHit: integer("owned_hit", { mode: "boolean" }),
});

export const claims = sqliteTable("claims", {
  id: text("id").primaryKey(),
  surfaceId: text("surface_id")
    .notNull()
    .references(() => surfaces.id),
  class: text("class").notNull(),
  status: text("status")
    .$type<"open" | "answered" | "dismissed" | "falsified">()
    .notNull(),
  title: text("title").notNull(),
  // Brief-schema row fields, discrete columns.
  queryTopic: text("query_topic"),
  intent: text("intent"),
  recommendedAsset: text("recommended_asset"),
  priority: text("priority"),
  briefStatus: text("brief_status"),
  // Derived deterministically: strongest confidence_tag among linked evidence.
  confidence: text("confidence").notNull(),
  falsifiability: text("falsifiability").notNull(),
  // Immutable birth pointer: set on insert only, never on re-observation — the
  // "new since last visit" delta derives from it, so rewriting it would make old
  // claims masquerade as new.
  createdRunId: text("created_run_id")
    .notNull()
    .references(() => runs.id),
  // The latest run that observed (re-derived) this claim; updated every infer pass.
  lastObservedRunId: text("last_observed_run_id")
    .notNull()
    .references(() => runs.id),
  // Two plain-consequence sentences a reader gets before any jargon (UX clarity
  // override register). Generated by src/engine/lib/narrate.ts; null until narrated.
  narration: text("narration"),
});

export const claimEvidence = sqliteTable(
  "claim_evidence",
  {
    claimId: text("claim_id")
      .notNull()
      .references(() => claims.id),
    evidenceId: text("evidence_id")
      .notNull()
      .references(() => evidence.id),
  },
  (t) => [primaryKey({ columns: [t.claimId, t.evidenceId] })],
);

export const bets = sqliteTable(
  "bets",
  {
  id: text("id").primaryKey(),
  claimId: text("claim_id")
    .notNull()
    .references(() => claims.id),
  surfaceId: text("surface_id")
    .notNull()
    .references(() => surfaces.id),
  actionClass: text("action_class").notNull(),
  // Score fields stored decomposed: the prioritization score is impact x confidence x
  // class weight x prior / effort, and every factor is stored, never a black-box number.
  impact: real("impact").notNull(),
  effort: real("effort").notNull(),
  confidence: real("confidence").notNull(),
  // Remaining decomposed factors. Nullable: bets placed before decide existed carry
  // only the first three.
  classWeight: real("class_weight"),
  prior: real("prior"),
  score: real("score"),
  // The snapshot metric this bet is judged on.
  outcomeMetric: text("outcome_metric").notNull(),
  // Min runs and days after ship before assessment.
  outcomeWindow: text("outcome_window", { mode: "json" })
    .$type<{ minRuns: number; minDays: number }>()
    .notNull(),
  // `cancelled` is the terminal state for a placed bet the operator will not ship
  // (see verbs.cancelBet): without it a placed bet whose claim is dismissed sits in the
  // queue forever with no transition available. Text column, so no DDL change: the
  // lifecycle CHECKs below constrain only the states that claim timestamp evidence.
  state: text("state")
    .$type<"placed" | "shipped" | "exec-verified" | "outcome-assessed" | "settled" | "cancelled">()
    .notNull(),
  // Lifecycle timestamps (epoch ms), one per transition, no single verified flag.
  placedAt: integer("placed_at").notNull(),
  shippedAt: integer("shipped_at"),
  execVerifiedAt: integer("exec_verified_at"),
  outcomeAssessedAt: integer("outcome_assessed_at"),
  settledAt: integer("settled_at"),
  execVerifyRunId: text("exec_verify_run_id").references(() => runs.id),
  settlement: text("settlement").$type<"keep" | "revise" | "stop">(),
  outcomeNote: text("outcome_note"),
  // Plain-consequence narration for the default layer (see claims.narration).
  narration: text("narration"),
  },
  // Lifecycle CHECKs mirroring src/db/transitions.ts (the application-level guard):
  // a state may not claim evidence it does not carry. Enforced on the live db via
  // deliberate drizzle-kit push and mirrored in the test DDL.
  (t) => [
    check("bets_exec_verified_requires_shipped_at", sql`${t.state} NOT IN ('exec-verified', 'outcome-assessed', 'settled') OR ${t.shippedAt} IS NOT NULL`),
    check("bets_settled_requires_outcome_assessed_at", sql`${t.state} != 'settled' OR ${t.outcomeAssessedAt} IS NOT NULL`),
  ],
);

export const assets = sqliteTable(
  "assets",
  {
    id: text("id").primaryKey(),
    betId: text("bet_id")
      .notNull()
      .references(() => bets.id),
    type: text("type").$type<"fix-spec" | "page" | "tool" | "outreach-draft">().notNull(),
    body: text("body"),
    route: text("route"),
    state: text("state")
      .$type<"generated" | "approved" | "published" | "skipped" | "rejected">()
      .notNull(),
    approvedBy: text("approved_by"),
    publishedAt: integer("published_at"), // epoch ms
    // Outreach ethics gate: set when no genuinely helpful draft is possible (claim taxonomy).
    skipReason: text("skip_reason"),
    // Claims this asset actually answers, when it answers more than the one claim
    // whose bet it hangs off (brand-defense ships ONE owned answer page covering every
    // open brand-defense claim on the surface). Lets a bet be reported as
    // "covered by <asset>" instead of dead-ending. Null on single-claim generators.
    coveredClaimIds: text("covered_claim_ids", { mode: "json" }).$type<string[]>(),
    // Review-gate rejection: required one-line reason; a rejected asset's bet
    // feeds learn as a non-win settlement equivalent (src/engine/learn/priors.ts).
    rejectedReason: text("rejected_reason"),
  },
  (t) => [
    check("assets_rejected_requires_reason", sql`${t.state} != 'rejected' OR ${t.rejectedReason} IS NOT NULL`),
  ],
);

export const snapshots = sqliteTable("snapshots", {
  id: text("id").primaryKey(),
  runId: text("run_id")
    .notNull()
    .references(() => runs.id),
  surfaceId: text("surface_id")
    .notNull()
    .references(() => surfaces.id),
  metric: text("metric").notNull(),
  value: real("value").notNull(),
  // e.g. engine lane for share-of-answer
  meta: text("meta", { mode: "json" }).$type<Record<string, unknown>>(),
});
