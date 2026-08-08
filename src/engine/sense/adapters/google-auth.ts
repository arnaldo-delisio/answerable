// Shared Google OAuth2 access-token helper for the gsc + analytics adapters.
// Two credential lanes: GOOGLE_APPLICATION_CREDENTIALS (service-account JSON on
// disk, JWT-bearer grant signed locally with node:crypto) or GSC_OAUTH_REFRESH_TOKEN
// + GSC_OAUTH_CLIENT_ID + GSC_OAUTH_CLIENT_SECRET (refresh grant). Returns an
// outcome instead of throwing: callers write honest failure rows.

import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";

// Injection seam: adapters accept a fetch implementation so recorded fixtures can
// stand in for the live API (no credentials exist on this box yet).
export type FetchLike = typeof fetch;

export const GOOGLE_ENV_VARS = [
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GSC_OAUTH_REFRESH_TOKEN",
  "GSC_OAUTH_CLIENT_ID",
  "GSC_OAUTH_CLIENT_SECRET",
];

export function googleCredentialsPresent(): boolean {
  return (
    !!process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    !!(
      process.env.GSC_OAUTH_REFRESH_TOKEN &&
      process.env.GSC_OAUTH_CLIENT_ID &&
      process.env.GSC_OAUTH_CLIENT_SECRET
    )
  );
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const TIMEOUT_MS = 15_000;

const b64url = (input: string): string => Buffer.from(input).toString("base64url");

export interface TokenOutcome {
  token: string | null;
  error: string | null;
}

export async function getGoogleAccessToken(
  scope: string,
  fetchImpl: FetchLike = fetch,
): Promise<TokenOutcome> {
  try {
    const saPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    let body: URLSearchParams;
    if (saPath) {
      const sa = JSON.parse(readFileSync(saPath, "utf8")) as {
        client_email: string;
        private_key: string;
      };
      const now = Math.floor(Date.now() / 1000);
      const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(
        JSON.stringify({ iss: sa.client_email, scope, aud: TOKEN_URL, iat: now, exp: now + 3600 }),
      )}`;
      const signature = createSign("RSA-SHA256").update(unsigned).sign(sa.private_key, "base64url");
      body = new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${signature}`,
      });
    } else {
      body = new URLSearchParams({
        grant_type: "refresh_token",
        client_id: process.env.GSC_OAUTH_CLIENT_ID ?? "",
        client_secret: process.env.GSC_OAUTH_CLIENT_SECRET ?? "",
        refresh_token: process.env.GSC_OAUTH_REFRESH_TOKEN ?? "",
      });
    }
    const res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = (await res.json()) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || typeof json.access_token !== "string") {
      return {
        token: null,
        error: `token endpoint ${res.status}: ${json.error ?? ""} ${json.error_description ?? ""}`.trim(),
      };
    }
    return { token: json.access_token, error: null };
  } catch (e) {
    return { token: null, error: e instanceof Error ? e.message : String(e) };
  }
}
