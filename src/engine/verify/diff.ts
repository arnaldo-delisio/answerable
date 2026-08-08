// Verify station, run-over-run differ: compares check_keys across the last two runs of
// a surface. check_key = adapter/check-name@check-version/subject, unique per
// (surface_id, run_id, check_key); this is evidence identity. A key present before and
// absent now reports "missing" (collection failure is a reported state, never a silent
// drop); a bumped check-version starts a new series and the old one reads "retired".

import { asc, desc, eq } from "drizzle-orm";
import { db, schema } from "../../db";

type EvidenceRow = typeof schema.evidence.$inferSelect;

export interface CheckDiff {
  checkKey: string;
  kind: "added" | "missing" | "retired" | "changed" | "unchanged";
  before?: { status: string; value: Record<string, unknown> | null };
  after?: { status: string; value: Record<string, unknown> | null };
  // For retired keys: the new-version key that replaced this series.
  retiredBy?: string;
}

export interface RunDiff {
  surfaceId: string;
  prevRunId: string;
  currRunId: string;
  diffs: CheckDiff[];
}

// check_key = adapter / check-name @ check-version / subject
export interface ParsedKey {
  series: string; // adapter/check-name
  version: string;
  subject: string;
}

export function parseCheckKey(key: string): ParsedKey | null {
  const m = /^([^@]+)@([^/]+)\/(.+)$/.exec(key);
  return m ? { series: m[1], version: m[2], subject: m[3] } : null;
}

// Inverse of parseCheckKey for well-formed parts (series without "@", version without "/").
export function composeCheckKey(parts: ParsedKey): string {
  return `${parts.series}@${parts.version}/${parts.subject}`;
}

// Measurement noise, not facts: fields that legitimately vary between two runs of
// the SAME unchanged reality (an LLM answer's length differs every call) must not
// flip a row to "changed" — that is exactly the bug where eight pass→pass AI-answer
// rows all rendered under "changed" and "0 results unchanged". Order-insensitive
// arrays (entity citation sets — owned_hit is the tracked fact, not answer order)
// compare as sets.
const VOLATILE_VALUE_KEYS = new Set(["response_chars"]);
const ORDER_INSENSITIVE_ARRAY_KEYS = new Set(["entities_cited"]);

function significantValue(v: Record<string, unknown> | null): Record<string, unknown> | null {
  if (v === null) return null;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    if (VOLATILE_VALUE_KEYS.has(k)) continue;
    out[k] =
      ORDER_INSENSITIVE_ARRAY_KEYS.has(k) && Array.isArray(val)
        ? [...val].sort()
        : val;
  }
  return out;
}

// Values are normalized extracted fields; equal facts compare equal via stable JSON.
function stableJson(v: unknown): string {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return JSON.stringify(v) ?? "null";
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`)
    .join(",")}}`;
}

export function diffEvidence(
  surfaceId: string,
  prevRunId: string,
  currRunId: string,
  prevRows: EvidenceRow[],
  currRows: EvidenceRow[],
): RunDiff {
  const curr = new Map(currRows.map((r) => [r.checkKey, r]));
  const prev = new Map(prevRows.map((r) => [r.checkKey, r]));
  const diffs: CheckDiff[] = [];

  for (const [key, before] of prev) {
    const after = curr.get(key);
    if (after) {
      const changed =
        before.status !== after.status ||
        stableJson(significantValue(before.value)) !== stableJson(significantValue(after.value));
      diffs.push({
        checkKey: key,
        kind: changed ? "changed" : "unchanged",
        before: { status: before.status, value: before.value },
        after: { status: after.status, value: after.value },
      });
      continue;
    }
    // Absent now: a bumped check-version on the same series + subject retires the old
    // series; anything else is a missing collection, reported, never silently dropped.
    const parsed = parseCheckKey(key);
    const successor = parsed
      ? currRows.find((r) => {
          const p = parseCheckKey(r.checkKey);
          return p !== null && p.series === parsed.series && p.subject === parsed.subject && p.version !== parsed.version;
        })
      : undefined;
    diffs.push({
      checkKey: key,
      kind: successor ? "retired" : "missing",
      before: { status: before.status, value: before.value },
      ...(successor ? { retiredBy: successor.checkKey } : {}),
    });
  }

  for (const [key, after] of curr) {
    if (!prev.has(key)) {
      diffs.push({ checkKey: key, kind: "added", after: { status: after.status, value: after.value } });
    }
  }

  diffs.sort((a, b) => a.checkKey.localeCompare(b.checkKey));
  return { surfaceId, prevRunId, currRunId, diffs };
}

// Diff the last two runs of a surface. Returns null when fewer than two runs exist:
// history is made, never fabricated.
export function diffLastTwoRuns(surfaceId: string): RunDiff | null {
  const runs = db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.surfaceId, surfaceId))
    // Deterministic run ordering: started_at, ties broken by id, so "the last two runs"
    // never depends on insertion order when timestamps collide.
    .orderBy(desc(schema.runs.startedAt), desc(schema.runs.id))
    .limit(2)
    .all();
  if (runs.length < 2) return null;
  const [currRun, prevRun] = runs;
  const rowsFor = (runId: string): EvidenceRow[] =>
    db
      .select()
      .from(schema.evidence)
      .where(eq(schema.evidence.runId, runId))
      .orderBy(asc(schema.evidence.checkKey))
      .all();
  return diffEvidence(surfaceId, prevRun.id, currRun.id, rowsFor(prevRun.id), rowsFor(currRun.id));
}
