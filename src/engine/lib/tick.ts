// Tick (cron entry point for a surface's config `cadence` field): runs every onboarded surface
// whose cadence says it is due (no run yet, or last run older than the cadence window),
// stations sense -> infer -> decide -> act, then summarizes what changed: new claims,
// new bets, assets awaiting review, verify diff counts. The summary posts to
// ANSWERABLE_NOTIFY_WEBHOOK when set, otherwise prints. A failed lane or surface is a summary
// line, never a thrown error: tick always completes the sweep.

import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "../../db";
import type { Surface } from "./surface";
import { createRun, finishRun } from "./run";
import { sense } from "../sense";
import { infer } from "../infer";
import { decide } from "../decide";
import { act } from "../act";
import { diffLastTwoRuns } from "../verify/diff";
import { listOutbox } from "../act/outbox";

const CADENCE_MS: Record<string, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

export interface SurfaceTick {
  surfaceId: string;
  cadence: string | null;
  due: boolean;
  reason: string; // why it ran or did not
  runId: string | null;
  newClaims: number;
  newBets: number;
  failures: string[];
  verify: { changed: number; missing: number; appeared: number; retired: number } | null;
}

export interface TickResult {
  ranAt: number;
  surfaces: SurfaceTick[];
  assetsAwaitingReview: number; // state generated across all surfaces
  outboxPending: number; // approved-unsent outreach drafts the sender can actually retrieve
  notified: "webhook" | "stdout";
  webhookError: string | null;
}

function lastRunStartedAt(surfaceId: string): number | null {
  const run = db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.surfaceId, surfaceId))
    .orderBy(desc(schema.runs.startedAt), desc(schema.runs.id))
    .limit(1)
    .get();
  return run?.startedAt ?? null;
}

async function tickSurface(
  surfaceId: string,
  config: Record<string, unknown>,
  checkId: string,
): Promise<SurfaceTick> {
  const cadence = typeof config.cadence === "string" ? config.cadence : null;
  const t: SurfaceTick = {
    surfaceId,
    cadence,
    due: false,
    reason: "",
    runId: null,
    newClaims: 0,
    newBets: 0,
    failures: [],
    verify: null,
  };
  if (!cadence || !(cadence in CADENCE_MS)) {
    t.reason = "no cadence configured; tick skips this surface";
    return t;
  }
  const last = lastRunStartedAt(surfaceId);
  if (last !== null && Date.now() - last < CADENCE_MS[cadence]) {
    t.reason = `last run ${new Date(last).toISOString()} is within the ${cadence} window`;
    return t;
  }
  t.due = true;
  t.reason = last === null ? "no runs yet" : `last run ${new Date(last).toISOString()} older than ${cadence} window`;

  // sense
  try {
    const { id: runId, configSnapshot } = createRun(surfaceId, checkId);
    t.runId = runId;
    await sense(configSnapshot as unknown as Surface, runId);
    finishRun(runId, surfaceId, ["sense"]);
  } catch (e) {
    t.failures.push(`sense: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
    return t; // downstream stations need this run's evidence
  }
  // infer
  try {
    const results = infer(surfaceId);
    t.newClaims = results.reduce(
      (n, r) => n + r.claims.filter((c) => c.action === "created").length,
      0,
    );
  } catch (e) {
    t.failures.push(`infer: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
  }
  // decide
  try {
    const results = decide(surfaceId);
    t.newBets = results.reduce((n, r) => n + r.placed.length, 0);
  } catch (e) {
    t.failures.push(`decide: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
  }
  // act
  try {
    act(surfaceId);
  } catch (e) {
    t.failures.push(`act: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
  }
  // verify results: run-over-run diff counts from the fresh run
  try {
    const diff = diffLastTwoRuns(surfaceId);
    if (diff) {
      const counts = { changed: 0, missing: 0, appeared: 0, retired: 0 };
      for (const d of diff.diffs) {
        // The differ's kind for a check_key seen for the first time is "added"; the
        // summary calls it "appeared". Map it, or the count silently stays 0 forever.
        const key = d.kind === "added" ? "appeared" : d.kind;
        if (key in counts) counts[key as keyof typeof counts] += 1;
      }
      t.verify = counts;
    }
  } catch (e) {
    t.failures.push(`verify diff: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
  }
  return t;
}

export function renderSummary(result: TickResult): string {
  const lines = [`answerable tick ${new Date(result.ranAt).toISOString()}`];
  for (const s of result.surfaces) {
    if (!s.due) {
      lines.push(`  ${s.surfaceId}: not due (${s.reason})`);
      continue;
    }
    const verify = s.verify
      ? `verify diff: ${s.verify.changed} changed, ${s.verify.appeared} appeared, ${s.verify.missing} missing, ${s.verify.retired} retired`
      : "verify diff: unavailable";
    lines.push(`  ${s.surfaceId}: ran (${s.reason}); ${s.newClaims} new claim(s), ${s.newBets} new bet(s); ${verify}`);
    for (const f of s.failures) lines.push(`    FAILED ${f}`);
  }
  lines.push(`  assets awaiting review: ${result.assetsAwaitingReview}`);
  lines.push(`  outbox pending (approved, unsent): ${result.outboxPending}`);
  return lines.join("\n");
}

export async function tick(): Promise<TickResult> {
  const surfaces = db.select().from(schema.surfaces).all();
  const results: SurfaceTick[] = [];
  // One tick sweep = one cycle: every due surface's run shares this check_id.
  const checkId = randomUUID();
  for (const s of surfaces) {
    // Operator lifecycle: paused/archived surfaces skip cadence entirely — visible as
    // a not-due line, never silently absent from the sweep report.
    if (s.lifecycle !== "active") {
      results.push({
        surfaceId: s.id,
        cadence: typeof s.configSnapshot.cadence === "string" ? (s.configSnapshot.cadence as string) : null,
        due: false,
        reason: `surface is ${s.lifecycle}; tick skips it`,
        runId: null,
        newClaims: 0,
        newBets: 0,
        failures: [],
        verify: null,
      });
      continue;
    }
    results.push(await tickSurface(s.id, s.configSnapshot, checkId));
  }

  const assets = db.select().from(schema.assets).all();
  const result: TickResult = {
    ranAt: Date.now(),
    surfaces: results,
    assetsAwaitingReview: assets.filter((a) => a.state === "generated").length,
    // The outbox itself is the count: a draft the sender cannot retrieve (still
    // carrying engine placeholders) is not pending work, and reporting it as such
    // would be work nobody can do.
    outboxPending: listOutbox().length,
    notified: "stdout",
    webhookError: null,
  };

  const webhook = process.env.ANSWERABLE_NOTIFY_WEBHOOK;
  if (webhook) {
    try {
      const res = await fetch(webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: renderSummary(result), tick: result }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) result.notified = "webhook";
      else result.webhookError = `webhook returned http ${res.status}; summary printed instead`;
    } catch (e) {
      result.webhookError = `webhook post failed (${e instanceof Error ? e.message : String(e)}); summary printed instead`;
    }
  }
  return result;
}
