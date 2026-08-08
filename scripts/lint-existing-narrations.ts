// One-off audit: run the new deterministic entity lint over
// every stored claim/bet narration; violating narrations are NULLed so the next
// `answerable narrate` regenerates them under the lint. Prints every violation for the record.

import { eq, isNotNull } from "drizzle-orm";
import { db, schema } from "../src/db";
import { describeViolations, lintText, whitelistForClaim } from "../src/engine/lib/entity-lint";

let nulled = 0;

for (const c of db.select().from(schema.claims).where(isNotNull(schema.claims.narration)).all()) {
  const violations = lintText(c.narration!, whitelistForClaim(c.id));
  if (violations.length === 0) continue;
  console.log(`CLAIM ${c.id}: ${describeViolations(violations)}\n  "${c.narration!.slice(0, 160)}"`);
  db.update(schema.claims).set({ narration: null }).where(eq(schema.claims.id, c.id)).run();
  nulled++;
}

for (const b of db.select().from(schema.bets).where(isNotNull(schema.bets.narration)).all()) {
  const violations = lintText(b.narration!, whitelistForClaim(b.claimId, [b.id, b.actionClass, b.outcomeMetric]));
  if (violations.length === 0) continue;
  console.log(`BET ${b.id}: ${describeViolations(violations)}\n  "${b.narration!.slice(0, 160)}"`);
  db.update(schema.bets).set({ narration: null }).where(eq(schema.bets.id, b.id)).run();
  nulled++;
}

console.log(`done: ${nulled} narration(s) nulled for regeneration`);
