// Geo-panel sense adapter: samples AI answer engines as a consumer would, via the
// subscription CLIs installed on this box: a subscription-CLI proxy for the
// consumer-facing surface, cheaper than an API-key panel but n=1 per prompt and
// volatile run to run (this is a deliberate cost/fidelity tradeoff, not an oversight).
// Lane "claude" = `claude -p <prompt> --allowedTools WebSearch`; lane "codex" =
// `codex exec <prompt>` (ChatGPT-backed). One panel_observations row + one evidence
// row per prompt. A missing CLI or a failed invocation writes honest fail rows;
// collect never throws for a lane-level problem.

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Surface, AiEngineLaneTarget } from "../../lib/surface";
import type { EvidenceRow, CollectResult } from "./crawl";
import type { EntityCited } from "../../../db/schema";
import { wordIndex, hasNegativeContext, type BrandIdentity } from "../../lib/brand-identity";

export interface PanelObservationRow {
  id: string;
  runId: string;
  surfaceId: string;
  promptSetVersion: string;
  promptId: string;
  engine: string;
  responseDigest: string;
  entitiesCited: EntityCited[];
  // THREE states, not two. true = the answer named the operator. false = the answer
  // was searched for the operator's known names and did not carry them. null =
  // UNGROUNDED: no identity could be resolved for this surface, so the answer was
  // never searched at all. Collapsing null into false is what manufactures a
  // confident 0% share out of a run that measured nothing (honest gated states over
  // fake zeros). Every consumer must branch on `=== true` / `=== false` / `== null`.
  ownedHit: boolean | null;
}

const TIMEOUT_MS = 120_000;
const DIGEST_CHARS = 500;

// The observed brand comes from the brand's stored identity profile (aliases +
// negative terms, src/engine/lib/brand-identity.ts), resolved by the sense
// station and passed in. An ALIAS in the response is the owned hit — there is no
// second, conditionally-matched class of token, and no category vocabulary voting
// on whether an ambiguous word counted this time. A domain label like "example" is
// also an ordinary word, so it matches only if the operator deliberately listed it
// as an alias. A negative term present in the response vetoes the owned hit
// outright: the answer is about the other thing.

// Engine -> CLI invocation. Both are subscription-CLI proxies for the consumer surfaces.
// codex exec is stdin-sensitive non-interactively ("Reading additional input from
// stdin...") and interleaves metadata with the answer in plain mode, so the codex lanes
// run --json (JSONL events on stdout) and extract the agent_message text;
// --skip-git-repo-check keeps the lane working outside a trusted git workdir.
const LANES: Record<string, { bin: string; args: (prompt: string) => string[]; extract?: (stdout: string) => string }> = {
  claude: { bin: "claude", args: (p) => ["-p", p, "--allowedTools", "WebSearch"] },
  codex: { bin: "codex", args: (p) => ["exec", "--skip-git-repo-check", "--json", p], extract: extractCodexJson },
  chatgpt: { bin: "codex", args: (p) => ["exec", "--skip-git-repo-check", "--json", p], extract: extractCodexJson }, // ChatGPT lane runs via the Codex CLI
};

// Parse codex exec --json JSONL: the answer is the item.completed agent_message text
// (joined if the turn emitted several). Unparseable lines are skipped; no match = "".
export function extractCodexJson(stdout: string): string {
  const messages: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { type?: string; item?: { type?: string; text?: string } };
      if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
        messages.push(event.item.text);
      }
    } catch {
      // non-JSON noise line: skip
    }
  }
  return messages.join("\n").trim();
}

// Stable slug of the prompt text: lowercase, alnum runs joined by "-", capped.
export function promptSlug(prompt: string): string {
  return prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64)
    .replace(/-$/, "");
}

interface CliOutcome {
  ok: boolean;
  stdout: string;
  error: string | null;
  fetchedAt: number;
}

function runCli(bin: string, args: string[]): Promise<CliOutcome> {
  const fetchedAt = Date.now();
  // Fresh empty temp cwd per run: both CLIs load project context (CLAUDE.md, docs)
  // from their working directory, which contaminated answers when the lane inherited
  // the cockpit tree as cwd. An empty dir gives a consumer-blank workspace.
  const cwd = mkdtempSync(join(tmpdir(), "answerable-geo-panel-"));
  return new Promise((resolve) => {
    const done = (outcome: CliOutcome) => {
      rmSync(cwd, { recursive: true, force: true });
      resolve(outcome);
    };
    const child = execFile(bin, args, { cwd, timeout: TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        done({ ok: false, stdout: stdout ?? "", error: err.message, fetchedAt });
      } else {
        done({ ok: true, stdout, error: null, fetchedAt });
      }
    });
    // codex exec reads additional prompt input from a non-TTY stdin; an open pipe
    // yields an empty run, so close it immediately.
    child.stdin?.end();
  });
}

// Scan the response for the surface's competitors + the owned brand; rank = order of
// first appearance in the text. Without an identity (no brand row, no config brand
// key, and no observed surface to derive a domain from) there is no owned-brand
// matching at all: the engine does not know this brand's names, so it reports
// ownedHit `null` (ungrounded, we could not look) rather than `false` (we looked and
// it was absent). The two are different facts and the product must never print the
// second when only the first is true.
export function extractEntities(
  response: string,
  surface: Surface,
  identity: BrandIdentity | null = null,
): { entities: EntityCited[]; ownedHit: boolean | null } {
  const hits: { entity: string; url: string; index: number }[] = [];

  for (const c of surface.competitors) {
    const idx = wordIndex(response, c.name);
    if (idx >= 0) hits.push({ entity: c.name, url: c.url, index: idx });
  }

  let ownedIdx = -1;
  // A negative term in the response means the token belongs to something else
  // (a look-alike product name, an unrelated acronym): no owned match is read from it.
  if (identity && !hasNegativeContext(response, identity)) {
    for (const variant of identity.aliases) {
      const idx = wordIndex(response, variant);
      if (idx >= 0 && (ownedIdx < 0 || idx < ownedIdx)) ownedIdx = idx;
    }
  }
  if (ownedIdx >= 0 && identity) hits.push({ entity: identity.name, url: identity.url, index: ownedIdx });

  hits.sort((a, b) => a.index - b.index);
  return {
    entities: hits.map((h, i) => ({ entity: h.entity, url: h.url, rank: i + 1 })),
    ownedHit: identity ? ownedIdx >= 0 : null,
  };
}

export async function collect(
  surface: Surface,
  runId: string,
  identity: BrandIdentity | null = null,
): Promise<CollectResult> {
  const target = surface.target as AiEngineLaneTarget;
  const evidence: EvidenceRow[] = [];
  const panelObservations: PanelObservationRow[] = [];

  const lane = LANES[target.engine];
  const { version, prompts } = target.prompt_set;

  for (const [i, prompt] of prompts.entries()) {
    const promptId = promptSlug(prompt);
    const checkKey = `geo-panel/prompt@v1/${promptId}`;

    // Each prompt is a real CLI shellout that can run minutes with zero stdout output
    // (stdout stays the machine surface). Without this, a slow geo-panel run is
    // indistinguishable from a hang to both a human and an agent watching the process.
    process.stderr.write(
      `sense: querying ${target.engine} (${i + 1}/${prompts.length}): ${promptId}\n`,
    );

    if (!lane) {
      // Unknown engine: honest per-prompt failure, never a throw.
      evidence.push({
        id: randomUUID(),
        runId,
        surfaceId: surface.id,
        checkKey,
        status: "fail",
        confidenceTag: "observed",
        value: { error: `no CLI lane for engine "${target.engine}"`, engine: target.engine, prompt },
        provenance: { url: null, fetched_at: Date.now(), method: "none" },
        cost: 0,
      });
      continue;
    }

    const outcome = await runCli(lane.bin, lane.args(prompt));
    const prov = { url: null, fetched_at: outcome.fetchedAt, method: `cli:${lane.bin}` };

    if (!outcome.ok || outcome.stdout.trim().length === 0) {
      // Missing CLI (ENOENT), timeout, or empty response: honest lane failure row.
      evidence.push({
        id: randomUUID(),
        runId,
        surfaceId: surface.id,
        checkKey,
        status: "fail",
        confidenceTag: "observed",
        value: { error: outcome.error ?? "empty response", engine: target.engine, cli: lane.bin, prompt },
        provenance: prov,
        cost: 0,
      });
      continue;
    }

    const response = (lane.extract ? lane.extract(outcome.stdout) : outcome.stdout).trim();
    if (response.length === 0) {
      // CLI ran but no assistant message could be extracted: honest lane failure row.
      evidence.push({
        id: randomUUID(),
        runId,
        surfaceId: surface.id,
        checkKey,
        status: "fail",
        confidenceTag: "observed",
        value: { error: "no assistant message in CLI output", engine: target.engine, cli: lane.bin, prompt },
        provenance: prov,
        cost: 0,
      });
      continue;
    }
    const { entities, ownedHit } = extractEntities(response, surface, identity);

    panelObservations.push({
      id: randomUUID(),
      runId,
      surfaceId: surface.id,
      promptSetVersion: version,
      promptId,
      engine: target.engine,
      responseDigest: response.slice(0, DIGEST_CHARS),
      entitiesCited: entities,
      ownedHit,
    });

    evidence.push({
      id: randomUUID(),
      runId,
      surfaceId: surface.id,
      checkKey,
      status: "pass",
      confidenceTag: "observed",
      value: {
        engine: target.engine,
        prompt,
        response_chars: response.length,
        entities_cited: entities.map((e) => e.entity),
        owned_hit: ownedHit,
      },
      provenance: prov,
      cost: 0,
    });
  }

  return { evidence, panelObservations, cost: 0 };
}
