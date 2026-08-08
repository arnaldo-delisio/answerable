// Evidence identity: check_key = adapter / check-name @ check-version / subject,
// unique per (surface_id, run_id, check_key). Parse/compose must round-trip so the
// differ's series matching never drifts from the composed keys adapters write.

import { describe, expect, it } from "vitest";
import { composeCheckKey, parseCheckKey } from "../src/engine/verify/diff";

describe("check_key parse/compose", () => {
  it("parses the canonical shape into series, version, subject", () => {
    expect(parseCheckKey("crawl/hreflang@v1/https://www.example.com/en")).toEqual({
      series: "crawl/hreflang",
      version: "v1",
      subject: "https://www.example.com/en",
    });
  });

  it("keeps slashes inside the subject (URLs are subjects)", () => {
    const p = parseCheckKey("crawl/ssr@v2/https://www.example.com/en/blog/some-post");
    expect(p?.subject).toBe("https://www.example.com/en/blog/some-post");
    expect(p?.version).toBe("v2");
  });

  it("allows @ inside the subject (only the first @ splits series from version)", () => {
    const p = parseCheckKey("x/recent-mentions@v1/@examplehq");
    expect(p).toEqual({ series: "x/recent-mentions", version: "v1", subject: "@examplehq" });
  });

  it("returns null for keys without the @version/subject shape", () => {
    expect(parseCheckKey("no-version-here")).toBeNull();
    expect(parseCheckKey("adapter/check@v1")).toBeNull(); // no subject
  });

  it("compose(parse(key)) is the identity on real adapter keys", () => {
    const keys = [
      "crawl/robots-bot-rules@v1/GPTBot",
      "crawl/sitemap@v1/https://www.example.com/sitemap.xml",
      "geo-panel/prompt@v1/p-07",
      "community/reddit-mentions@v1/freelance-rate-calculator",
      "x/recent-mentions@v1/@examplehq",
      "sense/lane-status@v1/dataforseo",
    ];
    for (const k of keys) {
      const parsed = parseCheckKey(k);
      expect(parsed).not.toBeNull();
      expect(composeCheckKey(parsed!)).toBe(k);
    }
  });

  it("parse(compose(parts)) recovers the parts", () => {
    const parts = { series: "crawl/hreflang", version: "v3", subject: "https://a/b/c@d" };
    expect(parseCheckKey(composeCheckKey(parts))).toEqual(parts);
  });
});
