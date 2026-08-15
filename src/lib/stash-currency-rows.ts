/**
 * Maps poe.ninja's stash currency-format payload to DB-shaped rows.
 *
 * This is the ingestion boundary for the only two-sided feed poe.ninja
 * publishes (Currency and Fragment), and the one place the feed's inverted
 * units are allowed to exist. Per ADR 0042 in the app repo, spreads come from
 * this feed's pay/receive and **nothing downstream may ever see a per-chaos
 * rate** — so the inversion dies here, in a pure function, pinned by tests
 * against a captured payload.
 *
 * The two sides are quoted in mutually inverted units:
 *
 *   receive.value  chaos per unit of the currency — what an instant *buyer*
 *                  pays. Already the unit we want; the feed's own
 *                  `chaosEquivalent` is this number.
 *   pay.value      units of the currency per chaos — what an instant *seller*
 *                  gets, expressed upside down. Chaos per unit is its
 *                  reciprocal.
 *
 * Captured 2026-08-15 (Allflame), Divine Orb: pay 0.0055, receive 193.4. Left
 * alone, the pay side would read as 0.0055 chaos against a 185.4-chaos orb —
 * wrong by a factor of the price squared, and silently so.
 *
 * Sides are independently optional. Rows quoted on one side only are common
 * (36 of 68 lines in that capture were receive-only); such a row carries only
 * the side it has, and the app excludes it from the tradeable universe.
 *
 * Beyond the units, this function judges nothing. The live feed carries
 * 90%-plus spreads on vendor-tier currency (bulk buyers offer 100 transmutes
 * per chaos while sellers ask two), outright crossed quotes on thin pairs, and
 * the occasional row of pure garbage. All of it is real and all of it is
 * passed through: ADR 0042 puts the volume floor and the exchange-feed referee
 * downstream, where the hourly volume that decides those questions actually
 * exists. Ingestion reports; the strategy judges.
 */

import type { NinjaCurrencyResponse, NinjaFetchedItem } from "./ninja-types";

export interface StashCurrencyContext {
  game: string;
  league: string;
  /** poe.ninja type this payload was fetched for — "Currency" or "Fragment". */
  type: string;
  /** Chaos per divine, for the divine-denominated mirror of chaosValue. */
  divineRate: number;
}

/** Chaos per unit from the pay side's inverted quote.
 *
 *  A missing side, and a quote that is zero, negative or non-finite, both mean
 *  "no pay side": inverting those yields Infinity or a negative price, which
 *  would poison every spread computed from the row. Absent is honest; a
 *  fabricated number is not. */
function payChaosPerUnit(value: number | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  return 1 / value;
}

export function mapStashCurrencyRows(
  data: NinjaCurrencyResponse,
  ctx: StashCurrencyContext,
): NinjaFetchedItem[] {
  const detailMap = new Map<string, { icon: string; tradeId: string }>();
  for (const detail of data.currencyDetails ?? []) {
    detailMap.set(detail.name, { icon: detail.icon, tradeId: detail.tradeId });
  }

  return (data.lines ?? []).map((line) => {
    const chaos = line.chaosEquivalent;
    const detail = detailMap.get(line.currencyTypeName);
    const payValue = payChaosPerUnit(line.pay?.value);

    return {
      game: ctx.game,
      league: ctx.league,
      itemName: line.currencyTypeName.toLowerCase(),
      chaosValue: chaos,
      divineValue: ctx.divineRate > 0 ? chaos / ctx.divineRate : 0,
      listingCount: line.receive?.listing_count ?? 0,
      source: "stash" as const,
      ninjaCategory: ctx.type,
      icon: detail?.icon ?? null,
      detailsId: line.detailsId,
      sparklineData: line.receiveSparkLine?.data ?? null,
      totalChange: line.receiveSparkLine?.totalChange ?? null,
      payValue,
      // The listing count belongs to the side's price, so it goes only where
      // that price went: a pay quote we refused to invert has no count either.
      payListingCount: payValue == null ? null : (line.pay?.listing_count ?? null),
      receiveValue: line.receive?.value ?? null,
      receiveListingCount: line.receive?.listing_count ?? null,
    };
  });
}
