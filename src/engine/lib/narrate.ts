// Narration pass: two plain-consequence sentences per open claim / placed bet, the
// plain-language layer a reader gets first (UX clarity override register). Uses the act
// station's shared claude CLI lane (prompt over stdin, never a shell argument).
// Cache discipline: only rows with narration IS NULL are narrated — reruns are
// cheap and never overwrite existing narration.

import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "../../db";
import { llmText } from "../act/llm";
import { describeViolations, lintText, whitelistForClaim, type EntityWhitelist } from "./entity-lint";

// The override's own rewrite examples ARE the register.
const REGISTER = `You write for a busy website owner with no SEO, analytics, or engineering knowledge.
Rewrite the technical finding below into EXACTLY two short plain-English sentences:
first the consequence for their website's visitors or traffic, then what doing
something about it would change. No jargon (no "hreflang", "schema", "claim",
"bet", "crawler", "SERP", "citation" unqualified). No preamble, no quotes, no
bullet points — output only the two sentences.

Register examples:
- "Missing hreflang annotations on deep localized routes" -> "Google may send visitors to the wrong language version of these pages. Fixing the language labels helps each visitor land on the page written for them."
- "Schema coverage is incomplete" -> "Search engines cannot clearly understand what some of these pages are about. Adding the missing page descriptions makes them easier to find in search."
- "AI citation visibility is weak" -> "AI assistants rarely mention this brand when answering relevant questions. Improving this makes the brand show up in more of those answers."`;

// Entity-linted generation, the deterministic entity-lint language layer: the narration may only name
// engines/vendors/competitors/numbers present in the claim's linked data. One
// regeneration with the violations named; a second failure leaves the row
// un-narrated (narration stays NULL, so readers fall back to the honest raw title,
// and the next narrate pass retries), never a false sentence.
function lintedNarration(
  prompt: string,
  subject: string,
  whitelist: EntityWhitelist,
  notes: string[],
): { text: string | null; pending: boolean } {
  const first = llmText(prompt, subject, notes);
  if (first.pending) return { text: null, pending: true };
  let violations = lintText(first.text, whitelist);
  if (violations.length === 0) return { text: first.text, pending: false };
  const retryPrompt = `${prompt}

Your previous attempt named entities or numbers not present in the finding's own data
(${describeViolations(violations)}). Rewrite the two sentences WITHOUT naming any
company, product, engine, or number that is not in the finding above.`;
  const second = llmText(retryPrompt, `${subject} (lint retry)`, notes);
  if (second.pending) return { text: null, pending: true };
  violations = lintText(second.text, whitelist);
  if (violations.length === 0) return { text: second.text, pending: false };
  notes.push(`entity lint: ${subject} still names data-absent entities after one retry (${describeViolations(violations)}); left un-narrated`);
  return { text: null, pending: true };
}

export interface NarrateResult {
  claimsNarrated: number;
  betsNarrated: number;
  skipped: number;
  notes: string[];
}

export function narrate(): NarrateResult {
  const notes: string[] = [];
  let claimsNarrated = 0;
  let betsNarrated = 0;
  let skipped = 0;

  const openClaims = db
    .select()
    .from(schema.claims)
    .where(and(eq(schema.claims.status, "open"), isNull(schema.claims.narration)))
    .all();

  for (const c of openClaims) {
    const prompt = `${REGISTER}

Technical finding (an issue found on the website "${c.surfaceId}"):
Title: ${c.title}
Category: ${c.class}
${c.queryTopic ? `Topic: ${c.queryTopic}\n` : ""}${c.recommendedAsset ? `Recommended fix type: ${c.recommendedAsset}\n` : ""}`;
    const { text, pending } = lintedNarration(prompt, `narration for ${c.id}`, whitelistForClaim(c.id), notes);
    if (pending) {
      skipped++;
      continue;
    }
    db.update(schema.claims)
      .set({ narration: text })
      .where(eq(schema.claims.id, c.id))
      .run();
    claimsNarrated++;
  }

  const placedBets = db
    .select()
    .from(schema.bets)
    .where(and(eq(schema.bets.state, "placed"), isNull(schema.bets.narration)))
    .all();

  for (const b of placedBets) {
    const claim = db
      .select()
      .from(schema.claims)
      .where(eq(schema.claims.id, b.claimId))
      .get();
    const prompt = `${REGISTER}

Technical finding (a planned improvement for the website "${b.surfaceId}"):
Planned action: ${b.actionClass}
Underlying issue: ${claim?.title ?? "unknown"}
Success will be measured on: ${b.outcomeMetric}`;
    const { text, pending } = lintedNarration(
      prompt,
      `narration for ${b.id}`,
      whitelistForClaim(b.claimId, [b.id, b.actionClass, b.outcomeMetric]),
      notes,
    );
    if (pending) {
      skipped++;
      continue;
    }
    db.update(schema.bets)
      .set({ narration: text })
      .where(eq(schema.bets.id, b.id))
      .run();
    betsNarrated++;
  }

  return { claimsNarrated, betsNarrated, skipped, notes };
}
