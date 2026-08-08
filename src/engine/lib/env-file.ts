// Managed credential env file, sourced by the CLI at startup so `answerable doctor` and
// the collectors see the same keys. Single home: ~/.config/answerable/env, overridable
// via ANSWERABLE_ENV_PATH (tests point it at a temp file). Values NEVER get logged,
// thrown, or echoed back — callers report var names only.
//
// Read-only from this repo: the engine sources credentials, it never writes them.
// Populate the file by hand (or point ANSWERABLE_ENV_PATH at your own), or use the
// project-local .env the quickstart copies.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function envFilePath(): string {
  return process.env.ANSWERABLE_ENV_PATH || join(homedir(), ".config", "answerable", "env");
}

// KEY=VALUE lines; blank lines and #-comments ignored; value is everything
// after the first "=" (values validated upstream to contain no newlines).
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
    out[key] = trimmed.slice(eq + 1);
  }
  return out;
}

export function readEnvFile(): Record<string, string> {
  const p = envFilePath();
  if (!existsSync(p)) return {};
  try {
    return parseEnvFile(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

// Source the file into process.env without overriding vars already set by the
// real environment (real env wins; the file only fills gaps). Idempotent and
// cheap; the CLI calls it at entry, before any command runs.
export function loadEnvFile(): void {
  for (const [k, v] of Object.entries(readEnvFile())) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

