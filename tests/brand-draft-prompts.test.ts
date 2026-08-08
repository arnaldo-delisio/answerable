// Prompts seeded at the product's own entry point (`brand add <domain>`) feed the
// geo-panel share-of-answer lane directly: a broken question yields a confident,
// worthless number. These tests pin the defects observed live — raw page ornament
// reaching a prompt, a tagline treated as a category, and (stripe.com, probed from a
// German-hosted box) a non-English claimed category sailing past an English-only
// blocklist because the rule had no words to object to — at the unit level:
// cleanBrandToken, isPlausibleCategory/isAssessableCategory, and discoveryPrompts'
// behavior when a category is absent, rejected, or unassessable.

import { describe, expect, it } from "vitest";
import {
  cleanBrandToken,
  isPlausibleCategory,
  isAssessableCategory,
  discoveryPrompts,
} from "../src/engine/lib/brand-draft";
import { brandSegmentFromTitle } from "../src/engine/lib/draft";

describe("brandSegmentFromTitle", () => {
  // The mailchimp.com case: the brand is the LAST segment, not the first.
  it("picks the segment matching the domain label when the brand is last (mailchimp.com case)", () => {
    expect(
      brandSegmentFromTitle("Die E-Mail-Marketing-Plattform jetzt mit SMS | Mailchimp", "mailchimp"),
    ).toBe("Mailchimp");
  });

  it("picks the segment matching the domain label when the brand is first", () => {
    expect(brandSegmentFromTitle("Stripe | Financial Infrastructure to Grow Your Revenue", "stripe")).toBe(
      "Stripe",
    );
  });

  it("falls back to the domain label when there is no separator and nothing matches (trello.com case)", () => {
    expect(brandSegmentFromTitle("Capture, organize, and tackle your to-dos from anywhere", "trello")).toBe(
      "trello",
    );
  });

  it("falls back to the domain label when no segment matches it", () => {
    expect(brandSegmentFromTitle("The Ultimate Platform | Some Other Name", "acme")).toBe("acme");
  });

  it("matches a non-Latin brand segment (tencent case)", () => {
    expect(brandSegmentFromTitle("欢迎访问 | 腾讯", "腾讯")).toBe("腾讯");
  });
});

describe("cleanBrandToken", () => {
  it("strips title ornament (the htmx.org case: '</> htmx')", () => {
    expect(cleanBrandToken("</> htmx", "htmx")).toBe("htmx");
  });

  it("passes through a clean brand name untouched", () => {
    expect(cleanBrandToken("Stripe", "stripe")).toBe("Stripe");
  });

  it("falls back to the domain label when nothing plausible survives", () => {
    expect(cleanBrandToken("★★★ !!! ---", "acme")).toBe("acme");
    expect(cleanBrandToken("", "acme")).toBe("acme");
  });

  it("keeps a non-Latin name — it is real content, not ornament", () => {
    expect(cleanBrandToken("腾讯", "tencent")).toBe("腾讯");
  });

  it("falls back when the title is pure tagline with no brand name in it (trello.com case)", () => {
    expect(cleanBrandToken("Capture, organize, and tackle your to-dos from anywhere", "trello")).toBe("trello");
  });
});

describe("isPlausibleCategory", () => {
  it("rejects the htmx.org tagline ('high power tools for html')", () => {
    expect(isPlausibleCategory("high power tools for html")).toBe(false);
  });

  it("accepts a genuine noun-phrase category", () => {
    expect(isPlausibleCategory("project management software")).toBe(true);
    expect(isPlausibleCategory("email marketing platform")).toBe(true);
  });

  it("rejects marketing punctuation and ornament", () => {
    expect(isPlausibleCategory("the #1 tool for teams!")).toBe(false);
    expect(isPlausibleCategory("★ project tool ★")).toBe(false);
  });

  it("rejects an overlong phrase", () => {
    expect(isPlausibleCategory("a very long run-on phrase that reads like marketing copy about many things")).toBe(false);
  });

  it("rejects a hype opener even with trailing punctuation (plausible.io case)", () => {
    expect(isPlausibleCategory("Simple, privacy-friendly Google Analytics alternative")).toBe(false);
  });

  it("rejects an empty candidate", () => {
    expect(isPlausibleCategory("")).toBe(false);
    expect(isPlausibleCategory("   ")).toBe(false);
  });

  // The stripe.com case: probed from a German-hosted box, the site served
  // "Online-Bezahldienst und Zahlungsdienstleister" as its claimed category. Pure ASCII,
  // no hype word, no marketing punctuation — every English-only check waves it through.
  // It must be rejected anyway, because the rule cannot assess it, not because it
  // recognizes it as bad.
  it("fails closed on a non-English category the blocklist has no words to judge (stripe.com/de case)", () => {
    expect(isPlausibleCategory("Online-Bezahldienst und Zahlungsdienstleister")).toBe(false);
  });

  it("still accepts a genuine English category with no hype words (control for the fix above)", () => {
    expect(isPlausibleCategory("payment processing software")).toBe(true);
  });
});

describe("isAssessableCategory", () => {
  it("is false for the German phrase — no recognizable English word in it", () => {
    expect(isAssessableCategory("Online-Bezahldienst und Zahlungsdienstleister")).toBe(false);
  });

  it("is true for an ordinary English category phrase", () => {
    expect(isAssessableCategory("project management software")).toBe(true);
  });
});

describe("discoveryPrompts", () => {
  it("uses the category-shaped prompts when the category is plausible", () => {
    const prompts = discoveryPrompts("Acme", "project management software");
    expect(prompts).toEqual([
      "best tools for project management software",
      "Acme alternatives",
      "is Acme worth it",
      "project management software: which product should I use?",
    ]);
  });

  it("degrades to fewer, brand-only prompts when the category is implausible (htmx.org case)", () => {
    const prompts = discoveryPrompts("htmx", "high power tools for html");
    expect(prompts).toEqual(["htmx alternatives", "is htmx worth it", "what is htmx?"]);
    for (const p of prompts) expect(p).not.toContain("high power tools for html");
  });

  it("degrades to brand-only prompts when there is no category at all", () => {
    const prompts = discoveryPrompts("Acme", null);
    expect(prompts).toEqual(["Acme alternatives", "is Acme worth it", "what is Acme?"]);
  });

  it("never lets ornament reach a prompt when brand is derived via cleanBrandToken", () => {
    const brand = cleanBrandToken("</> htmx", "htmx");
    const prompts = discoveryPrompts(brand, null);
    for (const p of prompts) {
      expect(p).not.toContain("</>");
    }
  });

  it("degrades to brand-only prompts on a non-English category (stripe.com/de case) — never interpolated", () => {
    const prompts = discoveryPrompts("Stripe", "Online-Bezahldienst und Zahlungsdienstleister");
    expect(prompts).toEqual(["Stripe alternatives", "is Stripe worth it", "what is Stripe?"]);
    for (const p of prompts) expect(p).not.toContain("Bezahldienst");
  });
});
