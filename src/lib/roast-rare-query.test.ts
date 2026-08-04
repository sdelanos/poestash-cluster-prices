import { describe, expect, it } from "vitest";
import { buildRareSearchQuery, type RoastRareMarket } from "./roast-rare-query";

const market = (over: Partial<RoastRareMarket> = {}): RoastRareMarket => ({
  referenceFingerprint: "a".repeat(32),
  slot: "Ring 1",
  baseType: "Two-Stone Ring",
  ilvlMin: 84,
  filters: [
    { statId: "explicit.stat_3299347043", min: 90 },
    { statId: "explicit.stat_3372524247", min: 41 },
  ],
  ...over,
});

describe("buildRareSearchQuery", () => {
  // Pinned whole rather than field by field. The app builds the same *shape* in
  // roastRareTradeUrl, in a different repo where no test can reach it, so this
  // is what makes a change to the shape here a deliberate one rather than a
  // silent drift away from the search the player clicks.
  it("searches rares of the base, at the guide's rolls, cheapest first", () => {
    expect(buildRareSearchQuery(market())).toEqual({
      query: {
        status: { option: "available" },
        type: "Two-Stone Ring",
        stats: [
          {
            type: "and",
            filters: [
              { id: "explicit.stat_3299347043", value: { min: 90 } },
              { id: "explicit.stat_3372524247", value: { min: 41 } },
            ],
          },
        ],
        filters: {
          type_filters: { filters: { rarity: { option: "rare" } } },
          misc_filters: { filters: { ilvl: { min: 84 } } },
        },
      },
      sort: { price: "asc" },
    });
  });

  it("leaves the item-level filter off entirely when there is no floor", () => {
    const q = buildRareSearchQuery(market({ ilvlMin: null })) as any;
    expect(q.query.filters.misc_filters).toBeUndefined();
    expect(q.query.filters.type_filters.filters.rarity.option).toBe("rare");
  });

  // An unbounded filter still narrows the search to items carrying the mod,
  // which is the honest thing to ask for a mod with no number in it.
  it("filters on a mod with no number without bounding it", () => {
    const q = buildRareSearchQuery(
      market({ filters: [{ statId: "explicit.stat_1", min: null }] }),
    ) as any;
    expect(q.query.stats[0].filters).toEqual([{ id: "explicit.stat_1", value: {} }]);
  });

  // Not a real Reference slot — the app only writes rows for rares it resolved
  // at least one mod on — but a base-only search is still valid rather than
  // malformed, and the trade API rejects an empty `stats` array.
  it("omits the stats block when there are no filters at all", () => {
    const q = buildRareSearchQuery(market({ filters: [] })) as any;
    expect(q.query.stats).toBeUndefined();
  });
});
