// Verify station, execution slice (go-live and outcome are separate checks: this is the
// go-live half): for a shipped bet, re-check the bet's
// target check_keys against a fresh verify run's evidence. Target check_keys are derived
// from the asset's "Verification criteria" section (the schema has no spare json column
// for storing them on the bet, so the spec body is the source of truth). Criteria pass
// -> bet moves to exec-verified with exec_verified_at + exec_verify_run_id; criteria
// fail -> the bet stays shipped and the diff is reported honestly.

import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "../../db";
import { assertTransition } from "../../db/transitions";

type EvidenceRow = typeof schema.evidence.$inferSelect;
type BetRow = typeof schema.bets.$inferSelect;

export interface TargetCheck {
  checkKey: string;
  requiredStatus: string;
}

export interface CheckOutcome {
  checkKey: string;
  requiredStatus: string;
  actualStatus: string | null; // null = check_key absent from the verify run (missing)
  pass: boolean;
  // Prior value from the claim's supporting evidence, for the honest diff.
  claimValue: Record<string, unknown> | null;
  verifyValue: Record<string, unknown> | null;
}

export interface ExecutionVerifyResult {
  betId: string;
  verifyRunId: string;
  targets: CheckOutcome[];
  // Unparsed check-key-shaped criteria lines; any entry here forces pass = false.
  parserNotes: string[];
  pass: boolean;
  applied: boolean; // false on a dry check or when criteria did not pass
  // A bet whose assets yield NO check-key-shaped criteria cannot be execution-verified.
  // That is a legitimate state (page and outreach assets carry prose criteria only, and
  // an asset may not have been generated yet), not an error: the bet is skipped with an
  // honest note and the rest of the verification proceeds. It was a throw once, which
  // crashed the whole `verify` pass and left `settle` permanently unreachable.
  skipped: boolean;
  skipNote: string | null;
}

// Criteria lines in generated specs read either
//   - `<check_key>` must read `<status>` ...
//   - `<check_key>` must remain `<status>` ...
// (both phrasings ship in the generators, fix-spec.ts). Only backticked keys carrying
// the evidence-identity shape (adapter/check@version/subject) count as targets;
// prose-only criteria (snapshot thresholds) are outcome-leg territory.
const CRITERIA_LINE = /^-\s+`([^`]+@[^`]+\/[^`]+)`\s+must\s+(?:read|remain)\s+`([^`]+)`/;
// A bullet whose first backticked token is check-key-shaped names an execution target;
// if CRITERIA_LINE cannot parse it, that criterion must fail loudly, never silently pass.
const CHECK_KEY_BULLET = /^-\s+`[^`]+@[^`]+\/[^`]+`/;

export interface ExtractedCriteria {
  targets: TargetCheck[];
  // Verification-criteria lines the parser could NOT turn into a target. Check-key-shaped
  // ones block the pass (unparsed criteria never silently pass); prose-only lines
  // (snapshot thresholds) are reported for transparency but belong to the outcome leg.
  unparsedTargets: string[];
  proseLines: string[];
}

export function extractCriteria(specBody: string): ExtractedCriteria {
  const result: ExtractedCriteria = { targets: [], unparsedTargets: [], proseLines: [] };
  const section = /##\s*Verification criteria\s*\n([\s\S]*?)(?:\n##\s|$)/.exec(specBody);
  if (!section) return result;
  for (const raw of section[1].split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("- ")) continue;
    const m = CRITERIA_LINE.exec(line);
    if (m) result.targets.push({ checkKey: m[1], requiredStatus: m[2] });
    else if (CHECK_KEY_BULLET.test(line)) result.unparsedTargets.push(line);
    else result.proseLines.push(line);
  }
  return result;
}

// Back-compat surface: targets only.
export function extractTargetChecks(specBody: string): TargetCheck[] {
  return extractCriteria(specBody).targets;
}

function targetsForBet(betId: string): { targets: TargetCheck[]; parserNotes: string[] } {
  const rows = db.select().from(schema.assets).where(eq(schema.assets.betId, betId)).all();
  const targets: TargetCheck[] = [];
  const parserNotes: string[] = [];
  const seen = new Set<string>();
  for (const asset of rows) {
    if (!asset.body) continue;
    const extracted = extractCriteria(asset.body);
    for (const t of extracted.targets) {
      if (!seen.has(t.checkKey)) {
        seen.add(t.checkKey);
        targets.push(t);
      }
    }
    for (const u of extracted.unparsedTargets) {
      parserNotes.push(`asset ${asset.id}: unparsed verification criterion (fails the check): ${u}`);
    }
  }
  return { targets, parserNotes };
}

// The claim's supporting evidence values, keyed by check_key (for the diff).
function claimEvidenceByKey(claimId: string): Map<string, EvidenceRow> {
  const links = db
    .select()
    .from(schema.claimEvidence)
    .where(eq(schema.claimEvidence.claimId, claimId))
    .all();
  if (links.length === 0) return new Map();
  const rows = db
    .select()
    .from(schema.evidence)
    .where(inArray(schema.evidence.id, links.map((l) => l.evidenceId)))
    .all();
  return new Map(rows.map((r) => [r.checkKey, r]));
}

// Re-check one bet's target check_keys against the verify run's evidence. dryCheck skips
// the state transition (for checking a not-yet-shipped bet without lying about lifecycle).
export function verifyExecution(bet: BetRow, verifyRunId: string, opts: { dryCheck?: boolean } = {}): ExecutionVerifyResult {
  const { targets, parserNotes } = targetsForBet(bet.id);
  if (targets.length === 0 && parserNotes.length === 0) {
    const assetCount = db.select().from(schema.assets).where(eq(schema.assets.betId, bet.id)).all().length;
    return {
      betId: bet.id,
      verifyRunId,
      targets: [],
      parserNotes: [],
      pass: false,
      applied: false,
      skipped: true,
      skipNote:
        assetCount === 0
          ? `bet ${bet.id}: no assets, so no verification criteria to check; not execution-verifiable (stays ${bet.state})`
          : `bet ${bet.id}: its ${assetCount} asset(s) carry prose verification criteria only, no check_key; not execution-verifiable by this engine (stays ${bet.state}, and outcome assessment reads exec-verified bets, so this one needs a human call)`,
    };
  }

  const verifyRows = db
    .select()
    .from(schema.evidence)
    .where(and(eq(schema.evidence.runId, verifyRunId), eq(schema.evidence.surfaceId, bet.surfaceId)))
    .all();
  const verifyByKey = new Map(verifyRows.map((r) => [r.checkKey, r]));
  const claimByKey = claimEvidenceByKey(bet.claimId);

  const outcomes: CheckOutcome[] = targets.map((t) => {
    const found = verifyByKey.get(t.checkKey);
    return {
      checkKey: t.checkKey,
      requiredStatus: t.requiredStatus,
      actualStatus: found?.status ?? null,
      pass: found !== undefined && found.status === t.requiredStatus,
      claimValue: claimByKey.get(t.checkKey)?.value ?? null,
      verifyValue: found?.value ?? null,
    };
  });

  // Unparsed criteria fail loudly: a criterion the parser could not read never passes.
  const pass = outcomes.every((o) => o.pass) && parserNotes.length === 0;
  const applied = pass && !opts.dryCheck && bet.state === "shipped";
  if (applied) {
    assertTransition(bet, "exec-verified");
    db.update(schema.bets)
      .set({ state: "exec-verified", execVerifiedAt: Date.now(), execVerifyRunId: verifyRunId })
      .where(eq(schema.bets.id, bet.id))
      .run();
  }
  return { betId: bet.id, verifyRunId, targets: outcomes, parserNotes, pass, applied, skipped: false, skipNote: null };
}

export function shippedBets(surfaceId: string): BetRow[] {
  return db
    .select()
    .from(schema.bets)
    .where(and(eq(schema.bets.surfaceId, surfaceId), eq(schema.bets.state, "shipped")))
    .all();
}
