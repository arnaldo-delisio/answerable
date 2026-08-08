// Verify differ semantics (evidence identity, run-over-run diffing): equal check_keys
// compare across runs; a key present before and absent now is "missing" (reported,
// never silently dropped); a bumped check-version retires the old series with a
// retiredBy pointer to its successor; equal facts compare equal via normalized values.

import { describe, expect, it } from "vitest";
import { diffEvidence } from "../src/engine/verify/diff";
import type { CheckDiff } from "../src/engine/verify/diff";

type Row = Parameters<typeof diffEvidence>[3][number];

let n = 0;
function row(checkKey: string, status: string, value: Record<string, unknown> | null): Row {
  n += 1;
  return {
    id: `e${n}`,
    runId: "r",
    surfaceId: "s",
    checkKey,
    status,
    confidenceTag: "observed",
    value,
    provenance: {},
    cost: null,
  } as Row;
}

function byKind(diffs: CheckDiff[], kind: CheckDiff["kind"]): CheckDiff[] {
  return diffs.filter((d) => d.kind === kind);
}

describe("diffEvidence", () => {
  it("classifies added / changed / unchanged / missing / retired in one diff", () => {
    const prev = [
      row("crawl/ssr@v1/https://a/en", "pass", { chars: 1200 }),
      row("crawl/hreflang@v1/https://a/en", "present", { count: 5 }),
      row("crawl/sitemap@v1/https://a/sitemap.xml", "pass", { urls: 10 }),
      row("crawl/json-ld@v1/https://a/en", "absent", null),
    ];
    const curr = [
      row("crawl/ssr@v1/https://a/en", "pass", { chars: 1200 }), // unchanged
      row("crawl/hreflang@v1/https://a/en", "present", { count: 4 }), // changed (value)
      row("crawl/sitemap@v2/https://a/sitemap.xml", "pass", { urls: 10 }), // retires v1
      row("crawl/canonical@v1/https://a/en", "present", null), // added
      // json-ld absent now entirely -> missing
    ];
    const d = diffEvidence("s", "p", "c", prev, curr).diffs;
    expect(byKind(d, "unchanged").map((x) => x.checkKey)).toEqual(["crawl/ssr@v1/https://a/en"]);
    expect(byKind(d, "changed").map((x) => x.checkKey)).toEqual(["crawl/hreflang@v1/https://a/en"]);
    expect(byKind(d, "added").map((x) => x.checkKey)).toEqual([
      "crawl/canonical@v1/https://a/en",
      "crawl/sitemap@v2/https://a/sitemap.xml",
    ]);
    expect(byKind(d, "missing").map((x) => x.checkKey)).toEqual(["crawl/json-ld@v1/https://a/en"]);
    expect(byKind(d, "retired").map((x) => x.checkKey)).toEqual(["crawl/sitemap@v1/https://a/sitemap.xml"]);
  });

  it("retired carries retiredBy = the successor version's full key", () => {
    const prev = [row("crawl/sitemap@v1/https://a/sitemap.xml", "pass", { urls: 10 })];
    const curr = [row("crawl/sitemap@v2/https://a/sitemap.xml", "pass", { urls: 12 })];
    const d = diffEvidence("s", "p", "c", prev, curr).diffs;
    expect(d).toHaveLength(2);
    const retired = byKind(d, "retired")[0];
    expect(retired.retiredBy).toBe("crawl/sitemap@v2/https://a/sitemap.xml");
    expect(retired.before).toEqual({ status: "pass", value: { urls: 10 } });
  });

  it("a version bump on a different subject does NOT retire: it is a missing collection", () => {
    const prev = [row("crawl/ssr@v1/https://a/en", "pass", null)];
    const curr = [row("crawl/ssr@v2/https://a/fr", "pass", null)];
    const d = diffEvidence("s", "p", "c", prev, curr).diffs;
    expect(byKind(d, "missing").map((x) => x.checkKey)).toEqual(["crawl/ssr@v1/https://a/en"]);
    expect(byKind(d, "retired")).toHaveLength(0);
  });

  it("status change alone marks changed, with before and after populated", () => {
    const prev = [row("crawl/bot-access@v1/GPTBot", "pass", { code: 200 })];
    const curr = [row("crawl/bot-access@v1/GPTBot", "blocked", { code: 200 })];
    const [d] = diffEvidence("s", "p", "c", prev, curr).diffs;
    expect(d.kind).toBe("changed");
    expect(d.before?.status).toBe("pass");
    expect(d.after?.status).toBe("blocked");
  });

  it("equal facts compare equal regardless of object key order (normalized values)", () => {
    const prev = [row("crawl/json-ld@v1/https://a/en", "present", { a: 1, b: { x: 1, y: 2 } })];
    const curr = [row("crawl/json-ld@v1/https://a/en", "present", { b: { y: 2, x: 1 }, a: 1 })];
    expect(diffEvidence("s", "p", "c", prev, curr).diffs[0].kind).toBe("unchanged");
  });

  // Regression (production bug): eight geo-panel pass→pass rows differed only in
  // response_chars (answer length noise) and entities_cited order, so every row
  // rendered under "changed" while the summary said "0 results unchanged".
  // Volatile measurement fields and citation order are not facts.
  it("pass→pass rows differing only in response_chars / citation order are unchanged", () => {
    const prev = [
      row("geo-panel/prompt@v1/is-example-com-legit", "pass", {
        engine: "chatgpt",
        prompt: "Is example.com legit?",
        response_chars: 1613,
        entities_cited: ["Northwind Books", "Contoso Pay"],
        owned_hit: true,
      }),
    ];
    const curr = [
      row("geo-panel/prompt@v1/is-example-com-legit", "pass", {
        engine: "chatgpt",
        prompt: "Is example.com legit?",
        response_chars: 1508,
        entities_cited: ["Contoso Pay", "Northwind Books"],
        owned_hit: true,
      }),
    ];
    expect(diffEvidence("s", "p", "c", prev, curr).diffs[0].kind).toBe("unchanged");
  });

  it("a genuinely new cited entity or a flipped owned_hit still reads changed", () => {
    const base = {
      engine: "chatgpt",
      prompt: "Best invoicing tool?",
      response_chars: 100,
    };
    const prev = [
      row("geo-panel/prompt@v1/best-invoicing-tool", "pass", { ...base, entities_cited: ["Northwind Books"], owned_hit: false }),
    ];
    const newEntity = [
      row("geo-panel/prompt@v1/best-invoicing-tool", "pass", {
        ...base,
        entities_cited: ["Northwind Books", "Initech Invoices"],
        owned_hit: false,
      }),
    ];
    expect(diffEvidence("s", "p", "c", prev, newEntity).diffs[0].kind).toBe("changed");
    const flipped = [
      row("geo-panel/prompt@v1/best-invoicing-tool", "pass", { ...base, entities_cited: ["Northwind Books"], owned_hit: true }),
    ];
    expect(diffEvidence("s", "p", "c", prev, flipped).diffs[0].kind).toBe("changed");
  });

  it("missing is reported even when the key is malformed (never a silent drop)", () => {
    const prev = [row("not-a-parseable-key", "pass", null)];
    const d = diffEvidence("s", "p", "c", prev, []).diffs;
    expect(d).toEqual([
      expect.objectContaining({ checkKey: "not-a-parseable-key", kind: "missing" }),
    ]);
  });
});
