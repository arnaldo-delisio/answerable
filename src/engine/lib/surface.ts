// Surface config loader: the Search Surface config abstraction, one yaml schema per
// surface, so onboarding a surface is adding a config file rather than writing new
// code. Parses + validates one yaml surface file against the fixed field schema and
// the kind-applicability matrix (which lanes are valid per surface kind, below).

import { readFileSync } from "node:fs";
import { parse } from "yaml";

export type SurfaceKind = "web-locale" | "ai-engine-lane" | "community-platform";

export interface WebLocaleTarget {
  domain: string;
  path_prefix: string;
  locale: string;
}
export interface PromptSet {
  version: string;
  prompts: string[];
}
export interface AiEngineLaneTarget {
  engine: string;
  prompt_set: PromptSet;
}
export interface CommunityPlatformTarget {
  platform: string;
  query_set: string;
}
export type SurfaceTarget = WebLocaleTarget | AiEngineLaneTarget | CommunityPlatformTarget;

export interface Competitor {
  name: string;
  url: string;
}

export interface Publishing {
  policy: string;
  owner: string;
}

export interface Surface {
  id: string;
  kind: SurfaceKind;
  target: SurfaceTarget;
  observes?: string;
  audience: string;
  business_goal: string;
  desired_conversion: string;
  competitors: Competitor[];
  publishing: Publishing;
  lanes: Record<string, unknown>;
  priors_from?: string;
  policy: Record<string, number>; // empty object = default class weights
  cadence?: "daily" | "weekly"; // answerable tick runs due surfaces on this cadence
  brand?: string; // optional brand id this surface groups under (brands layer)
}

export class SurfaceConfigError extends Error {}

// Surface ids are filenames and primary keys: lowercase alnum + dashes, must
// start alnum, max 64 chars.
export const SURFACE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function assertSurfaceId(id: string, ctx = "surface"): void {
  if (!SURFACE_ID_RE.test(id)) {
    fail(
      `${ctx}: id "${id}" is invalid — ids are lowercase letters, digits, and dashes, start with a letter or digit, max 64 characters (they become file names and database keys)`,
    );
  }
}

const KINDS: SurfaceKind[] = ["web-locale", "ai-engine-lane", "community-platform"];

// Kind-applicability matrix: adapters valid per surface kind.
export const APPLICABLE_LANES: Record<SurfaceKind, string[]> = {
  "web-locale": ["crawl", "performance", "gsc", "bing", "analytics", "competitor", "dataforseo", "community", "x"],
  "ai-engine-lane": ["geo-panel", "dataforseo"],
  "community-platform": ["community", "x"],
};

const TARGET_FIELDS: Record<SurfaceKind, string[]> = {
  "web-locale": ["domain", "path_prefix", "locale"],
  "ai-engine-lane": ["engine", "prompt_set"],
  "community-platform": ["platform", "query_set"],
};

function fail(msg: string): never {
  throw new SurfaceConfigError(msg);
}

function requireString(obj: Record<string, unknown>, field: string, ctx: string): string {
  const v = obj[field];
  if (typeof v !== "string" || v.length === 0) fail(`${ctx}: required field "${field}" missing or not a non-empty string`);
  return v;
}

export function parseSurface(text: string, ctx = "surface"): Surface {
  const raw = parse(text);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail(`${ctx}: not a yaml mapping`);
  const doc = raw as Record<string, unknown>;

  const id = requireString(doc, "id", ctx);
  assertSurfaceId(id, ctx);
  const kind = requireString(doc, "kind", ctx) as SurfaceKind;
  if (!KINDS.includes(kind)) fail(`${ctx}: kind "${kind}" is not one of ${KINDS.join(" | ")}`);

  // target shape must match kind
  const target = doc.target;
  if (target === null || typeof target !== "object" || Array.isArray(target)) fail(`${ctx}: required field "target" missing or not a mapping`);
  const t = target as Record<string, unknown>;
  for (const f of TARGET_FIELDS[kind]) {
    if (kind === "ai-engine-lane" && f === "prompt_set") {
      // prompt_set is structured: {version, prompts[]} (list of prompt strings + version)
      const ps = t.prompt_set;
      if (ps === null || typeof ps !== "object" || Array.isArray(ps)) fail(`${ctx}: target.prompt_set must be a mapping {version, prompts}`);
      const psObj = ps as Record<string, unknown>;
      requireString(psObj, "version", `${ctx}: target.prompt_set`);
      if (!Array.isArray(psObj.prompts) || psObj.prompts.length === 0 || psObj.prompts.some((p) => typeof p !== "string" || p.length === 0)) {
        fail(`${ctx}: target.prompt_set.prompts must be a non-empty list of prompt strings`);
      }
      continue;
    }
    requireString(t, f, `${ctx}: target (kind ${kind})`);
  }
  const extra = Object.keys(t).filter((k) => !TARGET_FIELDS[kind].includes(k));
  if (extra.length > 0) fail(`${ctx}: target has fields not in the ${kind} shape: ${extra.join(", ")}`);

  // observes: required for ai-engine-lane and community-platform, forbidden for web-locale
  const observes = doc.observes;
  if (kind === "web-locale") {
    if (observes !== undefined && observes !== null) fail(`${ctx}: "observes" is forbidden for kind web-locale`);
  } else if (typeof observes !== "string" || observes.length === 0) {
    fail(`${ctx}: "observes" (owned web surface id) is required for kind ${kind}`);
  }

  const audience = requireString(doc, "audience", ctx);
  const business_goal = requireString(doc, "business_goal", ctx);
  const desired_conversion = requireString(doc, "desired_conversion", ctx);

  if (!Array.isArray(doc.competitors)) fail(`${ctx}: required field "competitors" missing or not a list`);
  const competitors = (doc.competitors as unknown[]).map((c, i) => {
    if (c === null || typeof c !== "object") fail(`${ctx}: competitors[${i}] is not a mapping`);
    const co = c as Record<string, unknown>;
    return {
      name: requireString(co, "name", `${ctx}: competitors[${i}]`),
      url: requireString(co, "url", `${ctx}: competitors[${i}]`),
    };
  });

  const pub = doc.publishing;
  if (pub === null || typeof pub !== "object" || Array.isArray(pub)) fail(`${ctx}: required field "publishing" missing or not a mapping`);
  const publishing: Publishing = {
    policy: requireString(pub as Record<string, unknown>, "policy", `${ctx}: publishing`),
    owner: requireString(pub as Record<string, unknown>, "owner", `${ctx}: publishing`),
  };

  // lanes: only kind-applicable adapters (a non-applicable lane is a config error, never a no-op)
  const lanes = doc.lanes;
  if (lanes === null || typeof lanes !== "object" || Array.isArray(lanes)) fail(`${ctx}: required field "lanes" missing or not a mapping`);
  const laneMap = lanes as Record<string, unknown>;
  for (const lane of Object.keys(laneMap)) {
    if (!APPLICABLE_LANES[kind].includes(lane)) {
      fail(`${ctx}: lane "${lane}" is not applicable to kind "${kind}" (applicable: ${APPLICABLE_LANES[kind].join(", ")})`);
    }
  }

  const priors_from = doc.priors_from;
  if (priors_from !== undefined && priors_from !== null && (typeof priors_from !== "string" || priors_from.length === 0)) {
    fail(`${ctx}: "priors_from" must be a surface id string when present`);
  }

  // brand: optional grouping pointer — same id shape as surface ids (it is a
  // brands-table primary key). Membership is grouping only, never behavior.
  const brand = doc.brand;
  if (brand !== undefined && brand !== null) {
    if (typeof brand !== "string" || brand.length === 0) fail(`${ctx}: "brand" must be a brand id string when present`);
    assertSurfaceId(brand, `${ctx}: brand`);
  }

  const cadence = doc.cadence;
  if (cadence !== undefined && cadence !== null && cadence !== "daily" && cadence !== "weekly") {
    fail(`${ctx}: "cadence" must be daily | weekly when present`);
  }

  const policy = doc.policy ?? {};
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) fail(`${ctx}: "policy" must be a mapping of class weights`);
  for (const [k, v] of Object.entries(policy as Record<string, unknown>)) {
    if (typeof v !== "number") fail(`${ctx}: policy.${k} must be a number (class weight)`);
  }

  return {
    id,
    kind,
    target: t as unknown as SurfaceTarget,
    ...(kind === "web-locale" ? {} : { observes: observes as string }),
    audience,
    business_goal,
    desired_conversion,
    competitors,
    publishing,
    lanes: laneMap,
    ...(typeof priors_from === "string" ? { priors_from } : {}),
    policy: policy as Record<string, number>,
    ...(cadence === "daily" || cadence === "weekly" ? { cadence } : {}),
    ...(typeof brand === "string" ? { brand } : {}),
  };
}

export function loadSurface(filePath: string): Surface {
  return parseSurface(readFileSync(filePath, "utf8"), filePath);
}
