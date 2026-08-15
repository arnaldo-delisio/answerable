# Answerable

**Answerable finds what is stopping people from finding and choosing your brand in Google
and in AI answers, writes the fix, and checks that the fix actually shipped.**

It asks ChatGPT and Claude what they say about a brand by driving the `claude` and `codex`
CLIs you are already signed into, so measuring what the answer engines tell your buyers
costs no API key and no extra account.

It is a command-line tool, built to be driven by a coding agent. There is no server, no
dashboard, and no account: an install is this repo, one SQLite file, and an env file.

## Why it is built this way

Evidence and inference are separate rows: what the engine observed is stored with its
provenance and a confidence tag, and what it concluded is a claim linked back to the
evidence it came from, so you can always ask which measurement a recommendation rests on.
The loop is a set of explicit state transitions rather than one silent end-to-end run, so
every station is its own command, each one inspectable and re-runnable, and a bet's
lifecycle is guarded so it cannot skip a step. Nothing reaches your site without a human,
because `publish` refuses any asset the review gate has not approved. After a fix ships,
`verify` re-collects evidence and re-checks the same check keys the claim was made from,
which keeps "shipped" and "actually live" two different states. Settled bets then feed
priors that reweight future rankings, which is real but young: treat it as a reading, not
a result.

## Start here

You need Node 20+, and a domain. Use your own.

```bash
git clone https://github.com/arnaldo-delisio/answerable.git && cd answerable
npm install
npm run db:push                                # create the SQLite schema

npx tsx src/cli.ts doctor                      # what can run, what a key would unlock
npx tsx src/cli.ts brand add yourdomain.com    # START HERE
```

`brand add` probes the domain and prints the brand's network. Run against `htmx.org`:

```
brand add htmx-org: created (htmx.org)
  8 surface(s) proposed (nothing is monitored until you onboard one):
    site htmx-org (htmx.org)
    site four-htmx-org (four.htmx.org)
    site swag-htmx-org (swag.htmx.org)
    site v1-htmx-org (v1.htmx.org)
    assistant htmx-org-chatgpt (chatgpt)
    assistant htmx-org-claude (claude)
    community htmx-org-hacker-news (hacker-news)
    community htmx-org-x (x (@htmx_org))
  note: community mention check on "htmx.org" — reddit: could not check (http 403), so nothing was proposed; hacker-news: 1106 results, so a community surface was proposed
  note: found 3 store/social profiles no collector reads yet (GitHub, GitHub, GitHub); nothing was proposed for them — each becomes a surface when an adapter can collect it
```

It found the sibling sites and the linked X profile on its own, and it proposes a surface
only where a lane can actually collect one.

The only row it created is the brand. Each proposal is written to
`config/surfaces/<id>.proposed.yaml`. Read one, fix what the probe guessed wrong, drop the
`.proposed`, and onboard it. That is what starts collection:

```bash
npx tsx src/cli.ts onboard config/surfaces/yourdomain-com.yaml
npx tsx src/cli.ts run yourdomain-com          # collect the first real evidence
```

## What it does

**It measures.** Per site: robots and per-bot access (GPTBot, ClaudeBot, PerplexityBot),
sitemap, hreflang, canonicals, JSON-LD, server-side rendering, Content-Signal, the
comparison and "best X" pages that rank for your category and whether they cite you, and
mentions in the communities where your buyers argue. Per assistant surface: what ChatGPT
and Claude actually answer to your prompt set, and who they cite.

**It drafts, by claim class.** Fix specs for technical and eligibility claims (hreflang,
site basics, bot blocks, SSR). Comparison pages for competitor claims. Owned answer pages
for brand-defense claims. Tool specs for tool opportunities. Outreach drafts for pages that
cite your competitors and not you. And for `ai-visibility` claims, the second
highest-weighted class in the product, quick-answer (AEO) blocks: a 40 to 60 word answer
per discovery prompt from your assistant surface's prompt set, each citing the prompt it
answers, for the homepage and any tool pages, plus a `FAQPage` JSON-LD block over the same
set. It is what you paste into a page to be the thing an answer engine quotes. Without a
local `claude` CLI the blocks are written `draft-pending` rather than invented.

Nothing ships without a human `approve`. `publish` does not put a page on your site: it
opens a PR on the repo your config names, or hands you a spec to deliver. Some drafts are
deliberately unfinished, because the comparison-page generator writes literal
`[NEEDS SOURCE]` rather than inventing a competitor's pricing, and `approve` refuses any
body still carrying one. Fill it in with `edit`, or ask for a revision with `regenerate`.

**It verifies.** `verify` answers one question: **did it ship.** It re-collects evidence
and compares the same check keys the claim was made from, so a fix is only marked verified
when the change is observably live.

`verify` also runs an **outcome assessment**, and the `learn` station turns settled bets
into priors that reweight future rankings. **Both are experimental**, and the CLI labels
them so in its own output. "Did the change move the number" is search attribution: it needs
a domain you control and weeks of settled bets before it tells you anything, so treat what
it prints as a reading, not a result. `settle <bet-id> <keep|revise|stop>` is your verdict
on what verify measured, and it is what feeds those priors.

### On a domain you do not control, the loop stops at publish

Everything up to and including the review gate runs for real on any domain: evidence,
claims, ranking, drafted fixes. But you cannot ship a change to somebody else's site, so
`verify` will permanently report "criteria NOT met, stays shipped" there. To close the loop
you need a domain you can push a change to.

## What runs with no credentials at all

On a fresh clone, with an empty `.env`, four lanes collect real evidence, so the whole loop
(evidence, claims, ranking, drafted fixes, the review gate) runs before you connect
anything.

| Lane | Surface kind | What it collects | How |
|---|---|---|---|
| `crawl` | site | robots and per-bot access (GPTBot, ClaudeBot, PerplexityBot…), sitemap, hreflang, canonicals, JSON-LD, SSR, Content-Signal | direct polite fetches of the site |
| `geo-panel` | assistant | what ChatGPT and Claude actually answer to your prompt set, and who they cite | the `claude` and `codex` CLIs you are already signed into |
| `community` | site, community | Reddit and Hacker News mentions of the brand, its competitors, and its demand queries (a `community` surface names one platform and gets only that one; a `site` surface sweeps both) | Reddit's public search JSON, HN via Algolia |
| `competitor` | site | the comparison and "best X" pages that rank for your category, and whether they cite you | direct fetches |

One caveat on the community lane, since a table row would overstate it. Hacker News answers
unauthenticated requests fine. Reddit's public search JSON refuses them from some hosts:
from this machine it returns HTTP 403 with and without a User-Agent, and datacenter IPs
appear to be the common case. That is one vantage point, not a universal verdict. Either
way, a non-200 is recorded as could-not-check with the status, never as a measured zero.

A fifth lane, `x`, joins them for free if the `xurl` CLI is on your PATH: it collects X
mentions of the brand on a `site` surface, or on a `community` surface whose platform is
`x`. `X_BEARER_TOKEN` takes precedence when it is set, and the lane falls back to `xurl`
when it is not.

Start with `doctor`: it names what each lane can do right now, and what each missing key
would add and cost.

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
| 6 | `X_BEARER_TOKEN` | X mentions lane (unnecessary if the `xurl` CLI is on your PATH) | Free tier |
| 7 | `ANTHROPIC_API_KEY` | API-billed interpretation for `infer` (falls back to the local `claude` CLI when unset) | Metered |
| 8 | `ANSWERABLE_NOTIFY_WEBHOOK` | Run and review summaries posted to your webhook | Free |

Keys live in `.env` (gitignored) or `~/.config/answerable/env`, which the CLI sources at
startup; real environment variables always win. The engine reads credentials and never
writes them.

## The loop, and the model

A **brand** is the top-level object: the thing being made visible. A brand has
**surfaces**, the places it can show up, and a surface is the unit of work. A `site` is a
website or one locale of one. An `assistant` is an AI answer engine people ask, like
ChatGPT or Claude. A `community` is a forum where the brand is discussed and owns none of
the text, like Reddit or Hacker News.

For each surface the engine walks a loop: **sense** (collect real evidence) → **infer**
(turn evidence into claims that could be wrong) → **decide** (rank them, with a score you
can read factor by factor) → **act** (write the fix) → **approve** (a human says yes) →
**publish** → **verify** (did the change actually go live).

```bash
npx tsx src/cli.ts infer yourdomain-com        # evidence -> claims
npx tsx src/cli.ts decide yourdomain-com       # open claims -> ranked bets
npx tsx src/cli.ts act yourdomain-com          # placed bets -> drafted fixes
npx tsx src/cli.ts preview <asset-id>          # read what it wrote
npx tsx src/cli.ts approve <asset-id>          # the human gate: nothing ships without it
npx tsx src/cli.ts publish <asset-id>          # a PR on your repo, or a spec handoff
npx tsx src/cli.ts verify yourdomain-com       # did it ship?
```

Every station is a separate command. Nothing advances to the next one on its own.

## The verbs

Run `npx tsx src/cli.ts` with no arguments for the current list, grouped as:

- **start**: `brand add`, `doctor`, `onboard`, `draft`
- **brand identity**: `brand list | create | alias | negative`
- **the loop**: `run`, `infer`, `decide`, `act`, `verify`, each on a surface id
- **assets**: `preview`, `edit`, `regenerate`, `approve`, `reject`, `publish`, `outbox`,
  `mark-sent`
- **bets**: `implemented`, `settle`, `cancel`, `dismiss`
- **housekeeping**: `narrate`, `spec`, `pause`, `archive`, `resume`, `tick`

Add `--json` to any verb for a structured result on stdout and nothing else. Exit code 1
means the verb refused, with the reason in `note`.

That is the agent surface. The full contract is in [AGENTS.md](AGENTS.md), and
`.claude/skills/answerable/SKILL.md` teaches a Claude Code session to drive it (copy it to
`~/.claude/skills/` to use it from anywhere).

## Running it continuously

Put `npx tsx src/cli.ts tick` on cron (every 30 minutes is plenty): it runs the surfaces
whose cadence is due and posts the review summary to `ANSWERABLE_NOTIFY_WEBHOOK`. Re-run
`npm ci && npm run db:push` on every upgrade; the schema evolves.

The repo ships no database, on purpose. `db:push` creates it at `data/answerable.db`, and
your first `run` is what fills it. Set `ANSWERABLE_DB_PATH` to point every command at a
different file: a scratch database to experiment in, or the real one on a box.

### Backup

State is one file. Back it up with SQLite's own snapshot, never a file copy, so the
write-ahead log is folded in:

```bash
node -e "require('better-sqlite3')('data/answerable.db').backup('/backups/answerable-$(date +%F).db')"
```

To restore: stop anything using the file, delete any leftover `data/answerable.db-wal` and
`data/answerable.db-shm` sidecars (a stale write-ahead log would replay over the restored
file and undo it), then copy the backup into place. Take a backup before every `db:push`.

## License

MIT.
