// Act station, outreach slice: authority/competitor claims whose evidence names
// listicle/comparison pages citing competitors but not the brand become outreach-draft
// assets (send-ready, human-sent: the engine never sends; claim taxonomy authority row).
//
// ETHICS GATE (deterministic, before any drafting): the target page's topic must
// actually cover the brand's category, judged from the evidence row's own
// comparison_targets/title. A page that names none of the surface's competitors offers
// no genuinely helpful pitch, so the asset is created with state `skipped` and
// skip_reason set; a draft is never forced.
//
// Draft body via LLM (claude CLI, prompt over stdin, never a shell argument) under a
// strict template: genuinely helpful, specific to the target page, affiliation explicit,
// no puffery. No LLM available = honest "draft-pending" body, state stays generated.
// A per-target failure is a note, never a throw that kills the act pass.

import { execFileSync } from "node:child_process";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "../../db";
import { upsertAsset } from "./asset-write";

type ClaimRow = typeof schema.claims.$inferSelect;
type EvidenceRow = typeof schema.evidence.$inferSelect;

export interface OutreachAsset {
  assetId: string;
  betId: string;
  claimId: string;
  targetUrl: string | null;
  targetTitle: string | null;
  state: "generated" | "skipped";
  skipReason: string | null;
  draftPending: boolean;
}

export interface OutreachResult {
  assets: OutreachAsset[];
  notes: string[];
}

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

interface TargetPage {
  evidence: EvidenceRow;
  url: string | null;
  title: string;
  comparisonTargets: string[];
}

// Listicle/comparison shape: the page's title or url reads as a roundup/comparison.
const LISTICLE_RE = /\balternatives?\b|\bvs\.?\b|\bversus\b|\bbest\b|\btop\s+\d+\b|\bcomparison\b|\broundup\b/i;

// Brand token from the surface's domain, e.g. www.example.com -> "example".
function brandTokenFor(surfaceId: string): string | null {
  const s = db.select().from(schema.surfaces).where(eq(schema.surfaces.id, surfaceId)).get();
  const config = s?.configSnapshot as { target?: { domain?: string }; observes?: string } | undefined;
  const domain = config?.target?.domain;
  if (domain) return domain.replace(/^www\./, "").split(".")[0].toLowerCase();
  // assistant/community surfaces: brand comes from the observed web surface.
  if (config?.observes) return brandTokenFor(config.observes);
  return null;
}

// Candidate target pages from a claim's linked evidence: page-shaped rows (a title in
// the extracted value) that read as listicle/comparison content and do not cite the
// brand. comparison_targets stays raw here; the ethics gate judges it separately.
function targetPagesFrom(evidenceRows: EvidenceRow[], brand: string | null): TargetPage[] {
  const targets: TargetPage[] = [];
  for (const r of evidenceRows) {
    if (r.status !== "pass") continue;
    const v = r.value as { title?: unknown; comparison_targets?: unknown } | null;
    const title = typeof v?.title === "string" ? v.title : null;
    if (!title) continue; // not a page-shaped evidence row (e.g. a panel prompt)
    const url = typeof (r.provenance as { url?: unknown }).url === "string"
      ? ((r.provenance as { url: string }).url)
      : null;
    const comparisonTargets = Array.isArray(v?.comparison_targets)
      ? (v.comparison_targets as unknown[]).filter((t): t is string => typeof t === "string")
      : [];
    const listicleShaped =
      LISTICLE_RE.test(title) || (url !== null && LISTICLE_RE.test(url)) || comparisonTargets.length > 1;
    if (!listicleShaped) continue;
    const citesBrand =
      brand !== null &&
      (title.toLowerCase().includes(brand) ||
        comparisonTargets.some((t) => t.toLowerCase().includes(brand)));
    if (citesBrand) continue;
    targets.push({ evidence: r, url, title, comparisonTargets });
  }
  return targets;
}

// Deterministic ethics precheck: the page verifiably covers the brand's category only
// when its own title/h1 named competitors from this surface's competitor list (the
// comparison_targets extraction). No named competitor = no evidence the page's topic is
// the brand's category = no genuinely helpful pitch possible.
function ethicsPrecheck(page: TargetPage): { pass: boolean; reason: string | null } {
  if (page.comparisonTargets.length === 0) {
    return {
      pass: false,
      reason:
        "target page names no competitor from this surface's category in its title/h1 (comparison_targets empty); no genuinely helpful, on-topic pitch is possible",
    };
  }
  return { pass: true, reason: null };
}

// ---- LLM draft ------------------------------------------------------------

function claudeCliAvailable(): boolean {
  try {
    execFileSync("claude", ["--version"], { stdio: "pipe", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function draftPrompt(page: TargetPage, brand: string, surfaceGoal: string): string {
  return [
    `Write the body of a short outreach email (under 150 words, no subject line, no signature block) to the editor of this page:`,
    ``,
    `Page title: ${page.title}`,
    `Page URL: ${page.url ?? "(url not recorded)"}`,
    `Competitors the page already covers: ${page.comparisonTargets.join(", ")}`,
    ``,
    `The sender represents "${brand}" (${surfaceGoal}). Strict rules:`,
    `- Be genuinely helpful and specific to THIS page: reference what it covers and why ${brand} is a relevant addition for its readers.`,
    `- State the sender's affiliation with ${brand} explicitly in the first two sentences.`,
    `- No puffery, no superlatives about ${brand}, no invented statistics or claims.`,
    `- Ask, do not demand: suggest the editor evaluate ${brand} for inclusion; offer to provide factual product information.`,
    `- Plain text only. Respond with ONLY the email body, nothing else.`,
  ].join("\n");
}

function draftBody(page: TargetPage, brand: string, surfaceGoal: string, notes: string[]): { body: string; pending: boolean } {
  if (!claudeCliAvailable()) {
    notes.push("outreach: claude CLI not on PATH; drafts created as draft-pending");
    return { body: "draft-pending: LLM unavailable", pending: true };
  }
  process.stderr.write(`act: querying claude for outreach draft to ${page.url ?? page.title}...\n`);
  try {
    // Prompt travels via stdin, never as a shell argument.
    const text = execFileSync("claude", ["-p", "--output-format", "text"], {
      input: draftPrompt(page, brand, surfaceGoal),
      encoding: "utf8",
      timeout: 180_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (text.length === 0) {
      notes.push(`outreach: LLM returned empty draft for ${page.url ?? page.title}; draft-pending`);
      return { body: "draft-pending: LLM unavailable", pending: true };
    }
    return { body: text, pending: false };
  } catch (e) {
    notes.push(
      `outreach: LLM draft failed for ${page.url ?? page.title} (${e instanceof Error ? e.message.slice(0, 120) : String(e)}); draft-pending`,
    );
    return { body: "draft-pending: LLM unavailable", pending: true };
  }
}

function renderAssetBody(page: TargetPage, claim: ClaimRow, emailBody: string): string {
  return `# Outreach draft (send-ready, human-sent; the engine never sends)

## Recipient context

- Page title: ${page.title}
- Page URL: ${page.url ?? "(url not recorded)"}
- Competitors the page cites: ${page.comparisonTargets.join(", ") || "(none)"}
- Claim: ${claim.id} (${claim.class})
- Evidence: \`${page.evidence.checkKey}\`

## Draft email body

${emailBody}
`;
}

// ---- entry ---------------------------------------------------------------

// Outreach assets for one surface's authority/competitor claims. Includes assistant
// and community surfaces observing a web surface, mirroring infer/decide.
export function generateOutreachDrafts(surfaceId: string): OutreachResult {
  const notes: string[] = [];
  const assets: OutreachAsset[] = [];

  const observers = db
    .select({ id: schema.surfaces.id })
    .from(schema.surfaces)
    .all()
    .filter((s) => {
      const c = db.select().from(schema.surfaces).where(eq(schema.surfaces.id, s.id)).get();
      return (c?.configSnapshot as { observes?: string } | undefined)?.observes === surfaceId;
    })
    .map((s) => s.id);
  const surfaceIds = [surfaceId, ...observers];

  const claims = db
    .select()
    .from(schema.claims)
    .where(inArray(schema.claims.surfaceId, surfaceIds))
    .all()
    .filter((c) => (c.class === "authority" || c.class === "competitor") && c.status === "open");
  if (claims.length === 0) {
    notes.push("no open authority/competitor claims on this surface (or its observers); nothing to draft");
    return { assets, notes };
  }

  const surface = db.select().from(schema.surfaces).where(eq(schema.surfaces.id, surfaceId)).get();
  const surfaceGoal =
    ((surface?.configSnapshot as { business_goal?: string } | undefined)?.business_goal ?? "").slice(0, 300);
  const brand = brandTokenFor(surfaceId);

  // Target ownership within this pass: asset id -> the claim that drafted it.
  const targetOwner = new Map<string, string>();

  for (const claim of claims) {
    try {
      const bet = db.select().from(schema.bets).where(eq(schema.bets.claimId, claim.id)).get();
      if (!bet) {
        notes.push(`claim ${claim.id}: no bet placed; outreach assets attach to a bet, skipped`);
        continue;
      }
      if (bet.state === "cancelled") {
        notes.push(`bet ${bet.id} is cancelled; the operator withdrew this work, nothing generated`);
        continue;
      }
      const evidenceRows = db
        .select({ e: schema.evidence })
        .from(schema.claimEvidence)
        .innerJoin(schema.evidence, eq(schema.claimEvidence.evidenceId, schema.evidence.id))
        .where(eq(schema.claimEvidence.claimId, claim.id))
        .all()
        .map((r) => r.e);
      const pages = targetPagesFrom(evidenceRows, brand);
      if (pages.length === 0) {
        notes.push(
          `claim ${claim.id}: evidence names no listicle/comparison pages (brand-uncited, page-shaped); no outreach target`,
        );
        continue;
      }
      for (const page of pages) {
        const subject = page.url ? slugify(new URL(page.url).hostname + new URL(page.url).pathname) : slugify(page.title);
        const assetId = `asset:${claim.surfaceId}:outreach:${subject}`;
        // One draft per target page per surface: outreach to the same page from two
        // claims is one email, not two, and the first claim owns the asset. Without
        // this the second claim silently rewrote the first one's draft and re-pointed
        // its bet (the collision shape fixed across the act generators).
        if (targetOwner.has(assetId)) {
          notes.push(
            `outreach target ${page.url ?? page.title} already drafted for claim ${targetOwner.get(assetId)}; claim ${claim.id} skipped (one draft per target)`,
          );
          continue;
        }
        targetOwner.set(assetId, claim.id);
        const gate = ethicsPrecheck(page);
        if (!gate.pass) {
          const skipWrite = upsertAsset(
            {
              id: assetId,
              betId: bet.id,
              type: "outreach-draft",
              body: renderAssetBody(page, claim, "(no draft: ethics gate skipped this target)"),
              route: page.url,
              state: "skipped",
              skipReason: gate.reason,
            },
            { state: "skipped", skipReason: gate.reason },
          );
          if (!skipWrite.written) {
            notes.push(skipWrite.note!);
            continue;
          }
          assets.push({
            assetId,
            betId: bet.id,
            claimId: claim.id,
            targetUrl: page.url,
            targetTitle: page.title,
            state: "skipped",
            skipReason: gate.reason,
            draftPending: false,
          });
          continue;
        }
        const { body: emailBody, pending } = draftBody(page, brand ?? claim.surfaceId, surfaceGoal, notes);
        const body = renderAssetBody(page, claim, emailBody);
        const write = upsertAsset({
          id: assetId,
          betId: bet.id,
          type: "outreach-draft",
          body,
          route: page.url,
          state: "generated",
          skipReason: null,
        });
        if (!write.written) {
          notes.push(write.note!);
          continue;
        }
        assets.push({
          assetId,
          betId: bet.id,
          claimId: claim.id,
          targetUrl: page.url,
          targetTitle: page.title,
          state: "generated",
          skipReason: null,
          draftPending: pending,
        });
      }
    } catch (e) {
      notes.push(
        `outreach failed for claim ${claim.id}: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`,
      );
    }
  }
  return { assets, notes };
}
