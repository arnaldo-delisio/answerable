// Act station, fix-spec slice: a placed technical/eligibility bet becomes a markdown
// change spec (asset type fix-spec, state generated). Deterministic template + evidence
// interpolation from the latest run's rows; no LLM call. Persists the full lineage
// claims -> claim_evidence -> bets -> assets (a claim may motivate several bets; a bet
// may produce several assets).

import { desc, eq, like, or } from "drizzle-orm";
import { db, schema } from "../../db";
import { upsertAsset } from "./asset-write";
import { FIX_SPEC_KINDS, type FixSpecKind } from "./fix-spec-kinds";

// The kind list lives in fix-spec-kinds.ts (the CLI reads it without loading the db);
// re-exported here so callers of the generator keep one import.
export { FIX_SPEC_KINDS } from "./fix-spec-kinds";
export type { FixSpecKind } from "./fix-spec-kinds";

export interface FixSpecResult {
  claimId: string;
  betId: string;
  assetId: string;
  markdown: string;
  evidenceIds: string[];
  runId: string;
  // Set when the stored asset was NOT rewritten (review-gate protection below).
  assetNote: string | null;
}

type EvidenceRow = typeof schema.evidence.$inferSelect;

// Fallback locale list, used only when the evidence carries no observed hreflang
// entries to derive the real list from.
const LOCALES = [
  "en", "fr", "sl", "de", "pl", "es", "id", "bg", "pt", "ar",
  "hi", "it", "ja", "ko", "nl", "ru", "tr", "zh", "el",
] as const;

function latestRunId(surfaceId: string): string {
  const run = db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.surfaceId, surfaceId))
    // Deterministic latest-run selection: started_at, ties broken by id (equal
    // timestamps otherwise make "latest" depend on insertion order).
    .orderBy(desc(schema.runs.startedAt), desc(schema.runs.id))
    .limit(1)
    .get();
  if (!run) throw new Error(`no runs for surface "${surfaceId}" (answerable run <surface-id> first)`);
  return run.id;
}

function evidenceFor(runId: string, checkKeyPrefixes: string[]): EvidenceRow[] {
  return db
    .select()
    .from(schema.evidence)
    .where(or(...checkKeyPrefixes.map((p) => like(schema.evidence.checkKey, `${p}%`))))
    .all()
    .filter((r) => r.runId === runId)
    .sort((a, b) => a.checkKey.localeCompare(b.checkKey));
}

// Confidence mapping: strongest confidence_tag among linked evidence.
const TAG_CONFIDENCE: Record<string, number> = {
  observed: 0.9,
  measured: 0.85,
  reported: 0.6,
  "reported-unverified": 0.4,
  inference: 0.3,
};

function strongestTag(rows: EvidenceRow[]): { tag: string; confidence: number } {
  let best = { tag: "inference", confidence: 0 };
  for (const r of rows) {
    const c = TAG_CONFIDENCE[r.confidenceTag] ?? 0;
    if (c > best.confidence) best = { tag: r.confidenceTag, confidence: c };
  }
  return best;
}

function observedStateTable(rows: EvidenceRow[]): string {
  const lines = ["| check_key | status | observed value |", "|---|---|---|"];
  for (const r of rows) {
    const value = r.value ? JSON.stringify(r.value) : "";
    const compact = value.length > 220 ? `${value.slice(0, 220)}…` : value;
    lines.push(`| \`${r.checkKey}\` | ${r.status} | \`${compact}\` |`);
  }
  return lines.join("\n");
}

// Locales derived from observed hreflang entries when present; template fallback otherwise.
function localesFrom(rows: EvidenceRow[]): string[] {
  for (const r of rows) {
    if (!r.checkKey.startsWith("crawl/hreflang@")) continue;
    const entries = (r.value as { entries?: { hreflang: string | null }[] } | null)?.entries ?? [];
    const locales = entries
      .map((e) => e.hreflang)
      .filter((h): h is string => typeof h === "string" && h !== "x-default");
    if (locales.length > 0) return locales;
  }
  return [...LOCALES];
}

function hreflangSpec(surfaceId: string, rows: EvidenceRow[], domain: string): string {
  const locales = localesFrom(rows);
  const hreflangRows = rows.filter((r) => r.checkKey.startsWith("crawl/hreflang@"));
  const languagesBlock = locales.map((l) => `        ${l}: \`https://${domain}/${l}\${path}\`,`).join("\n");
  const verifyKeys = hreflangRows.map((r) => `- \`${r.checkKey}\` must read \`present\` with one entry per locale (${locales.length} locales) plus \`x-default\`, each href pointing at the SAME page path in that locale (per-URL rule, not the locale root).`);

  return `# Fix spec: hreflang fan-out (${surfaceId})

Type: technical fix. Generated deterministically from run evidence; no LLM involved.

## Current observed state

${observedStateTable(rows)}

## Change required

The Next.js app must emit, on EVERY indexable URL, one \`<link rel="alternate">\` tag per
locale in the ${locales.length}-locale fan-out plus \`x-default\`, where each \`href\` is the
same page path translated into that locale (per-URL rule): a deep page such as
\`/en/guides/pricing\` links \`/fr/guides/pricing\`, never the \`/fr\` locale root.

In the Next.js App Router this is \`generateMetadata\` returning \`alternates.languages\`
computed from the current path:

\`\`\`ts
export async function generateMetadata({ params }): Promise<Metadata> {
  const path = pagePathWithoutLocale(params); // e.g. "/guides/pricing" or ""
  return {
    alternates: {
      canonical: \`https://${domain}/\${params.locale}\${path}\`,
      languages: {
${languagesBlock}
        "x-default": \`https://${domain}/en\${path}\`,
      },
    },
  };
}
\`\`\`

Rendered link-tag block pattern (per URL):

\`\`\`html
${locales.map((l) => `<link rel="alternate" hreflang="${l}" href="https://${domain}/${l}{path}" />`).join("\n")}
<link rel="alternate" hreflang="x-default" href="https://${domain}/en{path}" />
\`\`\`

Rules:

- \`x-default\` always points at the \`en\` variant of the same path.
- Every alternate URL must be a 200, self-canonical page; the hreflang set must be
  reciprocal (each listed variant lists the full set back).
- Locale roots keep their existing set; the change extends the per-URL rule to every
  sitemap URL, not only the sampled roots.

## Verification criteria

Re-run \`answerable run ${surfaceId}\` after shipping. The following check_keys must hold:

${verifyKeys.join("\n")}
- \`crawl/canonical@v1/<sampled pages>\` must remain \`present\` and self-referencing.
- Snapshot \`hreflang_coverage\` must read 1.0 for the run.

## Rollback

The change is additive metadata: reverting the \`generateMetadata\` alternates block
restores the prior state with no content or URL impact. No redirects, no data migration.
`;
}

function siteBasicsSpec(surfaceId: string, rows: EvidenceRow[], domain: string): string {
  const robotsRows = rows.filter((r) => r.checkKey.startsWith("crawl/robots-bot-rules@"));
  const sitemapRow = rows.find((r) => r.checkKey.startsWith("crawl/sitemap@"));
  const jsonLdRows = rows.filter((r) => r.checkKey.startsWith("crawl/json-ld@"));
  // Entity name for the JSON-LD block: the domain's own label, never a hard-coded
  // brand. The spec tells the operator to confirm it at ship time.
  const brandName = domain.replace(/^www\./, "").split(".")[0];

  return `# Fix spec: site basics (${surfaceId}): robots.txt, sitemap, Organization JSON-LD

Type: technical fix (eligibility basics). Generated deterministically from run evidence;
no LLM involved.

## Current observed state

${observedStateTable(rows)}

## Change required

### 1. robots.txt

Serve \`https://${domain}/robots.txt\` with explicit allow-all plus the sitemap pointer
(today the file 404s; bots default to unrestricted, but the sitemap discovery path and
the explicit signal are both missing):

\`\`\`
User-agent: *
Allow: /

Sitemap: https://${domain}/sitemap.xml
\`\`\`

Next.js App Router: \`app/robots.ts\` returning this via \`MetadataRoute.Robots\`.

### 2. sitemap.xml

Generate \`https://${domain}/sitemap.xml\` from the route tree with \`app/sitemap.ts\`
(\`MetadataRoute.Sitemap\`): enumerate every indexable route, absolute URLs, valid XML
urlset. No third-party dependency needed for a site this size.

### 3. Organization JSON-LD

Emit on the homepage a JSON-LD block identifying the entity:

\`\`\`html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Organization",
  "name": "${brandName}",
  "url": "https://${domain}/",
  "sameAs": []
}
</script>
\`\`\`

In Next.js: render the \`<script>\` in the root layout or page component with
\`dangerouslySetInnerHTML\` over \`JSON.stringify\` of the object (fill \`sameAs\` with the
entity's real profiles at ship time).

## Verification criteria

Re-run \`answerable run ${surfaceId}\` after shipping. The following check_keys must hold:

${robotsRows.map((r) => `- \`${r.checkKey}\` must read \`pass\` with \`robots_txt_present: true\` and \`root_blocked: false\`.`).join("\n")}
${sitemapRow ? `- \`${sitemapRow.checkKey.replace(/\/sitemap\.xml$/, "/sitemap.xml")}\` must read \`pass\` with \`exists: true\`, \`valid_xml: true\`, \`url_count\` > 0.` : ""}
${jsonLdRows.map((r) => `- \`${r.checkKey}\` must read \`present\` with \`types\` including \`Organization\`.`).join("\n")}
- Snapshot \`eligibility_pass_rate\` must not regress; \`sitemap_url_count\` must read > 0.

## Rollback

All three artifacts are additive files/blocks: delete \`app/robots.ts\`, \`app/sitemap.ts\`,
and the JSON-LD script to restore the prior state. No URL or content changes involved.
`;
}

// bot-block: crawler access denied, either by a robots.txt group (robots-bot-rules
// blocked) or at the edge (bot-access blocked/fail). Remediation is as deterministic as
// site-basics: the blocked agents are named by their own check_keys, the change is a
// robots.txt group edit and/or an edge allowlist entry, and the criteria are the same
// check_keys reading `pass`.
function botBlockSpec(surfaceId: string, rows: EvidenceRow[], domain: string): string {
  const robotsBlocked = rows.filter(
    (r) => r.checkKey.startsWith("crawl/robots-bot-rules@") && r.status === "blocked",
  );
  const edgeBlocked = rows.filter(
    (r) => r.checkKey.startsWith("crawl/bot-access@") && (r.status === "blocked" || r.status === "fail"),
  );
  const botOf = (r: EvidenceRow) => r.checkKey.split("/").pop() ?? r.checkKey;
  const robotsBots = [...new Set(robotsBlocked.map(botOf))];
  const edgeBots = [...new Set(edgeBlocked.map(botOf))];

  const robotsSection =
    robotsBots.length === 0
      ? `No robots.txt group blocks a probed agent; nothing to change in \`robots.txt\` for this claim.`
      : `\`https://${domain}/robots.txt\` disallows \`/\` for ${robotsBots.map((b) => `\`${b}\``).join(", ")}.
Remove those agents' blocking rules, or replace each group with an explicit allow:

\`\`\`
${robotsBots.map((b) => `User-agent: ${b}\nAllow: /\n`).join("\n")}Sitemap: https://${domain}/sitemap.xml
\`\`\`

Next.js App Router: the groups live in \`app/robots.ts\` (\`MetadataRoute.Robots\`).`;

  const edgeSection =
    edgeBots.length === 0
      ? `Every probed agent reached \`https://${domain}/\` at the edge; no CDN/WAF change is required.`
      : `${edgeBots.map((b) => `\`${b}\``).join(", ")} did NOT get a 2xx from \`https://${domain}/\` when probing with that
agent's user-agent string, which is an edge (CDN / WAF / bot-management) rule rather than a
robots.txt rule: robots.txt is advisory and cannot produce a non-2xx. Allowlist those
user-agents in the edge bot-management ruleset for the site's origin, then re-probe.

Observed probe values:

${edgeBlocked.map((r) => `- \`${r.checkKey}\`: status \`${r.status}\`, value \`${JSON.stringify(r.value)}\``).join("\n")}`;

  const criteria = [...robotsBlocked, ...edgeBlocked].map(
    (r) => `- \`${r.checkKey}\` must read \`pass\`.`,
  );

  return `# Fix spec: crawler access blocked (${surfaceId})

Type: technical fix (eligibility). Generated deterministically from run evidence; no LLM
involved. Blocked agents are named by the evidence, never guessed.

## Current observed state

${observedStateTable(rows)}

## Change required

### 1. robots.txt rules

${robotsSection}

### 2. Edge / bot-management rules

${edgeSection}

## Verification criteria

Re-run \`answerable run ${surfaceId}\` after shipping. The following check_keys must hold:

${criteria.length > 0 ? criteria.join("\n") : "- (no blocked agent in the latest run: nothing left to verify)"}
- Snapshot \`eligibility_pass_rate\` must not regress.

## Rollback

Both changes are allowlist entries: restore the prior \`robots.txt\` group and remove the
edge allowlist rule to return to the observed state. No URL, content, or data change.
`;
}

// ssr: server-rendered text below the threshold on sampled pages. Deterministic: the
// thin pages, their observed text_chars, and the threshold all come from the evidence
// rows, and the criteria are those same check_keys reading `pass`.
function ssrSpec(surfaceId: string, rows: EvidenceRow[], domain: string): string {
  const ssrRows = rows.filter((r) => r.checkKey.startsWith("crawl/ssr@"));
  const thin = ssrRows.filter((r) => r.status === "thin" || r.status === "fail");
  const threshold = thin
    .map((r) => (r.value as { min_text_chars?: number } | null)?.min_text_chars)
    .find((n): n is number => typeof n === "number");
  const pageLine = (r: EvidenceRow) => {
    const v = r.value as { text_chars?: number; html_chars?: number } | null;
    return `- \`${r.checkKey.replace("crawl/ssr@v1/", "")}\`: ${v?.text_chars ?? "?"} text chars in ${v?.html_chars ?? "?"} chars of HTML (status \`${r.status}\`).`;
  };

  return `# Fix spec: server-rendered content thin (${surfaceId})

Type: technical fix. Generated deterministically from run evidence; no LLM involved.

## Current observed state

${observedStateTable(rows)}

## Change required

${thin.length}/${ssrRows.length} sampled pages on https://${domain}/ return HTML whose extractable text is
below the ${threshold ?? "configured"}-character threshold, i.e. the page's content arrives only after
client-side JavaScript runs. Crawlers and AI-answer engines that do not execute JS see an
effectively empty page.

Pages below the threshold:

${thin.length > 0 ? thin.map(pageLine).join("\n") : "- (none in the latest run)"}

For each page above, the main content must be present in the initial HTML response:

- Next.js App Router: render the content in a server component. Move the data fetch into
  the component (or a server action) rather than a client-side effect, and keep
  \`"use client"\` on interaction-only leaves.
- Where the data genuinely cannot be fetched server-side, server-render the full text of
  the page and hydrate the interactive parts on top of it, rather than rendering a shell.
- Do not substitute a prerendered snapshot served only to bots: that is cloaking, and the
  verification below deliberately probes with the same request path as a normal reader.

## Verification criteria

Re-run \`answerable run ${surfaceId}\` after shipping. The following check_keys must hold:

${thin.length > 0 ? thin.map((r) => `- \`${r.checkKey}\` must read \`pass\`.`).join("\n") : "- (no thin page in the latest run: nothing left to verify)"}
- Snapshot \`eligibility_pass_rate\` must not regress.

## Rollback

The change is a rendering-mode change per page: reverting the affected components to their
previous client-side fetch restores the observed state. No URL or content change.
`;
}

// Which evidence families feed each spec kind, and the claim/bet framing per kind.
const KIND_CONFIG: Record<
  FixSpecKind,
  {
    prefixes: string[];
    claimClass: string;
    title: (surfaceId: string) => string;
    falsifiability: string;
    impact: number;
    outcomeMetric: string;
    render: (surfaceId: string, rows: EvidenceRow[], domain: string) => string;
  }
> = {
  hreflang: {
    prefixes: ["crawl/hreflang@", "crawl/canonical@", "crawl/sitemap@v1"],
    claimClass: "technical",
    title: (s) => `hreflang fan-out must hold per-URL across ${s}`,
    falsifiability:
      "Falsified when a later run's crawl/hreflang@v1 checks read present with a full reciprocal per-locale set plus x-default on every sampled page, deep pages included.",
    impact: 3,
    outcomeMetric: "hreflang_coverage",
    render: hreflangSpec,
  },
  "site-basics": {
    prefixes: ["crawl/robots-bot-rules@", "crawl/robots-content-signal@", "crawl/sitemap@v1", "crawl/json-ld@"],
    claimClass: "eligibility",
    title: (s) => `site basics missing on ${s}: robots.txt, sitemap, Organization JSON-LD`,
    falsifiability:
      "Falsified when a later run reads robots-bot-rules with robots_txt_present true, sitemap pass with url_count > 0, and json-ld present including Organization.",
    impact: 3,
    outcomeMetric: "eligibility_pass_rate",
    render: siteBasicsSpec,
  },
  "bot-block": {
    prefixes: ["crawl/robots-bot-rules@", "crawl/bot-access@"],
    // Same class and slug infer's own bot-block detector uses, so the spec attaches to
    // the detector's claim instead of minting a rival one.
    claimClass: "eligibility",
    title: (s) => `crawler access blocked on ${s}`,
    falsifiability:
      "Falsified when a later run's robots-bot-rules and bot-access checks all read pass for every probed bot.",
    impact: 4,
    outcomeMetric: "eligibility_pass_rate",
    render: botBlockSpec,
  },
  ssr: {
    prefixes: ["crawl/ssr@"],
    claimClass: "technical",
    title: (s) => `SSR content thin or failing on sampled pages (${s})`,
    falsifiability:
      "Falsified when a later run's crawl/ssr@v1 checks read pass (server-rendered text above threshold) on every sampled page.",
    impact: 3,
    outcomeMetric: "eligibility_pass_rate",
    render: ssrSpec,
  },
};

// Effort 2 = technical fix spec (1-5 effort rubric: 1 config-only change, 3 single
// content piece, 5 tool build).
const FIX_SPEC_EFFORT = 2;
const OUTCOME_WINDOW = { minRuns: 2, minDays: 14 };

export function generateFixSpec(surfaceId: string, kind: FixSpecKind): FixSpecResult {
  const config = KIND_CONFIG[kind];
  if (!config) throw new Error(`unknown fix-spec kind "${kind}" (${FIX_SPEC_KINDS.join(" | ")})`);

  const runId = latestRunId(surfaceId);
  const rows = evidenceFor(runId, config.prefixes);
  if (rows.length === 0) throw new Error(`no evidence rows for kind "${kind}" in run ${runId}`);

  const surface = db.select().from(schema.surfaces).where(eq(schema.surfaces.id, surfaceId)).get();
  if (!surface) throw new Error(`surface "${surfaceId}" not onboarded`);
  const domain = (surface.configSnapshot.target as { domain?: string } | undefined)?.domain ?? surfaceId;

  const markdown = config.render(surfaceId, rows, domain);
  const { confidence } = strongestTag(rows);

  // Deterministic ids: re-running the spec for the same surface+kind replaces, never
  // duplicates. Claim attachment prefers a SURVIVING infer-owned claim on the same
  // subject over minting the canonical slug: when infer has falsified
  // `claim:<surface>:hreflang` but its narrower sibling `claim:<surface>:hreflang-partial`
  // is open, the spec (and its bet/asset) attach to the open claim — a spec must never
  // resurrect or shadow a falsified claim.
  const canonicalClaimId = `claim:${surfaceId}:${kind}`;
  const candidateClaimIds =
    kind === "hreflang" ? [canonicalClaimId, `claim:${surfaceId}:hreflang-partial`] : [canonicalClaimId];
  const existingOpen = candidateClaimIds
    .map((id) => db.select().from(schema.claims).where(eq(schema.claims.id, id)).get())
    .find((c) => c !== undefined && c.status === "open");
  const claimId = existingOpen?.id ?? canonicalClaimId;
  const betId = `bet:${claimId.replace(/^claim:/, "")}`; // decide's bet-id convention
  // Cancellation is terminal: a cancelled bet can never reach `shipped`, so generating
  // an approvable artifact for it would mint work that can never travel. Refuse before
  // any claim, evidence, or asset write, whichever door reached here (`spec` or `act`).
  const cancelled = db.select().from(schema.bets).where(eq(schema.bets.id, betId)).get();
  if (cancelled?.state === "cancelled") {
    throw new Error(
      `bet ${betId} is cancelled; the operator withdrew this work, nothing generated`,
    );
  }
  const assetId = `asset:${surfaceId}:${kind}:fix-spec`;
  const now = Date.now();

  if (existingOpen) {
    // Infer owns the surviving claim's text/falsifiability; the spec only refreshes
    // its evidence-derived confidence and observation pointer (createdRunId is
    // immutable: set on insert only).
    db.update(schema.claims)
      .set({ confidence: String(confidence), lastObservedRunId: runId })
      .where(eq(schema.claims.id, claimId))
      .run();
  } else {
    db.insert(schema.claims)
      .values({
        id: claimId,
        surfaceId,
        class: config.claimClass,
        status: "open",
        title: config.title(surfaceId),
        confidence: String(confidence),
        falsifiability: config.falsifiability,
        createdRunId: runId,
        lastObservedRunId: runId,
      })
      .onConflictDoUpdate({
        target: schema.claims.id,
        set: { confidence: String(confidence), lastObservedRunId: runId },
      })
      .run();
  }

  for (const r of rows) {
    db.insert(schema.claimEvidence)
      .values({ claimId, evidenceId: r.id })
      .onConflictDoNothing()
      .run();
  }

  // Bet upsert: confidence refreshes ONLY while the bet is still placed. A shipped
  // (or later) bet is frozen at its placement-time reasoning (decide's own rule);
  // re-running the spec after ship must not silently rewrite the record it was
  // judged on.
  const existingBet = db.select().from(schema.bets).where(eq(schema.bets.id, betId)).get();
  if (!existingBet) {
    db.insert(schema.bets)
      .values({
        id: betId,
        claimId,
        surfaceId,
        actionClass: "technical fix",
        impact: config.impact,
        effort: FIX_SPEC_EFFORT,
        confidence,
        outcomeMetric: config.outcomeMetric,
        outcomeWindow: OUTCOME_WINDOW,
        state: "placed",
        placedAt: now,
      })
      .run();
  } else if (existingBet.state === "placed") {
    db.update(schema.bets).set({ confidence }).where(eq(schema.bets.id, betId)).run();
  }

  // Review-gate protection: regeneration must never mutate an asset the human gate has
  // already acted on (approved / published / skipped). The minimal correct branch is
  // skip-with-note: the stored asset stays byte-identical, the fresh markdown is still
  // returned to the caller for inspection, and the note says why nothing was written.
  // The gate itself lives in ONE place (act/asset-write.ts) so no write path can miss it;
  // the fresh markdown is still returned to the caller for inspection when the write is
  // refused, and the note says why nothing was stored.
  // betId is part of the update: a re-pointed spec (surviving-claim attachment above)
  // must carry its asset to the surviving claim's bet, not leave it on a stale one.
  const write = upsertAsset(
    { id: assetId, betId, type: "fix-spec", body: markdown, state: "generated" },
    { betId, body: markdown, state: "generated" },
  );
  const assetNote = write.note;

  return { claimId, betId, assetId, markdown, evidenceIds: rows.map((r) => r.id), runId, assetNote };
}

// ---- act-station entry --------------------------------------------------

export interface SurfaceFixSpec {
  kind: FixSpecKind;
  claimId: string;
  betId: string;
  assetId: string;
  state: "generated";
}

export interface FixSpecsResult {
  assets: SurfaceFixSpec[];
  notes: string[];
}

// Candidate claim ids per kind: infer and this generator share the slug
// `claim:<surface>:<kind>`, plus hreflang's narrower surviving sibling.
function claimCandidates(surfaceId: string, kind: FixSpecKind): string[] {
  const canonical = `claim:${surfaceId}:${kind}`;
  return kind === "hreflang" ? [canonical, `claim:${surfaceId}:hreflang-partial`] : [canonical];
}

// Every fix-spec kind whose claim is open on this surface AND already carries a bet.
// This is what closes the "ranked work with no generator" gap: bot-block and ssr claims
// become bets like any other, and this pass turns those bets into shippable specs.
// A per-kind failure is a note, never a throw that kills the act pass.
export function generateSurfaceFixSpecs(surfaceId: string): FixSpecsResult {
  const notes: string[] = [];
  const assets: SurfaceFixSpec[] = [];

  const surface = db.select().from(schema.surfaces).where(eq(schema.surfaces.id, surfaceId)).get();
  if (!surface) {
    notes.push(`surface "${surfaceId}" not onboarded; nothing to generate`);
    return { assets, notes };
  }

  for (const kind of FIX_SPEC_KINDS) {
    try {
      const claim = claimCandidates(surfaceId, kind)
        .map((id) => db.select().from(schema.claims).where(eq(schema.claims.id, id)).get())
        .find((c) => c !== undefined && c.status === "open");
      if (!claim) continue; // no open claim of this kind: nothing to fix, not a note
      const bet = db.select().from(schema.bets).where(eq(schema.bets.claimId, claim.id)).get();
      if (!bet) {
        notes.push(`claim ${claim.id}: no bet placed; fix specs attach to a bet, skipped`);
        continue;
      }
      if (bet.state === "cancelled") {
        notes.push(`bet ${bet.id} is cancelled; the operator withdrew this work, nothing regenerated`);
        continue;
      }
      const result = generateFixSpec(surfaceId, kind);
      if (result.assetNote) {
        notes.push(result.assetNote);
        continue;
      }
      assets.push({
        kind,
        claimId: result.claimId,
        betId: result.betId,
        assetId: result.assetId,
        state: "generated",
      });
    } catch (e) {
      notes.push(
        `fix spec "${kind}" failed: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`,
      );
    }
  }
  return { assets, notes };
}
