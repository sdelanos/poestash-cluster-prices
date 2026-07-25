/**
 * League resolution for the trade-API price workers (cluster jewels, split
 * bases).
 *
 * These two differ from every other worker in this repo. The bulk-feed workers
 * (poe.ninja, poe.watch) read a whole league in one request and can afford to
 * refresh the entire priced set, so they discover leagues from their own
 * upstream and price all of them (see `docs/adr/0001`). The trade workers spend
 * one rate-limited search per row and need hours to clear a single league, so
 * they have to commit to exactly one: the current challenge league.
 *
 * Two sources, each answering only what it is authoritative for, in this order:
 *
 *   1. `poe_leagues_cache` (GGG `/leagues`, refreshed by `refresh-leagues.ts`)
 *      picks the league. It says which leagues exist and when they started.
 *      This is the *same* GGG that serves the trade API these workers query, so
 *      a league listed here is a league trade will accept — the lag that makes
 *      GGG the wrong source for a poe.watch worker does not exist here. See
 *      `docs/adr/0002`.
 *   2. `ninja_price_meta` then vetoes that one pick. Both workers convert
 *      listing prices to chaos from `ninja_prices`, so a league poe.ninja has
 *      not priced yet cannot be priced correctly even though trade would answer
 *      for it.
 *
 * The order matters. `ninja_price_meta` retains ended leagues for days, so
 * filtering by it before picking lets a dead league outrank the one that just
 * started — which is precisely the rollover failure this module exists to fix.
 */

import type postgres from "postgres";
import { selectCurrentChallengeLeague } from "./priced-set";

/** Shape stored in `poe_leagues_cache.leagues` by `refresh-leagues.ts`. */
interface CachedLeague {
  id: string;
  startAt?: string | null;
}

/**
 * The league to price, or null when there is nothing to price yet — between
 * leagues, or in the window after GGG lists a new league but before poe.ninja
 * has priced it. Null is absence, not an outage: the caller should exit cleanly
 * rather than fail the run. Throws only when discovery itself is broken, per
 * the three-tier failure contract in CONTEXT.md.
 *
 * Pass `explicit` (an ad-hoc CLI league argument) to bypass resolution
 * entirely, including the poe.ninja veto, so a backfill can target any league.
 */
export async function resolveTradeLeague(
  sql: postgres.Sql,
  explicit: string | undefined,
): Promise<string | null> {
  if (explicit) return explicit;

  const [cacheRow] = await sql<{ leagues: CachedLeague[] }[]>`
    SELECT leagues FROM poe_leagues_cache WHERE game = 'poe1' AND realm = 'pc'
  `;
  const listed = cacheRow?.leagues ?? [];
  if (listed.length === 0) {
    // Tier 1 of the failure contract: discovery itself is broken (no poe1/pc
    // row means refresh-leagues has never succeeded). Fail loud rather than
    // exit 0 and look like a quiet between-leagues gap.
    throw new Error(
      "poe_leagues_cache has no poe1/pc row — refresh-leagues has not populated it. Cannot resolve a league.",
    );
  }

  // Pick from GGG's full list first. Gating on poe.ninja *before* the pick
  // would let an older league that poe.ninja happens to still hold win over
  // the league that actually just started — ninja_price_meta keeps ended
  // leagues around for days, so that is how a rollover silently keeps pricing
  // the dead league.
  const league = selectCurrentChallengeLeague(
    listed.map((l) => ({ name: l.id, startAt: l.startAt })),
  );

  if (!league) {
    console.log("No live challenge league listed by GGG, nothing to refresh.");
    return null;
  }

  // Both workers convert listing prices to chaos from ninja_prices, so a
  // league poe.ninja has not priced yet cannot be priced correctly here. Skip
  // it and pick it up next run rather than fall back to an older league.
  const [priced] = await sql<{ league: string }[]>`
    SELECT league FROM ninja_price_meta
    WHERE game = 'poe1' AND league = ${league}
  `;
  if (!priced) {
    console.log(
      `GGG lists ${league} but poe.ninja has not priced it yet — no chaos conversion available, nothing to refresh.`,
    );
    return null;
  }

  console.log(`Refreshing current challenge league: ${league}`);
  return league;
}
