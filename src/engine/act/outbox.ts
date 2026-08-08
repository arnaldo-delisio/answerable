// Outbox (agent surface, human review gate): approved-but-unsent outreach-draft assets
// as structured data for any authorized sending agent (`outbox --json`); the engine itself
// never sends.
// mark-sent records the send: state published + published_at.

import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "../../db";
import { draftIncomplete } from "./llm";
import { cancelledBetFor } from "./publish";

export interface OutboxEntry {
  assetId: string;
  betId: string;
  recipientContext: {
    pageTitle: string | null;
    pageUrl: string | null;
    competitorsCited: string[];
  };
  subjectSuggestion: string;
  body: string; // the draft email body alone, ready to send
}

// The draft asset body is the rendered markdown from act/outreach; recipient context and
// the email body are extracted from its stable template sections.
function parseAssetBody(body: string): {
  pageTitle: string | null;
  pageUrl: string | null;
  competitorsCited: string[];
  emailBody: string;
} {
  const line = (label: string): string | null => {
    const m = new RegExp(`^- ${label}: (.*)$`, "m").exec(body);
    return m ? m[1].trim() : null;
  };
  const pageTitle = line("Page title");
  const rawUrl = line("Page URL");
  const pageUrl = rawUrl && !rawUrl.startsWith("(") ? rawUrl : null;
  const rawCompetitors = line("Competitors the page cites");
  const competitorsCited =
    rawCompetitors && !rawCompetitors.startsWith("(")
      ? rawCompetitors.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
  const emailMatch = /## Draft email body\s*\n\n([\s\S]*)$/.exec(body);
  return { pageTitle, pageUrl, competitorsCited, emailBody: (emailMatch?.[1] ?? body).trim() };
}

// The send path carries the same gate as approve/publish: a draft still holding the
// engine's own placeholders is not deliverable, so it is never handed to a sender —
// including a legacy row approved before the gate existed, or a body edited after.
export function listOutbox(): OutboxEntry[] {
  const rows = db
    .select()
    .from(schema.assets)
    .where(
      and(
        eq(schema.assets.type, "outreach-draft"),
        eq(schema.assets.state, "approved"),
        isNull(schema.assets.publishedAt),
      ),
    )
    .all()
    .filter((a) => !draftIncomplete(a.body))
    // Withdrawn work is never handed to a sender, however it was approved.
    .filter((a) => cancelledBetFor(a.betId) === null);
  return rows.map((a) => {
    const parsed = parseAssetBody(a.body ?? "");
    return {
      assetId: a.id,
      betId: a.betId,
      recipientContext: {
        pageTitle: parsed.pageTitle,
        pageUrl: parsed.pageUrl ?? a.route,
        competitorsCited: parsed.competitorsCited,
      },
      subjectSuggestion: parsed.pageTitle
        ? `A suggestion for "${parsed.pageTitle}"`
        : "A suggestion for your comparison page",
      body: parsed.emailBody,
    };
  });
}

export interface MarkSentResult {
  assetId: string;
  state: string;
  publishedAt: number | null;
  note: string | null; // honest failure: why mark-sent did not apply
}

export function markSent(assetId: string): MarkSentResult {
  const asset = db.select().from(schema.assets).where(eq(schema.assets.id, assetId)).get();
  if (!asset) return { assetId, state: "unknown", publishedAt: null, note: `asset "${assetId}" not found` };
  if (asset.type !== "outreach-draft") {
    return { assetId, state: asset.state, publishedAt: asset.publishedAt, note: "mark-sent applies only to outreach-draft assets" };
  }
  if (asset.state !== "approved") {
    return {
      assetId,
      state: asset.state,
      publishedAt: asset.publishedAt,
      note: `asset is "${asset.state}", not approved; only approved drafts are sendable (review gate)`,
    };
  }
  if (draftIncomplete(asset.body)) {
    return {
      assetId,
      state: asset.state,
      publishedAt: asset.publishedAt,
      note: "draft still carries engine placeholders (draft-pending / [NEEDS SOURCE]); it was never deliverable, so mark-sent does not apply",
    };
  }
  const withdrawn = cancelledBetFor(asset.betId);
  if (withdrawn !== null) {
    return {
      assetId,
      state: asset.state,
      publishedAt: asset.publishedAt,
      note: `bet ${withdrawn} is cancelled; the operator withdrew this work, so this draft was never sendable`,
    };
  }
  const publishedAt = Date.now();
  db.update(schema.assets)
    .set({ state: "published", publishedAt })
    .where(eq(schema.assets.id, assetId))
    .run();
  return { assetId, state: "published", publishedAt, note: null };
}
