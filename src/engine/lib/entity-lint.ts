// Deterministic entity lint for LLM-generated language (narrations, AEO answers):
// generated text may only name engines/vendors/competitors/numbers that are present
// in the claim's own linked data. Post-generation check, no LLM involved: a fixed
// catalog of known engine/vendor names plus every competitor name configured on any
// surface is scanned with word boundaries; any catalog hit absent from the claim's
// whitelist is a violation. Digit runs are checked the same way against the numbers
// present in the linked data. Callers regenerate once on violation, then fall back
// to draft-pending — never ship text that names entities its evidence does not.

import { eq, inArray } from "drizzle-orm";
import { db, schema } from "../../db";

// Engines/vendors an LLM plausibly name-drops in this product's domain. The false
// narration this lint exists to catch ("Google's AI assistant Claude") named a vendor
// (Google) absent from the claim's data next to an engine (claude) present in it.
const KNOWN_ENGINE_VENDORS = [
  "Google",
  "Bing",
  "Microsoft",
  "Claude",
  "Anthropic",
  "ChatGPT",
  "OpenAI",
  "GPT",
  "Codex",
  "Gemini",
  "Perplexity",
  "Copilot",
  "Meta",
  "DuckDuckGo",
];

// Engine lane id -> the display names that engine legitimately licenses in text.
const ENGINE_NAMES: Record<string, string[]> = {
  claude: ["Claude"],
  chatgpt: ["ChatGPT", "GPT"],
  codex: ["Codex", "ChatGPT", "GPT"],
  google: ["Google"],
  bing: ["Bing"],
};

function wordRe(name: string): RegExp {
  return new RegExp(`(?<![a-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`, "i");
}

// The full scan catalog: known engines/vendors + every competitor name configured on
// any onboarded surface (competitors are the other name class an LLM invents claims
// about). Built per call — the surface set is small and this stays current.
export function entityCatalog(): string[] {
  const names = new Set(KNOWN_ENGINE_VENDORS);
  for (const s of db.select().from(schema.surfaces).all()) {
    const competitors = (s.configSnapshot as { competitors?: { name?: string }[] }).competitors ?? [];
    for (const c of competitors) if (typeof c.name === "string" && c.name.length > 1) names.add(c.name);
  }
  return [...names];
}

export interface EntityWhitelist {
  names: string[]; // entity names the text may use (case-insensitive, word-bounded)
  numbers: Set<string>; // digit runs the text may contain
  sourceText: string; // concatenated linked data the whitelist was built from
}

const collectNumbers = (text: string, into: Set<string>): void => {
  for (const m of text.match(/\d+(?:\.\d+)?/g) ?? []) into.add(m);
};

// Whitelist for one claim: everything present in the claim row, its linked evidence
// values, its surface's config identity (domain/brand/engine/competitors named in the
// linked data via titles and entities_cited), and optionally the bet row under
// narration. Catalog names count as "present" only if they appear in this material.
export function whitelistForClaim(
  claimId: string,
  extra: string[] = [],
): EntityWhitelist {
  const claim = db.select().from(schema.claims).where(eq(schema.claims.id, claimId)).get();
  const parts: string[] = [...extra];
  if (claim) {
    parts.push(claim.id, claim.title, claim.class, claim.queryTopic ?? "", claim.recommendedAsset ?? "", claim.surfaceId);
    const surface = db.select().from(schema.surfaces).where(eq(schema.surfaces.id, claim.surfaceId)).get();
    if (surface) {
      const cfg = surface.configSnapshot as {
        target?: { domain?: string; engine?: string };
        observes?: string;
      };
      if (cfg.target?.domain) parts.push(cfg.target.domain);
      if (cfg.observes) parts.push(cfg.observes);
      if (cfg.target?.engine) parts.push(cfg.target.engine, ...(ENGINE_NAMES[cfg.target.engine] ?? []));
    }
    const evidenceIds = db
      .select({ evidenceId: schema.claimEvidence.evidenceId })
      .from(schema.claimEvidence)
      .where(eq(schema.claimEvidence.claimId, claimId))
      .all()
      .map((r) => r.evidenceId);
    if (evidenceIds.length > 0) {
      for (const ev of db.select().from(schema.evidence).where(inArray(schema.evidence.id, evidenceIds)).all()) {
        parts.push(ev.checkKey, JSON.stringify(ev.value ?? {}));
      }
    }
  }
  const sourceText = parts.join("\n");
  const names = entityCatalog().filter((n) => wordRe(n).test(sourceText));
  const numbers = new Set<string>();
  collectNumbers(sourceText, numbers);
  return { names, numbers, sourceText };
}

export interface LintViolation {
  kind: "entity" | "number";
  token: string;
}

// Lint generated text against a whitelist. Deterministic and conservative: only
// catalog names and digit runs are judged — prose itself is not re-litigated here.
export function lintText(text: string, whitelist: EntityWhitelist): LintViolation[] {
  const violations: LintViolation[] = [];
  const allowed = new Set(whitelist.names.map((n) => n.toLowerCase()));
  for (const name of entityCatalog()) {
    if (allowed.has(name.toLowerCase())) continue;
    if (wordRe(name).test(text)) violations.push({ kind: "entity", token: name });
  }
  const found = new Set<string>();
  collectNumbers(text, found);
  for (const n of found) {
    if (!whitelist.numbers.has(n)) violations.push({ kind: "number", token: n });
  }
  return violations;
}

export const describeViolations = (violations: LintViolation[]): string =>
  violations.map((v) => `${v.kind}:"${v.token}"`).join(", ");
