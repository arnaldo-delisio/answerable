// Regenerate-with-feedback, one of the operator verbs: one revision pass over an
// awaiting-review draft. The operator's feedback is appended to the generator
// prompt (the claim context + the current draft) and the LLM lane produces one
// revised body — one regeneration per invocation, never a loop. LLM unavailable
// or failing is an honest note and the draft stays untouched (never a
// draft-pending body overwriting a real draft).

import { eq } from "drizzle-orm";
import { db, schema } from "../../db";
import { llmText, DRAFT_PENDING } from "./llm";
import type { VerbResult } from "../lib/verbs";

export function regenerateWithFeedback(assetId: string, feedback: string): VerbResult {
  const trimmed = feedback.trim();
  if (trimmed.length === 0) return { ok: false, note: "feedback is required to regenerate" };
  const asset = db.select().from(schema.assets).where(eq(schema.assets.id, assetId)).get();
  if (!asset) return { ok: false, note: `asset "${assetId}" not found` };
  if (asset.state !== "generated") {
    return { ok: false, note: `asset is ${asset.state}; only awaiting-review drafts can be regenerated` };
  }
  const body = asset.body ?? "";
  if (body.length === 0) return { ok: false, note: "asset has no body to regenerate" };

  const bet = db.select().from(schema.bets).where(eq(schema.bets.id, asset.betId)).get();
  const claim = bet
    ? db.select().from(schema.claims).where(eq(schema.claims.id, bet.claimId)).get()
    : undefined;

  // Generator prompt: the claim context and the current draft, with the
  // operator's feedback appended — the same shape the act generators use, plus
  // the one revision instruction.
  const prompt = [
    `You are revising a generated ${asset.type} draft for a search-growth engine.`,
    claim ? `The finding it addresses: ${claim.narration ?? claim.title}` : null,
    "Current draft:",
    "---",
    body,
    "---",
    `Operator feedback (fold this in): ${trimmed}`,
    "Return the complete revised draft only, in the same format as the current draft. No preamble, no commentary.",
  ]
    .filter((l): l is string => l != null)
    .join("\n\n");

  const notes: string[] = [];
  const { text, pending } = llmText(prompt, `regenerate ${assetId}`, notes);
  if (pending || text === DRAFT_PENDING) {
    return {
      ok: false,
      note: notes[0] ?? "LLM unavailable — the draft was not changed.",
    };
  }
  db.update(schema.assets).set({ body: text }).where(eq(schema.assets.id, assetId)).run();
  return { ok: true, note: null, assetId, state: asset.state, feedback: trimmed };
}
