// The fix-spec kinds, in their own module so the CLI can name them in `usage` and
// validate `spec <surface-id> <kind>` without importing the generator (and with it the
// database) at startup. One home for the list; fix-spec.ts re-exports it.

export const FIX_SPEC_KINDS = ["hreflang", "site-basics", "bot-block", "ssr"] as const;
export type FixSpecKind = (typeof FIX_SPEC_KINDS)[number];
