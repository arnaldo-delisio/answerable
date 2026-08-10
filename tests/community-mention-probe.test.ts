// The keyless mention probe behind `brand add`'s community gate. What is load-bearing is
// not the happy path but the difference between the three answers a platform can give:
// mentions exist, none exist, and "I could not tell you" — the last of which must never
// be read as either of the first two, and must never take the command down with it.

import { describe, expect, it } from "vitest";
import { probeMentions } from "../src/engine/sense/adapters/community";

const PROBE_MS = 30_000; // the probe sleeps a polite 2s before each request

// One stubbed reply for the single request the probe makes, at the same seam the
// adapter suites stub (globalThis.fetch). `reply` may also throw, which is how a
// transport-level failure reaches the probe.
async function withFetch<T>(reply: () => Response, fn: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => reply()) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("the mention probe reads what the lane would read", () => {
  it(
    "reports reddit mentions as found, with the platform's own count",
    async () => {
      const probe = await withFetch(
        () => json({ data: { dist: 12, children: [{ data: { title: "acme is fine" } }] } }),
        () => probeMentions("reddit", "acme.com"),
      );
      expect(probe).toEqual({ platform: "reddit", query: "acme.com", hitCount: 12, checked: true, reason: null });
    },
    PROBE_MS,
  );

  it(
    "reports an empty hacker news result as CHECKED and zero, never as unchecked",
    async () => {
      const probe = await withFetch(
        () => json({ nbHits: 0, hits: [] }),
        () => probeMentions("hacker-news", "acme.com"),
      );
      // The distinction the note depends on: this is a fact about the brand
      // ("nobody is discussing it there"), not a fact about the probe.
      expect(probe.checked).toBe(true);
      expect(probe.hitCount).toBe(0);
      expect(probe.reason).toBeNull();
    },
    PROBE_MS,
  );

  it(
    "degrades to unchecked on an http error, and says which one",
    async () => {
      // Reddit's public search refuses some datacenter IPs with a 403; that is the
      // real-world shape of this case and it is not a zero.
      const probe = await withFetch(
        () => json({ message: "Forbidden" }, 403),
        () => probeMentions("reddit", "acme.com"),
      );
      expect(probe.checked).toBe(false);
      expect(probe.hitCount).toBe(0);
      expect(probe.reason).toBe("http 403");
    },
    PROBE_MS,
  );

  it(
    "names a rate limit as one rather than reporting a bare status",
    async () => {
      const probe = await withFetch(
        () => json({}, 429),
        () => probeMentions("hacker-news", "acme.com"),
      );
      expect(probe.checked).toBe(false);
      expect(probe.reason).toBe("http 429 (rate-limited)");
    },
    PROBE_MS,
  );

  it(
    "degrades rather than throws when the platform is down",
    async () => {
      // The whole point of the never-throws contract: `brand add` must not fail because
      // Reddit was unreachable.
      const probe = await withFetch(
        () => {
          throw new Error("getaddrinfo ENOTFOUND www.reddit.com");
        },
        () => probeMentions("reddit", "acme.com"),
      );
      expect(probe.checked).toBe(false);
      expect(probe.reason).toContain("ENOTFOUND");
    },
    PROBE_MS,
  );

  // A 200 is not an answer. Every case below is a successful HTTP response carrying
  // something that is not a search listing — a proxy page, an error payload, a changed
  // API — and permissive extraction would report each as a confident zero. "Nobody
  // mentions this brand" is then a number nobody measured.
  it.each([
    ["an error payload with a 200 status", { message: "temporarily unavailable" }],
    ["an empty object", {}],
    ["a listing whose results array is missing", { data: { dist: 10 } }],
    ["a listing whose own count is missing", { data: { children: [] } }],
    ["a listing whose own count is not a number", { data: { dist: "many", children: [] } }],
    ["a null body", null],
    // Self-contradicting: a total of zero handed back beside results. Neither platform
    // can produce this, so it is not the platform answering — and it is the shape a
    // shape-check alone would wave through as a confident zero.
    ["zero results beside a page that has some", { data: { dist: 0, children: [{ data: { title: "acme is fine" } }] } }],
  ])("refuses to call reddit checked when it returned %s", async (_label, body) => {
    const probe = await withFetch(
      () => json(body),
      () => probeMentions("reddit", "acme.com"),
    );
    expect(probe.checked).toBe(false);
    expect(probe.hitCount).toBe(0);
    expect(probe.reason).toBe("responded 200 with a body that is not a reddit search listing");
  }, PROBE_MS);

  it.each([
    ["an error payload with a 200 status", { message: "index unavailable" }],
    ["an empty object", {}],
    ["a result set whose hits array is missing", { nbHits: 3 }],
    ["a result set whose own count is missing", { hits: [] }],
    ["a result set whose own count is not a number", { nbHits: null, hits: [] }],
    ["zero results beside a page that has some", { nbHits: 0, hits: [{ title: "acme is fine" }] }],
  ])("refuses to call hacker news checked when it returned %s", async (_label, body) => {
    const probe = await withFetch(
      () => json(body),
      () => probeMentions("hacker-news", "acme.com"),
    );
    expect(probe.checked).toBe(false);
    expect(probe.reason).toBe("responded 200 with a body that is not an algolia result set");
  }, PROBE_MS);

  it(
    "still calls a well-formed empty listing a real checked zero",
    async () => {
      // The distinction the guard above must not swallow: a platform that answered
      // properly and said "none" is a measurement, and it stays one.
      const reddit = await withFetch(
        () => json({ data: { dist: 0, children: [] } }),
        () => probeMentions("reddit", "acme.com"),
      );
      expect(reddit).toEqual({ platform: "reddit", query: "acme.com", hitCount: 0, checked: true, reason: null });
    },
    PROBE_MS,
  );

  it(
    "still calls a large total beside a short page a real measurement",
    async () => {
      // The other thing the contradiction rule must not swallow. HN's nbHits totals every
      // page and Reddit hands back one page, so a big count next to a handful of results
      // is the NORMAL shape — requiring the two to agree would fail every real response.
      const hn = await withFetch(
        () => json({ nbHits: 1106, hits: [{ title: "Show HN: htmx" }, { title: "htmx 2.0" }] }),
        () => probeMentions("hacker-news", "acme.com"),
      );
      expect(hn.checked).toBe(true);
      expect(hn.hitCount).toBe(1106);
    },
    PROBE_MS,
  );

  it(
    "asks each platform its own endpoint, and asks about the brand as a phrase",
    async () => {
      const asked: string[] = [];
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (input: string) => {
        asked.push(String(input));
        return json({ data: { dist: 0, children: [] }, nbHits: 0, hits: [] });
      }) as unknown as typeof fetch;
      try {
        await probeMentions("reddit", "acme.com");
        await probeMentions("hacker-news", "acme.com");
      } finally {
        globalThis.fetch = realFetch;
      }
      expect(asked[0]).toContain("https://www.reddit.com/search.json?q=acme.com");
      expect(asked[0]).toContain("t=month"); // the lane's own recency window
      expect(asked[1]).toContain("https://hn.algolia.com/api/v1/search?query=");
      expect(asked[1]).toContain(encodeURIComponent('"acme.com"'));
    },
    PROBE_MS,
  );
});
