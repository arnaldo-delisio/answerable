import type { Config } from "drizzle-kit";
import { mkdirSync } from "node:fs";
import path from "node:path";

// The db file's directory is created by whoever opens the db (the same rule as
// src/db/index.ts). `data/` is gitignored, so on a fresh clone it does not exist and
// `npm run db:push` — the first command in the README — used to die on a raw
// better-sqlite3 "Cannot open database because the directory does not exist" trace.
const DB_URL = process.env.ANSWERABLE_DB_PATH ?? "./data/answerable.db";
mkdirSync(path.dirname(DB_URL), { recursive: true });

export default {
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: DB_URL,
  },
} satisfies Config;
