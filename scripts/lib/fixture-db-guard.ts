// Import-time guard for fixture scripts that write rows no adapter collected.
//
// This runs as a TOP-LEVEL SIDE EFFECT and must be the FIRST import in any such
// script, ahead of "../src/db": ESM evaluates imports in source order, and src/db
// opens (and, if absent, CREATES) the sqlite file the moment it is imported. A
// guard placed in main() would already have stamped an empty database onto
// whatever path was configured before refusing. Running here means a refused
// fixture touches nothing at all.
//
// The rule: ANSWERABLE_DB_PATH must be set explicitly and must resolve inside this
// worktree. No default fall-through, and never the main checkout or the live
// service.
//
// SCOPE OF THE GUARANTEE, stated rather than implied: this protects against
// misconfiguration and against a symlink that is already on the path — a wrong
// env var, a copied command line, a `data` directory linked elsewhere. It is a
// path check, so it cannot survive an adversary who swaps a directory for a
// symlink in the window between this check and the moment src/db opens the file;
// closing that would need descriptor-based, no-follow opening inside src/db,
// which is a product change and not what a dev fixture should force. The threat
// this guard is for is a tired operator, not a hostile process with write access
// to the tree.

import path from "node:path";
import { realpathSync } from "node:fs";

// A lexical prefix check is not containment: <worktree>/data/answerable.db passes it
// even when `data` (or the file itself) is a symlink pointing outside, and
// better-sqlite3 follows symlinks. Resolve the real path of the target — or, if
// it does not exist yet, of its nearest existing ancestor — before comparing.
// The real path a write to `target` would land on. The database FILE need not
// exist yet, but its parent directory must: realpathing only the existing part
// and re-appending unresolved segments would leave a window where a concurrent
// process turns one of those segments into a symlink pointing outside, after the
// check and before better-sqlite3 opens the file. Requiring the parent to exist
// costs nothing (sqlite does not create parent directories either) and removes
// every unresolved directory segment from the comparison.
function realResolve(target: string): string {
  const parent = path.dirname(target);
  let realParent: string;
  try {
    realParent = realpathSync(parent);
  } catch {
    console.error(
      `Refusing to write fixture rows into ${target}: its directory (${parent}) does not exist. ` +
        "Point ANSWERABLE_DB_PATH at a database inside an existing directory in this worktree.",
    );
    process.exit(1);
  }
  const candidate = path.join(realParent, path.basename(target));
  // The file itself may already exist as a symlink pointing out of the tree.
  try {
    return realpathSync(candidate);
  } catch {
    return candidate; // does not exist yet: the resolved parent is the whole story
  }
}

const configured = process.env.ANSWERABLE_DB_PATH;
if (!configured) {
  console.error(
    "ANSWERABLE_DB_PATH is not set. This fixture writes rows no adapter collected and must never " +
      "fall through to a default database. Set ANSWERABLE_DB_PATH to this worktree's db copy.",
  );
  process.exit(1);
}

const dbPath = path.resolve(configured);
const resolved = realResolve(dbPath);
const worktree = realpathSync(path.resolve(import.meta.dirname, "..", ".."));
if (resolved !== worktree && !resolved.startsWith(worktree + path.sep)) {
  console.error(
    `Refusing to write fixture rows into ${dbPath} (resolves to ${resolved}): it is outside this ` +
      `worktree (${worktree}). This script may only touch the worktree's own db copy, never the ` +
      "main checkout or the live service.",
  );
  process.exit(1);
}

console.log(`fixture target: ${resolved}`);
