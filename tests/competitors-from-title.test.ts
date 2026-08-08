import { describe, it, expect } from "vitest";
import { competitorsFromTitle } from "../src/engine/lib/draft";

// A competitor list is a claim about who the brand competes with, and it flows into
// comparison pages and outreach drafts. These cases pin the rule that keeps it a claim
// rather than a word list: the brand itself must be one side of the comparison.
describe("competitorsFromTitle", () => {
  it("reads the other side of a real comparison page", () => {
    expect(competitorsFromTitle("Plausible vs Matomo: a privacy-first alternative | Plausible Analytics", "Plausible Analytics")).toEqual([
      "Matomo",
    ]);
  });

  it("recognises the brand by its domain label too", () => {
    expect(competitorsFromTitle("Plausible vs Matomo", ["Plausible Analytics", "plausible"])).toEqual(["Matomo"]);
  });

  it("reads a comparison whichever side the brand is on", () => {
    expect(competitorsFromTitle("Cloudflare Web Analytics vs Plausible", "Plausible")).toEqual(["Cloudflare Web Analytics"]);
  });

  it("ignores a docs page comparing two of the brand's own concepts", () => {
    expect(competitorsFromTitle("Anonymous vs identified events - Docs - PostHog", "PostHog")).toEqual([]);
    expect(competitorsFromTitle("Glue teams vs back-office teams - PostHog", "PostHog")).toEqual([]);
  });

  it("drops a trailing prose side of a three-way vs title", () => {
    expect(
      competitorsFromTitle("Cloudflare Web Analytics vs Plausible: a dedicated tool vs a side feature", "Plausible"),
    ).toEqual(["Cloudflare Web Analytics"]);
  });

  it("never names the brand as its own competitor", () => {
    expect(competitorsFromTitle("Plausible vs Plausible Analytics", "Plausible Analytics")).toEqual([]);
  });
});
