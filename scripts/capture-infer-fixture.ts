// Captures a recorded evidence fixture for the infer detector tests: one surface's
// latest run — surface row, run row, and evidence rows — read straight from
// data/answerable.db and saved to src/engine/infer/__fixtures__/. Re-run to refresh.
// Run: npx tsx scripts/capture-infer-fixture.ts [surface-id]
//
// This is an operator tool for capturing a fixture from their OWN db. The fixture the
// repo ships with (__fixtures__/synthetic-site-run.json) is not a capture: it is
// hand-authored synthetic data in the same shape, so no collected evidence travels
// with the repo.
import Database from "better-sqlite3";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const db = new Database(join(__dirname, "../data/answerable.db"), { readonly: true });
const surfaceId = process.argv[2] ?? "example-com-en";
const surface = db.prepare("select * from surfaces where id = ?").get(surfaceId);
const run = db
  .prepare("select * from runs where surface_id = ? order by started_at desc limit 1")
  .get(surfaceId) as { id: string };
const evidence = db
  .prepare("select * from evidence where run_id = ? order by check_key")
  .all(run.id);
const out = join(__dirname, `../src/engine/infer/__fixtures__/${surfaceId}-latest-run.json`);
writeFileSync(out, JSON.stringify({ surface, run, evidence }, null, 2) + "\n");
console.log(`captured ${evidence.length} evidence rows from run ${run.id} -> ${out}`);
