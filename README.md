# Answerable

**Answerable finds what is stopping people from finding and choosing your brand in Google
and in AI answers, writes the fix, and checks that the fix actually shipped.**

It is a command-line tool, built to be driven by a coding agent. There is no server, no
dashboard, and no account: an install is this repo, one SQLite file, and an env file.

## The model: brands and surfaces

A **brand** is the thing being made visible. It is the top-level object, and it is where
you start.

A brand has **surfaces**: the places it can show up.

- a **site** — a website, or one locale of one
- an **assistant** — an AI answer engine people ask, like ChatGPT or Claude
- a **community** — a forum where the brand is discussed and owns none of the text, like
  Reddit or Hacker News

A brand has sites it owns, assistants people ask, and communities where it is discussed.

You name the brand once. Answerable probes the domain, finds the surfaces, and proposes a
config for each site and assistant it found. Communities are hand-written: `brand add`
proposes one only where the probe has evidence of a specific community presence, and it
has none today, so `config/surfaces/example-community-hn.yaml` is the shape to copy.
Nothing is watched until you say so.

Then, for each surface, it walks a loop: **sense** (collect real evidence) → **infer**
(turn evidence into claims that could be wrong) → **decide** (rank them, with a score you
can read factor by factor) → **act** (write the fix) → **approve** (a human says yes) →
**publish** → **verify** (did the change actually go live).

It is directed and verified, never autonomous. Nothing touches the world without a human
saying yes, and nothing counts as done because the engine said so.

## Quickstart

You need Node 20+, and a domain. Use your own.

```bash
git clone https://github.com/arnaldo-delisio/answerable.git && cd answerable
npm install
npm run db:push                                # create the SQLite schema

npx tsx src/cli.ts doctor                      # what can run, what a key would unlock
npx tsx src/cli.ts brand add yourdomain.com    # START HERE
```

`brand add` probes the domain and prints the brand's network: the site itself, any sibling
sites it found, and the two assistant surfaces (every brand competes in AI answers whether
or not it knows it). It creates one thing — the brand — and writes a
`config/surfaces/<id>.proposed.yaml` for each surface. **Nothing is monitored yet.** Read a
proposal, fix what the probe guessed wrong, drop the `.proposed`, and onboard it:

```bash
npx tsx src/cli.ts onboard config/surfaces/yourdomain-com.yaml
npx tsx src/cli.ts run yourdomain-com          # collect the first real evidence
```

Then walk the loop one station at a time:

```bash
npx tsx src/cli.ts infer yourdomain-com        # evidence -> claims
npx tsx src/cli.ts decide yourdomain-com       # open claims -> ranked bets
npx tsx src/cli.ts act yourdomain-com          # placed bets -> drafted fixes
npx tsx src/cli.ts preview <asset-id>          # read what it wrote
npx tsx src/cli.ts approve <asset-id>          # the human gate: nothing ships without it
npx tsx src/cli.ts publish <asset-id>          # a PR on your repo, or a spec handoff
npx tsx src/cli.ts verify yourdomain-com       # did it ship?
```

Onboard the assistant proposals the same way to see what ChatGPT and Claude say when
buyers ask about your category. Those lanes drive the `claude` and `codex` CLIs you are
already signed into, so they cost no API keys.

Add `--json` to any verb for a structured result on stdout and nothing else. That is the
agent surface; the full contract is in [AGENTS.md](AGENTS.md), and
`.claude/skills/answerable/SKILL.md` teaches a Claude Code session to drive it (copy it to
`~/.claude/skills/` to use it from anywhere).

### On a domain you do not control, the loop stops at publish

Everything up to and including the review gate runs for real on any domain: evidence,
claims, ranking, drafted fixes. But `verify` re-collects evidence and checks whether the
approved change is actually live, and you cannot ship a change to somebody else's site. So
it will correctly and permanently report "criteria NOT met, stays shipped". That is the
product refusing to lie, not a bug. To close the loop you need a domain you can push a
change to.

## What verify claims, and what it does not

`verify` answers one question: **did it ship.** It re-collects evidence and compares the
same check keys the claim was made from, so a fix is only marked verified when the change
is observably live. That is the product's load-bearing claim.

`verify` also runs an **outcome assessment**, and the `learn` station turns settled bets
into priors that reweight future rankings. **Both are experimental.** They are real and
they run, but "did the change move the number" is search attribution: it needs a domain you
control and weeks of settled bets before it means anything, and until then it is reported,
never claimed. The CLI labels it experimental in its own output. Do not sell it.

`settle <bet-id> <keep|revise|stop>` is your verdict on what verify measured, and it is
what feeds those priors. Skipping it costs you nothing today and everything later.

## Every verb

Run `npx tsx src/cli.ts` with no arguments for the current list. In short:

- **start** — `brand add <domain>`, `doctor`, `onboard <file>`
- **brand identity** — `brand list | create | alias | negative` (what the mention lanes
  match on: the domain and its spoken form, plus any alias you type; `negative` vetoes
  look-alikes)
- **the loop** — `run` → `infer` → `decide` → `act` → `verify`, each on a surface id
- **assets** — `preview`, `edit`, `regenerate`, `approve`, `reject`, `publish`, `outbox`,
  `mark-sent`
- **bets** — `implemented`, `settle`, `cancel`, `dismiss`
- **housekeeping** — `narrate`, `spec`, `pause`, `archive`, `resume`, `tick`,
  `draft <domain>` (propose a single site config, without creating a brand)

Exit code 1 always means the verb refused, with the reason in `note`. Never a silent
no-op.

What `act` writes, by claim class: **fix specs** for technical and eligibility claims
(hreflang, site basics, bot blocks, SSR), **comparison pages** for competitor claims,
**owned answer pages** for brand-defense claims, **tool specs** for tool opportunities,
**outreach drafts** for pages that cite your competitors and not you, and — for
`ai-visibility` claims, the second-highest-weighted class in the product — **quick-answer
(AEO) blocks**: a 40 to 60 word answer per discovery prompt from your assistant surface's
prompt set, each citing the prompt it answers, for the homepage and any tool pages, plus a
`FAQPage` JSON-LD block over the same set. It is what you paste into a page to be the
thing an answer engine quotes. Without a local `claude` CLI the blocks are written as
`draft-pending` rather than invented.

Two things worth knowing before you are surprised by them. `publish` does not put a page
on your site: it opens a PR on the repo your config names, or hands you a spec to deliver.
And some drafts are deliberately unfinished — the comparison-page generator writes literal
`[NEEDS SOURCE]` rather than inventing a competitor's pricing, and `approve` refuses any
body still carrying one. Fill it in with `edit`, or ask for a revision with `regenerate`.

## Your data

### What runs with no credentials at all

This is the part worth knowing first. On a fresh clone, with an empty `.env`, four lanes
collect real evidence:

| Lane | Surface kind | What it collects | How |
|---|---|---|---|
| `crawl` | site | robots and per-bot access (GPTBot, ClaudeBot, PerplexityBot…), sitemap, hreflang, canonicals, JSON-LD, SSR, Content-Signal | direct polite fetches of the site |
| `geo-panel` | assistant | what ChatGPT and Claude actually answer to your prompt set, and who they cite | the `claude` and `codex` CLIs you are already signed into |
| `community` | site, community | Reddit and Hacker News mentions of the brand, its competitors, and its demand queries (a `community` surface names one platform and gets only that one; a `site` surface sweeps both) | Reddit's public search JSON, HN via Algolia |
| `competitor` | site | the comparison and "best X" pages that rank for your category, and whether they cite you | direct fetches |

A fifth, `x`, joins them for free if the `xurl` CLI is already on your PATH: it collects X
mentions of the brand on a `site` surface, or on a `community` surface whose platform is
`x`, falling back to `X_BEARER_TOKEN` when the CLI is absent.

So the whole loop — evidence, claims, ranking, drafted fixes, the review gate — runs
before you connect anything. Start with `doctor`: it names what each lane can do right
now, and what each missing key would add and cost.

### The optional layer: keys that deepen a lane

Every credential below extends a lane that already runs, or adds a keyed one. None of them
is required, and a lane without its key shows as an honest gated state in `doctor`, never
a zeroed metric.

| Priority | Credential (`.env.example`) | Unlocks | Cost |
|---|---|---|---|
| 1 | `GSC_OAUTH_CLIENT_ID` / `GSC_OAUTH_CLIENT_SECRET` / `GSC_OAUTH_REFRESH_TOKEN` / `GSC_SITE_URL` | Google Search Console: real indexation coverage, queries, impressions and clicks per path. The single highest-value connection. Shortcut: instead of an OAuth dance, have the Google account owner add a service account as a restricted user on the property, then point `GOOGLE_APPLICATION_CREDENTIALS` at its key file. | Free |
| 2 | `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` | Two calls: a backlinks summary (domain rank + referring domains) and an LLM-mentions search for the brand. Every call is refused before it is made when the estimate would pass the surface's `max_cost_per_run`. Keyed on a domain, so it belongs on a `site` surface; the lane matrix also allows it on an `assistant` surface, where the target carries no domain and it reports gated instead of spending | Cents per call, budget-guarded |
| 3 | `PAGESPEED_API_KEY` | Real Core Web Vitals via PageSpeed Insights | Free |
| 4 | `GOOGLE_APPLICATION_CREDENTIALS` + `GA4_PROPERTY_ID` | GA4: conversions on the pages the fixes touch | Free |
| 5 | `BING_WEBMASTER_KEY` | Bing Webmaster, read-only: rank and traffic stats, plus your remaining URL-submission quota. The engine reads the quota and never submits a URL | Free |
| 6 | `X_BEARER_TOKEN` | X mentions lane (skip it if the `xurl` CLI is on your PATH — the lane tries that first) | Free tier |
| 7 | `ANTHROPIC_API_KEY` | API-billed interpretation for `infer` (falls back to the local `claude` CLI when unset) | Metered |
| 8 | `ANSWERABLE_NOTIFY_WEBHOOK` | Run and review summaries posted to your webhook | Free |

Keys live in `.env` (gitignored) or `~/.config/answerable/env`, which the CLI sources at
startup; real environment variables always win. The engine reads credentials and never
writes them. A lane without its key shows as an honest gated state in `doctor`, never a
zeroed metric — and a metric it could not measure is never reported as zero.

## Running it continuously

```bash
npm ci && npm run db:push       # install, create or upgrade the schema
```

Then put `npx tsx src/cli.ts tick` on cron (every 30 minutes is plenty): it runs the
surfaces whose cadence is due and posts the review summary to
`ANSWERABLE_NOTIFY_WEBHOOK`. Re-run `db:push` on every upgrade; the schema evolves.

The repo ships no database, on purpose. `db:push` creates it at `data/answerable.db`, and
your first `run` is what fills it. Set `ANSWERABLE_DB_PATH` to point every command at a
different file — a scratch database to experiment in, or the real one on a box.

### Backup

State is one file. Back it up with SQLite's own snapshot, never a file copy, so the
write-ahead log is folded in:

```bash
node -e "require('better-sqlite3')('data/answerable.db').backup('/backups/answerable-$(date +%F).db')"
```

To restore: stop anything using the file, delete any leftover `data/answerable.db-wal` and
`data/answerable.db-shm` sidecars (a stale write-ahead log would replay over the restored
file and undo it), then copy the backup into place. Take a backup before every `db:push`.

## Where surfaces go next

Every place a buyer can discover a brand becomes one more surface kind behind the same
config schema: an app store listing, a GitHub repository, a LinkedIn page, a marketplace.
Each arrives as one adapter when there is real evidence to collect, never as a speculative
empty kind. `brand add` already reports the store and social profiles it finds and says
plainly that nothing watches them yet.

## License

MIT.
