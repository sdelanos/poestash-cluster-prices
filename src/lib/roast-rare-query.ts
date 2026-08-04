/**
 * The trade search for one Reference rare slot (poestash #127, app ADR 0022).
 *
 * What this prices is **the guide's own rare**: every mod it rolls, at the value
 * it rolls them. That is what a Reference fingerprint keys, and it is why the
 * figure is deterministic and shareable across everyone following that guide.
 * The app cannot run the search itself — the platform's trade quota is metered
 * on our application identity and a page load must never spend any of it.
 *
 * It is *not* the search the player clicks. That one is the model's: a shorter,
 * looser subset of these mods, enough of the item to fix their build. So this
 * figure is a ceiling on what their click turns up, and the app labels it as the
 * guide's own roll rather than as the price of those results.
 *
 * The query *shape* deliberately matches `roastRareTradeUrl` in the app
 * (`lib/trade/build-trade-url.ts`): rare rarity, base as `type`, an item-level
 * floor when there is one, `and` filters with `min` values. Cross-repo, so
 * nothing can assert the two agree — the test below pins this shape so a change
 * to it is a deliberate one, and the app side has to be checked by hand.
 */

/** One row of `roast_reference_prices`, as the worker needs it. Written by the
 *  app: only the app has a PoB parser to derive any of this. */
export interface RoastRareMarket {
  referenceFingerprint: string;
  slot: string;
  /** English base name, spelled as the trade site's `type` expects. */
  baseType: string;
  ilvlMin: number | null;
  /** `min` null for a mod carrying no number — filter on it, unbounded. */
  filters: { statId: string; min: number | null }[];
}

/**
 * Listing status. `available` is what the app's own trade link opens with, so it
 * is what the sampled figure has to mean: a price the player cannot reach by
 * clicking through is not a price we should be quoting at them.
 */
const LISTING_STATUS = "available";

export function buildRareSearchQuery(market: RoastRareMarket): unknown {
  return {
    query: {
      status: { option: LISTING_STATUS },
      type: market.baseType,
      ...(market.filters.length > 0
        ? {
            stats: [
              {
                type: "and",
                filters: market.filters.map((f) => ({
                  id: f.statId,
                  value: f.min != null ? { min: f.min } : {},
                })),
              },
            ],
          }
        : {}),
      filters: {
        type_filters: { filters: { rarity: { option: "rare" } } },
        ...(market.ilvlMin != null
          ? { misc_filters: { filters: { ilvl: { min: market.ilvlMin } } } }
          : {}),
      },
    },
    sort: { price: "asc" },
  };
}
