// SSRF-guarded fetch for the draft prober: every URL the draft path fetches
// (seed domain, robots Sitemap pointer, sitemap <loc> URLs) comes from or via
// user/remote input, so before each request the hostname is resolved and
// private/loopback/link-local/CGNAT/metadata addresses are rejected, only
// http(s) on standard ports is allowed, and redirects are followed manually
// (max 3 hops) with the same validation per hop.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { politeFetch, type FetchOutcome } from "../sense/adapters/crawl";

const MAX_REDIRECT_HOPS = 3;

function ipv4ToInt(ip: string): number {
  const [a, b, c, d] = ip.split(".").map(Number);
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

const BLOCKED_V4: [string, number][] = [
  ["0.0.0.0", 8], // "this network"
  ["127.0.0.0", 8], // loopback
  ["10.0.0.0", 8], // private
  ["172.16.0.0", 12], // private
  ["192.168.0.0", 16], // private
  ["169.254.0.0", 16], // link-local / cloud metadata
  ["100.64.0.0", 10], // CGNAT
];

function isBlockedIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return BLOCKED_V4.some(([base, bits]) => n >>> (32 - bits) === ipv4ToInt(base) >>> (32 - bits));
}

function isBlockedIp(addr: string): boolean {
  const ip = addr.toLowerCase();
  if (isIP(ip) === 4) return isBlockedIpv4(ip);
  // IPv4-mapped IPv6 (::ffff:a.b.c.d)
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) return isBlockedIpv4(mapped[1]);
  if (ip === "::1" || ip === "::") return true; // loopback / unspecified
  const first = parseInt(ip.split(":")[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  return false;
}

// Returns null when the URL is safe to fetch, or a human-readable rejection.
export async function ssrfReject(rawUrl: string): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return `unparseable URL: ${rawUrl}`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `blocked non-http(s) scheme "${url.protocol}"`;
  }
  if (url.port !== "" && url.port !== "80" && url.port !== "443") {
    return `blocked non-standard port ${url.port}`;
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
    } catch {
      return `hostname does not resolve: ${host}`;
    }
  }
  if (addresses.length === 0) return `hostname does not resolve: ${host}`;
  for (const addr of addresses) {
    if (isBlockedIp(addr)) return `blocked private/internal address ${addr} for host ${host}`;
  }
  return null;
}

// politeFetch with SSRF validation before every request, redirects followed
// manually with per-hop validation. Same never-throws FetchOutcome contract.
export async function safeFetch(
  rawUrl: string,
  opts: { method?: string; userAgent?: string; headers?: Record<string, string> } = {},
): Promise<FetchOutcome> {
  let url = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    const rejection = await ssrfReject(url);
    if (rejection) return { ok: false, status: null, body: null, error: rejection, fetchedAt: Date.now() };
    const res = await politeFetch(url, { ...opts, redirect: "manual" });
    if (res.status !== null && res.status >= 300 && res.status < 400 && res.location) {
      url = new URL(res.location, url).toString();
      continue;
    }
    return res;
  }
  return { ok: false, status: null, body: null, error: `too many redirects (>${MAX_REDIRECT_HOPS}) from ${rawUrl}`, fetchedAt: Date.now() };
}
