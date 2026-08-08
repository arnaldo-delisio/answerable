#!/usr/bin/env node
// answerable CLI. A brand is the top-level object (`brand add <domain>` is the entry
// point); a surface is one place the brand shows up (a site, or an assistant).
// Verbs: brand | onboard | run | infer | decide | act | narrate | spec | verify | approve |
// publish | preview | edit | regenerate | outbox | mark-sent | reject | implemented |
// settle | cancel | dismiss | pause | archive | resume | tick | doctor | draft <domain>.
// Every command takes --json for
// machine-readable results (agent surface: any authorized agent reads the outbox and
// sends approved drafts; the engine itself never sends); human text otherwise.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadSurface, SurfaceConfigError } from "./engine/lib/surface";
import { loadEnvFile, parseEnvFile } from "./engine/lib/env-file";
import { FIX_SPEC_KINDS } from "./engine/act/fix-spec-kinds";

// Source the managed credential file (~/.config/answerable/env) before any command runs,
// so `answerable doctor` and the collectors read one consistent set of keys. Real
// environment variables always win; the file only fills gaps.
loadEnvFile();

// Then fill any remaining gaps from the project-local .env (the quickstart's
// `cp .env.example .env`). The managed file above already claimed process.env for
// anything it defines, so it wins on overlap — it is the deployment's own
// credential store; .env is the pre-connect bootstrap.
const dotEnvPath = join(process.cwd(), ".env");
if (existsSync(dotEnvPath)) {
  for (const [k, v] of Object.entries(parseEnvFile(readFileSync(dotEnvPath, "utf8")))) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

function usage(): void {
  console.log(
    [
      "usage: answerable <command> [--json]",
      "  brand add <domain>             START HERE: probe a domain, create the brand,",
      "                                 propose a config for every surface it found",
      "  brand list                     brands and the identity each one matches on",
      "  brand create <id> <domain>     create a brand, identity seeded from the domain only",
      "  brand alias <id> <term>...     add aliases (the only way a bare name is ever matched)",
      "  brand negative <id> [term]...  set the negative terms that veto a match (none clears)",
      "  onboard <file>                 validate + register a surface config",
      "  run <surface-id>               open a run and collect (sense + snapshots)",
      "  infer <surface-id>             evidence -> claims",
      "  decide <surface-id>            open claims -> ranked bets",
      "  act <surface-id>               placed bets -> generated assets (+ narration)",
      "  narrate                        plain-language narration for open claims + placed bets",
      `  spec <surface-id> <kind>       generate one fix spec (kinds: ${FIX_SPEC_KINDS.join(" | ")})`,
      "  verify <surface-id>            did it ship: re-collect and check the approved change",
      "                                 went live (+ experimental outcome assessment)",
      "  approve <asset-id>             review gate: asset -> approved",
      "  publish <asset-id>             execute publishing policy (PR | spec-handoff)",
      "  preview <asset-id>             write a generated asset's body to stdout",
      "  edit <asset-id> [--file <p>]   replace an awaiting-review draft's body (stdin by default)",
      "  regenerate <asset-id> <text>   one LLM revision pass over an awaiting-review draft",
      "  outbox                         approved-unsent outreach drafts",
      "  mark-sent <asset-id>           record a sent outreach draft (published)",
      "  reject <asset-id> <reason>     review gate: asset -> rejected (feeds learn as negative signal)",
      "  implemented <bet-id>           spec-handoff: bet -> shipped, exec-verify queued for next verify",
      "  settle <bet-id> <keep|revise|stop>  outcome-assessed bet -> settled (feeds the experimental learn priors)",
      "  cancel <bet-id> <reason>       placed bet -> cancelled (terminal; the queue never strands a bet)",
      "  dismiss <claim-id>             mark a recommendation not relevant (claim -> dismissed)",
      "  pause <surface-id>             surface lifecycle -> paused (tick skips cadence)",
      "  archive <surface-id>           surface lifecycle -> archived (tick skips it, history kept)",
      "  resume <surface-id>            surface lifecycle -> active",
      "  tick                           run due surfaces per cadence + notify summary",
      "  doctor                         credentials, CLIs, db, last runs",
      "  draft <domain>                 probe a site -> config/surfaces/<slug>.proposed.yaml",
    ].join("\n"),
  );
}

// json mode: the command's structured result prints as JSON and nothing else.
let jsonMode = false;
function emit(data: unknown, human: () => void): void {
  if (jsonMode) console.log(JSON.stringify(data, null, 2));
  else human();
}

// brand: create a brand and edit its identity. This is the ONLY supported path to a
// second brand — `onboard` refuses a config naming a brand that does not exist, and
// `npm run db:brands` is a backfill over surfaces already onboarded, not a create.
async function brandCmd(sub: string | undefined, rest: string[]): Promise<void> {
  const brands = await import("./engine/lib/brands");
  const [id, ...terms] = rest;
  let result: import("./engine/lib/verbs").VerbResult;
  switch (sub) {
    case "add": {
      if (!id) return usage();
      const { brandAdd } = await import("./engine/lib/brand-add");
      const added = await brandAdd(id);
      if (!added.ok) process.exitCode = 1;
      emit(added, () => {
        if (!added.ok) {
          console.error(`brand add ${id}: ${added.note}`);
          return;
        }
        const surfaces = added.surfaces as import("./engine/lib/brand-add").ProposedSurface[];
        console.log(`brand add ${added.brandId}: created (${added.primaryDomain})`);
        console.log(`  display name: ${added.name} (identity is the domain and its spoken form, never a name)`);
        console.log(`  the site calls itself: ${added.observedName}${added.category ? ` — ${added.category}` : ""}`);
        console.log(`  aliases: ${(added.aliases as string[]).join(", ")}`);
        console.log(`  ${surfaces.length} surface(s) proposed (nothing is monitored until you onboard one):`);
        for (const s of surfaces) {
          console.log(`    ${s.kind} ${s.id} (${s.what}${s.linkage === "weak" ? ", weak link to the brand — confirm it is yours" : ""})`);
          console.log(`      ${s.path}`);
        }
        for (const u of added.unreachable as { target: string; error: string }[]) {
          console.log(`  unreachable: ${u.target} (${u.error})`);
        }
        for (const n of added.notes as string[]) console.log(`  note: ${n}`);
        const first = surfaces.find((s) => s.kind === "site") ?? surfaces[0];
        if (first) {
          console.log(`  next: review ${first.path}, drop the .proposed from the name, then`);
          console.log(`        answerable onboard config/surfaces/${first.id}.yaml && answerable run ${first.id}`);
        }
      });
      return;
    }
    case "list":
      result = brands.listBrands();
      break;
    case "create":
      if (!id || !terms[0]) return usage();
      result = brands.createBrand(id, terms[0]);
      break;
    case "alias":
      if (!id) return usage();
      result = brands.addBrandAliases(id, terms);
      break;
    case "negative":
      if (!id) return usage();
      result = brands.setBrandNegativeTerms(id, terms);
      break;
    default:
      return usage();
  }
  if (!result.ok) process.exitCode = 1;
  emit(result, () => {
    if (!result.ok) {
      console.error(`brand ${sub}: ${result.note}`);
      return;
    }
    if (sub === "list") {
      const rows = result.brands as { brandId: string; primaryDomain: string; aliases: string[]; negativeTerms: string[] }[];
      if (rows.length === 0) {
        console.log("no brands (create one with `brand create <id> <domain>`)");
        return;
      }
      for (const b of rows) {
        console.log(`${b.brandId} (${b.primaryDomain})`);
        console.log(`  aliases: ${b.aliases.join(", ")}`);
        console.log(`  negative terms: ${b.negativeTerms.length > 0 ? b.negativeTerms.join(", ") : "none"}`);
      }
      return;
    }
    console.log(`brand ${sub} ${result.brandId}: primary domain ${result.primaryDomain}`);
    console.log(`  aliases: ${(result.aliases as string[]).join(", ")}`);
    console.log(
      `  negative terms: ${(result.negativeTerms as string[]).length > 0 ? (result.negativeTerms as string[]).join(", ") : "none"}`,
    );
  });
}

async function onboard(file: string): Promise<void> {
  const surface = loadSurface(file);
  const { db, schema } = await import("./db");
  const { eq } = await import("drizzle-orm");
  // The config file is the source of truth for brand membership: onboard registers
  // `brand:` exactly as written, including clearing it when the field is dropped.
  // An unknown brand is an error, never a silently ungrouped surface.
  let brandId: string | null = null;
  if (surface.brand) {
    const brand = db.select().from(schema.brands).where(eq(schema.brands.id, surface.brand)).get();
    if (!brand) {
      console.error(
        `onboard: config names brand "${surface.brand}", which doesn't exist yet (create it with \`brand create ${surface.brand} <domain>\`)`,
      );
      process.exitCode = 1;
      return;
    }
    brandId = brand.id;
  }
  db.insert(schema.surfaces)
    .values({
      id: surface.id,
      kind: surface.kind,
      configSnapshot: surface as unknown as Record<string, unknown>,
      onboardedAt: Date.now(),
      brandId,
    })
    .onConflictDoUpdate({
      target: schema.surfaces.id,
      set: {
        kind: surface.kind,
        configSnapshot: surface as unknown as Record<string, unknown>,
        brandId,
      },
    })
    .run();
  emit({ onboarded: surface.id, kind: surface.kind, lanes: Object.keys(surface.lanes) }, () => {
    console.log(`onboarded ${surface.id} (${surface.kind}, lanes: ${Object.keys(surface.lanes).join(", ")})`);
  });
}

// Core of `run`: opens a run and collects. Returns the structured result without printing
// anything, so a caller (the CLI's own `run` command, or `verify` collecting a fresh run
// internally) can decide how/whether to surface it. Printing lives only in the two callers.
async function runSurface(surfaceId: string): Promise<{
  runId: string;
  surfaceId: string;
  sense: { rowsWritten: number; laneCosts: Record<string, number> };
  snapshots: Record<string, number>;
  costTotal: number;
}> {
  const { createRun, finishRun } = await import("./engine/lib/run");
  const { sense } = await import("./engine/sense");
  // One CLI run invocation = one cycle: mint a check_id so every run it opens is
  // groupable back to that one cycle.
  const { id: runId, configSnapshot } = createRun(surfaceId, randomUUID());
  const surface = configSnapshot as unknown as import("./engine/lib/surface").Surface;

  const senseResult = await sense(surface, runId);
  const { snapshots, costTotal } = finishRun(runId, surfaceId, ["sense"]);

  return {
    runId,
    surfaceId,
    sense: { rowsWritten: senseResult.rowsWritten, laneCosts: senseResult.laneCosts },
    snapshots,
    costTotal,
  };
}

function printRunResult(r: Awaited<ReturnType<typeof runSurface>>): void {
  console.log(`  sense: ${r.sense.rowsWritten} evidence rows`);
  for (const [lane, cost] of Object.entries(r.sense.laneCosts)) {
    console.log(`    lane ${lane}: cost ${cost}`);
  }
  console.log("  snapshots:");
  for (const [metric, value] of Object.entries(r.snapshots)) {
    console.log(`    ${metric}: ${value}`);
  }
  console.log(`  cost total: ${r.costTotal}`);
}

async function run(surfaceId: string): Promise<void> {
  const r = await runSurface(surfaceId);
  emit(r, () => {
    console.log(`run ${r.runId} (surface ${surfaceId})`);
    printRunResult(r);
  });
}

async function inferCmd(surfaceId: string): Promise<void> {
  const { infer } = await import("./engine/infer");
  const results = infer(surfaceId);
  emit(results, () => {
    for (const r of results) {
      console.log(`infer ${r.surfaceId} (run ${r.runId})`);
      if (r.claims.length === 0) console.log("  no claims (all detectors clear)");
      for (const c of r.claims) {
        console.log(`  ${c.action} ${c.id} [${c.class}] confidence ${c.confidence} status ${c.status}`);
        console.log(`    ${c.title}`);
      }
      for (const n of r.notes) console.log(`  note: ${n}`);
    }
  });
}

async function decideCmd(surfaceId: string): Promise<void> {
  const { decide } = await import("./engine/decide");
  const results = decide(surfaceId);
  emit(results, () => {
    for (const r of results) {
      console.log(`decide ${r.surfaceId}`);
      if (r.ranked.length === 0) console.log("  no open claims to rank");
      for (const [i, sc] of r.ranked.entries()) {
        console.log(`  #${i + 1} score ${sc.score.toFixed(3)} ${sc.claimId} [${sc.claimClass}]`);
        console.log(`     ${sc.title}`);
        console.log(
          `     impact ${sc.impact} x confidence ${sc.confidence} x weight ${sc.classWeight} x prior ${sc.prior.multiplier.toFixed(3)} (${sc.prior.scope}: ${sc.prior.wins}/${sc.prior.settlements}) / effort ${sc.effort} -> ${sc.outcomeMetric}`,
        );
      }
      for (const p of r.placed) console.log(`  placed ${p.betId} (score ${p.score.toFixed(3)})`);
      for (const p of r.rescored) console.log(`  re-scored ${p.betId} (score ${p.score.toFixed(3)})`);
      for (const n of r.notes) console.log(`  note: ${n}`);
    }
  });
}

async function actCmd(surfaceId: string): Promise<void> {
  const { act } = await import("./engine/act");
  const { narrate } = await import("./engine/lib/narrate");
  const r = act(surfaceId);
  // The narration pass rides act's tail (only null-narration rows are touched), but its
  // result is part of act's ONE structured result: --json means a single document on
  // stdout and nothing else, and two concatenated objects are not parseable JSON.
  const narration = narrate();
  emit({ ...r, narration }, () => {
    console.log(`act ${surfaceId}`);
    console.log(`  tool specs: ${r.toolSpecs.assets.length} asset(s)`);
    for (const a of r.toolSpecs.assets) {
      console.log(`    ${a.assetId} [tool, ${a.state}] route ${a.route} (bet ${a.betId})`);
    }
    for (const n of r.toolSpecs.notes) console.log(`    note: ${n}`);

    console.log(`  outreach drafts: ${r.outreach.assets.length} asset(s)`);
    for (const a of r.outreach.assets) {
      console.log(
        `    ${a.assetId} [outreach-draft, ${a.state}]${a.draftPending ? " (draft-pending)" : ""} target ${a.targetUrl ?? a.targetTitle}`,
      );
      if (a.skipReason) console.log(`      skip reason: ${a.skipReason}`);
    }
    for (const n of r.outreach.notes) console.log(`    note: ${n}`);

    console.log(`  brand-defense pages: ${r.brandDefense.assets.length} asset(s)`);
    for (const a of r.brandDefense.assets) {
      console.log(
        `    ${a.assetId} [page, ${a.state}]${a.draftPending ? " (draft-pending)" : ""} route ${a.route} (bet ${a.betId}, ${a.claimIds.length} claim(s))`,
      );
    }
    for (const n of r.brandDefense.notes) console.log(`    note: ${n}`);

    console.log(`  comparison pages: ${r.comparison.assets.length} asset(s)`);
    for (const a of r.comparison.assets) {
      console.log(
        `    ${a.assetId} [page, ${a.state}]${a.draftPending ? " (draft-pending)" : ""} route ${a.route} (bet ${a.betId})`,
      );
    }
    for (const n of r.comparison.notes) console.log(`    note: ${n}`);

    console.log(`  AEO block specs: ${r.aeoBlocks.assets.length} asset(s)`);
    for (const a of r.aeoBlocks.assets) {
      console.log(
        `    ${a.assetId} [fix-spec, ${a.state}]${a.draftPending ? " (draft-pending)" : ""} ${a.promptCount} prompt block(s) over ${a.pages.length} page(s) (bet ${a.betId})`,
      );
    }
    for (const n of r.aeoBlocks.notes) console.log(`    note: ${n}`);

    console.log(`  fix specs: ${r.fixSpecs.assets.length} asset(s)`);
    for (const a of r.fixSpecs.assets) {
      console.log(`    ${a.assetId} [fix-spec, ${a.state}] kind ${a.kind} (bet ${a.betId}, claim ${a.claimId})`);
    }
    for (const n of r.fixSpecs.notes) console.log(`    note: ${n}`);

    console.log(
      `  narrate: ${narration.claimsNarrated} claim(s), ${narration.betsNarrated} bet(s) narrated, ${narration.skipped} skipped`,
    );
    for (const n of narration.notes) console.log(`    note: ${n}`);
  });
}

async function narrateCmd(): Promise<void> {
  const { narrate } = await import("./engine/lib/narrate");
  const r = narrate();
  emit(r, () => {
    console.log(
      `narrate: ${r.claimsNarrated} claim(s), ${r.betsNarrated} bet(s) narrated, ${r.skipped} skipped`,
    );
    for (const n of r.notes) console.log(`  note: ${n}`);
  });
}

async function spec(surfaceId: string, kind: string): Promise<void> {
  const { generateFixSpec } = await import("./engine/act/fix-spec");
  if (!(FIX_SPEC_KINDS as readonly string[]).includes(kind)) {
    console.error(`unknown spec kind "${kind}" (${FIX_SPEC_KINDS.join(" | ")})`);
    process.exitCode = 1;
    return;
  }
  const result = generateFixSpec(surfaceId, kind as import("./engine/act/fix-spec-kinds").FixSpecKind);
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const path = await import("node:path");
  const outDir = path.join(process.cwd(), "specs");
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${surfaceId}-${kind}.md`);
  writeFileSync(outFile, result.markdown);
  emit(
    {
      kind,
      surfaceId,
      runId: result.runId,
      claimId: result.claimId,
      betId: result.betId,
      assetId: result.assetId,
      evidenceCount: result.evidenceIds.length,
      written: outFile,
    },
    () => {
      console.log(`spec ${kind} (surface ${surfaceId}, run ${result.runId})`);
      console.log(`  claim ${result.claimId} <- ${result.evidenceIds.length} evidence rows`);
      console.log(`  bet ${result.betId} (placed) -> asset ${result.assetId} (generated)`);
      if (result.assetNote) console.log(`  note: ${result.assetNote}`);
      console.log(`  written: ${outFile}`);
    },
  );
}

async function verify(surfaceId: string): Promise<void> {
  const { diffLastTwoRuns } = await import("./engine/verify/diff");
  const { shippedBets, verifyExecution } = await import("./engine/verify/execution");

  // Differ needs two runs; with fewer, collect a fresh sense pass first (real run 2 data).
  // runSurface() only returns its result, never prints, so the fresh run's numbers fold
  // into verify's own single result under `freshRun` instead of printing a second document
  // (the same fix as `act` folding `narrate`'s result under `narration`).
  let diff = diffLastTwoRuns(surfaceId);
  let freshRun: Awaited<ReturnType<typeof runSurface>> | null = null;
  if (!diff) {
    if (!jsonMode) console.log(`verify ${surfaceId}: fewer than two runs; collecting a fresh run for the diff`);
    freshRun = await runSurface(surfaceId);
    diff = diffLastTwoRuns(surfaceId);
  }
  if (!diff) {
    console.error(`verify ${surfaceId}: still fewer than two runs; nothing to diff`);
    process.exitCode = 1;
    return;
  }

  const shipped = shippedBets(surfaceId);
  // Every refusal in this CLI is a structured note: a bet that cannot be
  // execution-verified (no derivable check_keys) reports itself and the pass continues,
  // and even an unexpected failure on one bet never becomes a raw stack trace that takes
  // the whole verification (and with it `settle`) down.
  const executions: import("./engine/verify/execution").ExecutionVerifyResult[] = [];
  const refusals: { betId: string; note: string }[] = [];
  for (const bet of shipped) {
    try {
      const result = verifyExecution(bet, diff.currRunId);
      if (result.skipped) refusals.push({ betId: bet.id, note: result.skipNote! });
      else executions.push(result);
    } catch (e) {
      refusals.push({
        betId: bet.id,
        note: `execution verify refused: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  // Outcome leg (go-live and outcome stay separate checks): exec-verified bets checked against their outcome windows;
  // immature windows print honestly (no bet matures before minRuns AND minDays).
  const { assessOutcomes } = await import("./engine/verify/outcome");
  const outcomes = assessOutcomes(surfaceId);
  emit({ surfaceId, diff, freshRun, executions, refusals, outcomes }, () => {
    if (freshRun) {
      console.log(`  collected run ${freshRun.runId}:`);
      printRunResult(freshRun);
    }
    console.log(`verify ${surfaceId}: diff run ${diff.prevRunId} -> ${diff.currRunId}`);
    const counts: Record<string, number> = {};
    for (const d of diff.diffs) counts[d.kind] = (counts[d.kind] ?? 0) + 1;
    console.log(`  ${diff.diffs.length} check_keys: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(", ")}`);
    for (const d of diff.diffs) {
      if (d.kind === "unchanged") continue;
      if (d.kind === "changed") {
        console.log(`  changed ${d.checkKey}: ${d.before!.status} -> ${d.after!.status}`);
        const before = JSON.stringify(d.before!.value);
        const after = JSON.stringify(d.after!.value);
        if (before !== after) console.log(`    value: ${before} -> ${after}`);
      } else if (d.kind === "retired") {
        console.log(`  retired ${d.checkKey} (new series: ${d.retiredBy})`);
      } else {
        console.log(`  ${d.kind} ${d.checkKey}${d.kind === "missing" ? " (present before, absent now)" : ""}`);
      }
    }

    // Execution verify: shipped bets only (the go-live half of the bet lifecycle).
    if (executions.length === 0 && refusals.length === 0) {
      console.log(`  execution: no shipped bets to verify (correct: nothing shipped yet)`);
    }
    for (const r of refusals) console.log(`  note: ${r.note}`);
    for (const result of executions) {
      for (const n of result.parserNotes) console.log(`  note: ${n}`);
      if (result.pass) {
        console.log(`  bet ${result.betId}: exec-verified (run ${result.verifyRunId})`);
        continue;
      }
      console.log(`  bet ${result.betId}: criteria NOT met, stays shipped`);
      for (const t of result.targets.filter((o) => !o.pass)) {
        console.log(`    ${t.checkKey}: required "${t.requiredStatus}", got ${t.actualStatus === null ? "missing" : `"${t.actualStatus}"`}`);
        if (t.claimValue || t.verifyValue) {
          console.log(`      claim evidence: ${JSON.stringify(t.claimValue)}`);
          console.log(`      verify run:     ${JSON.stringify(t.verifyValue)}`);
        }
      }
    }

    // Outcome assessment: EXPERIMENTAL, and labelled so in the output. Whether a shipped
    // change went live is a fact this engine re-collects and checks. Whether it moved the
    // number is search attribution: it needs a domain you control and weeks of settled
    // bets before it says anything, so it is reported, never claimed.
    if (outcomes.length === 0) {
      console.log(`  outcome (experimental): no exec-verified bets to assess`);
    } else {
      console.log(`  outcome (experimental — attribution, not proof; needs weeks of data):`);
    }
    for (const o of outcomes) {
      console.log(`    bet ${o.betId}: ${o.mature ? "outcome-assessed" : o.note}`);
      if (o.mature) console.log(`      ${o.note}`);
    }
  });
}

async function approveCmd(assetId: string): Promise<void> {
  const { approve } = await import("./engine/act/publish");
  const result = approve(assetId);
  if (result.note !== null) process.exitCode = 1;
  emit(result, () => {
    if (result.note !== null) console.error(`approve ${assetId}: ${result.note}`);
    else console.log(`approve ${assetId}: state ${result.state} (approved by ${result.approvedBy}, from ${result.approvedBySource})`);
  });
}

async function publishCmd(assetId: string): Promise<void> {
  const { publish } = await import("./engine/act/publish");
  const result = await publish(assetId);
  if (result.state !== "published") process.exitCode = 1;
  emit(result, () => {
    console.log(`publish ${assetId}: mode ${result.mode}, state ${result.state ?? "unknown"}`);
    if (result.prUrl) console.log(`  PR: ${result.prUrl}`);
    if (result.betShipped) console.log(`  bet marked shipped`);
    for (const n of result.notes) console.log(`  note: ${n}`);
  });
}

// preview: the asset body itself on stdout (this engine serves nothing, so reading a
// generated asset is a CLI read). --json wraps it with the asset's identity like every
// other verb; human mode prints the body and nothing else, so it pipes.
async function previewCmd(assetId: string): Promise<void> {
  const { previewAsset } = await import("./engine/lib/verbs");
  const result = previewAsset(assetId);
  if (!result.ok) process.exitCode = 1;
  emit(result, () => {
    if (!result.ok) console.error(`preview ${assetId}: ${result.note}`);
    else process.stdout.write(`${result.body as string}\n`);
  });
}

// edit: hand-finish an awaiting-review draft. The replacement body arrives on stdin by
// default (so an agent can pipe a completed page straight in) or from `--file <path>`.
// The approval gate is untouched: a body still carrying placeholders is stored and still
// refused by `approve`, which the result reports as `draftIncomplete`.
async function editCmd(assetId: string, filePath?: string): Promise<void> {
  let body: string;
  if (filePath) {
    if (!existsSync(filePath)) {
      console.error(`edit ${assetId}: file "${filePath}" not found`);
      process.exitCode = 1;
      return;
    }
    body = readFileSync(filePath, "utf8");
  } else {
    if (process.stdin.isTTY) {
      console.error(`edit ${assetId}: no body on stdin (pipe one, or pass --file <path>)`);
      process.exitCode = 1;
      return;
    }
    body = readFileSync(0, "utf8");
  }
  const { editAsset } = await import("./engine/lib/verbs");
  const result = editAsset(assetId, body);
  if (!result.ok) process.exitCode = 1;
  emit(result, () => {
    if (!result.ok) console.error(`edit ${assetId}: ${result.note}`);
    else {
      console.log(`edit ${assetId}: state ${result.state}, ${result.bytes} byte(s) written`);
      if (result.draftIncomplete)
        console.log("  note: body still carries engine placeholders; approve will refuse it");
    }
  });
}

// regenerate: one LLM revision pass over an awaiting-review draft, folding the operator's
// feedback in. One regeneration per invocation, never a loop; an unavailable LLM lane is a
// note and the stored draft is left exactly as it was.
async function regenerateCmd(assetId: string, feedback: string): Promise<void> {
  const { regenerateWithFeedback } = await import("./engine/act/regenerate");
  const result = regenerateWithFeedback(assetId, feedback);
  if (!result.ok) process.exitCode = 1;
  emit(result, () => {
    if (!result.ok) console.error(`regenerate ${assetId}: ${result.note}`);
    else console.log(`regenerate ${assetId}: state ${result.state}, draft revised`);
  });
}

async function outboxCmd(): Promise<void> {
  const { listOutbox } = await import("./engine/act/outbox");
  const entries = listOutbox();
  // Outbox is the agent surface (approved-unsent outreach drafts), but it takes --json
  // like every other verb: human mode gets a readable summary, not a raw JSON dump.
  emit(entries, () => {
    if (entries.length === 0) {
      console.log("outbox: no approved-unsent outreach drafts");
      return;
    }
    for (const e of entries) {
      console.log(`${e.assetId} (bet ${e.betId}) -> ${e.recipientContext.pageUrl ?? e.recipientContext.pageTitle ?? "unknown target"}`);
      console.log(`  subject: ${e.subjectSuggestion}`);
      if (e.recipientContext.competitorsCited.length > 0) {
        console.log(`  competitors cited: ${e.recipientContext.competitorsCited.join(", ")}`);
      }
    }
  });
}

async function markSentCmd(assetId: string): Promise<void> {
  const { markSent } = await import("./engine/act/outbox");
  const result = markSent(assetId);
  if (result.note !== null) process.exitCode = 1;
  emit(result, () => {
    if (result.note !== null) console.error(`mark-sent ${assetId}: ${result.note}`);
    else console.log(`mark-sent ${assetId}: state ${result.state}, published_at ${new Date(result.publishedAt!).toISOString()}`);
  });
}

// Shared driver for the operator verbs: emit the result, exit 1 on a guard note.
async function verbCmd(
  name: "reject" | "implemented" | "settle" | "cancel" | "dismiss" | "pause" | "archive" | "resume",
  arg: string,
  reason?: string,
): Promise<void> {
  const verbs = await import("./engine/lib/verbs");
  const result =
    name === "reject"
      ? verbs.reject(arg, reason ?? "")
      : name === "settle"
        ? verbs.settleBet(arg, reason ?? "")
        : name === "cancel"
          ? verbs.cancelBet(arg, reason ?? "")
        : name === "implemented"
          ? verbs.markImplemented(arg)
          : name === "dismiss"
            ? verbs.dismissClaim(arg)
            : name === "pause"
              ? verbs.pauseSurface(arg)
              : name === "archive"
                ? verbs.archiveSurface(arg)
                : verbs.resumeSurface(arg);
  if (!result.ok) process.exitCode = 1;
  emit(result, () => {
    if (!result.ok) console.error(`${name} ${arg}: ${result.note}`);
    else {
      const detail =
        "state" in result
          ? `state ${result.state}${result.settlement ? ` (${result.settlement})` : ""}`
          : "status" in result
            ? `status ${result.status}`
            : `lifecycle ${result.lifecycle}`;
      console.log(`${name} ${arg}: ${detail}`);
    }
  });
}

async function tickCmd(): Promise<void> {
  const { tick, renderSummary } = await import("./engine/lib/tick");
  const result = await tick();
  // Exit 0 always: lane failures live in the summary, tick itself succeeded.
  emit(result, () => {
    console.log(renderSummary(result));
    if (result.notified === "webhook") console.log("  summary posted to ANSWERABLE_NOTIFY_WEBHOOK");
    if (result.webhookError) console.log(`  ${result.webhookError}`);
  });
}

async function doctorCmd(): Promise<void> {
  const { doctor, renderDoctor } = await import("./engine/lib/doctor");
  const report = doctor();
  emit(report, () => console.log(renderDoctor(report)));
}

async function draftCmd(domain: string): Promise<void> {
  const { draft } = await import("./engine/lib/draft");
  const result = await draft(domain);
  emit(result, () => {
    console.log(`draft ${result.domain} (${result.pagesCrawled} page(s) crawled)`);
    console.log(`  brand: ${result.brand}${result.category ? ` (claimed category: ${result.category})` : ""}`);
    console.log(`  locales: ${result.locales.length > 0 ? result.locales.join(", ") : "none observed"} (${result.localeSource})`);
    console.log(`  competitors from comparison titles: ${result.competitors.length > 0 ? result.competitors.map((c) => c.name).join(", ") : "none found"}`);
    for (const n of result.notes) console.log(`  note: ${n}`);
    console.log(`  written: ${result.yamlPath}`);
  });
}

async function main(argv: string[]): Promise<void> {
  jsonMode = argv.includes("--json");
  const [command, arg, ...rest] = argv.filter((a) => a !== "--json");
  const arg2 = rest[0];

  switch (command) {
    case "brand":
      await brandCmd(arg, rest);
      break;
    case "onboard":
      if (!arg) return usage();
      try {
        await onboard(arg);
      } catch (e) {
        if (e instanceof SurfaceConfigError) {
          console.error(`config error: ${e.message}`);
          process.exitCode = 1;
          return;
        }
        throw e;
      }
      break;
    case "run":
      if (!arg) return usage();
      await run(arg);
      break;
    case "infer":
      if (!arg) return usage();
      await inferCmd(arg);
      break;
    case "decide":
      if (!arg) return usage();
      await decideCmd(arg);
      break;
    case "act":
      if (!arg) return usage();
      await actCmd(arg);
      break;
    case "narrate":
      await narrateCmd();
      break;
    case "spec":
      if (!arg || !arg2) return usage();
      await spec(arg, arg2);
      break;
    case "verify":
      if (!arg) return usage();
      await verify(arg);
      break;
    case "approve":
      if (!arg) return usage();
      await approveCmd(arg);
      break;
    case "publish":
      if (!arg) return usage();
      await publishCmd(arg);
      break;
    case "preview":
      if (!arg) return usage();
      await previewCmd(arg);
      break;
    case "edit": {
      if (!arg) return usage();
      const flag = rest.indexOf("--file");
      await editCmd(arg, flag >= 0 ? rest[flag + 1] : undefined);
      break;
    }
    case "regenerate":
      if (!arg || rest.length === 0) return usage();
      await regenerateCmd(arg, rest.join(" "));
      break;
    case "outbox":
      await outboxCmd();
      break;
    case "mark-sent":
      if (!arg) return usage();
      await markSentCmd(arg);
      break;
    case "reject":
      if (!arg || rest.length === 0) return usage();
      await verbCmd("reject", arg, rest.join(" "));
      break;
    case "settle":
      if (!arg || !arg2) return usage();
      await verbCmd("settle", arg, arg2);
      break;
    case "cancel":
      if (!arg || rest.length === 0) return usage();
      await verbCmd("cancel", arg, rest.join(" "));
      break;
    case "implemented":
    case "dismiss":
    case "pause":
    case "archive":
    case "resume":
      if (!arg) return usage();
      await verbCmd(command, arg);
      break;
    case "tick":
      await tickCmd();
      break;
    case "doctor":
      await doctorCmd();
      break;
    case "draft":
      if (!arg) return usage();
      await draftCmd(arg);
      break;
    default:
      usage();
      process.exitCode = command ? 1 : 0;
  }
}

main(process.argv.slice(2));
