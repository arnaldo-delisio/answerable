// Act station, shared LLM lane for the page generators: claude CLI (`claude -p`),
// prompt over stdin, never a shell argument. CLI absent, empty, or failing = honest
// draft-pending text plus a visible note, never a throw that kills the act pass.

import { execFileSync } from "node:child_process";

export const DRAFT_PENDING = "draft-pending: LLM unavailable";

// Approval-gate integrity: a draft still carrying the engine's own honest
// placeholders — "draft-pending" prose (LLM lane down) and "[NEEDS SOURCE]" cells
// (no cited fact yet) — must never approve or publish. One shared predicate, so
// the gate is enforced where the state changes, never only where the body is read back.
export function draftIncomplete(body: string | null): boolean {
  return body != null && (body.includes("draft-pending") || body.includes("[NEEDS SOURCE]"));
}

export function claudeCliAvailable(): boolean {
  try {
    execFileSync("claude", ["--version"], { stdio: "pipe", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

// One prompt in, trimmed text out. `subject` labels the failure note.
export function llmText(
  prompt: string,
  subject: string,
  notes: string[],
): { text: string; pending: boolean } {
  if (!claudeCliAvailable()) {
    notes.push(`llm: claude CLI not on PATH; ${subject} created draft-pending`);
    return { text: DRAFT_PENDING, pending: true };
  }
  // Multi-minute CLI shellouts print nothing to stdout by design (stdout is the
  // machine surface); without this a slow act pass looks identical to a hang, to a
  // human and to an agent watching the process. stderr only, always — --json keeps
  // stdout as exactly one document, but an agent piping stderr still needs the sign
  // of life.
  process.stderr.write(`act: querying claude for ${subject}...\n`);
  try {
    // Prompt travels via stdin, never as a shell argument.
    const text = execFileSync("claude", ["-p", "--output-format", "text"], {
      input: prompt,
      encoding: "utf8",
      timeout: 180_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (text.length === 0) {
      notes.push(`llm: empty response for ${subject}; draft-pending`);
      return { text: DRAFT_PENDING, pending: true };
    }
    return { text, pending: false };
  } catch (e) {
    notes.push(
      `llm: draft failed for ${subject} (${e instanceof Error ? e.message.slice(0, 120) : String(e)}); draft-pending`,
    );
    return { text: DRAFT_PENDING, pending: true };
  }
}

// JSON-shaped variant: extracts the first {...} block and parses it; any failure
// (no CLI, no JSON, parse error) returns null with a note, never a throw.
export function llmJson<T>(prompt: string, subject: string, notes: string[]): T | null {
  const { text, pending } = llmText(prompt, subject, notes);
  if (pending) return null;
  // Models sometimes fence or preface the JSON: try the raw text, then the first
  // fenced block, then the first greedy {...} span.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const greedy = /\{[\s\S]*\}/.exec(text)?.[0];
  for (const candidate of [text, fenced, greedy]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // try the next extraction
    }
  }
  notes.push(`llm: no parseable JSON object for ${subject}; draft-pending`);
  return null;
}
