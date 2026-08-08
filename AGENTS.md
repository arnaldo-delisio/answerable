# Answerable, agent guide

Give it a domain: it finds what's holding a brand back in Google and AI answers,
generates the fix, gates every world-touching act behind one human approval, and verifies
that the approved change actually shipped. The CLI is the whole product surface, and it is
built to be driven by an agent: every verb takes `--json`, and the interpretation lanes run
on the `claude` and `codex` CLIs you are already signed into, so the loop needs no API keys.

## The model

A **brand** is the top-level object: the thing being made visible. A brand has
**surfaces**, the places it can show up, and a surface is the engine's unit of work — every
station runs per surface. Two kinds today:

- `kind: site` — a website, or one locale of one
- `kind: assistant` — an AI answer engine people ask (ChatGPT, Claude)

(`kind: community-platform` also exists and is unchanged.) The old kind names `web-locale`
and `ai-engine-lane` are gone with no compatibility shim; a config using one is refused
with a message naming its replacement. **Upgrading an install that already has surface
rows:** the rename is not migrated in the database, so rename the `kind:` in each config
and re-run `onboard <file>` on it — onboard updates the existing row's kind and config
snapshot in place. A row left on an old kind value still runs, but `infer` falls
through to its default branch and runs only the generic LLM-sentiment detector — none of
the site or assistant detectors fire, and nothing says so.

`brand add <domain>` is the entry point. It probes the domain, **creates exactly one row —
the brand** — and writes a `config/surfaces/<id>.proposed.yaml` per discovered surface.
It registers no surface: onboarding is what starts collection, and that stays the
operator's confirmation. A refusal (an unusable domain, a brand id that already exists)
writes nothing at all, and the existing-brand check runs before the network probe.

## CLI

Every command is `npx tsx src/cli.ts <verb>` and takes `--json` for machine-readable
output (structured result on stdout, nothing else). Verbs:

- `brand add <domain>` (probe a domain, create the brand, propose its surfaces — the entry point)
- `brand list|create|alias|negative` (see below) · `onboard <file>` · `draft <domain>` (probe one site, propose one config, create no brand)
- `run <surface-id>` → `infer` → `decide` → `act` → `verify` (the loop, one station each)
- `narrate` · `spec <surface-id> <kind>` where kind is `hreflang` | `site-basics` | `bot-block` | `ssr` (`act` runs every kind whose claim is open and bet on; `spec` is the one-off door into the same generator)
- `approve <asset-id>` · `reject <asset-id> <reason>` · `publish <asset-id>`
- `preview <asset-id>` (the generated body itself on stdout)
- `edit <asset-id> [--file <path>]` (replacement body from stdin by default) · `regenerate <asset-id> <feedback>`
- `outbox` · `mark-sent <asset-id>`
- `implemented <bet-id>` · `settle <bet-id> <keep|revise|stop>` · `cancel <bet-id> <reason>` · `dismiss <claim-id>` · `pause|archive|resume <surface-id>`
- `tick` (run due surfaces per cadence, post the review summary webhook)
- `doctor` (lanes, credentials, db, last runs; run this first, always)

Exit code 1 means the verb refused, never a silent no-op. A verb that ran and then refused
carries the reason in `note` in its JSON result; a verb that refuses before doing any work
(unknown `spec` kind, an `onboard` config that is invalid or names a brand that does not
exist, a `verify` on a surface that still has fewer than two runs) prints the reason on
stderr and writes nothing to stdout.

So `--json` puts either exactly one JSON document on stdout or nothing at all, never two.
Where a verb runs a second station internally its result is folded into that one document:
`act` folds its narration pass under `narration`, and `verify` folds under `freshRun` the
run it collects for itself when the surface has fewer than two runs yet (`null` when it did
not need one). `verify` likewise reports bets it could not execution-verify under
`refusals` rather than throwing. `preview` in human mode prints the asset body and nothing
else, so it pipes.

## Brands: what the engine matches on

A brand groups surfaces and carries the identity every mention lane matches against.
`onboard` refuses a config whose `brand:` names a brand that does not exist, so the brand
comes first — `brand add` for a real domain, `brand create` when you are wiring one by
hand:

```bash
answerable brand add acme.com                  # probe, create the brand, propose its surfaces
answerable brand list                          # ids, primary domains, aliases, negative terms
answerable brand create acme acme.com          # aliases seeded: "acme.com", "acme com"
answerable brand alias acme "Acme Labs"        # add an alias (additive)
answerable brand negative acme "Acme Corp"     # set the veto list (no terms clears it)
```

**One matching rule, and these verbs do not bend it.** An identity matches its `aliases`;
its `negativeTerms` veto a match; nothing else. So:

- `create` derives identity from the DOMAIN only — the registrable domain and its spoken
  form. The brand id is a key, not evidence: `create acme acme.com` does NOT make the bare
  word "Acme" matchable, and there is no display-name argument, because a display name is
  a bare token too and bare tokens match ordinary prose. The domain must be a real dotted
  hostname; `create acme acme` and `create acme localhost` are refused, because seeding
  from a dotless host would put a bare token in `aliases` by the back door.
- `alias` is the only way a bare name ever becomes matchable, and only because you typed
  it. Nothing is enabled on your behalf.
- `create` against an existing id is REFUSED, never merged: a merge would rewrite an
  identity you own from an argument meant to create a new one. `brand add` refuses the same
  way, before it probes.
- `brand add` stores the name it observed on the site as the brand's display `name` only.
  A display name is a bare token and bare tokens are never identity here, so it is not an
  alias and nothing matches on it until you type it into `brand alias`.

`npm run db:brands` is the backfill for surfaces already onboarded, not a create. On a
fresh database it groups every ungrouped surface under the brand its own config names,
seeding that brand's aliases from every domain the group's configs target. Once any brand
exists it narrows to surfaces carrying an explicit `brand:` key: those are grouped (and
their brand created if it is missing and a config supplies a domain), while surfaces with
no `brand:` key are left exactly where they are. It never rewrites an existing brand's
identity. A brand's `primary_domain` is a presentation default — for a multi-domain group
it is an arbitrary but deterministic pick, and matching is unaffected because every domain
in the group is an alias. Pick your own by running `brand create` before `db:brands`.

## Mention counts: measured vs candidate

The community and X lanes read a provider's own count for a whole result set, but only
inspect the first handful of hits — and that handful is the only text a brand's negative
terms can be applied to. So when a negative filter is active for a query, the provider-wide
total is reported as `community_mention_candidate_count` / `x_mention_candidate_count`: an
upper bound containing an unknown share of vetoed look-alikes. The headline
`community_mention_count` / `x_mention_count` is derived only from queries no veto applies
to, and when every brand query is filtered the headline is not written at all. A missing
headline means "not measurable here", exactly like share of answer's ungrounded state — it
never means zero.

## What publish does, exactly

Nothing here serves a website. `publish` never puts a page live on the customer domain;
it executes the surface's publishing policy, and there are three outcomes:

- **PR** — the surface config carries `publishing.repo`: the asset markdown travels as a
  real pull request on that repo via the `gh` CLI (fix specs and tool specs under
  `specs/`, answer pages under `pages/`).
- **spec-handoff** — a fix spec or tool spec with no repo configured: the asset is
  marked published with a handoff note on its body, for a human to deliver.
- **staged** — an answer page: the approved body is recorded as the artifact and read
  back with `preview`. With a repo configured it also travels as a PR, and that PR is
  the delivery: if it fails, the publish fails (mode `none`) and the asset stays
  approved rather than reporting a ship that never happened.

Either way the bet moves to `shipped` at publish, and whether the change actually went
live is verify's separate, later fact (`answerable verify`). `implemented <bet-id>` is
the other door into the same place: it ships a bet whose fix was delivered outside this
engine, so it applies to bets that never went through `publish`, and it refuses a bet
publish already shipped. Read what was generated with `answerable preview <asset-id>`. A draft
carrying the engine's own placeholders ("draft-pending", "[NEEDS SOURCE]") is an
incomplete draft: `approve` refuses it, and so does `publish`, until the placeholders are gone.

Two verbs finish such a draft, both restricted to assets still in `generated` (an approved
or published asset is past the gate and is never rewritten underneath it). That rule is
enforced in ONE place, `src/engine/act/asset-write.ts`, through which every generator
writes: a regeneration that would land on an asset the gate has acted on (`approved`,
`published`, `skipped`, `rejected`) refuses with a note and leaves the stored row
byte-identical, whichever verb triggered it:

- `edit <asset-id>` replaces the body with your own text, read from stdin (`cat page.md |
  answerable edit <asset-id>`) or from `--file <path>`. The comparison-page generator
  emits `[NEEDS SOURCE]` cells on purpose rather than inventing facts, so this is how a
  comparison page gets finished. The gate is unchanged: an edited body that still carries a
  placeholder is stored and still refused by `approve`, and the result says so with
  `draftIncomplete: true`.
- `regenerate <asset-id> <feedback>` runs ONE LLM revision pass over the draft with your
  feedback folded in. Never a loop; if the LLM lane is unavailable the stored draft is left
  exactly as it was and the verb refuses with a note.

`approve` records who approved, from `ANSWERABLE_APPROVER` if set, otherwise the `USER`
of the shell that ran it, otherwise `"operator"`. The result reports which of the three it
used as `approvedBySource`, so an explicit approver is distinguishable from an inferred OS
account. Set `ANSWERABLE_APPROVER` on any shared box, in CI, or when an agent approves on
behalf of a named human.

## Cancelling work you will not do: cancel

`dismiss <claim-id>` closes a recommendation, but its bet keeps standing. `cancel <bet-id>
<reason>` is the off-ramp: a `placed` bet moves to the terminal `cancelled` state with the
reason recorded, so no bet is ever stranded with no transition available. Only `placed`
bets can be cancelled — anything shipped is already in the world and gets judged, not
withdrawn. A cancelled bet is not a settlement and teaches the priors nothing: it was
never shipped, so there is nothing to learn from.

Cancellation reaches everything the bet produced: `act` regenerates nothing for it, and
an asset approved before the cancellation is no longer deliverable — `publish` refuses
before opening a PR or writing a handoff, the `outbox` stops listing the draft, and
`mark-sent` refuses it.

## verify: did it ship

`verify` has two legs and they carry very different weight.

**Execution verification is the claim.** It re-collects evidence and compares the same
check keys the claim was made from; a bet is marked exec-verified only when the change is
observably live, and otherwise it stays `shipped` and says which check key failed with
both values. This is concrete and fast.

**Outcome assessment and the learn priors are EXPERIMENTAL.** They run, they are real, and
they are not load-bearing: "did the change move the number" is search attribution, and it
needs a domain you control plus weeks of settled bets before it says anything. The CLI
labels the outcome leg experimental in its own output. Report it that way; do not present
a prior or an outcome note as proof a fix worked.

## Closing the loop: settle

**Any domain you do not control walks the loop only as far as `publish`.** `verify`
re-checks a fix spec's `check_key`s against live evidence, and nobody can ship a change to
somebody else's site — so it correctly and permanently reports "criteria NOT met, stays
shipped", no bet reaches `outcome-assessed`, and `settle` is unreachable. That is `verify` refusing to claim a
fix worked when it was never actually shipped, not a bug. Point a surface at a domain
you control and can ship a change to (repo `publish` can PR against, or a spec you can
hand-deliver) to see `verify` → `settle` close for real.

`verify` takes a bet as far as `outcome-assessed` — it measured what happened. Whether
that was worth repeating is a judgment, and it is yours: `settle <bet-id>
<keep|revise|stop>` records it and moves the bet to `settled`. The learn station's priors
count ONLY settled bets with a settlement ("keep" is the win; "revise" and "stop" are
non-wins), and those priors are a factor in every future `decide` score. Those priors are
the experimental leg above: an unsettled backlog is how they stay empty, and an empty prior
is a neutral multiplier, not a wrong answer.

## Outbox contract

Outreach is a handoff, never a send. `outbox --json` returns approved-unsent drafts as a
structured array (asset id, recipient context, body); without `--json` it prints a readable
summary, like every other verb. The sending party (human or an
authorized agent outside this repo) delivers them through its own mail channel, then
records the fact with `mark-sent <asset-id>`, which is what moves the asset to
published. An asset not marked sent is truthfully still unsent.

## Guardrails (hard)

- **The engine never sends.** No SMTP, no mail API, no auto-posting, ever. Outreach
  leaves only via the outbox contract above.
- **The review gate is load-bearing.** Nothing publishes without an explicit
  `approve` first: agents may generate, rank, and stage, but the approve verb is the
  human's unless a human has delegated it explicitly for a named asset.
- **Never fabricate evidence.** Every claim derives from real collected rows with
  provenance and cost; missing data is reported as an honest gated or empty state, never a
  zero, an interpolation, or an invented history. Do not insert rows the collectors did
  not produce.
- Secrets live in `.env` or `~/.config/answerable/env` (both outside git) only; the
  engine reads them and never writes them, and `doctor` reports presence, never values.
