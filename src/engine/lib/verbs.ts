// Operator verbs: preview | edit | reject | mark-implemented | settle | cancel | dismiss |
// pause | archive. Each verb is a small state transition (preview is the one read) with
// honest guards: an invalid precondition returns a note (CLI exits 1), never a silent
// write or a throw.

import { eq } from "drizzle-orm";
import { db, schema } from "../../db";
import { assertTransition } from "../../db/transitions";
import { draftIncomplete } from "../act/llm";

export interface VerbResult {
  ok: boolean;
  note: string | null;
  [key: string]: unknown;
}

// Preview: read one generated asset's body back. This engine serves nothing, so reading
// what was generated is a CLI read, never a URL. An asset with no body (a skipped one)
// says so rather than printing an empty string as if it were content.
export function previewAsset(assetId: string): VerbResult {
  const asset = db.select().from(schema.assets).where(eq(schema.assets.id, assetId)).get();
  if (!asset) return { ok: false, note: `asset "${assetId}" not found` };
  if (asset.body === null || asset.body.length === 0) {
    return {
      ok: false,
      note: `asset "${assetId}" has no body${asset.skipReason ? ` (skipped: ${asset.skipReason})` : ""}`,
      assetId,
      type: asset.type,
      state: asset.state,
    };
  }
  return {
    ok: true,
    note: null,
    assetId,
    type: asset.type,
    state: asset.state,
    route: asset.route,
    body: asset.body,
  };
}

// Edit an awaiting-review draft: replace its body wholesale with the operator's own text.
// This is the hand-finishing path for a generator that deliberately leaves gaps to fill
// (the comparison-page generator emits literal "[NEEDS SOURCE]" cells rather than
// inventing facts), so a page that could otherwise never satisfy the approval gate can be
// completed without weakening the gate.
//
// Restricted to `generated`: an approved or published asset has already passed the human
// gate, and editing its body underneath that approval would make the gate meaningless.
// Rejected and skipped assets are not drafts awaiting review either.
//
// THE PLACEHOLDER GATE IS NOT TOUCHED HERE. An edited body that still carries
// "draft-pending" or "[NEEDS SOURCE]" is stored (partial progress is legitimate), and
// `approve` still refuses it exactly as before — the gate stays the one enforcement
// point. The result says so via `draftIncomplete`, so the operator is never told the
// edit finished the job when it did not.
export function editAsset(assetId: string, body: string): VerbResult {
  if (body.trim().length === 0) return { ok: false, note: "a replacement body is required" };
  const asset = db.select().from(schema.assets).where(eq(schema.assets.id, assetId)).get();
  if (!asset) return { ok: false, note: `asset "${assetId}" not found` };
  if (asset.state !== "generated") {
    return { ok: false, note: `asset is ${asset.state}; only awaiting-review drafts can be edited` };
  }
  db.update(schema.assets).set({ body }).where(eq(schema.assets.id, assetId)).run();
  return {
    ok: true,
    note: null,
    assetId,
    state: asset.state,
    bytes: Buffer.byteLength(body, "utf8"),
    draftIncomplete: draftIncomplete(body),
  };
}

// Reject at the review gate: asset -> rejected with a required reason. The rejected
// asset's bet feeds learn as a negative signal (non-win settlement equivalent,
// src/engine/learn/priors.ts). Only pre-publish states are rejectable: a published
// asset is already in the world and its bet is judged by verify, not the gate.
export function reject(assetId: string, reason: string): VerbResult {
  const trimmed = reason.trim();
  if (trimmed.length === 0) return { ok: false, note: "a rejection reason is required" };
  const asset = db.select().from(schema.assets).where(eq(schema.assets.id, assetId)).get();
  if (!asset) return { ok: false, note: `asset "${assetId}" not found` };
  if (asset.state !== "generated" && asset.state !== "approved") {
    return { ok: false, note: `asset is ${asset.state}; only generated or approved assets can be rejected` };
  }
  db.update(schema.assets)
    .set({ state: "rejected", rejectedReason: trimmed })
    .where(eq(schema.assets.id, assetId))
    .run();
  return { ok: true, note: null, assetId, state: "rejected", reason: trimmed };
}

// Mark-as-implemented for spec-handoff bets (no repo access path): flips the bet to
// shipped with shipped_at now. That alone queues execution verification: the next
// `answerable verify` pass reads shipped bets (src/engine/verify/execution.ts shippedBets)
// and checks the spec's criteria against the fresh run.
export function markImplemented(betId: string): VerbResult {
  const bet = db.select().from(schema.bets).where(eq(schema.bets.id, betId)).get();
  if (!bet) return { ok: false, note: `bet "${betId}" not found` };
  if (bet.state === "shipped") {
    return {
      ok: false,
      note: `bet "${betId}" is already shipped — publish already moved it there (a spec-handoff bet ships at publish, not at implemented), so no action is needed here`,
    };
  }
  try {
    assertTransition(bet, "shipped");
  } catch (e) {
    return { ok: false, note: e instanceof Error ? e.message : String(e) };
  }
  const now = Date.now();
  db.update(schema.bets).set({ state: "shipped", shippedAt: now }).where(eq(schema.bets.id, betId)).run();
  return { ok: true, note: null, betId, state: "shipped", shippedAt: now };
}

// Settle an outcome-assessed bet: the operator's keep / revise / stop judgment on what
// the outcome actually showed. This is the last transition in the bet lifecycle and the
// one that closes the learn loop: priors (src/engine/learn/priors.ts) count only bets in
// `settled` state WITH a non-null settlement, "keep" as the win, "revise" and "stop" as
// non-wins, so until a bet is settled here nothing it taught ever reaches decide's
// scoring. `verify` stops at outcome-assessed by design — whether an observed movement
// was worth repeating is a judgment, not a measurement.
export const SETTLEMENTS = ["keep", "revise", "stop"] as const;
export type Settlement = (typeof SETTLEMENTS)[number];

export function settleBet(betId: string, settlement: string): VerbResult {
  const choice = settlement.trim().toLowerCase();
  if (!(SETTLEMENTS as readonly string[]).includes(choice)) {
    return { ok: false, note: `settlement must be one of ${SETTLEMENTS.join(" | ")}` };
  }
  const bet = db.select().from(schema.bets).where(eq(schema.bets.id, betId)).get();
  if (!bet) return { ok: false, note: `bet "${betId}" not found` };
  try {
    assertTransition(bet, "settled");
  } catch (e) {
    return { ok: false, note: e instanceof Error ? e.message : String(e) };
  }
  const now = Date.now();
  db.update(schema.bets)
    .set({ state: "settled", settlement: choice as Settlement, settledAt: now })
    .where(eq(schema.bets.id, betId))
    .run();
  return { ok: true, note: null, betId, state: "settled", settlement: choice, settledAt: now };
}

// Cancel a placed bet: the operator will not ship this one. Terminal, and the only
// off-ramp from `placed` — dismissing a claim closes the recommendation but leaves its
// bet standing, which used to strand the bet in `placed` with no transition available.
// A reason is required (the same rule as `reject`) and is recorded in outcome_note, so
// the queue never loses why work was dropped.
//
// A cancelled bet is NOT a settlement: priors count only `settled` rows with a
// settlement (src/engine/learn/priors.ts), so cancelling teaches nothing about whether
// the action class works — the bet was never shipped, so there is nothing to learn from.
export function cancelBet(betId: string, reason: string): VerbResult {
  const trimmed = reason.trim();
  if (trimmed.length === 0) return { ok: false, note: "a cancellation reason is required" };
  const bet = db.select().from(schema.bets).where(eq(schema.bets.id, betId)).get();
  if (!bet) return { ok: false, note: `bet "${betId}" not found` };
  try {
    assertTransition(bet, "cancelled");
  } catch (e) {
    return { ok: false, note: e instanceof Error ? e.message : String(e) };
  }
  db.update(schema.bets)
    .set({ state: "cancelled", outcomeNote: `cancelled: ${trimmed}` })
    .where(eq(schema.bets.id, betId))
    .run();
  return { ok: true, note: null, betId, state: "cancelled", reason: trimmed };
}

// "Not relevant" on a recommendation: claim -> dismissed. Decide skips non-open
// claims, so no new bets flow from it; the claim row and its status stay readable.
export function dismissClaim(claimId: string): VerbResult {
  const claim = db.select().from(schema.claims).where(eq(schema.claims.id, claimId)).get();
  if (!claim) return { ok: false, note: `claim "${claimId}" not found` };
  if (claim.status !== "open") {
    return { ok: false, note: `claim is ${claim.status}; only open claims can be dismissed` };
  }
  db.update(schema.claims).set({ status: "dismissed" }).where(eq(schema.claims.id, claimId)).run();
  return { ok: true, note: null, claimId, status: "dismissed" };
}

// Surface lifecycle (schema.surfaces.lifecycle): pause stops tick cadence; archive is the
// stronger form of the same thing — the surface is retired from routine operation, so
// `tick` skips it too and it is not expected to appear in ongoing reporting. Neither
// touches history: every run, claim, bet and asset row stays readable, and `resume` puts
// the surface back into cadence.
function setLifecycle(surfaceId: string, lifecycle: "active" | "paused" | "archived"): VerbResult {
  const surface = db.select().from(schema.surfaces).where(eq(schema.surfaces.id, surfaceId)).get();
  if (!surface) return { ok: false, note: `surface "${surfaceId}" not onboarded` };
  if (surface.lifecycle === lifecycle) {
    return { ok: false, note: `surface is already ${lifecycle}` };
  }
  db.update(schema.surfaces).set({ lifecycle }).where(eq(schema.surfaces.id, surfaceId)).run();
  return { ok: true, note: null, surfaceId, lifecycle };
}

export const pauseSurface = (surfaceId: string): VerbResult => setLifecycle(surfaceId, "paused");
export const archiveSurface = (surfaceId: string): VerbResult => setLifecycle(surfaceId, "archived");
export const resumeSurface = (surfaceId: string): VerbResult => setLifecycle(surfaceId, "active");
