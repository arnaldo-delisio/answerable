---
name: answerable
description: Drive the Answerable engine from the CLI — add a brand, audit its visibility in Google and AI answers, turn evidence into claims, rank and draft fixes, take them to the human review gate, and verify afterwards that the change actually shipped. Use when the user asks to audit, improve, or measure a brand's search or AI-answer visibility with this repo.
version: 1.1.0
triggers: [answerable, brand add, audit my site, search visibility, AI answer visibility, share of answer, run the loop, why don't I show up in ChatGPT]
tags: [seo, aeo, geo, audit, cli, agent-driven]
allowed-tools: Bash Read Write
prerequisites:
  commands: [node, npx]
  optional-commands: [claude, codex, gh]
---

## What this is

Answerable is an engine plus a CLI. It collects real evidence about a domain, turns it
into falsifiable claims, ranks fixes, drafts them, **waits for a human to approve**, and
afterwards checks whether the change actually went live.

**The model.** A **brand** is the top-level object: the thing being made visible. A brand
has **surfaces**, the places it can show up, and the surface is the engine's unit — every
station runs per surface. A brand has sites it owns, assistants people ask, and communities
where it is discussed. Three kinds:

- `kind: site` — a website, or one locale of one
- `kind: assistant` — an AI answer engine people ask (ChatGPT, Claude); it declares the
  site surface it `observes`
- `kind: community` — a forum where the brand is discussed and owns none of the text
  (`target: {platform, query_set}`, platform being `reddit` | `hacker-news` | `x`; it
  declares what it `observes` too). Keyless on Reddit and HN. `brand add` never proposes
  one — copy `config/surfaces/example-community-hn.yaml` and write it by hand, and
  only when the brand actually has a presence on that platform.

The old names `web-locale`, `ai-engine-lane` and `community-platform` were renamed with no
compatibility shim — a config using one is refused with a message naming its replacement.
If you have an example memorised, it is out of date.

**`brand add <domain>` is the entry point.** It probes the domain, creates ONE row (the
brand), and writes a `config/surfaces/<id>.proposed.yaml` per surface it found. It
registers no surface: `onboard` is what starts collection, and that is the operator's
call.

There is no server and no dashboard. The CLI is the whole product surface. Every verb is
`npx tsx src/cli.ts <verb>` from the repo root (`npm run answerable -- <verb>` is the same
thing). State is one SQLite file, `data/answerable.db` (or `ANSWERABLE_DB_PATH`).

**Always start with `doctor`.** It reports which lanes can run, which CLIs are present,
and the db state. Never guess what is connected.

```bash
npx tsx src/cli.ts doctor
```

## The loop, and why the order is the order

Each station consumes what the previous one wrote. Running one out of order does not
error, it just finds nothing to work on.

| Station | Verb | Reads | Writes |
|---|---|---|---|
| onboard | `onboard <file>` | a surface yaml in `config/surfaces/` | a surface row |
| sense | `run <surface-id>` | the surface config | evidence rows + metric snapshots for this run |
| infer | `infer <surface-id>` | the latest run's evidence | claims (each with confidence + a falsifiability condition) |
| decide | `decide <surface-id>` | **open claims** | ranked scores, and a placed bet per claim worth acting on |
| act | `act <surface-id>` | **placed bets** | generated assets (fix specs, answer pages, comparison pages, quick-answer AEO blocks, outreach drafts, tool specs) + narration |
| gate | `approve` / `reject` | a generated asset | approved or rejected state — **human decision, see below** |
| publish | `publish <asset-id>` | an approved asset | a PR or a spec handoff; the bet moves to `shipped` |
| verify | `verify <surface-id>` | two runs + shipped bets | run-over-run diff and the did-it-ship check (plus an experimental outcome assessment) |
| settle | `settle <bet-id> <keep\|revise\|stop>` | an **outcome-assessed** bet | the settlement that feeds future `decide` priors |

`decide` comes after `infer` because it ranks *claims*, and claims only exist once `infer`
has read the run's evidence. `act` generates only for *placed bets*, which only `decide`
creates. `settle` refuses a bet that `verify` has not taken to `outcome-assessed`:

```
$ npx tsx src/cli.ts settle bet:example-com-en:bot-block keep --json
{ "ok": false,
  "note": "bet bet:example-com-en:bot-block: cannot move to \"settled\" from \"shipped\" (requires \"outcome-assessed\")" }
```

A first pass, end to end:

```bash
npx tsx src/cli.ts doctor
npx tsx src/cli.ts brand add acme.com                   # creates the brand, proposes its surfaces
# read and edit each proposal, then drop the .proposed:
mv config/surfaces/acme-com.proposed.yaml config/surfaces/acme-com.yaml
npx tsx src/cli.ts onboard config/surfaces/acme-com.yaml
npx tsx src/cli.ts run acme-com --json
npx tsx src/cli.ts infer acme-com --json
npx tsx src/cli.ts decide acme-com --json
npx tsx src/cli.ts act acme-com --json
npx tsx src/cli.ts preview <asset-id>                   # read what it wrote, before anyone approves
# STOP. Show the human the drafts and the ranking. `approve` is theirs.
```

## Every verb

Grouped by what they are for. All of them take `--json`.

**Setup**
- `brand add <domain>` — the entry point: probe a domain, create the brand, write a proposed config per site and assistant surface it found, plus a community surface only where one can actually be collected (reddit/hacker-news only where a keyless mention check found the brand really is discussed there; `x` only where the site links an X profile and the box has `xurl` or `X_BEARER_TOKEN`). Anything found with no collector — store listings, GitHub, LinkedIn — is reported, never proposed. Each site proposal lists, commented out, the competitor names read off the brand's own comparison-page titles; `competitors:` ships empty and valid because the probe cannot know a competitor's own URL and the competitor lane fetches that URL. Uncomment the real ones and supply their URLs — the comparison-page and outreach generators key off competitor claims. Refuses (writing nothing) if the brand already exists.
- `doctor` — credentials, CLIs, db, last run per surface.
- `draft <domain>` — probe one site and write one proposed site config; creates no brand. Use it to add a site to a brand that already exists.
- `onboard <file>` — validate and register a surface config (re-onboarding updates it).
- `brand list` · `brand create <id> <domain>` · `brand alias <id> <term>...` · `brand negative <id> [term]...`

**The loop**
- `run <surface-id>` · `infer <surface-id>` · `decide <surface-id>` · `act <surface-id>` · `verify <surface-id>`
- `narrate` — plain-language narration for open claims and placed bets (`act` already does this pass at its tail).
- `spec <surface-id> <kind>` — generate one fix spec on demand; kinds are `hreflang`, `site-basics`, `bot-block`, `ssr`. It writes `specs/<surface-id>-<kind>.md`. Rarely needed: `act` generates every kind whose claim is open and bet on.

**Assets**
- `preview <asset-id>` — the generated body on stdout (human mode prints the body alone, so it pipes).
- `edit <asset-id> [--file <path>]` — replace a draft's body; stdin by default (`cat page.md | npx tsx src/cli.ts edit <asset-id>`).
- `regenerate <asset-id> <feedback>` — ONE LLM revision pass with your feedback. Never a loop.
- `approve <asset-id>` — the review gate. **Human.**
- `reject <asset-id> <reason>` — gate refusal; feeds the learn station as negative signal.
- `publish <asset-id>` — execute the surface's publishing policy.
- `outbox` — approved-unsent outreach drafts (`--json` for the structured array).
- `mark-sent <asset-id>` — record that an outreach draft was actually sent by someone else.

**Bets and claims**
- `implemented <bet-id>` — a fix shipped outside this engine; queues exec-verify for the next `verify`.
- `settle <bet-id> <keep|revise|stop>` · `cancel <bet-id> <reason>` (placed bets only, terminal) · `dismiss <claim-id>`

**Lifecycle**
- `pause|archive|resume <surface-id>` · `tick` (run every surface whose cadence is due, print the review summary, post it to `ANSWERABLE_NOTIFY_WEBHOOK` if set).

## The `--json` contract

`--json` on any verb prints the structured result on stdout and nothing else. Parse it; do
not scrape the human text. Exit code 1 means the verb refused — never a silent no-op.

- **One document, always.** No verb prints two. Where a verb runs a second station
  internally, that station's result is folded into the same document: `act --json` carries
  its narration pass under `narration`, and `verify --json` carries under `freshRun` the
  run it collects for itself when the surface has fewer than two runs yet (`null` when it
  did not need one).
- **Refusals come in two shapes.** A verb that ran and then refused puts the reason in
  `note` in its JSON result. A verb that refuses before doing any work — an unknown `spec`
  kind, an `onboard` config that is invalid or names a brand that does not exist, a
  `verify` on a surface that still has fewer than two runs — prints the reason on
  **stderr** and writes nothing to stdout. Either way the exit code is 1. So stdout is
  either exactly one JSON document or empty: check the exit code before parsing.
- **`outbox --json` is a JSON array**, empty when nothing is awaiting delivery. Without
  `--json` it prints a readable summary, like every other verb.

## Timings: this is not a hang

`infer`, `act`, `regenerate` and the AI-answer lanes shell out to the local `claude` and
`codex` CLIs. They print progress to stderr (`act: querying claude for narration for ...`,
`sense: querying claude (3/8): ...`). Measured on one Linux box against `example.com`:

| Command | Observed |
|---|---|
| `run` on a web surface (crawl + community + competitor + x) | ~1 min |
| `run` on an AI-answer surface, 8 prompts via `claude` | ~1.5 min |
| `infer` | ~12 s |
| `act` (5 bets: 4 fix specs, 1 answer page, 11 narrations) | ~1.8 min |
| `verify` (includes collecting a run) | ~1 min |
| `draft <domain>` (12 pages crawled) | ~9 s |
| `brand add <domain>` (probes the site, its subdomains, robots + sitemap, and crawls up to 12 pages for comparison-page titles) | ~10-30 s |
| `tick` with nothing due | ~1.5 s |

Bigger prompt sets and more bets scale these up. Several minutes with stderr progress is
normal. Do not kill it, and do not report it as a hang.

## The review gate: you do not hold it

**`approve` is the human's decision.** The engine generates, ranks, drafts and stages. Your
job is to get work to the gate and stop there, with the drafts previewed and the ranking
explained. Do not run `approve` unattended, do not batch-approve, and do not approve
"so the demo can continue".

`approve` records who approved: `ANSWERABLE_APPROVER` if set, else the shell's `USER`, else
`"operator"`, and it reports which under `approvedBySource`. If a human has explicitly
delegated approval of a named asset to you, set `ANSWERABLE_APPROVER` to their name so the
audit trail says a person, not an OS account.

**Stop and ask the human:**
- before any `approve`,
- before any `publish` that targets a real repo (it opens a real PR via `gh`),
- before `mark-sent` (it asserts a message was actually delivered),
- when a claim's evidence looks thin — low confidence, one sampled page, or a claim resting
  on a mention count you cannot see the underlying hits for. Say so; do not launder it into
  a confident recommendation.

## Honesty rules you must not break

These are what the product is. Breaking one is worse than not finishing the task.

1. **Never fill a `[NEEDS SOURCE]` placeholder with an invented fact.** The comparison-page
   generator emits those cells deliberately rather than guessing a competitor's pricing.
   `edit` exists so a real source can be supplied — by a human, or by you *after actually
   looking it up and citing where it came from*. `approve` refuses a body still carrying a
   placeholder, and says so:

   ```
   $ npx tsx src/cli.ts approve asset:example-com-en:site-basics:fix-spec --json
   { "state": "generated",
     "note": "draft still carries engine placeholders (draft-pending / [NEEDS SOURCE]); regenerate or fill them before approving" }
   ```
   `edit` reports the same fact as `"draftIncomplete": true`. Do not route around it.

2. **A gated or unmeasured metric is never zero.** A lane without its key shows as gated in
   `doctor`, and so does a lane that cannot key on anything: DataForSEO needs a domain, so
   on an assistant surface (the only non-site kind its lane matrix allows) it writes a gated
   row and spends nothing — enable it on the site surface being observed. When a brand's negative terms filter every query, the headline
   `community_mention_count` / `x_mention_count` is *not written at all* and the
   provider-wide total appears as `community_mention_candidate_count` /
   `x_mention_candidate_count` — an upper bound containing look-alikes. Missing means "not
   measurable here". Report it that way. Same for share of answer's ungrounded state.

3. **The engine never sends anything.** No SMTP, no mail API, no auto-posting. `outbox`
   hands you approved-unsent drafts (`--json` for the structured array); a human or an
   authorized agent outside this repo delivers them, and only then does `mark-sent` record
   it. An asset not marked sent is truthfully unsent.

4. **Never insert evidence the collectors did not produce.** Every claim traces to real
   rows with provenance and cost. Do not write to the db by hand.

5. **`publish` does not put a page on the customer's site.** It executes the surface's
   publishing policy: a PR on `publishing.repo` via `gh`, or a `spec-handoff` note for a
   human to deliver, or a staged answer page. Whether the change actually went live is
   `verify`'s separate, later fact.

6. **`verify` proves one thing: did it ship.** Execution verification re-collects evidence
   and compares the claim's own check keys, so "exec-verified" means the change is
   observably live. Say that. The **outcome assessment and the learn priors are
   experimental**: real and running, but "did it move the number" is search attribution and
   needs a domain the user controls plus weeks of settled bets before it means anything.
   The CLI labels the outcome leg experimental in its own output. Never present a prior or
   an outcome note as proof a fix worked.

## Where the loop stops on a domain you do not control

Against `example.com`, or any domain the user cannot ship a change to, the loop runs for
real as far as `publish` — onboarding, evidence, claims, ranking, generation and the review
gate all genuinely work. Then it stops, correctly:

```
$ npx tsx src/cli.ts verify example-com-en
  bet bet:example-com-en:bot-block: criteria NOT met, stays shipped
    crawl/bot-access@v1/GPTBot: required "pass", got "blocked"
      claim evidence: {"http_status":404,...}
      verify run:     {"http_status":404,...}
  outcome (experimental): no exec-verified bets to assess
```

That is `verify` refusing to claim a fix worked when nobody shipped it. No bet reaches
`outcome-assessed`, so `settle` is unreachable and the learn priors stay empty. **Tell the
user this before the demo, not after.** Closing the loop needs a domain they control and
can ship to: a repo `publish` can PR against, or a spec they can hand-deliver.

## Notes that save a session

- **`onboard` refuses a config naming a brand that does not exist.** `brand add acme.com`
  creates it (and proposes the surfaces); `brand create acme acme.com` is the by-hand door. Identity comes from the domain only — `create acme acme.com`
  does *not* make the bare word "Acme" matchable, because bare tokens match ordinary prose.
  `brand alias` is the only way a name becomes matchable, and only because someone typed it.
  `brand create` against an existing id is refused, never merged.
- **Surface config schema:** `onboard` validates against `src/engine/lib/surface.ts` and
  refuses with `config error: ...`. The shipped `config/surfaces/*.yaml` files are the
  working examples — a `site`, an `assistant` with `observes:` pointing at the site it
  is measured against, and a `community` naming one platform. Start from `brand add`'s proposals and one of those, never from
  memory: a config saying `kind: web-locale`, `kind: ai-engine-lane` or
  `kind: community-platform` is refused, with the new name in the message.
- **Assets past the gate are never rewritten.** `edit` and `regenerate` work only on assets
  still in `generated`; on `approved`, `published`, `skipped` or `rejected` they refuse and
  leave the stored row byte-identical.
- **`cancel` is the off-ramp** for a placed bet nobody will ship. It is terminal, it teaches
  the priors nothing (nothing shipped, nothing to learn), and it disarms everything the bet
  produced: `publish` refuses, the draft leaves the `outbox`, `mark-sent` refuses.
  `dismiss <claim-id>` closes the recommendation but leaves its bet standing.
- **`settle` is the step people skip and the one that makes ranking improve.** Only settled
  bets feed the priors that reweight every future `decide`.
- The repo ships no seeded database; a fresh clone is empty by design. `npm run db:push`
  creates the schema, and again after every upgrade.
- To try things without touching a live install, point `ANSWERABLE_DB_PATH` at a scratch
  file and run `npm run db:push` against it.
