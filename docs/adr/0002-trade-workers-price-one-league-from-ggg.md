# Trade-API workers price a single league, resolved from GGG's league list

## Context

ADR 0001 has every price worker discover its leagues from its own upstream and
refresh the whole priced set. That works for the bulk-feed workers: poe.ninja
and poe.watch each serve a league in one request, so pricing four leagues costs
four requests.

The two trade-API workers — `refresh-cluster-prices` (cluster jewel combos) and
`refresh-split-prices` (split base markets) — do not fit that shape. They spend
one rate-limited search per row against the PoE trade API, bound by 30 requests
per 300s. Cluster alone has ~2800 combos at ~10s each: roughly 8 hours of wall
clock for *one* league. They cannot refresh a priced set, so they have to pick
exactly one league.

Both were pinned to a hardcoded `"Mirage"` default. At the Allflame rollover they
kept running on schedule and kept writing the ended league, leaving the Cluster
Craft page and the Base Splitting strategy empty for every user.

## Decision

The trade workers resolve one league at run time: the newest live softcore
challenge league, from two sources, each answering the part it is authoritative
for (`lib/trade-league.ts`).

- **`poe_leagues_cache`** — GGG's `/leagues`, refreshed hourly by
  `refresh-leagues.ts` — decides which leagues exist, when they started, and
  which one is picked.
- **`ninja_price_meta`** — the leagues poe.ninja has priced — then vetoes that
  single pick. Both workers convert listing prices to chaos from `ninja_prices`,
  so a league poe.ninja has not priced cannot be priced correctly here.

**The order is load-bearing.** `ninja_price_meta` retains ended leagues for days
(it held Ancestors and Mirage rows well after both ended), so filtering by it
*before* picking lets a dead league be the only candidate left and win — exactly
the rollover failure above. Pick from GGG, then veto.

The pick itself is `selectCurrentChallengeLeague` in `lib/priced-set.ts`,
alongside `selectPricedSet`, so all league classification stays in one module.
It follows the app's `detectDefaultLeague`: newest `startAt` wins, permanent and
SSF/Ruthless/Hardcore variants excluded.

One deliberate divergence from the app: the worker also skips a league whose
`startAt` is still in the future. GGG publishes the next league before it goes
live, and trade has no listings for it yet, so pricing it early wastes the rate
limit budget on empty searches. The app has no such filter, so during that
pre-launch window the selector can default to a league the workers are not yet
pricing. That window closes at launch, and the alternative — the workers
committing their whole budget to a league with no economy — is worse.

`refresh-cluster-prices` additionally seeds the new league's combo rows from the
most recently refreshed existing league. Its refresh loop only ever `UPDATE`s,
and the combo catalog lives nowhere but this table, so a league with no rows
reads as "nothing due" and would never be priced. Split already self-seeds
through its upsert.

## Considered options

**Reading `poe_leagues_cache`, which ADR 0001 rejects.** That rejection is about
sources that *lag* GGG: a worker that takes a new league name from GGG and hands
it to poe.watch gets `400 "league doesn't exist"` for hours-to-days. The trade
workers query the PoE trade API — the same GGG that publishes the list — so a
league GGG lists is a league trade will accept, and the failure mode ADR 0001
guards against cannot occur. The lagging dependency here is poe.ninja, for
currency conversion only, and that is what the `ninja_price_meta` gate covers.

**Discovering from `ninja_price_meta` alone**, the way `refresh-temple-prices`
does. Rejected: it carries no start dates, and it retains ended leagues. Temple
never has to choose — it prices every league it finds — so recency is enough for
it and not for a worker that must pick one. Picking the most recently refreshed
row would break during the dual-list window, when both leagues are fresh.

**Falling back to Standard when no challenge league is live.** Rejected: it
would spend the entire rate-limit budget writing rows no page reads. The
resolver returns null and the worker exits cleanly, matching the three-tier
failure contract.

## Consequences

- Rollovers need no workflow edit or backfill for either worker.
- The trade workers price the softcore challenge league only — no Hardcore
  variant. That is the pre-existing scope; the rate limit does not allow more.
- There is a window after a league launches where GGG lists it but poe.ninja has
  not priced it. The workers log that and exit 0 without pricing anything, then
  pick the league up on the next run. They do *not* fall back to the previous
  league — a few hours of no new data beats hours of data for a dead economy.
- A missing `poe_leagues_cache` poe1/pc row throws (tier 1 of the failure
  contract): discovery is broken, and a silent exit 0 would look like an
  ordinary between-leagues gap.
- ADR 0001 still holds for every bulk-feed worker. This is a documented
  exception for the trade-API workers, not a replacement.

## Not changed

`refresh-ultimatum-prices` was reported as pinned in the originating issue
(sdelanos/poestash#57) but was not. It has discovered leagues from poe.watch
since ADR 0001, and showed zero Allflame rows at the time of the report only
because poe.watch had not yet indexed the new league — the documented skip-and-
continue behaviour, working as designed. It picked Allflame up on its own once
poe.watch began serving it, with no code change.
