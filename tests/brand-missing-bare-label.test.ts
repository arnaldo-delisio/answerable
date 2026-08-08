// A brand seeded from its domain starts with "htmx.org" and "htmx org" and nothing else,
// because the bare label is an ordinary word the engine never seeds on the operator's
// behalf. Real answers say "htmx". So the first run reports owned_hit false on every
// prompt and share of answer 0, with the brand row present and the engine believing it
// looked — true rows, and unreadable without the reason.
//
// Nothing here changes matching or the metric. What is asserted is that the engine SAYS
// what is missing: the bare label is absent from the aliases (the one decidable question),
// the run's single note, and doctor's line. The note never characterizes the aliases; it
// lists them, so what it prints is true whatever the operator has typed.

import "./helpers/testdb";
import { describe, expect, it } from "vitest";
import { db, schema } from "../src/db";
import { identityFromRow, missingBareLabel, seedAliases } from "../src/engine/lib/brand-identity";
import { coverageNote, type PanelObservationRow } from "../src/engine/sense/adapters/geo-panel";
import { doctor, renderDoctor } from "../src/engine/lib/doctor";

const identity = (aliases: string[], domain = "htmx.org", id = "htmx-org", name = "Htmx") =>
  identityFromRow({ id, name, primaryDomain: domain, aliases });

const observation = (promptId: string, ownedHit: boolean | null): PanelObservationRow => ({
  id: `obs-${promptId}`,
  runId: "run-1",
  surfaceId: "htmx-org-geo-chatgpt",
  promptSetVersion: "v1",
  promptId,
  engine: "chatgpt",
  responseDigest: "...",
  entitiesCited: [],
  ownedHit,
});

describe("missingBareLabel", () => {
  it("names the label the aliases `brand add` seeds are missing", () => {
    const aliases = seedAliases({ name: "Htmx", primaryDomain: "htmx.org" });
    expect(aliases).toEqual(["htmx.org", "htmx org"]);
    expect(missingBareLabel(identity(aliases))).toBe("htmx");
  });

  it("is empty once an alias carries the label, whatever its case", () => {
    expect(missingBareLabel(identity(["htmx.org", "htmx org", "htmx"]))).toBe("");
    expect(missingBareLabel(identity(["htmx.org", "htmx org", "Htmx"]))).toBe("");
  });

  it("reads the brand's own domain, not whichever alias looks like a host", () => {
    // The label comes from primary_domain. An alias for a sibling host does not move it.
    expect(missingBareLabel(identity(["acme.io", "acme io"], "acme.com"))).toBe("acme");
  });

  it("still names the label when a display name spells the domain", () => {
    // "Acme Corp" on acme.corp: text cannot tell this from a spoken domain, and it does
    // not have to — the bare label "acme" is absent either way, so the warning is right.
    expect(missingBareLabel(identity(["acme.corp", "Acme Corp"], "acme.corp", "acme-corp", "Acme Corp"))).toBe("acme");
    expect(missingBareLabel(identity(["acme.corp", "Acme Corp", "Acme"], "acme.corp", "acme-corp", "Acme Corp"))).toBe("");
  });

  it("does not depend on the brand's display name", () => {
    // The round where the name was consulted made a brand named "Htmx Org" go quiet while
    // it was genuinely missing "htmx". The name is not part of this question.
    expect(missingBareLabel(identity(["htmx.org", "htmx org"], "htmx.org", "htmx-org", "Htmx Org"))).toBe("htmx");
  });

  it("is empty without an identity, or when no label can be derived", () => {
    expect(missingBareLabel(null)).toBe("");
    expect(missingBareLabel(identity([]))).toBe(""); // no aliases = no identity at all
  });
});

describe("coverageNote", () => {
  const missing = identity(["htmx.org", "htmx org"]);
  const present = identity(["htmx.org", "htmx org", "htmx"]);
  const zeroHits = [observation("what-is-htmx", false), observation("best-hypermedia-lib", false)];

  it("fires once when every answer missed and the bare label is absent", () => {
    expect(coverageNote(missing, zeroHits)).toBe(
      "0 of 2 answers matched this brand. Its aliases are: htmx.org, htmx org. " +
        'If people say "htmx", add it: answerable brand alias htmx-org htmx',
    );
  });

  it("stays quiet when at least one answer matched", () => {
    expect(coverageNote(missing, [observation("a", true), observation("b", false)])).toBeNull();
  });

  it("stays quiet when an alias already carries the label", () => {
    expect(coverageNote(present, zeroHits)).toBeNull();
  });

  it("stays quiet when an observation was never searched (ungrounded, not a miss)", () => {
    // "0 of N answers matched" may only count answers the engine actually looked at.
    expect(coverageNote(missing, [observation("a", null), observation("b", null)])).toBeNull();
    expect(coverageNote(missing, [observation("a", false), observation("b", null)])).toBeNull();
  });

  it("stays quiet without an identity, or with nothing collected", () => {
    expect(coverageNote(null, zeroHits)).toBeNull();
    expect(coverageNote(missing, [])).toBeNull();
  });
});

describe("doctor", () => {
  it("names the brand missing its plain name and the command that fixes it", () => {
    db.insert(schema.brands)
      .values({
        id: "htmx-org",
        name: "Htmx",
        primaryDomain: "htmx.org",
        createdAt: 1,
        aliases: ["htmx.org", "htmx org"],
        negativeTerms: [],
      })
      .run();
    db.insert(schema.brands)
      .values({
        id: "acme-com",
        name: "Acme",
        primaryDomain: "acme.com",
        createdAt: 1,
        aliases: ["acme.com", "acme com", "Acme"],
        negativeTerms: [],
      })
      .run();

    const report = doctor();
    expect(report.brandsMissingBareLabel).toEqual([
      { brandId: "htmx-org", aliases: ["htmx.org", "htmx org"], label: "htmx" },
    ]);
    expect(renderDoctor(report)).toContain(
      'htmx-org: aliases htmx.org, htmx org; if people say "htmx": answerable brand alias htmx-org htmx',
    );
    expect(renderDoctor(report)).not.toContain("acme-com:");
  });
});
