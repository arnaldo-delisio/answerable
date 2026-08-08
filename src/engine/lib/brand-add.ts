// `answerable brand add <domain>`: the entry point. A brand is the thing being made
// visible and it is the top-level object, so the first command an operator runs names a
// brand, not a config file. This probes the domain (draftBrand: the brand's own site, the
// sibling properties it links to, its store and social presence, and the two AI-answer
// lanes) and turns that proposal into something the operator can act on.
//
// WHAT IT WRITES, AND WHY EXACTLY THIS MUCH:
//
//   - ONE database row: the brand itself, seeded from the domain exactly as `brand create`
//     seeds it: identity comes from the domain and nothing else. The name the site calls
//     itself is REPORTED (as `observedName`) and never stored, because a display name is a
//     bare token and bare tokens match ordinary prose — this engine never makes one
//     matchable on an operator's behalf.
//     The brand is what the operator asked for by name, so creating it is not a surprise,
//     and every proposed config can then carry `brand:` and onboard without a second step.
//   - ONE `.proposed.yaml` per discovered surface, and NO surface rows. A registered
//     surface is a thing the engine collects against — it costs network, quota, and money
//     on the keyed lanes, and its config carries fields no probe can know (the real
//     audience, the real business goal, the real conversion). So surfaces stay proposals
//     on disk, with `# proposed:` on every guessed field, exactly like `draft <domain>`
//     already does; `onboard` is the operator's confirmation. Nothing is monitored until
//     they run it.
//
// A refusal writes nothing at all: an existing brand id is refused before the probe runs.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { draftBrand, facetLinkage, isPlausibleCategory, type BrandProposal } from "./brand-draft";
import { yamlQuote } from "./draft";
import { brandIdForDomain, brandHost, composeChildId } from "./brand-id";
import { brandExists, createBrand } from "./brands";
import { SURFACE_ID_RE } from "./surface";
import type { VerbResult } from "./verbs";

export interface ProposedSurface {
  id: string;
  kind: "site" | "assistant";
  what: string; // the host, or the assistant's engine
  path: string; // the .proposed.yaml written for it
  linkage: "strong" | "weak" | "seed"; // how the probe tied it to the brand
}

function slugForHost(host: string): string {
  return brandIdForDomain(host);
}

// EVERY probed string passes through here before it reaches yaml, and that is not
// cosmetic. A site's own meta description routinely carries newlines and several
// paragraphs; a JSON-LD name or a title can carry one too, and that name flows into the
// seeded discovery prompts. A newline inside a quoted yaml scalar ends the line and the
// next one is unindented: the file this command wrote would then be refused by the loader
// it wrote it for. Collapse all whitespace (control characters included) to single spaces,
// drop the rest, and cap the length — these fields are `# proposed:` placeholders for the
// operator to replace, so a long tail buys nothing.
const PROBED_TEXT_MAX = 240;
function oneLine(s: string): string {
  const flat = s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > PROBED_TEXT_MAX ? `${flat.slice(0, PROBED_TEXT_MAX).trimEnd()}…` : flat;
}

// A locale comes straight off an hreflang attribute in somebody else's HTML, and it lands
// in this yaml as a bare scalar (`locale: xx`) — the one probed value that is not a
// quoted string or a comment. An attribute is not a locale just because it sits in an
// hreflang slot, so anything not locale-shaped is dropped rather than written out and
// trusted. Same shape the sitemap path detector already requires, plus the longer
// subtags a real hreflang carries (`pt-BR`, `zh-Hant-TW`).
const LOCALE_RE = /^[a-z]{2,3}(-[a-z0-9]{2,8}){0,2}$/i;
function usableLocales(locales: string[]): string[] {
  return locales.filter((l) => LOCALE_RE.test(l));
}

function header(domain: string, extra: string): string[] {
  return [
    `# proposed: drafted by \`answerable brand add ${domain}\`, ${new Date().toISOString().slice(0, 10)}.`,
    `# proposed: ${extra}`,
    `# proposed: Review every field, then rename off the .proposed and \`answerable onboard\` it.`,
  ];
}

function renderSiteYaml(
  p: BrandProposal,
  site: BrandProposal["facets"]["websites"][number],
  id: string,
  brandId: string,
  domain: string,
): string {
  const locales = usableLocales(site.locales);
  const primary = locales[0] ?? "en";
  const nonPrimary = locales.slice(1);
  const lines = [
    ...header(domain, `a site surface: ${site.url}${site.title ? ` ("${oneLine(site.title)}")` : ""}`),
    `id: ${id}`,
    `kind: site`,
    `brand: ${brandId}`,
    `target:`,
    `  domain: ${site.host}`,
    `  path_prefix: /  # proposed: adjust when the primary locale lives under /${primary}/`,
    `  locale: ${primary}  # proposed: ${
      locales.length === 0 ? "no usable locale signal observed; defaulted to en" : `observed via ${site.localeSource}`
    }`,
  ];
  if (nonPrimary.length > 0) {
    lines.push(`  # proposed: other locales observed here; each becomes its own site file:`);
    for (const l of nonPrimary) lines.push(`  #   locale: ${l}`);
  }
  lines.push(
    `audience: >-  # proposed: from the site's own description; replace with the real brief`,
    `  ${p.brand.description ? oneLine(p.brand.description) : `Visitors of ${site.host} (nothing observed on the site; write the audience by hand).`}`,
    `business_goal: >-  # proposed: placeholder; state the real goal`,
    `  Grow qualified search and AI-answer visibility for ${oneLine(p.brand.name)}.`,
    `desired_conversion: signup  # proposed: replace with the site's real conversion`,
    `competitors: []  # proposed: the probe names none; fill by hand, or run \`draft ${site.host}\` which reads comparison-page titles`,
    `publishing:`,
    `  policy: review-required`,
    `  owner: operator  # proposed: confirm the owner`,
    `  # repo: owner/name  # proposed: set to open real PRs on approve (directed and verified, never autonomous)`,
    `lanes:`,
    `  crawl:`,
    `    enabled: true`,
    `  community:`,
    `    enabled: false  # proposed: enable once demand queries are chosen`,
    `# cadence: weekly  # proposed: uncomment to put this surface on the tick schedule`,
    `policy: {}  # default class weights`,
  );
  return lines.join("\n") + "\n";
}

function renderAssistantYaml(
  p: BrandProposal,
  lane: BrandProposal["facets"]["ai_lanes"][number],
  id: string,
  brandId: string,
  observes: string,
  domain: string,
): string {
  const lines = [
    ...header(domain, `an assistant surface: what ${lane.engine} answers when buyers ask`),
    `id: ${id}`,
    `kind: assistant`,
    `brand: ${brandId}`,
    `target:`,
    `  engine: ${lane.engine}`,
    `  prompt_set:`,
    `    version: discovery-v1`,
    // Same message the probe already reasoned out (draftBrand's laneEvidence): whether
    // the category was used, rejected as a tagline, or never observed. Re-deriving this
    // from p.brand.category alone would drift from what discoveryPrompts() actually did —
    // the category can exist and still not be the reason these prompts look the way they do.
    `    prompts:  # proposed: ${lane.evidence[0]?.observed ?? "seeded from the site's claimed category"}`,
    // Two operators running the identical command must get the same category regardless
    // of where their server sits: the probe now sends a deliberate Accept-Language rather
    // than whatever the box's own network location implies. Surfaced so an operator whose
    // market is not English can see what the probe actually got and supply the real
    // category by hand, rather than the choice being invisible.
    ...(lane.evidence[1]?.observed ? [`    # proposed: ${lane.evidence[1].observed}`] : []),
  ];
  const categoryUsable = p.brand.category !== null && isPlausibleCategory(p.brand.category);
  for (const prompt of lane.prompts) lines.push(`      - ${yamlQuote(oneLine(prompt))}`);
  lines.push(
    `observes: ${observes}  # the site surface this assistant's answers are measured against`,
    `audience: >-  # proposed: who is asking; replace with the real brief`,
    `  Buyers asking ${lane.engine} discovery and reputation questions about ${oneLine(categoryUsable ? (p.brand.category as string) : p.brand.name)}.`,
    `business_goal: >-  # proposed: placeholder; state the real goal`,
    `  Measure and grow ${oneLine(p.brand.name)}'s share of answer in ${lane.engine}.`,
    `desired_conversion: signup  # proposed: replace with the real conversion`,
    `competitors: []  # proposed: name the competitors you expect to be recommended instead`,
    `publishing:`,
    `  policy: review-required`,
    `  owner: operator  # proposed: confirm the owner`,
    `lanes:`,
    `  geo-panel:`,
    `    enabled: true`,
    `# cadence: weekly  # proposed: uncomment to put this surface on the tick schedule`,
    `policy: {}  # default class weights`,
  );
  return lines.join("\n") + "\n";
}

export async function brandAdd(domain: string, projectRoot = process.cwd()): Promise<VerbResult> {
  const host = brandHost(domain);
  if (!host) {
    return { ok: false, note: `"${domain}" is not a usable domain (expected a hostname like acme.com)` };
  }
  const brandId = brandIdForDomain(host);
  if (!SURFACE_ID_RE.test(brandId)) {
    return { ok: false, note: `"${domain}" does not derive a usable brand id (got "${brandId}")` };
  }
  // Refuse before the probe: the network pass takes tens of seconds and would only reach
  // the same refusal. `brand alias` / `brand negative` edit an existing brand.
  if (brandExists(brandId)) {
    return {
      ok: false,
      note: `brand "${brandId}" already exists (edit it with \`brand alias\` / \`brand negative\`, or add surfaces with \`draft <domain>\` + \`onboard\`)`,
    };
  }

  const proposal = await draftBrand(host);

  const outDir = path.join(projectRoot, "config", "surfaces");
  const notes = [...proposal.notes];

  // PLAN EVERYTHING BEFORE MUTATING ANYTHING. Two hosts can slug to the same surface id
  // (brandIdForDomain strips a leading "www.", so blog.example.com and www.blog.example.com
  // agree), and the operator may already have a proposal at one of these paths from
  // `draft`. Writing as we go would silently overwrite either one. So ids and paths are
  // resolved first, and a collision refuses the whole command with nothing created.
  const planned: { surface: ProposedSurface; body: string }[] = [];
  const byId = new Map<string, string>(); // id -> what claimed it

  const reachable = proposal.facets.websites.filter((w) => w.reachable);
  for (const w of proposal.facets.websites.filter((s) => !s.reachable)) {
    notes.push(`site ${w.host} did not answer; proposed nothing for it`);
  }
  let primaryId: string | null = null;
  for (const site of reachable) {
    const id = slugForHost(site.host);
    if (!SURFACE_ID_RE.test(id)) {
      notes.push(`site ${site.host} skipped: no usable surface id derives from that host`);
      continue;
    }
    const claimedBy = byId.get(id);
    if (claimedBy) {
      return {
        ok: false,
        note: `${site.host} and ${claimedBy} both derive the surface id "${id}"; nothing was created — onboard them one at a time with \`draft <domain>\``,
      };
    }
    byId.set(id, site.host);
    if (site.primary) primaryId = id;
    planned.push({
      surface: {
        id,
        kind: "site",
        what: site.host,
        path: path.join(outDir, `${id}.proposed.yaml`),
        linkage: site.primary ? "seed" : facetLinkage(site.evidence),
      },
      body: renderSiteYaml(proposal, site, id, brandId, host),
    });
  }

  // Assistants: always proposed, but each declares the site surface it observes, so they
  // can only be written when a primary site surface was proposed for them to point at.
  if (primaryId) {
    for (const lane of proposal.facets.ai_lanes) {
      const id = composeChildId(brandId, `-${lane.engine}`);
      const claimedBy = byId.get(id);
      if (claimedBy) {
        return {
          ok: false,
          note: `the ${lane.engine} surface and ${claimedBy} both derive the surface id "${id}"; nothing was created`,
        };
      }
      byId.set(id, `the ${lane.engine} surface`);
      planned.push({
        surface: { id, kind: "assistant", what: lane.engine, path: path.join(outDir, `${id}.proposed.yaml`), linkage: "seed" },
        body: renderAssistantYaml(proposal, lane, id, brandId, primaryId, host),
      });
    }
  } else {
    notes.push(
      `the seed domain did not answer, so no site surface was proposed — and an assistant surface must declare the site it observes, so the AI-answer lanes were not proposed either`,
    );
  }

  // A file already at one of these paths is the operator's, whatever put it there. Refuse
  // rather than overwrite, and name the files so the refusal is actionable.
  const occupied = planned.filter((p) => existsSync(p.surface.path)).map((p) => p.surface.path);
  if (occupied.length > 0) {
    return {
      ok: false,
      note: `these files already exist and would be overwritten: ${occupied.join(", ")} — move or delete them first (nothing was created)`,
    };
  }

  // Commit: files first, brand row last. The brand row is what makes a re-run refuse, so
  // creating it last means a failed write leaves a state a re-run can still get through,
  // rather than a brand nobody can add surfaces to.
  //
  // Every write is exclusive (`wx`): the preflight above exists for the readable
  // multi-file message, but it is a check separated in time from the write, and only the
  // open itself can decide the race. A partial commit is then undone — the files this run
  // created are removed, so "nothing was created" stays true on every failure path.
  mkdirSync(outDir, { recursive: true });
  const madeFiles: string[] = [];
  let created: VerbResult;
  try {
    for (const p of planned) {
      // Recorded BEFORE the write, not after: an exclusive open that succeeds and then
      // fails mid-write (a full disk, an I/O error) has already created the file, and a
      // rollback list built from returns would leave that partial file behind while the
      // refusal claimed nothing was created. Rolling back a path that was never created
      // is a no-op; missing one is a lie.
      madeFiles.push(p.surface.path);
      writeFileSync(p.surface.path, p.body, { flag: "wx" });
    }
    // Inside the same try: createBrand can throw (a locked database, a uniqueness race
    // between its existence read and its insert), and a throw here would strand the files.
    created = createBrand(brandId, proposal.brand.primaryDomain);
  } catch (e) {
    for (const f of madeFiles) rmSync(f, { force: true });
    return {
      ok: false,
      note: `brand add failed (${e instanceof Error ? e.message : String(e)}); nothing was created`,
    };
  }
  if (!created.ok) {
    for (const f of madeFiles) rmSync(f, { force: true });
    return created;
  }
  const written = planned.map((p) => p.surface);

  // Store listings and social profiles are real parts of the brand's network and the probe
  // found them, but no adapter collects evidence from either yet. Reporting them as found
  // and unmonitorable is the honest shape; proposing a config for a kind that cannot run
  // would be an empty surface pretending to be coverage.
  const notMonitored = [
    ...proposal.facets.store_listings.map((s) => ({ what: s.store, url: s.url })),
    ...proposal.facets.social_profiles.map((s) => ({ what: s.network, url: s.url })),
  ];
  if (notMonitored.length > 0) {
    notes.push(
      `found ${notMonitored.length} store/social ${notMonitored.length === 1 ? "profile" : "profiles"} (${notMonitored
        .map((n) => n.what)
        .join(", ")}); there is no adapter for those yet, so nothing was proposed for them`,
    );
  }

  return {
    ok: true,
    note: null,
    brandId,
    // The STORED display name, which createBrand derives from the domain. The name the
    // site calls itself is reported beside it as an observation, never as identity: a
    // display name is a bare token, and bare tokens match ordinary prose.
    name: created.name,
    observedName: proposal.brand.name,
    primaryDomain: proposal.brand.primaryDomain,
    category: proposal.brand.category,
    aliases: created.aliases,
    negativeTerms: created.negativeTerms,
    surfaces: written,
    notMonitored,
    unreachable: proposal.unreachable,
    notes,
  };
}
