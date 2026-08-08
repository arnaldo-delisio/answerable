// Doctor: honest health report. Env credentials present/absent per adapter, required
// CLIs found, db reachable + row counts, last run per surface, and what each missing key
// unlocks, read from the key-pending evidence rows' own text (never restated here).
// Reporting only: doctor never throws and never mutates anything.

import { execFileSync } from "node:child_process";
import { db, schema } from "../../db";
import { identityFromRow, missingBareLabel } from "./brand-identity";

// Adapter -> env vars that unlock it (adapters' own ENV_VAR declarations; the google
// service-account path OR the oauth triple satisfies gsc/analytics).
const ADAPTER_ENV: Record<string, string[]> = {
  crawl: [],
  community: [],
  "geo-panel": [], // CLI-backed (claude/codex); no key
  competitor: [],
  x: ["X_BEARER_TOKEN"],
  performance: ["PAGESPEED_API_KEY"],
  dataforseo: ["DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD"],
  gsc: ["GOOGLE_APPLICATION_CREDENTIALS", "GSC_OAUTH_CLIENT_ID", "GSC_OAUTH_CLIENT_SECRET", "GSC_OAUTH_REFRESH_TOKEN"],
  analytics: ["GA4_PROPERTY_ID", "GOOGLE_APPLICATION_CREDENTIALS"],
  bing: ["BING_WEBMASTER_KEY"],
};

// Adapters whose credential is a LADDER, not a single env var: the env key first, then
// an already-authenticated CLI on PATH. Reporting only the env var made doctor say
// "X_BEARER_TOKEN absent" for a lane that then ran for real through `xurl` and billed a
// real account. Doctor's job is to say what WILL run, so the CLI rung is checked too.
// (Mirrors the ladder in src/engine/sense/adapters/x.ts.)
const ADAPTER_CLI_FALLBACK: Record<string, string> = {
  x: "xurl",
};

const CLIS = ["claude", "codex", "gh"] as const;

function cliOnPath(cli: string): boolean {
  try {
    execFileSync("which", [cli], { encoding: "utf8", timeout: 15_000, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export interface DoctorReport {
  env: Record<
    string,
    {
      present: string[];
      absent: string[];
      keyless: boolean;
      // Credential-ladder rung below the env key: an already-authenticated CLI that the
      // adapter falls back to. null when the adapter has no such rung.
      fallbackCli: string | null;
      fallbackCliOnPath: boolean | null;
      // What the operator actually needs to know: whether this lane will collect.
      willRun: boolean;
    }
  >;
  clis: Record<string, { found: boolean; version: string | null }>;
  db: {
    reachable: boolean;
    error: string | null;
    rowCounts: Record<string, number>;
  };
  lastRunPerSurface: { surfaceId: string; runId: string; startedAt: number; stationsRun: string[] }[];
  // What each missing key unlocks, from the key-pending rows' own value text.
  keyPending: { checkKey: string; reason: string | null; unlock: string | null; price: string | null }[];
  // Brands whose aliases do not carry the domain's bare label: they will match "acme.com"
  // and "acme com" and miss every answer that says "Acme", which is how answers name brands.
  brandsMissingBareLabel: { brandId: string; aliases: string[]; label: string }[];
}

function cliVersion(cli: string): { found: boolean; version: string | null } {
  try {
    const out = execFileSync(cli, ["--version"], { encoding: "utf8", timeout: 15_000, stdio: "pipe" }).trim();
    return { found: true, version: out.split("\n")[0] };
  } catch {
    return { found: false, version: null };
  }
}

export function doctor(): DoctorReport {
  const env: DoctorReport["env"] = {};
  for (const [adapter, vars] of Object.entries(ADAPTER_ENV)) {
    const present = vars.filter((v) => !!process.env[v]);
    const fallbackCli = ADAPTER_CLI_FALLBACK[adapter] ?? null;
    const fallbackReady = fallbackCli !== null && cliOnPath(fallbackCli);
    env[adapter] = {
      present,
      absent: vars.filter((v) => !process.env[v]),
      keyless: vars.length === 0,
      fallbackCli,
      fallbackCliOnPath: fallbackCli === null ? null : fallbackReady,
      // The honest bottom line: will this lane collect on this box?
      willRun: vars.length === 0 || present.length > 0 || fallbackReady,
    };
  }

  const clis: DoctorReport["clis"] = {};
  for (const cli of CLIS) clis[cli] = cliVersion(cli);

  const report: DoctorReport = {
    env,
    clis,
    db: { reachable: false, error: null, rowCounts: {} },
    lastRunPerSurface: [],
    keyPending: [],
    brandsMissingBareLabel: [],
  };

  try {
    const tables = {
      surfaces: schema.surfaces,
      runs: schema.runs,
      evidence: schema.evidence,
      panel_observations: schema.panelObservations,
      claims: schema.claims,
      bets: schema.bets,
      assets: schema.assets,
      snapshots: schema.snapshots,
    };
    for (const [name, table] of Object.entries(tables)) {
      report.db.rowCounts[name] = db.select().from(table).all().length;
    }
    report.db.reachable = true;

    for (const s of db.select().from(schema.surfaces).all()) {
      const run = db
        .select()
        .from(schema.runs)
        .all()
        .filter((r) => r.surfaceId === s.id)
        .sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id))[0];
      if (run) {
        report.lastRunPerSurface.push({
          surfaceId: s.id,
          runId: run.id,
          startedAt: run.startedAt,
          stationsRun: run.stationsRun,
        });
      } else {
        report.lastRunPerSurface.push({ surfaceId: s.id, runId: "(none)", startedAt: 0, stationsRun: [] });
      }
    }

    for (const b of db.select().from(schema.brands).all()) {
      const identity = identityFromRow(b);
      const label = missingBareLabel(identity);
      if (identity && label) report.brandsMissingBareLabel.push({ brandId: b.id, aliases: identity.aliases, label });
    }

    // Latest key-pending row per check_key: the lane's own words on what a key unlocks.
    // "Latest" is chronological, by the row's run: run ids are uuids, so ordering on
    // the id would pick a random row and report stale text as current.
    const startedAt = new Map(db.select().from(schema.runs).all().map((r) => [r.id, r.startedAt]));
    const pending = db
      .select()
      .from(schema.evidence)
      .all()
      .filter((r) => r.status === "key-pending")
      .sort(
        (a, b) =>
          (startedAt.get(b.runId) ?? 0) - (startedAt.get(a.runId) ?? 0) || b.runId.localeCompare(a.runId),
      );
    const seen = new Set<string>();
    for (const r of pending) {
      if (seen.has(r.checkKey)) continue;
      seen.add(r.checkKey);
      const v = r.value as { reason?: unknown; unlock?: unknown; price?: unknown } | null;
      report.keyPending.push({
        checkKey: r.checkKey,
        reason: typeof v?.reason === "string" ? v.reason : null,
        unlock: typeof v?.unlock === "string" ? v.unlock : null,
        price: typeof v?.price === "string" ? v.price : null,
      });
    }
  } catch (e) {
    report.db.error = e instanceof Error ? e.message : String(e);
  }

  return report;
}

export function renderDoctor(r: DoctorReport): string {
  const lines = ["answerable doctor"];
  lines.push("  adapter credentials:");
  for (const [adapter, e] of Object.entries(r.env)) {
    if (e.keyless) lines.push(`    ${adapter}: keyless (always runnable)`);
    else {
      const parts = [
        ...e.present.map((v) => `${v} present`),
        ...e.absent.map((v) => `${v} absent`),
      ];
      if (e.fallbackCli !== null) {
        parts.push(
          e.fallbackCliOnPath
            ? `${e.fallbackCli} CLI on PATH (already authenticated: this lane RUNS through it and bills that account)`
            : `${e.fallbackCli} CLI not on PATH`,
        );
      }
      parts.push(e.willRun ? "lane WILL run" : "lane will NOT run");
      lines.push(`    ${adapter}: ${parts.join(", ")}`);
    }
  }
  lines.push("  CLIs:");
  for (const [cli, c] of Object.entries(r.clis)) {
    lines.push(`    ${cli}: ${c.found ? `found (${c.version})` : "NOT FOUND"}`);
  }
  if (!r.db.reachable) {
    lines.push(`  db: UNREACHABLE (${r.db.error})`);
    return lines.join("\n");
  }
  lines.push(`  db: reachable; rows: ${Object.entries(r.db.rowCounts).map(([t, n]) => `${t} ${n}`).join(", ")}`);
  lines.push("  last run per surface:");
  for (const s of r.lastRunPerSurface) {
    lines.push(
      s.runId === "(none)"
        ? `    ${s.surfaceId}: no runs yet`
        : `    ${s.surfaceId}: ${new Date(s.startedAt).toISOString()} (${s.stationsRun.join("+") || "open"}) run ${s.runId}`,
    );
  }
  if (r.brandsMissingBareLabel.length > 0) {
    lines.push("  brands whose aliases do not include their plain name:");
    for (const b of r.brandsMissingBareLabel) {
      lines.push(`    ${b.brandId}: aliases ${b.aliases.join(", ")}; if people say "${b.label}": answerable brand alias ${b.brandId} ${b.label}`);
    }
  }
  if (r.keyPending.length > 0) {
    lines.push("  missing keys and what they unlock (the lanes' own words):");
    for (const k of r.keyPending) {
      lines.push(`    ${k.checkKey}: ${k.reason ?? "(no reason recorded)"}`);
      if (k.unlock) lines.push(`      unlocks: ${k.unlock}`);
      if (k.price) lines.push(`      price: ${k.price}`);
    }
  }
  return lines.join("\n");
}
