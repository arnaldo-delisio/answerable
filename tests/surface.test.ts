// Surface config loader: one yaml schema per surface, validated against its kind's
// applicable adapters/classes/metrics. Enabling a non-applicable lane is a config error
// naming the lane and the kind, never a silent no-op; target shape must match kind;
// ai-engine-lane prompt_set is structured {version, prompts[]}.

import { describe, expect, it } from "vitest";
import { parseSurface, SurfaceConfigError } from "../src/engine/lib/surface";

const base = `
id: example-com-en
kind: web-locale
target:
  domain: www.example.com
  path_prefix: /
  locale: en
audience: Freelancers and the clients who hire them
business_goal: freelancer signups
desired_conversion: signup
competitors:
  - name: Initech Invoices
    url: https://initech.example
publishing:
  policy: review-required
  owner: operator
lanes:
  crawl: { enabled: true }
`;

const aiLane = `
id: example-geo-claude
kind: ai-engine-lane
target:
  engine: claude
  prompt_set:
    version: v1
    prompts: ["best invoicing tool", "is example.com legit"]
observes: example-com-en
audience: a
business_goal: b
desired_conversion: c
competitors: []
publishing: { policy: review-required, owner: operator }
lanes:
  geo-panel: { enabled: true }
`;

describe("parseSurface", () => {
  it("parses a valid web-locale surface with defaults", () => {
    const s = parseSurface(base);
    expect(s.id).toBe("example-com-en");
    expect(s.kind).toBe("web-locale");
    expect(s.target).toEqual({ domain: "www.example.com", path_prefix: "/", locale: "en" });
    expect(s.policy).toEqual({}); // empty = default class weights from the prioritization score
    expect(s.observes).toBeUndefined();
  });

  it("parses a valid ai-engine-lane surface incl. structured prompt_set", () => {
    const s = parseSurface(aiLane);
    expect(s.observes).toBe("example-com-en");
    expect((s.target as { prompt_set: { prompts: string[] } }).prompt_set.prompts).toHaveLength(2);
  });

  it("rejects a non-applicable lane, naming both the lane and the kind", () => {
    const text = base + "  geo-panel: { enabled: true }\n";
    expect(() => parseSurface(text)).toThrowError(SurfaceConfigError);
    expect(() => parseSurface(text)).toThrowError(/lane "geo-panel".*kind "web-locale"/);
  });

  it("rejects crawl on an ai-engine-lane surface (matrix, other direction)", () => {
    expect(() => parseSurface(aiLane.replace("geo-panel:", "crawl:"))).toThrowError(
      /lane "crawl".*kind "ai-engine-lane"/,
    );
  });

  it("observes is forbidden for web-locale and required for the other kinds", () => {
    expect(() => parseSurface(base + "observes: other\n")).toThrowError(/forbidden for kind web-locale/);
    expect(() => parseSurface(aiLane.replace("observes: example-com-en\n", ""))).toThrowError(
      /"observes".*required for kind ai-engine-lane/,
    );
  });

  it("rejects a target missing a required field for its kind", () => {
    expect(() => parseSurface(base.replace("  locale: en\n", ""))).toThrowError(/"locale"/);
  });

  it("rejects target fields outside the kind's shape", () => {
    expect(() => parseSurface(base.replace("  locale: en\n", "  locale: en\n  engine: claude\n"))).toThrowError(
      /fields not in the web-locale shape: engine/,
    );
  });

  it("rejects malformed prompt_set: missing version, empty prompts, non-string prompt", () => {
    expect(() => parseSurface(aiLane.replace("    version: v1\n", ""))).toThrowError(/prompt_set.*"version"/);
    expect(() => parseSurface(aiLane.replace('["best invoicing tool", "is example.com legit"]', "[]"))).toThrowError(
      /prompts must be a non-empty list/,
    );
    expect(() => parseSurface(aiLane.replace('["best invoicing tool", "is example.com legit"]', "[3]"))).toThrowError(
      /prompts must be a non-empty list/,
    );
    expect(() => parseSurface(aiLane.replace(/  prompt_set:[\s\S]*?is example.com legit"\]\n/, "  prompt_set: v1\n"))).toThrowError(
      /prompt_set must be a mapping/,
    );
  });

  it("rejects unknown kind and non-mapping documents", () => {
    expect(() => parseSurface(base.replace("kind: web-locale", "kind: podcast"))).toThrowError(
      /kind "podcast" is not one of/,
    );
    expect(() => parseSurface("- just\n- a list\n")).toThrowError(/not a yaml mapping/);
  });

  it("validates cadence, priors_from, and numeric policy weights", () => {
    expect(parseSurface(base + "cadence: weekly\n").cadence).toBe("weekly");
    expect(() => parseSurface(base + "cadence: hourly\n")).toThrowError(/daily \| weekly/);
    expect(parseSurface(base + "priors_from: example-guides-com\n").priors_from).toBe("example-guides-com");
    expect(() => parseSurface(base + "priors_from: 3\n")).toThrowError(/priors_from/);
    expect(parseSurface(base + "policy: { brand-defense: 2.0 }\n").policy).toEqual({ "brand-defense": 2.0 });
    expect(() => parseSurface(base + 'policy: { brand-defense: high }\n')).toThrowError(
      /policy\.brand-defense must be a number/,
    );
  });
});
