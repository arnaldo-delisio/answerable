// Sense station: runs the surface's enabled + applicable lanes. Lanes without a built
// adapter write a single "lane-pending" evidence row so absence is visible, never silent
// (honest lane status principle).

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "../../db";
import type { Surface } from "../lib/surface";
import { identityFromDomain, identityFromRow, type BrandIdentity } from "../lib/brand-identity";
import * as crawl from "./adapters/crawl";
import * as community from "./adapters/community";
import * as x from "./adapters/x";
import * as geoPanel from "./adapters/geo-panel";
import * as competitor from "./adapters/competitor";
import * as performance from "./adapters/performance";
import * as dataforseo from "./adapters/dataforseo";
import * as gsc from "./adapters/gsc";
import * as bing from "./adapters/bing";
import * as analytics from "./adapters/analytics";
import type { CollectResult, EvidenceRow } from "./adapters/crawl";
import type { PanelObservationRow } from "./adapters/geo-panel";

type Adapter = { collect(surface: Surface, runId: string): Promise<CollectResult> };

// Adapters stay database-free: the brand's identity profile (aliases + negative
// terms) is resolved HERE, where the db already lives, and passed down as a
// plain value to the adapters that actually match brand text. The rest keep
// their own third parameter (performance takes injected deps), so this is a
// separate lookup rather than a widened shared signature.
type BrandAwareAdapter = {
  collect(surface: Surface, runId: string, identity: BrandIdentity | null): Promise<CollectResult>;
};

// Built adapters by lane name; every other lane is honestly pending.
// performance/dataforseo/gsc/bing/analytics are typed key-pending adapters: each
// writes one honest lane-status row naming the unlock and price until keys exist.
const ADAPTERS: Record<string, Adapter> = {
  crawl,
  community,
  x,
  "geo-panel": geoPanel,
  competitor,
  performance,
  dataforseo,
  gsc,
  bing,
  analytics,
};

// The lanes that read brand text and therefore need the identity profile.
const BRAND_AWARE: Record<string, BrandAwareAdapter> = {
  community,
  x,
  "geo-panel": geoPanel,
};

export function laneEnabled(config: unknown): boolean {
  if (config === null || typeof config !== "object") return false;
  return (config as Record<string, unknown>).enabled === true;
}

// The one database read behind brand matching: the surface's brand id -> that
// brand's stored identity profile. Kept here rather than in the adapters so the
// adapters stay pure and testable with a plain object.
export function loadBrandIdentity(brandId: string | undefined): BrandIdentity | null {
  if (!brandId) return null;
  const row = db.select().from(schema.brands).where(eq(schema.brands.id, brandId)).get();
  return identityFromRow(row ?? null);
}

// Brand membership has two representations: the relational truth (surfaces.brand_id,
// what grouping reads, and the only thing adoption sets) and the config truth
// (the surface config's "brand" key). Adoption deliberately leaves the operator's config
// byte-for-byte, so a surface adopted into a brand can carry the column and no config
// key. The column is therefore authoritative here, with the config key as the fallback
// for surfaces whose row is absent (unsaved/parsed-only configs) or unassigned.
// Fallback identity for a surface with no brand row: the web surface it declares it
// OBSERVES already names the target domain, so the operator's identity is on record
// even before a brand exists. `onboard` refuses a config naming an unknown brand, and the
// quickstart creates none, so this is the ordinary state of a fresh install, not an edge
// case: a brand only exists once the operator runs `answerable brand create` or
// `npm run db:brands`. Domain-only and transient (never written to the brands table).
export function observedSurfaceIdentity(surface: Surface): BrandIdentity | null {
  const observed = surface.observes;
  if (!observed) return null;
  const row = db.select().from(schema.surfaces).where(eq(schema.surfaces.id, observed)).get();
  const domain = (row?.configSnapshot as { target?: { domain?: string } } | undefined)?.target?.domain;
  if (typeof domain !== "string" || domain.length === 0) return null;
  return identityFromDomain(`derived:${observed}`, domain);
}

export function resolveBrandIdentity(surface: Surface): BrandIdentity | null {
  const row = db.select().from(schema.surfaces).where(eq(schema.surfaces.id, surface.id)).get();
  return loadBrandIdentity(row?.brandId ?? surface.brand) ?? observedSurfaceIdentity(surface);
}

export interface SenseResult {
  rowsWritten: number;
  laneCosts: Record<string, number>;
  cost: number;
}

export async function sense(surface: Surface, runId: string): Promise<SenseResult> {
  const evidenceRows: EvidenceRow[] = [];
  const panelRows: PanelObservationRow[] = [];
  const laneCosts: Record<string, number> = {};
  // null = neither the surfaces row nor the config names a brand, or that brand has
  // no identity profile yet. The brand matchers then match nothing rather than
  // guessing at names.
  const identity = resolveBrandIdentity(surface);


  for (const [lane, config] of Object.entries(surface.lanes)) {
    if (!laneEnabled(config)) continue;
    const adapter = ADAPTERS[lane];
    if (adapter) {
      const brandAware = BRAND_AWARE[lane];
      const result = brandAware
        ? await brandAware.collect(surface, runId, identity)
        : await adapter.collect(surface, runId);
      evidenceRows.push(...result.evidence);
      panelRows.push(...(result.panelObservations as PanelObservationRow[]));
      laneCosts[lane] = result.cost;
    } else {
      evidenceRows.push({
        id: randomUUID(),
        runId,
        surfaceId: surface.id,
        checkKey: `sense/lane-status@v1/${lane}`,
        status: "lane-pending",
        confidenceTag: "observed",
        value: { lane, reason: "adapter not built yet" },
        provenance: { url: null, fetched_at: Date.now(), method: "none" },
        cost: 0,
      });
      laneCosts[lane] = 0;
    }
  }

  replaceRunEvidence(runId, evidenceRows, panelRows);

  const cost = Object.values(laneCosts).reduce((a, b) => a + b, 0);
  return { rowsWritten: evidenceRows.length + panelRows.length, laneCosts, cost };
}

// Idempotent per station, lineage-safe: claim_evidence rows (written by infer) reference
// evidence ids, so a sense re-run must never delete-and-reinsert wholesale (that breaks
// the FK once infer has run). check_key is the stable evidence identity, so: rows matching
// an existing (surface_id, check_key) for this run are UPDATEd in place (the old id
// survives, lineage intact); genuinely new keys insert.
// For keys that vanish on the re-run: the "missing" state is the run-over-run DIFFER's
// contract (a key present in the previous run and absent now), not an intra-run one, so
// the correct minimal branch here is: delete vanished rows nothing references, and keep
// rows claim_evidence still points at with status "superseded" so their lineage stays
// inspectable without pretending they were re-observed. check_key is the stable identity
// behind this (evidence identity).
export function replaceRunEvidence(
  runId: string,
  evidenceRows: EvidenceRow[],
  panelRows: PanelObservationRow[],
): void {
  // Collision-proof composite key: deliberately not a naive `${a}-${b}` join, since a
  // hyphen (or any separator that can appear inside surfaceId/checkKey) lets `a-b`+`c`
  // collide with `a`+`b-c`. JSON.stringify of the pair keeps the two components
  // unambiguous while staying plain text (a raw NUL byte here made this whole file
  // binary to grep, silently hiding it from every text-based audit sweep).
  const identity = (surfaceId: string, checkKey: string) => JSON.stringify([surfaceId, checkKey]);
  const oldRows = db.select().from(schema.evidence).where(eq(schema.evidence.runId, runId)).all();
  const oldByKey = new Map(oldRows.map((r) => [identity(r.surfaceId, r.checkKey), r]));
  const newKeys = new Set<string>();

  for (const row of evidenceRows) {
    const key = identity(row.surfaceId, row.checkKey);
    newKeys.add(key);
    const old = oldByKey.get(key);
    if (old) {
      db.update(schema.evidence)
        .set({
          status: row.status,
          confidenceTag: row.confidenceTag as typeof old.confidenceTag,
          value: row.value,
          provenance: row.provenance,
          cost: row.cost,
        })
        .where(eq(schema.evidence.id, old.id))
        .run();
    } else {
      db.insert(schema.evidence).values(row).run();
    }
  }

  const vanished = oldRows.filter((r) => !newKeys.has(identity(r.surfaceId, r.checkKey)));
  if (vanished.length > 0) {
    const referenced = new Set(
      db
        .select()
        .from(schema.claimEvidence)
        .where(inArray(schema.claimEvidence.evidenceId, vanished.map((r) => r.id)))
        .all()
        .map((l) => l.evidenceId),
    );
    for (const r of vanished) {
      if (referenced.has(r.id)) {
        db.update(schema.evidence).set({ status: "superseded" }).where(eq(schema.evidence.id, r.id)).run();
      } else {
        db.delete(schema.evidence).where(eq(schema.evidence.id, r.id)).run();
      }
    }
  }

  // panel_observations carry no inbound FKs: plain replacement stays correct.
  db.delete(schema.panelObservations).where(eq(schema.panelObservations.runId, runId)).run();
  if (panelRows.length > 0) db.insert(schema.panelObservations).values(panelRows).run();
}
