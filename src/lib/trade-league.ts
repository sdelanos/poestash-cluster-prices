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
 * Two sources, each answering the part it is actually authoritative for:
 *
 *   - `poe_leagues_cache` (GGG `/leagues`, refreshed by `refresh-leagues.ts`)
 *     says which leagues exist and when they started. This is the *same* GGG
 *     that serves the trade API these workers query, so a league listed here
 *     is a league trade will accept — the lag that makes GGG the wrong source
 *     for a poe.watch worker does not exist here. See `docs/adr/0002`.
 *   - `ninja_price_meta` says which leagues poe.ninja has priced. Both workers
 *     convert listing prices to chaos using `ninja_prices` rows, so a league
 *     with no poe.ninja data yet cannot be priced correctly even though trade
 *     would answer for it.
 *
 * The answer is the newest live challenge league present in both.
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
 * has priced it. Null is absence, not an outage: the caller should exit
 * cleanly rather than fail the run.
 *
 * Pass `explicit` (an ad-hoc CLI league argument) to bypass resolution
 * entirely, including the poe.ninja gate, so a backfill can target any league.
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
    console.log(
      "poe_leagues_cache has no poe1/pc row yet — run refresh:leagues first. Nothing to refresh.",
    );
    return null;
  }

  const pricedRows = await sql<{ league: string }[]>`
    SELECT DISTINCT league FROM ninja_price_meta WHERE game = 'poe1'
  `;
  const priced = new Set(pricedRows.map((r) => r.league));

  const candidates = listed
    .filter((l) => priced.has(l.id))
    .map((l) => ({ name: l.id, startAt: l.startAt }));

  const league = selectCurrentChallengeLeague(candidates);

  if (!league) {
    // Distinguish the two reasons so a rollover morning is diagnosable from
    // the job log alone.
    const anyChallenge = selectCurrentChallengeLeague(
      listed.map((l) => ({ name: l.id, startAt: l.startAt })),
    );
    console.log(
      anyChallenge
        ? `GGG lists ${anyChallenge} but poe.ninja has not priced it yet — no chaos conversion available, nothing to refresh.`
        : "No live challenge league listed by GGG, nothing to refresh.",
    );
    return null;
  }

  console.log(`Refreshing current challenge league: ${league}`);
  return league;
}
