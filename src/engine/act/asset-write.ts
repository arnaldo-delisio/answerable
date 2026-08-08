// The ONE write path for generated assets. Every act generator upserts through here,
// so the review gate is enforced in a single place rather than re-implemented (and
// forgotten) per generator.
//
// The gate rule, stated once in README and AGENTS.md: an approved or published asset is
// past the gate and is never rewritten underneath it. A regeneration that would land on
// such an asset refuses with an honest note and leaves the stored row byte-identical —
// the same shape as every other guarded refusal in this codebase (a note, never a throw,
// never a silent write). `skipped` and `rejected` are gate decisions too: the human acted
// on them, so they are equally frozen.

import { eq } from "drizzle-orm";
import { db, schema } from "../../db";

type AssetInsert = typeof schema.assets.$inferInsert;
type AssetUpdate = Partial<Omit<AssetInsert, "id">>;

// States the human review gate has acted on: never overwritten by a generator.
export const GATED_ASSET_STATES = ["approved", "published", "skipped", "rejected"] as const;

export interface AssetWriteResult {
  assetId: string;
  written: boolean;
  // Set only when the write was refused; the caller surfaces it as a generator note.
  note: string | null;
}

export function isGated(state: string): boolean {
  return (GATED_ASSET_STATES as readonly string[]).includes(state);
}

// Upsert one asset, refusing any write onto a gated row.
// `update` is what changes on a re-generation (body/route/state/...); omit it to reuse
// the insert values, which is what every generator wants.
export function upsertAsset(values: AssetInsert, update?: AssetUpdate): AssetWriteResult {
  const existing = db.select().from(schema.assets).where(eq(schema.assets.id, values.id)).get();
  if (existing && isGated(existing.state)) {
    return {
      assetId: values.id,
      written: false,
      note: `asset ${values.id} is ${existing.state} (past the review gate); regeneration refused, stored asset untouched`,
    };
  }
  const set: AssetUpdate =
    update ??
    ({
      betId: values.betId,
      body: values.body,
      route: values.route,
      state: values.state,
      skipReason: values.skipReason ?? null,
      coveredClaimIds: values.coveredClaimIds ?? null,
    } as AssetUpdate);
  db.insert(schema.assets)
    .values(values)
    .onConflictDoUpdate({ target: schema.assets.id, set })
    .run();
  return { assetId: values.id, written: true, note: null };
}
