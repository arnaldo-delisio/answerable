# Answerable

**Answerable finds what is stopping people from finding and choosing you in Google and
in AI answers, generates the fix, and proves whether it worked.**

It is an engine and a command-line tool, built to be driven by a coding agent. Give it a
domain. It collects real evidence about that domain and the places buyers actually look,
turns the evidence into claims it can be wrong about, ranks what to do first with
reasoning you can read, writes the fix, waits for one human approval, and then checks
separately whether the change went live and whether it moved anything.

It is directed and verified, never autonomous. Nothing touches the world without a human
saying yes, and nothing counts as done because the engine said so.

**Who it is for:** anyone who owns a site's growth and works with a coding agent. Point
Claude Code (or any agent that can run a shell) at this repo, tell it to run the loop,
and read what comes back. Every verb takes `--json`, and the interpretation lanes run on
the `claude` and `codex` CLIs you are already signed into, so the whole loop runs with no
API keys at all.

**Start here:** `npx tsx src/cli.ts doctor`.

### The Claude skill

This repo ships a skill at `.claude/skills/answerable/SKILL.md` that teaches a Claude Code
session to drive the loop: station order, the `--json` contract, how long the LLM lanes
really take, and where to stop for the human. It loads automatically when you open Claude
Code in this repo. To use it from anywhere (against a site whose repo is somewhere else):

```bash
cp -r .claude/skills/answerable ~/.claude/skills/
```

The skill assumes it is run from an Answerable checkout, so tell the session where that is.

## What the loop does

Every run walks six stations:

| Station | What happens |
|---|---|
| **sense** | collect evidence: crawl the site, ask AI answer engines real buyer questions, scan communities and competitor pages |
| **infer** | turn evidence into claims, each with a confidence tag and a falsifiability condition (how we would know this claim was wrong) |
| **decide** | rank open claims with a decomposed score you can read factor by factor, never a black-box number |
| **act** | generate the response: a technical fix spec, an answer page, a comparison page, a free tool spec |
| **verify** | two separate questions, never merged: did it go live, and did it improve anything |
| **learn** | settled bets become win-rates per claim class, which steer what gets ranked first next time |

Two ideas hold the whole thing up. **A surface is any place a buyer can find you** (a
locale of your site, an AI answer engine, a community), and all of them share one config
schema, so onboarding a new one is a file, never new code. And **history is a product
function**: the engine writes a metric snapshot every run, so trends read real
accumulated rows from your first collection onward. It makes history; it never fabricates
it.

## Quickstart

You need Node 20+. The quickstart below onboards one web surface and runs its keyless
lanes: crawl, community, competitor. AI-answer probes (ChatGPT and Claude) are a separate
surface kind, config/surfaces/example-geo-chatgpt.yaml and example-geo-claude.yaml, driven
by the `claude` and `codex` CLIs you already have installed and signed in locally (the
`codex` CLI is what talks to ChatGPT), not a billed API; onboard and run those the same way
to see AI-answer evidence. See "Connect your data" below for exactly which lanes are
keyless and which are optional extensions.

```bash
git clone https://github.com/arnaldo-delisio/answerable.git && cd answerable
npm install
npm run db:push                                   # create the SQLite schema
cp .env.example .env                              # optional: only for the extra lanes

npx tsx src/cli.ts doctor                         # what is live, what a key would unlock
npx tsx src/cli.ts draft example.com              # probe a domain, propose a config
npx tsx src/cli.ts onboard config/surfaces/example-com-en.yaml
npx tsx src/cli.ts run example-com-en             # sense: collect the first real evidence

npx tsx src/cli.ts onboard config/surfaces/example-geo-chatgpt.yaml
npx tsx src/cli.ts onboard config/surfaces/example-geo-claude.yaml
npx tsx src/cli.ts run example-geo-chatgpt        # sense: AI-answer probes via codex
npx tsx src/cli.ts run example-geo-claude         # sense: AI-answer probes via claude
```

The repo ships no database. A fresh clone is empty on purpose: `db:push` creates the schema
at `data/answerable.db` and your first `run` is what fills it. Set `ANSWERABLE_DB_PATH` to
point every command (including `db:push`) at a different file instead — a scratch database
to experiment in, or the real one on a box where `data/` is not where you want state to
live.

Then walk the rest of the loop a station at a time, and read what it generated:

```bash
npx tsx src/cli.ts infer example-com-en           # evidence -> claims
npx tsx src/cli.ts decide example-com-en          # open claims -> ranked bets
npx tsx src/cli.ts act example-com-en             # placed bets -> generated assets
npx tsx src/cli.ts preview <asset-id>             # the generated body itself, on stdout
cat page.md | npx tsx src/cli.ts edit <asset-id>  # finish a draft by hand (or --file <path>)
npx tsx src/cli.ts regenerate <asset-id> "..."    # one LLM revision pass with your feedback
npx tsx src/cli.ts approve <asset-id>             # the human gate: nothing ships without it
npx tsx src/cli.ts publish <asset-id>             # PR to your repo, or a spec handoff
npx tsx src/cli.ts verify example-com-en          # did it go live, did it move anything
npx tsx src/cli.ts settle <bet-id> keep           # your verdict: keep | revise | stop
npx tsx src/cli.ts cancel <bet-id> "not doing it" # the off-ramp: a placed bet you will not ship
```

**`example.com` cannot close the loop, and that is expected.** The quickstart walks a
domain nobody controls as far as `publish`, and that is a genuine dry run: onboarding,
evidence collection, claims, ranking, generation, and the review gate all run for real.
But `verify` re-checks a fix spec's `check_key`s against live evidence, and nobody can
ship a change to `example.com` — so it will correctly and permanently report "criteria
NOT met, stays shipped", no bet ever reaches `outcome-assessed`, and `settle` stays
unreachable. That is not a bug or a sign you did something wrong; it is `verify` refusing
to lie about a change that was never actually shipped. To see `verify` → `settle` close
for real, point a surface config at a domain you actually control and can push a change
to (a repo `publish` can open a PR against, or a spec you can hand-deliver), run the loop
against it, ship the fix, and re-run `verify`.

`spec <surface-id> <kind>` generates one technical fix spec on demand; the kinds are
`hreflang`, `site-basics`, `bot-block` and `ssr`. You rarely need it: `act` already
generates a spec for every one of those kinds whose claim is open and carries a bet, so
nothing the engine ranks is left without a way to ship.

`approve` records the approver from `ANSWERABLE_APPROVER` if you set it, otherwise from
the `USER` of the shell you ran it in, otherwise `"operator"` — set the env var on a
shared box or in CI so the audit trail names a person rather than an OS account.

`edit` and `regenerate` exist because some drafts are deliberately unfinished. The
comparison-page generator writes literal `[NEEDS SOURCE]` cells rather than inventing a
competitor's pricing, and `approve` refuses any body still carrying one — so you fill them
in (`edit`) or ask for a revision (`regenerate`), and only then can the page be approved.
Editing is restricted to drafts still awaiting review, and it never weakens the gate.

`settle` is the step people skip, and it is the one that makes the engine get better.
`verify` measures; `settle` is your keep / revise / stop verdict on what it measured. Only
settled bets feed the learn station's priors, and those priors reweight every future
`decide` ranking. Leave bets at `outcome-assessed` and the loop stays open.

Add `--json` to any of them for a structured result on stdout and nothing else: that is
the agent surface, and the full contract is in [AGENTS.md](AGENTS.md).

The quickstart creates no brand row, and it does not need one: an AI-answer surface
declares the web surface it `observes`, and that config already carries your domain, so
the engine matches answers against your domain and its spoken form from the first run.

A brand groups several surfaces and carries the identity every mention lane matches
against. The brand has to exist before the config that names it: `onboard` refuses a config
whose `brand:` key names a brand that is not there yet. So create it first, then point
configs at it:

```bash
npx tsx src/cli.ts brand create acme acme.com      # aliases seeded: "acme.com", "acme com"
npx tsx src/cli.ts brand alias acme "Acme Labs"    # add an alias you want matched
npx tsx src/cli.ts brand negative acme "Acme Corp" # tokens that mean it is NOT you
npx tsx src/cli.ts brand list                      # what each brand currently matches on
# then add `brand: acme` to each surface config and onboard it again
```

The identity comes from the domain and nothing else. The brand id is a key, not evidence:
creating `acme` does not make the bare word "Acme" matchable, and there is no display-name
argument to give, because a bare token matches ordinary prose ("For example, ..." should
never count as a mention of example.com). Listing a name in `alias` is the only way it is
ever matched, and it happens because you typed it. Creating a brand whose id already exists
is refused rather than merged over.

Negative terms change what the mention lanes are willing to claim. Those lanes read a
provider's count for a whole result set but only inspect the first few hits, and that
handful is the only text a negative term can be applied to — so once a veto is active for a
query, the provider-wide total is reported as `community_mention_candidate_count` (an upper
bound that still contains look-alikes) instead of as owned mentions. The headline
`community_mention_count` is derived only from queries no veto applies to, and if every
brand query is filtered it is not written at all. A missing headline means "not measurable
here", never zero. The X lane works the same way.

`npm run db:brands` is the backfill for surfaces you onboarded before you had brands: it
reads them and, for each one not yet in a brand, creates the brand row its own config names
(the `brand:` key, or an id derived from the surface's domain) and points the surface at it.
It seeds that brand's aliases from every web target domain the group's configs name — each
domain and its spoken form — so the new brand grounds exactly the mentions the
domain-derived fallbacks already grounded, including the group's second and third domains.
It never turns the `brand:` key itself into an alias, invents no product names and no
negative terms, and never rewrites an existing brand's identity. A brand whose configs name
no domain is left ungrouped and reported rather than given an identity guessed from its
name — create it yourself with `brand create`. Once any brand exists, `db:brands` narrows
to surfaces carrying an explicit `brand:` key and leaves everything else exactly where it
is, so re-running it is safe. A brand's primary domain is a display default; for a group
spanning several domains it is an arbitrary deterministic pick, and matching is unaffected
because every domain is an alias.

You are never worse off for having run `db:brands`. If no brand exists, share of answer
reads as an explicit "not checked" state rather than 0%, and no visibility or brand-defense
finding is raised: the engine never reports an absence it did not look for.

## Connect your data

Answerable runs keyless out of the box: site crawls, AI-answer panels (ChatGPT and Claude,
via the CLIs already on your box), community scans, and competitor pages need no
credentials at all. The table below is the optional layer — every row is a lane the engine
already runs without it; each key you add just unlocks a deeper or additional one (X
mentions included: it needs `X_BEARER_TOKEN` or an authenticated `xurl`, so it is optional,
not keyless). Start with `npx tsx src/cli.ts doctor`: it reads your environment, shows
every lane's status, and names exactly what each missing key would unlock and what it
costs.

| Priority | Credential (`.env.example`) | Unlocks | Cost |
|---|---|---|---|
| 1 | `GSC_OAUTH_CLIENT_ID` / `GSC_OAUTH_CLIENT_SECRET` / `GSC_OAUTH_REFRESH_TOKEN` / `GSC_SITE_URL` | Google Search Console: real indexation coverage, queries, impressions and clicks per path. The single highest-value connection. Shortcut: instead of an OAuth dance, ask whoever owns the Google account to add a service account as a restricted user on the Search Console property, then point `GOOGLE_APPLICATION_CREDENTIALS` at its key file. | Free |
| 2 | `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` | Rank tracking, keyword volumes, backlinks, LLM-mentions | Cents per query, budget-guarded |
| 3 | `PAGESPEED_API_KEY` | Real Core Web Vitals via PageSpeed Insights | Free |
| 4 | `GOOGLE_APPLICATION_CREDENTIALS` + `GA4_PROPERTY_ID` | GA4: conversions on the pages the fixes touch | Free |
| 5 | `BING_WEBMASTER_KEY` | Bing Webmaster coverage + submission | Free |
| 6 | `X_BEARER_TOKEN` | X mentions lane | Free tier |
| 7 | `ANTHROPIC_API_KEY` | API-billed interpretation for the infer station (falls back to the local `claude` CLI when unset) | Metered |
| 8 | `ANSWERABLE_NOTIFY_WEBHOOK` | Run and review summaries posted to your webhook | Free |

Keys live in `.env` (gitignored) or in `~/.config/answerable/env`, which the CLI sources
at startup; real environment variables always win. The engine reads credentials and never
writes them. A lane without its key shows as an honest gated state in `doctor`, never a
zeroed metric.

## Where surfaces go next

Everything the engine watches is a surface behind one config schema, and today that means
websites per locale, AI answer engines, and communities. The same shape is the direction of
travel: any place a buyer can discover you (an app store listing, a GitHub repository, a
LinkedIn page, a docs site, a marketplace listing) becomes one adapter and one row in the
coverage matrix, added when real evidence for it arrives, never as a speculative empty kind.

## Running it continuously

There is no server and nothing to deploy: an install is this repo, one SQLite file, and an
env file. On a box:

```bash
npm ci && npm run db:push       # install and create/upgrade the schema
```

Then put `npx tsx src/cli.ts tick` on cron (every 30 minutes is plenty) to run the
surfaces whose cadence is due and post the review summary to `ANSWERABLE_NOTIFY_WEBHOOK`.
Run `npm run db:push` on every upgrade before the next tick; the schema evolves.

### Backup

The entire state is one file: `data/answerable.db`, or `ANSWERABLE_DB_PATH` if you
override it. Back it up with SQLite's own snapshot, not a file copy, so the write-ahead
log is folded in:

```bash
node -e "require('better-sqlite3')('data/answerable.db').backup('/backups/answerable-$(date +%F).db')"
```

To restore: stop anything using the file, remove any existing `data/answerable.db-wal` and
`data/answerable.db-shm` sidecars (a stale write-ahead log left behind would otherwise
replay against the restored file and defeat the restore), then copy the backup into place
as `data/answerable.db`. Take a backup before every schema push.

## License

MIT.
