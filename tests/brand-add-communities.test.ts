// `brand add`'s community gate: which of the things the probe found become a proposed
// surface, which are reported instead, and what the operator is told in each case.
//
// The rule this suite exists to hold is one line: NOTHING is proposed that cannot
// actually be collected. Discovery is maximal (the probe reads every profile the site
// links to and asks two platforms whether the brand is discussed at all); activation is
// selective (a config file is written only where a lane can run). Every case below is one
// way that rule could quietly rot into coverage theatre — a Reddit surface for a brand
// nobody mentions, an X surface on a box with no X credential, a "could not check" read
// as a "none found", or a store listing proposed for an adapter that does not exist.

import { describe, expect, it } from "vitest";
import { planCommunitySurfaces, notMonitoredFacets, renderCommunityYaml } from "../src/engine/lib/brand-add";
import type { BrandProposal } from "../src/engine/lib/brand-draft";
import type { MentionProbe } from "../src/engine/sense/adapters/community";
import { parseSurface } from "../src/engine/lib/surface";

const found = (platform: MentionProbe["platform"], hitCount: number): MentionProbe => ({
  platform,
  query: "acme.com",
  hitCount,
  checked: true,
  reason: null,
});
const unchecked = (platform: MentionProbe["platform"], reason: string): MentionProbe => ({
  platform,
  query: "acme.com",
  hitCount: 0,
  checked: false,
  reason,
});

const social = (network: string, url: string) => ({
  network,
  url,
  evidence: [{ observed: "profile linked from the site's own page", where: "https://acme.com/" }],
});

function proposal(over: {
  mentions?: MentionProbe[];
  social?: BrandProposal["facets"]["social_profiles"];
  stores?: BrandProposal["facets"]["store_listings"];
}): BrandProposal {
  return {
    brand: { name: "Acme", primaryDomain: "acme.com", description: "Acme does things", category: "invoicing software" },
    competitors: [{ name: "Northwind", url: "https://northwind.example" }],
    facets: {
      websites: [],
      store_listings: over.stores ?? [],
      social_profiles: over.social ?? [],
      ai_lanes: [],
    },
    community_mentions: over.mentions ?? [],
    unreachable: [],
    notes: [],
  };
}

describe("reddit and hacker news are gated on real mentions", () => {
  it("proposes only the platform that had mentions, and says so about the one that did not", () => {
    const plan = planCommunitySurfaces(proposal({ mentions: [found("reddit", 0), found("hacker-news", 37)] }), null);

    expect(plan.propose.map((p) => p.platform)).toEqual(["hacker-news"]);
    expect(plan.notes).toEqual([
      'community mention check on "acme.com" — reddit: checked, none found, so nothing was proposed; hacker-news: 37 results, so a community surface was proposed',
    ]);
  });

  it("proposes nothing when neither platform talks about the brand, and reports the check", () => {
    const plan = planCommunitySurfaces(proposal({ mentions: [found("reddit", 0), found("hacker-news", 0)] }), null);

    expect(plan.propose).toEqual([]);
    // "Checked, none found" is a finding about the brand and it is reported as one. The
    // alternative — silence — is indistinguishable from never having looked.
    expect(plan.notes).toEqual([
      'community mention check on "acme.com" — reddit: checked, none found, so nothing was proposed; hacker-news: checked, none found, so nothing was proposed',
    ]);
  });

  it("keeps a platform that could not answer separate from one that answered zero", () => {
    const plan = planCommunitySurfaces(
      proposal({ mentions: [unchecked("reddit", "http 403"), found("hacker-news", 0)] }),
      null,
    );

    expect(plan.propose).toEqual([]);
    expect(plan.notes).toEqual([
      'community mention check on "acme.com" — reddit: could not check (http 403), so nothing was proposed; hacker-news: checked, none found, so nothing was proposed',
    ]);
  });

  it("proposes both when both talk, and counts one result as one", () => {
    const plan = planCommunitySurfaces(proposal({ mentions: [found("reddit", 1), found("hacker-news", 4)] }), null);

    expect(plan.propose.map((p) => p.platform)).toEqual(["reddit", "hacker-news"]);
    expect(plan.notes[0]).toContain("reddit: 1 result, so a community surface was proposed");
    expect(plan.propose[0].why).toContain('a reddit search for "acme.com" returned 1 result');
  });

  it("says nothing at all about a check that never ran", () => {
    // The seed domain did not answer: no site surface to observe, so no probe and no
    // claim about what Reddit thinks.
    expect(planCommunitySurfaces(proposal({}), null).notes).toEqual([]);
  });
});

describe("x is gated on the lane being runnable on this box", () => {
  const withX = { social: [social("X", "https://x.com/acmehq")] };

  it("proposes an x surface when a credential exists, naming the rung it will run on", () => {
    const plan = planCommunitySurfaces(proposal(withX), "xurl");

    expect(plan.propose.map((p) => p.platform)).toEqual(["x"]);
    expect(plan.propose[0].what).toBe("x (@acmehq)");
    expect(plan.propose[0].why).toContain("the site links an X profile (https://x.com/acmehq)");
    expect(plan.propose[0].extraComments.join("\n")).toContain("the x lane runs on xurl on this box");
    // The handle is not what the lane matches on, and the proposal says so rather than
    // letting the operator assume a surface named @acmehq counts posts that say @acmehq.
    expect(plan.propose[0].extraComments.join("\n")).toContain("answerable brand alias acme-com acmehq");
    expect(plan.notes).toEqual([]);
  });

  it("proposes nothing and names what would enable it when the box has no credential", () => {
    const plan = planCommunitySurfaces(proposal(withX), null);

    expect(plan.propose).toEqual([]);
    expect(plan.notes).toEqual([
      "found an X profile (https://x.com/acmehq); the x lane collects it, but this box has neither the `xurl` CLI on PATH nor X_BEARER_TOKEN set, so no x surface was proposed — install one, then copy config/surfaces/example-community-hn.yaml with `platform: x`",
    ]);
  });

  it("treats a twitter.com profile as the same X profile the probe labelled it", () => {
    const plan = planCommunitySurfaces(
      proposal({ social: [social("X", "https://twitter.com/acmehq")] }),
      "X_BEARER_TOKEN",
    );
    expect(plan.propose.map((p) => p.platform)).toEqual(["x"]);
  });
});

describe("what has no collector is reported, never proposed", () => {
  const network = {
    stores: [
      { store: "Apple App Store", url: "https://apps.apple.com/app/acme", evidence: [] },
      { store: "Google Play", url: "https://play.google.com/store/apps/details", evidence: [] },
    ],
    social: [social("GitHub", "https://github.com/acme"), social("LinkedIn", "https://linkedin.com/company/acme")],
  };

  it("proposes nothing for store listings or github, whatever else was found", () => {
    const plan = planCommunitySurfaces(proposal({ ...network, mentions: [found("reddit", 9)] }), "xurl");
    expect(plan.propose.map((p) => p.platform)).toEqual(["reddit"]);
  });

  it("lists them as found-and-unmonitored without claiming they have no adapter in general", () => {
    const { items, note } = notMonitoredFacets(proposal(network));

    expect(items.map((i) => i.what)).toEqual(["Apple App Store", "Google Play", "GitHub", "LinkedIn"]);
    expect(note).toBe(
      "found 4 store/social profiles no collector reads yet (Apple App Store, Google Play, GitHub, LinkedIn); nothing was proposed for them — each becomes a surface when an adapter can collect it",
    );
  });

  it("leaves X out of that list in both directions: it has a lane, so it is accounted for once", () => {
    const withX = proposal({ social: [social("X", "https://x.com/acmehq"), social("GitHub", "https://github.com/acme")] });
    // Proposed as a surface, or explained in its own note — either way, reporting it here
    // too would say "no collector reads it yet", which is false.
    expect(notMonitoredFacets(withX).items.map((i) => i.what)).toEqual(["GitHub"]);
    expect(notMonitoredFacets(withX).note).toContain("found 1 store/social profile no collector reads yet (GitHub)");
  });

  it("says nothing when the probe found nothing to report", () => {
    expect(notMonitoredFacets(proposal({}))).toEqual({ items: [], note: null });
  });
});

describe("the proposals it writes are configs the loader accepts", () => {
  // A proposal the engine's own loader would refuse is worse than no proposal: the
  // operator finds out at `onboard`, after they have edited it.
  it.each([
    ["hacker-news", "community"],
    ["x", "x"],
  ])("renders a valid %s community surface", (platform, lane) => {
    const plan = planCommunitySurfaces(
      proposal({ mentions: [found("hacker-news", 5)], social: [social("X", "https://x.com/acmehq")] }),
      "xurl",
    );
    const planned = plan.propose.find((p) => p.platform === platform)!;
    const yaml = renderCommunityYaml(proposal({}), planned, `acme-com-${platform}`, "acme-com", "acme-com-en", "acme.com");

    const surface = parseSurface(yaml, platform);
    expect(surface.kind).toBe("community");
    expect(surface.target).toMatchObject({ platform });
    expect(surface.observes).toBe("acme-com-en");
    expect(surface.brand).toBe("acme-com");
    expect(Object.keys(surface.lanes)).toEqual([lane]);
    expect(yaml).toContain("# proposed: Review every field");
  });
});
