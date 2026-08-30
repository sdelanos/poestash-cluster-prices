# The Warrant corpus samples the public stash river, and never enumerates

## Context

A Warrant is the one stash row the app never prices. Every copy is a distinct
combination — six Mercenary skills, ten to eighteen distinct (support, tier)
pairs — so nothing aggregates it, and the app shows a trade search instead of a
figure (app ADR 0060). That ADR left one question open and set the bar for
answering it: *show that an extra filter separates prices, the way Infamous was
shown not to.* Answering it needs a market sample, and there was no way to get
one.

The obvious way is a worker enumerating combinations against the trade API. It
is not slow, it is arithmetically impossible. App ADR 0022 pins the trade budget
at 30 requests per 300s, metered on our whole application identity and already
shared by four workers, against hundreds of supports and tiers. The cluster
worker spends eight hours on 2,800 combos; the Warrant keyspace has no bound at
all.

## Decision

> **The Warrant corpus is a bounded sample of the public stash river, seeked to
> by bisection, aggregated in memory, and stored only as per-(support, tier)
> contrasts. No combination is ever enumerated and no observation is ever
> stored in Postgres.**

Four things follow from that sentence, and each was measured live before it was
built (2026-08-30, Allflame).

**The river is a different budget.** `/public-stash-tabs` meters under
`public-stash-tabs-request-limit-pc` — `Ip=2:1:60`, two requests a second per IP
— on a `service:psapi` token this application already holds. It costs zero trade
budget, so this worker never competes with the four that share ADR 0022's
window. Pacing still comes off the response headers via `lib/rate-limit.ts`
rather than a constant, and a 429 is waited out rather than raced.

**The market samples itself.** Warrants were 3.31% of every item crossing the
river (7,909 of 238,630 in 250 pages), and 90% of them carried a parseable
price. The whole listed Warrant market cycles past in minutes, so the
combinations arrive on their own, weighted by how often people actually list
them. That is a better sample than an enumeration would have been, not a
consolation prize.

**The head is reachable by bisection, and is never a constant.** GGG accepts
synthetic change ids — five identical components — and seeks to the nearest real
position. So a run finds the live tail by halving a bracket: twelve requests,
about six seconds. It matters that this is re-derived every run. The originating
issue measured the head near `5.2e9`; by implementation that position returned
an empty page and the live tail was `3.47e9`. A pinned constant would have gone
stale within days and *silently*, because an empty page is not an error.

**A run is a sample, not a stream.** No cursor is persisted. Each run seeks,
steps back a fixed distance to give itself a backlog to drain at full pace,
drains a bounded number of pages, and stops. A late, interrupted or repeated run
therefore samples a *later slice of the same market* — there is no catch-up
debt, no staleness bug, and nothing to corrupt. Idempotence within a run comes
from deduping on GGG's item id, because a tab crossing the river twice
republishes every item in it.

## Considered options

**Log every observation and aggregate in SQL.** Rejected on cost, which is the
main design constraint here. At the measured rate that is ~1.25M rows and
~500MB a day, and the database would double inside a week. `ultimatum_prices` is
the precedent worth matching instead: 24,115 combinatorial rows in 8MB, written
as the derived artifact. The corpus aggregates in the worker's memory and writes
198 rows for a league.

**Store nothing and analyse in the worker.** Rejected: the finding has to be
re-checkable, and a run that prints a conclusion to a CI log leaves nothing to
re-analyse when the answer is challenged or the league turns over. The raw
sample is kept as an NDJSON Actions artifact on this public repo — free, outside
Postgres, and deleted on the retention window rather than accumulating.

**A ratio of medians as the separation statistic.** Rejected *by* the first live
sample, which is the whole reason it is worth recording. Warrants are priced in
round divine: 6,967 Allflame listings had a median of exactly 1 divine, and so
did nearly every subgroup. A ratio of medians could therefore only ever return
1.00 or 2.00, collapsing two orders of magnitude of real spread into two
possible answers. The corpus stores a rank statistic instead — the probability
that a Warrant carrying the pair is priced above one that is not, ties as half
(Mann-Whitney), where **0.5 means the axis separates nothing**. Medians and
quartiles stay on the row because they are what a human reads; the AUC is what a
claim gets made on.

## Consequences

- **The corpus is bounded by construction.** The key is
  `(league, support_hash, tier)` and every run overwrites it, so the table stays
  at a few hundred rows a league however long the worker runs. 198 rows in the
  first live sample.
- **Only leagues poe.ninja has priced enter the corpus**, because chaos
  conversion reads `ninja_prices` like the other trade workers. That is also
  what keeps private leagues (`Some League (PL12345)`) out on their own, with a
  minimum sample size behind it as a second gate.
- **Prices in a currency with no chaos rate leave the corpus** rather than
  entering it at a guessed value — 15 observations of 7,103 in the first run.
  Currency Exchange listings (`~price N offer`) are excluded the same way: the
  number is a ratio, and read as an amount it makes a 1-chaos Warrant.
- **The corpus stores two contrasts, not one, and the second is the one to
  read.** A league-wide contrast is confounded — a support rolls on some builds,
  so its baseline is a different population — and it hid the only real effect in
  the data. Every row therefore also carries `stratified_auc`, computed inside
  identical-skill-set strata, plus the count of strata favouring the pair.
- **The measurement it was built for found exactly one axis**: `Return T3`, at a
  stratified AUC of 0.668 across 28 strata, favoured in 26 (p = 0.0033). That
  clears the bar app ADR 0060 set for narrowing a Warrant query, and leaves
  whether to narrow it as a product question. Details in the app repo at
  `docs/research/warrant-support-price-separation.md`.
- **This worker feeds no player-facing figure.** Nothing in the app reads
  `warrant_support_price_samples`, and a Warrant stays unpriced (app ADR 0034):
  one axis at 0.668 explains a modest part of a two-orders-of-magnitude spread.
