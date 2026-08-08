// Act station, publish slice (human review gate: nothing publishes without an explicit
// approve first): approve moves an asset to
// `approved`; publish executes per the surface's publishing policy and marks the bet
// shipped. Fix-specs with `publishing.repo` configured open a real GitHub PR via the gh
// CLI (title from the claim, body = the spec markdown); without a repo the asset carries
// a spec-handoff note. Tool assets are build specs and travel the same PR/handoff path.
// Page assets are staged, never served: this engine has no web server, so publish never
// puts anything live on the customer domain — that stays verify's separate, later fact.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db, schema } from "../../db";
import { assertTransition } from "../../db/transitions";
import { draftIncomplete } from "./llm";

type AssetRow = typeof schema.assets.$inferSelect;

export interface ApproveResult {
  assetId: string;
  state: string;
  approvedBy: string;
  // Where approvedBy came from, so the recorded approver is never a mystery name in the
  // audit trail: "ANSWERABLE_APPROVER" | "USER" (the OS user running the CLI) |
  // "default" (neither set).
  approvedBySource: "ANSWERABLE_APPROVER" | "USER" | "default";
  note: string | null; // honest failure: why the approve did not apply
}

// Who the review gate records as the approver, in order:
//   1. ANSWERABLE_APPROVER — set it when the person approving is not the OS account
//      running the CLI (shared box, CI, an agent acting for a named human);
//   2. USER — the OS user of the shell that ran `answerable approve`;
//   3. "operator" — neither is set.
// Documented in README (Review gate) and AGENTS.md; the source travels in the result so
// `--json` consumers can tell an explicit approver from an inferred one.
export function approver(): { approvedBy: string; approvedBySource: ApproveResult["approvedBySource"] } {
  if (process.env.ANSWERABLE_APPROVER) {
    return { approvedBy: process.env.ANSWERABLE_APPROVER, approvedBySource: "ANSWERABLE_APPROVER" };
  }
  if (process.env.USER) return { approvedBy: process.env.USER, approvedBySource: "USER" };
  return { approvedBy: "operator", approvedBySource: "default" };
}

export interface PublishResult {
  assetId: string;
  type: string | null;
  state: string | null;
  mode: "pr" | "spec-handoff" | "staged" | "outbox" | "none";
  prUrl: string | null;
  betShipped: boolean;
  notes: string[];
}

function getAsset(assetId: string): AssetRow | undefined {
  return db.select().from(schema.assets).where(eq(schema.assets.id, assetId)).get();
}

// Cancellation is terminal and means "will not ship". An asset approved BEFORE its bet
// was cancelled must not still travel, so every delivery door asks this before acting:
// publish, the outbox listing, and mark-sent (src/engine/act/outbox.ts).
export function cancelledBetFor(betId: string): string | null {
  const bet = db.select().from(schema.bets).where(eq(schema.bets.id, betId)).get();
  return bet?.state === "cancelled" ? bet.id : null;
}

export function approve(assetId: string): ApproveResult {
  const asset = getAsset(assetId);
  const { approvedBy, approvedBySource } = approver();
  if (!asset) return { assetId, state: "unknown", approvedBy, approvedBySource, note: `asset "${assetId}" not found` };
  if (asset.state === "skipped") {
    return {
      assetId,
      state: asset.state,
      approvedBy,
      approvedBySource,
      note: `asset is skipped (${asset.skipReason ?? "no reason recorded"}); a skipped asset is not approvable`,
    };
  }
  if (asset.state === "rejected") {
    return {
      assetId,
      state: asset.state,
      approvedBy,
      approvedBySource,
      note: `asset is rejected (${asset.rejectedReason ?? "no reason recorded"}); rejection is a terminal review decision, not a state approve can undo`,
    };
  }
  if (asset.state === "published") {
    return { assetId, state: asset.state, approvedBy, approvedBySource, note: "asset is already published; approve not applied" };
  }
  if (draftIncomplete(asset.body)) {
    return {
      assetId,
      state: asset.state,
      approvedBy,
      approvedBySource,
      note: "draft still carries engine placeholders (draft-pending / [NEEDS SOURCE]); regenerate or fill them before approving",
    };
  }
  db.update(schema.assets)
    .set({ state: "approved", approvedBy })
    .where(eq(schema.assets.id, assetId))
    .run();
  return { assetId, state: "approved", approvedBy, approvedBySource, note: null };
}

// Surface config for the asset's bet, resolved bet -> surface.
function surfaceConfigFor(betId: string): { surfaceId: string; config: Record<string, unknown> } | null {
  const bet = db.select().from(schema.bets).where(eq(schema.bets.id, betId)).get();
  if (!bet) return null;
  const surface = db.select().from(schema.surfaces).where(eq(schema.surfaces.id, bet.surfaceId)).get();
  if (!surface) return null;
  return { surfaceId: bet.surfaceId, config: surface.configSnapshot };
}

// Claim title for the PR title, resolved asset -> bet -> claim.
function claimTitleFor(betId: string): string | null {
  const bet = db.select().from(schema.bets).where(eq(schema.bets.id, betId)).get();
  if (!bet) return null;
  const claim = db.select().from(schema.claims).where(eq(schema.claims.id, bet.claimId)).get();
  return claim?.title ?? null;
}

function markBetShipped(betId: string): boolean {
  const bet = db.select().from(schema.bets).where(eq(schema.bets.id, betId)).get();
  if (!bet || bet.state !== "placed") return false;
  assertTransition(bet, "shipped");
  db.update(schema.bets)
    .set({ state: "shipped", shippedAt: Date.now() })
    .where(eq(schema.bets.id, betId))
    .run();
  return true;
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// Open a real PR carrying the asset markdown at a repo-relative path: shallow
// clone, branch, commit, push, gh pr create. Every failure is a note; the
// workspace is always cleaned up.
function openAssetPr(
  repo: string,
  assetId: string,
  claimTitle: string,
  repoRelPath: string,
  specMarkdown: string,
  notes: string[],
): string | null {
  const workDir = mkdtempSync(path.join(tmpdir(), "answerable-publish-"));
  const branch = `answerable/${slugify(assetId)}`;
  const run = (cmd: string, args: string[], opts: { cwd?: string; input?: string } = {}): string =>
    execFileSync(cmd, args, {
      cwd: opts.cwd,
      input: opts.input,
      encoding: "utf8",
      timeout: 120_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  try {
    run("gh", ["repo", "clone", repo, workDir, "--", "--depth", "1"]);
    run("git", ["checkout", "-b", branch], { cwd: workDir });
    const specPath = path.join(workDir, repoRelPath);
    run("mkdir", ["-p", path.dirname(specPath)]);
    writeFileSync(specPath, specMarkdown);
    run("git", ["add", repoRelPath.split("/")[0]], { cwd: workDir });
    run("git", ["commit", "-m", `answerable: ${claimTitle}`], { cwd: workDir });
    run("git", ["push", "-u", "origin", branch, "--force"], { cwd: workDir });
    // PR body = the spec markdown itself; authored prose travels via file, never argv.
    const bodyPath = path.join(workDir, ".answerable-pr-body.md");
    writeFileSync(bodyPath, specMarkdown);
    const prUrl = run(
      "gh",
      ["pr", "create", "--repo", repo, "--head", branch, "--title", claimTitle, "--body-file", bodyPath],
      { cwd: workDir },
    );
    return prUrl.split("\n").pop() ?? prUrl;
  } catch (e) {
    notes.push(
      `PR creation failed for ${repo}: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}; asset stays approved`,
    );
    return null;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

export function publish(assetId: string): Promise<PublishResult> {
  return publishAsync(assetId);
}

async function publishAsync(assetId: string): Promise<PublishResult> {
  const notes: string[] = [];
  const result: PublishResult = {
    assetId,
    type: null,
    state: null,
    mode: "none",
    prUrl: null,
    betShipped: false,
    notes,
  };
  const asset = getAsset(assetId);
  if (!asset) {
    notes.push(`asset "${assetId}" not found`);
    return result;
  }
  result.type = asset.type;
  result.state = asset.state;
  if (asset.state !== "approved") {
    notes.push(`asset is "${asset.state}", not approved; publish requires the review gate (answerable approve first)`);
    return result;
  }
  // Second half of the same gate: a body edited back into placeholders after the
  // approve must not travel as a PR or a handoff.
  if (draftIncomplete(asset.body)) {
    notes.push("draft still carries engine placeholders (draft-pending / [NEEDS SOURCE]); publish refused");
    return result;
  }

  const withdrawn = cancelledBetFor(asset.betId);
  if (withdrawn !== null) {
    notes.push(
      `bet ${withdrawn} is cancelled; the operator withdrew this work, so the approved asset is not deliverable`,
    );
    return result;
  }

  const surfaceInfo = surfaceConfigFor(asset.betId);
  const publishing = (surfaceInfo?.config.publishing ?? {}) as { repo?: string };

  if (asset.type === "outreach-draft") {
    // Sending is the outbox's job; the engine itself never sends. Publish does not apply.
    result.mode = "outbox";
    notes.push("outreach drafts are sent by an authorized agent via answerable outbox + answerable mark-sent, never published here");
    return result;
  }

  // fix-spec and tool are both build specs for the owner's own repo: PR when the surface
  // configures one, spec-handoff otherwise.
  if (asset.type === "fix-spec" || asset.type === "tool") {
    const claimTitle = claimTitleFor(asset.betId) ?? assetId;
    if (typeof publishing.repo === "string" && publishing.repo.length > 0) {
      const prUrl = openAssetPr(
        publishing.repo,
        assetId,
        claimTitle,
        `specs/${slugify(assetId)}.md`,
        asset.body ?? "",
        notes,
      );
      if (prUrl === null) return result; // honest failure: stays approved
      result.mode = "pr";
      result.prUrl = prUrl;
      // Report the PR URL on the asset (route column; fix-specs have no product route).
      db.update(schema.assets)
        .set({ state: "published", publishedAt: Date.now(), route: prUrl })
        .where(eq(schema.assets.id, assetId))
        .run();
    } else {
      result.mode = "spec-handoff";
      const note = `\n\n---\n\nspec-handoff: no publishing.repo configured for this surface; deliver this spec to the owner manually.\n`;
      const body = (asset.body ?? "").includes("spec-handoff:") ? asset.body : (asset.body ?? "") + note;
      db.update(schema.assets)
        .set({ state: "published", publishedAt: Date.now(), body })
        .where(eq(schema.assets.id, assetId))
        .run();
      notes.push("no publishing.repo on the surface; spec-handoff note recorded on the asset");
    }
  } else {
    // Page truth: a page body is NOT served on the customer domain by this
    // publish — it is staged (readable with `answerable preview <asset-id>`).
    // When the surface has publishing.repo, the page travels as a real PR and that
    // PR is the delivery; without one, staging is the delivery. Either way the
    // state is "published" internally and the mode reported is "staged", never live.
    result.mode = "staged";
    let body = asset.body ?? "";
    if (typeof publishing.repo === "string" && publishing.repo.length > 0 && !/^pr: https?:/m.test(body)) {
      const claimTitle = claimTitleFor(asset.betId) ?? assetId;
      const prUrl = openAssetPr(
        publishing.repo,
        assetId,
        claimTitle,
        `pages/${slugify(asset.route ?? assetId)}.md`,
        body,
        notes,
      );
      // The repo IS the configured delivery: a failed PR delivered nothing, so the
      // asset stays approved and its bet stays placed rather than reporting a ship
      // that never happened. Without a repo, staging is the whole intended outcome.
      if (prUrl === null) {
        result.mode = "none";
        return result;
      }
      result.prUrl = prUrl;
      // Record the PR on the asset itself (body marker — `route` keeps the
      // page's intended path, unlike fix-specs which have no product route).
      body = `${body.trimEnd()}\n\n---\n\npr: ${prUrl}\n`;
    }
    db.update(schema.assets)
      .set({ state: "published", publishedAt: Date.now(), body })
      .where(eq(schema.assets.id, assetId))
      .run();
  }

  result.state = "published";
  result.betShipped = markBetShipped(asset.betId);
  if (!result.betShipped) notes.push("bet was not in state placed; shipped transition not applied");
  return result;
}
