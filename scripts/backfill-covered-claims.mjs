// One-off backfill for assets.covered_claim_ids (added with the covered-by linkage):
// the brand-defense owned answer page lists the claims it answers in its body's
// "## Claims answered" section — the same list the generator now stores on the column.
// Idempotent: re-running rewrites the same ids. Usage: node scripts/backfill-covered-claims.mjs

import Database from "better-sqlite3";
import path from "node:path";

const dbPath = process.env.ANSWERABLE_DB_PATH ?? path.join(process.cwd(), "data", "answerable.db");
const db = new Database(dbPath);

const cols = db.prepare("pragma table_info(assets)").all().map((c) => c.name);
if (!cols.includes("covered_claim_ids")) {
  db.prepare("ALTER TABLE assets ADD COLUMN covered_claim_ids text").run();
  console.log("added assets.covered_claim_ids");
}

const rows = db.prepare("select id, body from assets where id like '%brand-defense%'").all();
for (const r of rows) {
  const section = /## Claims answered\s*\n\n([\s\S]*?)\n\n/.exec(r.body ?? "");
  if (!section) {
    console.log(`skip ${r.id}: no "Claims answered" section in body`);
    continue;
  }
  const ids = [...section[1].matchAll(/^- (\S+) \[/gm)].map((m) => m[1]);
  if (ids.length === 0) {
    console.log(`skip ${r.id}: no claim ids listed`);
    continue;
  }
  db.prepare("update assets set covered_claim_ids = ? where id = ?").run(JSON.stringify(ids), r.id);
  console.log(`backfilled ${r.id}: ${ids.join(", ")}`);
}
