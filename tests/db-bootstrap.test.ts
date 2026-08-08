// A fresh clone must be able to create its database. `data/` is gitignored, so it never
// arrives with the clone, and `npm run db:push` — the first command in the README — died
// on a raw better-sqlite3 "Cannot open database because the directory does not exist"
// trace. Whoever opens the db creates its directory: src/db/index.ts already did, and
// drizzle.config.ts (what db:push loads) now does too.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function loadConfigWithDbPath(dbPath: string): Promise<{ url: string }> {
  const saved = process.env.ANSWERABLE_DB_PATH;
  process.env.ANSWERABLE_DB_PATH = dbPath;
  try {
    // Fresh module registry each case, so the config's directory-creating side effect
    // actually re-runs rather than being served from cache.
    vi.resetModules();
    const mod = await import("../drizzle.config");
    return (mod.default as { dbCredentials: { url: string } }).dbCredentials;
  } finally {
    if (saved === undefined) delete process.env.ANSWERABLE_DB_PATH;
    else process.env.ANSWERABLE_DB_PATH = saved;
  }
}

describe("db:push on a fresh clone", () => {
  it("creates the database's directory when it does not exist yet", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "answerable-fresh-"));
    created.push(root);
    const dataDir = path.join(root, "data");
    const dbPath = path.join(dataDir, "answerable.db");
    expect(existsSync(dataDir)).toBe(false);

    const credentials = await loadConfigWithDbPath(dbPath);

    expect(existsSync(dataDir)).toBe(true);
    expect(credentials.url).toBe(dbPath);
  });

  it("creates a nested directory for a custom ANSWERABLE_DB_PATH too", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "answerable-fresh-"));
    created.push(root);
    const dbPath = path.join(root, "deep", "nested", "answerable.db");

    await loadConfigWithDbPath(dbPath);

    expect(existsSync(path.dirname(dbPath))).toBe(true);
  });
});
