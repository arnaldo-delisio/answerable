// Brand identity as data: what text identifies a brand used to
// be hard-coded in the matchers in src/. These tests prove the move to the brands row
// preserved the behavior EXACTLY, that negative terms veto a false match, that an
// ambiguous bare token is matched only when the operator explicitly listed it as an
// alias, and that a different brand matches on its own names — the hard-coding is gone.

import { describe, expect, it } from "vitest";
import { parseSurface, type Surface } from "../src/engine/lib/surface";
import {
  identityFromDomain,
  identityFromRow,
  normalizeTerms,
  seedAliases,
  hasNegativeContext,
} from "../src/engine/lib/brand-identity";
import { deriveQueries, dropNegativeHits, type TopHit } from "../src/engine/sense/adapters/community";
import { extractEntities } from "../src/engine/sense/adapters/geo-panel";

// A brand whose bare token is an ordinary English word — the hard case the
// precision rules exist for.
const EXAMPLE_ROW = {
  id: "example",
  name: "Example",
  primaryDomain: "www.example.com",
  aliases: ["example.com", "example com"],
  negativeTerms: ["for example", "example.org"],
};
const example = identityFromRow(EXAMPLE_ROW)!;

const webYaml = (domain: string) => `
id: ${domain.replace(/[^a-z0-9]/g, "-")}-en
kind: site
target:
  domain: ${domain}
  path_prefix: /
  locale: en
audience: Freelancers and the clients who hire them
business_goal: signups
desired_conversion: signup
competitors: []
publishing:
  policy: review-required
  owner: operator
lanes:
  community: { enabled: true }
`;

const laneYaml = (observes: string) => `
id: ${observes}-geo
kind: assistant
target:
  engine: chatgpt
  prompt_set:
    version: discovery-v1
    prompts: ["what is the best invoicing tool?"]
observes: ${observes}
audience: Freelancers asking answer engines which tool to use
business_goal: share of answer
desired_conversion: signup
competitors: []
publishing:
  policy: review-required
  owner: operator
lanes:
  geo-panel:
    enabled: true
`;

const exampleSurface: Surface = parseSurface(webYaml("www.example.com"));
const exampleLane: Surface = parseSurface(laneYaml("www-example-com-en"));

describe("identityFromRow", () => {
  it("carries the stored aliases and nothing derived beside them", () => {
    expect(example.aliases).toEqual(["example.com", "example com"]);
    expect(example.url).toBe("https://www.example.com");
  });
  it("is null without aliases: no profile means no guessing", () => {
    expect(identityFromRow({ ...EXAMPLE_ROW, aliases: null })).toBeNull();
    expect(identityFromRow({ ...EXAMPLE_ROW, aliases: [] })).toBeNull();
    expect(identityFromRow(null)).toBeNull();
  });
  it("matches the bare token only when the operator listed it as an alias", () => {
    // No inference in either direction: negative terms do not enable it, and their
    // absence does not disable it. The alias list is the whole answer.
    expect(example.aliases).not.toContain("example");
    const opted = identityFromRow({ ...EXAMPLE_ROW, aliases: ["example.com", "Example"] })!;
    expect(opted.aliases).toEqual(["example.com", "Example"]);
  });
  it("normalizes stored junk (trim, empty, dupes, over-long)", () => {
    expect(normalizeTerms([" a ", "A", "", 7, "b", "x".repeat(200)])).toEqual(["a", "b"]);
    expect(normalizeTerms("nope")).toEqual([]);
  });
});

// A domain-derived identity is the fallback for an install with no brand row yet.
// It must never fabricate a mention: its bare token is an ordinary English word in
// the shipped sample domain itself, and it carries no negative terms to veto one.
describe("identityFromDomain: derived identities never match a bare token", () => {
  const derived = identityFromDomain("derived:x", "www.example.com")!;

  it("keeps the explicit domain aliases and nothing else", () => {
    expect(derived.aliases).toEqual(["example.com", "example com"]);
    expect(derived.negativeTerms).toEqual([]);
  });

  // The false positive this exists to prevent: ordinary category prose using the
  // registrable label as an English word, on a lane whose context words all appear.
  it("reads no owned hit from a generic label in ordinary category prose", () => {
    const r = extractEntities(
      "For example, invoicing software can chase late invoices for freelancers automatically.",
      exampleLane,
      derived,
    );
    expect(r.ownedHit).toBe(false);
    expect(r.entities).toEqual([]);
  });

  // The accepted tradeoff, asserted so nobody "fixes" it back: a derived identity
  // MISSES a genuine mention that never names the domain. Under-claiming is the
  // correct failure direction — a missed hit understates, a false hit fabricates.
  it("accepts the miss: 'Example is great' without the domain is not a hit", () => {
    expect(extractEntities("Example is a great invoicing tool.", exampleLane, derived).ownedHit).toBe(
      false,
    );
    // Naming the domain still lands, which is the whole point of the fallback.
    expect(extractEntities("example.com is a great invoicing tool.", exampleLane, derived).ownedHit).toBe(
      true,
    );
  });

  // A STORED identity follows the SAME rule: having negative terms is not consent to
  // match the bare label. EXAMPLE_ROW carries two negative terms and still does not.
  it("holds a stored identity to the same rule", () => {
    expect(extractEntities("Example is an invoicing tool.", exampleLane, example).ownedHit).toBe(false);
  });
});

describe("seedAliases from the probe", () => {
  it("seeds the domain forms, and nothing the probe did not observe", () => {
    expect(seedAliases({ name: "Example", primaryDomain: "www.example.com" })).toEqual([
      "example.com",
      "example com",
    ]);
  });
  it("keeps a brand name that is more than the domain's bare token, plus observed siblings", () => {
    expect(seedAliases({ name: "Acme Labs", primaryDomain: "acme.example" }, ["www.acme.example"])).toEqual([
      "acme.example",
      "acme example",
      "Acme Labs",
    ]);
  });
});

describe("deriveQueries: the seeded profile reproduces the domain-only derivation", () => {
  // The regression proof. The hard-coded derivation produced exactly these three
  // queries from the domain alone; feeding the seeded aliases in must not add,
  // remove, or reorder a single one.
  const expected = [
    { query: "example.com", kind: "brand" },
    { query: '"example com"', kind: "brand" },
    { query: "example", kind: "brand-ambiguous" },
  ];
  it("matches the domain-only derivation", () => {
    expect(deriveQueries(exampleSurface, example)).toEqual(expected);
    expect(deriveQueries(exampleSurface, example)).toEqual(deriveQueries(exampleSurface));
  });
  it("adds a second brand's own aliases as brand queries", () => {
    const acme = identityFromRow({
      id: "acme",
      name: "Acme Labs",
      primaryDomain: "acme.example",
      aliases: ["acme.example", "Acme Labs", "acmelabs"],
      negativeTerms: [],
    })!;
    const qs = deriveQueries(parseSurface(webYaml("acme.example")), acme);
    expect(qs).toEqual([
      { query: "acme.example", kind: "brand" },
      { query: '"acme example"', kind: "brand" },
      { query: "acme", kind: "brand-ambiguous" },
      { query: "Acme Labs", kind: "brand" },
      { query: "acmelabs", kind: "brand" },
    ]);
  });
});

describe("extractEntities: owned-hit behavior", () => {
  it("counts an unambiguous alias", () => {
    const r = extractEntities("Check out example.com for freelance invoicing.", exampleLane, example);
    expect(r.ownedHit).toBe(true);
    expect(r.entities).toEqual([{ entity: "Example", url: "https://www.example.com", rank: 1 }]);
  });
  it("counts the bare token only when the operator opted in by listing it", () => {
    expect(extractEntities("Take a house, an apple, a bicycle.", exampleLane, example).ownedHit).toBe(false);
    // Not listed: no hit, however much category language surrounds it.
    expect(extractEntities("Example is an invoicing tool.", exampleLane, example).ownedHit).toBe(false);
    // Listed: an ordinary alias, matched like any other.
    const opted = identityFromRow({ ...EXAMPLE_ROW, aliases: ["example.com", "Example"] })!;
    expect(extractEntities("Example is an invoicing tool.", exampleLane, opted).ownedHit).toBe(true);
    // And the operator's negative terms still veto the false one.
    expect(extractEntities("For example, an invoicing tool.", exampleLane, opted).ownedHit).toBe(false);
  });
  it("rejects a match sitting in a negative context", () => {
    const r = extractEntities(
      "For example, a tool could do this; the example.com invoicing product is unrelated.",
      exampleLane,
      example,
    );
    expect(r.ownedHit).toBe(false);
    expect(r.entities).toEqual([]);
    expect(hasNegativeContext("see example.org for the spec", example)).toBe(true);
  });
  it("matches a second brand on ITS aliases, never on another brand's", () => {
    const acme = identityFromRow({
      id: "acme",
      name: "Acme Labs",
      primaryDomain: "acme.example",
      aliases: ["acme.example"],
      negativeTerms: ["acme corp"],
    })!;
    const s = parseSurface(laneYaml("acme-example"));
    expect(extractEntities("acme.example ships fast", s, acme).ownedHit).toBe(true);
    expect(extractEntities("example.com ships fast", s, acme).ownedHit).toBe(false);
    expect(extractEntities("acme.example, not Acme Corp", s, acme).ownedHit).toBe(false);
  });
  // Without a profile the engine never looked, so the honest answer is null
  // (ungrounded), NOT false. `false` would assert the answer did not name the
  // brand — here it plainly does — and that fabricated zero is what the ungrounded
  // state exists to prevent.
  it("reports ungrounded (null), never false, without a profile", () => {
    const r = extractEntities("example.com is an invoicing tool", exampleLane, null);
    expect(r.ownedHit).toBeNull();
    expect(r.entities).toEqual([]);
  });
});

describe("dropNegativeHits", () => {
  const hit = (title: string): TopHit => ({ title, url: "https://x", score: 0, created: "" });
  it("drops hits whose text carries a negative term, keeps the rest", () => {
    const { kept, excluded } = dropNegativeHits(
      [hit("example.com launches"), hit("For example, a benchmark"), hit("A counterexample worth reading")],
      example,
    );
    expect(kept.map((h) => h.title)).toEqual(["example.com launches", "A counterexample worth reading"]);
    expect(excluded).toBe(1);
  });
  it("is a no-op without an identity or without negative terms", () => {
    const hits = [hit("For example, a benchmark")];
    expect(dropNegativeHits(hits, null)).toEqual({ kept: hits, excluded: 0 });
    expect(dropNegativeHits(hits, identityFromRow({ ...EXAMPLE_ROW, negativeTerms: [] })!)).toEqual({
      kept: hits,
      excluded: 0,
    });
  });
});
