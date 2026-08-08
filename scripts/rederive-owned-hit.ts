// One-off re-derivation: re-check every stored
// panel_observations row that counted an owned hit, under the corrected rule (a bare
// brand token needs the domain or a declared context word in the response). Rows are judged
// against response_digest — the stored first 500 chars, the only response text kept —
// so this pass only DEMOTES hits whose digest shows no grounding; it never promotes a
// miss (truncated text can hide a hit, not fabricate one). Affected runs'
// share_of_answer snapshot rows are recomputed with the same denominators run.ts uses.

import { eq } from "drizzle-orm";
import { db, schema } from "../src/db";
import { extractEntities } from "../src/engine/sense/adapters/geo-panel";
import { resolveBrandIdentity } from "../src/engine/sense";
import type { Surface } from "../src/engine/lib/surface";

const obs = db.select().from(schema.panelObservations).all();
const affectedRuns = new Set<string>();
let demoted = 0;

for (const o of obs) {
  if (o.ownedHit !== true) continue;
  const surface = db.select().from(schema.surfaces).where(eq(schema.surfaces.id, o.surfaceId)).get();
  if (!surface) continue;
  // Re-judging needs the same identity the sense station used. Without one,
  // extractEntities returns ownedHit null (ungrounded) and demoting on that would
  // rewrite a real hit as a miss on no evidence: skip the row instead.
  const identity = resolveBrandIdentity(surface.configSnapshot as unknown as Surface);
  if (!identity) {
    console.log(`skipped ${o.surfaceId}/${o.promptId} (run ${o.runId}): no brand identity to re-judge against`);
    continue;
  }
  const { ownedHit, entities } = extractEntities(
    o.responseDigest,
    surface.configSnapshot as unknown as Surface,
    identity,
  );
  if (ownedHit !== false) continue;
  db.update(schema.panelObservations)
    .set({ ownedHit: false, entitiesCited: entities })
    .where(eq(schema.panelObservations.id, o.id))
    .run();
  affectedRuns.add(o.runId);
  demoted++;
  console.log(`demoted ${o.surfaceId}/${o.promptId} (run ${o.runId}): digest shows no brand grounding`);
}

for (const runId of affectedRuns) {
  const run = db.select().from(schema.runs).where(eq(schema.runs.id, runId)).get();
  if (!run) continue;
  const rows = db.select().from(schema.panelObservations).where(eq(schema.panelObservations.runId, runId)).all();
  const snapRows = db
    .select()
    .from(schema.snapshots)
    .where(eq(schema.snapshots.runId, runId))
    .all()
    .filter((s) => s.metric === "share_of_answer");
  for (const snap of snapRows) {
    const snapEngine = (snap.meta as { engine?: string } | null)?.engine;
    const engineRows = rows.filter((p) => p.engine === snapEngine);
    const hits = engineRows.filter((p) => p.ownedHit === true).length;
    const grounded = engineRows.filter((p) => p.ownedHit !== null).length;
    // Same denominator rule as run.ts finishRun: rows both OBSERVED and GROUNDED,
    // i.e. `grounded` itself. Neither a failed prompt (no row at all) nor an
    // ungrounded row (no brand identity to search it for) is evidence of a miss,
    // so neither joins the denominator, whether or not the run snapshot carries a
    // recorded prompt set.
    const ungrounded = engineRows.length - grounded;
    const denominator = grounded;
    if (denominator <= 0) continue;
    const value = hits / denominator;
    const meta: Record<string, unknown> = {
      ...((snap.meta as Record<string, unknown> | null) ?? {}),
      judged: denominator,
    };
    if (ungrounded > 0) meta.ungrounded = ungrounded;
    db.update(schema.snapshots).set({ value, meta }).where(eq(schema.snapshots.id, snap.id)).run();
    console.log(`snapshot ${snap.id} (run ${runId}, engine ${snapEngine}): ${snap.value} -> ${value}`);
  }
}

console.log(`done: ${demoted} observation(s) demoted, ${affectedRuns.size} run(s) re-aggregated`);
