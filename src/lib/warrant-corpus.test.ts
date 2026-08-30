import { describe, expect, it } from "vitest";
import { buildCorpus, dedupeObservations, type PricedObservation } from "./warrant-corpus";
import type { SupportTier, WarrantObservation } from "./warrant-observation";

let seq = 0;
const obs = (
  chaos: number,
  supports: SupportTier[],
  over: Partial<WarrantObservation> = {},
): PricedObservation => ({
  chaos,
  observation: {
    itemId: `item-${seq++}`,
    league: "Allflame",
    archetype: "Flamequiver",
    infamous: false,
    level: "82",
    skillHashes: [1],
    supports,
    price: { amount: chaos, currency: "chaos" },
    ...over,
  },
});

const pierce: SupportTier = { hash: 50, name: "Pierce", tier: 2 };
const fork: SupportTier = { hash: 60, name: "Greater Fork", tier: 3 };

describe("dedupeObservations", () => {
  it("keeps one observation per item id, the last seen winning", () => {
    const a = obs(10, [pierce]).observation;
    const relisted = { ...a, price: { amount: 20, currency: "chaos" } };
    const deduped = dedupeObservations([a, relisted]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].price.amount).toBe(20);
  });

  it("keeps distinct items apart", () => {
    expect(dedupeObservations([obs(1, []).observation, obs(2, []).observation])).toHaveLength(2);
  });
});

describe("buildCorpus", () => {
  it("emits one row per (support, tier) pair, not one per Warrant", () => {
    const rows = buildCorpus([obs(10, [pierce, fork]), obs(20, [pierce, fork])]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.sampleCount)).toEqual([2, 2]);
  });

  it("stays bounded when the same pairs are observed again and again", () => {
    const many = Array.from({ length: 500 }, (_, i) => obs(i + 1, [pierce, fork]));
    expect(buildCorpus(many)).toHaveLength(2);
  });

  it("splits the same support at two tiers into two rows", () => {
    const t1 = { hash: 50, name: "Pierce", tier: 1 };
    const rows = buildCorpus([obs(10, [pierce]), obs(10, [t1])]);
    expect(rows.map((r) => r.tier)).toEqual([1, 2]);
  });

  it("contrasts a pair against the same league's Warrants that lack it", () => {
    // Carrying Pierce: 100 and 300 (median 200). Lacking it: 10 and 30 (20).
    const rows = buildCorpus([
      obs(100, [pierce]),
      obs(300, [pierce]),
      obs(10, [fork]),
      obs(30, [fork]),
    ]);
    const p = rows.find((r) => r.supportHash === 50)!;
    expect(p.medianChaos).toBe(200);
    expect(p.baselineMedianChaos).toBe(20);
    expect(p.baselineCount).toBe(2);
    // Every Pierce Warrant outranks every other one.
    expect(p.separationAuc).toBe(1);
  });

  it("reports 0 for a pair that is always the cheap half", () => {
    const rows = buildCorpus([obs(10, [pierce]), obs(30, [pierce]), obs(100, [fork]), obs(300, [fork])]);
    expect(rows.find((r) => r.supportHash === 50)!.separationAuc).toBe(0);
  });

  it("reports 0.5 for a pair that tracks the market", () => {
    const rows = buildCorpus([obs(10, [pierce]), obs(30, [pierce]), obs(10, [fork]), obs(30, [fork])]);
    expect(rows.find((r) => r.supportHash === 50)!.separationAuc).toBe(0.5);
  });

  it("grades a partial separation the ratio of medians cannot see", () => {
    // The market prices everything at one of two round numbers, which is what
    // Warrants actually do: 6,998 live listings had a median of exactly one
    // divine, and so did nearly every subgroup. Three of the four expensive
    // Warrants carry Pierce, so the axis clearly leans — and every median in
    // sight is identical, so a ratio of medians would report "no effect".
    const rows = buildCorpus([
      obs(291, [pierce]),
      obs(2910, [pierce]),
      obs(2910, [pierce]),
      obs(2910, [pierce]),
      obs(291, [fork]),
      obs(291, [fork]),
      obs(291, [fork]),
      obs(2910, [fork]),
    ]);
    const p = rows.find((r) => r.supportHash === 50)!;
    expect(p.medianChaos).toBe(2910);
    expect(p.baselineMedianChaos).toBe(291);
    // 12 of the 16 pairwise comparisons, ties as half: a clear lean, graded.
    expect(p.separationAuc).toBe(0.75);
  });

  it("counts a tied price as half a win rather than dropping it", () => {
    // One pair Warrant against one baseline Warrant at the identical price:
    // no information either way, which is exactly 0.5.
    const rows = buildCorpus([obs(291, [pierce]), obs(291, [fork])]);
    expect(rows.find((r) => r.supportHash === 50)!.separationAuc).toBe(0.5);
  });

  it("carries quantiles so a wide spread is visible behind the median", () => {
    const rows = buildCorpus([1, 2, 3, 4, 100].map((c) => obs(c, [pierce])));
    const p = rows[0];
    expect(p.medianChaos).toBe(3);
    expect(p.p25Chaos).toBe(2);
    expect(p.p75Chaos).toBe(4);
  });

  it("does not compare across leagues", () => {
    const rows = buildCorpus([
      obs(10, [pierce]),
      obs(1000, [pierce], { league: "Standard" }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.league, r.medianChaos])).toEqual([
      ["Allflame", 10],
      ["Standard", 1000],
    ]);
  });

  it("reports 0.5, not a divide by zero, when every Warrant carries the pair", () => {
    const rows = buildCorpus([obs(10, [pierce]), obs(30, [pierce])]);
    expect(rows[0].baselineCount).toBe(0);
    expect(rows[0].separationAuc).toBe(0.5);
  });

  it("keeps both Warrants apart when two share a price", () => {
    // Two Warrants priced 10, one with the pair and one without: the baseline
    // must keep the second 10 rather than swallowing both.
    const rows = buildCorpus([obs(10, [pierce]), obs(10, [fork])]);
    const p = rows.find((r) => r.supportHash === 50)!;
    expect(p.baselineCount).toBe(1);
    expect(p.baselineMedianChaos).toBe(10);
  });

  it("stamps every row with the league's whole sample size", () => {
    const rows = buildCorpus([obs(10, [pierce]), obs(20, [fork]), obs(30, [])]);
    expect(rows.every((r) => r.leagueSampleCount === 3)).toBe(true);
  });

  it("emits nothing for an empty sample", () => {
    expect(buildCorpus([])).toEqual([]);
  });
});

describe("buildCorpus, the stratified contrast", () => {
  /** A sample of `n` Warrants on one skill set, the first `carrying` of which
   *  hold Pierce. `priceWith`/`priceWithout` set the two price levels. */
  const stratum = (
    skills: number[],
    n: number,
    carrying: number,
    priceWith: number,
    priceWithout: number,
  ) =>
    Array.from({ length: n }, (_, i) =>
      i < carrying
        ? obs(priceWith, [pierce], { skillHashes: skills })
        : obs(priceWithout, [fork], { skillHashes: skills }),
    );

  it("says nothing when no skill set has enough Warrants to split", () => {
    // Below MIN_STRATUM there is no stratum to compare inside, so the honest
    // answer is 0.5 and no strata — never a figure derived from one Warrant.
    const rows = buildCorpus(stratum([1, 2], 10, 5, 1000, 10));
    const p = rows.find((r) => r.supportHash === 50)!;
    expect(p.strataCount).toBe(0);
    expect(p.stratifiedAuc).toBe(0.5);
  });

  it("measures inside a skill set once it is big enough", () => {
    const rows = buildCorpus(stratum([1, 2], 20, 10, 1000, 10));
    const p = rows.find((r) => r.supportHash === 50)!;
    expect(p.strataCount).toBe(1);
    expect(p.strataAbove).toBe(1);
    expect(p.stratifiedAuc).toBe(1);
  });

  it("ignores a stratum too lopsided to say anything", () => {
    // 2 carriers against 18 is below MIN_STRATUM_SIDE: the stratum is big
    // enough, the split is not, so it contributes nothing rather than noise.
    const rows = buildCorpus(stratum([1, 2], 20, 2, 1000, 10));
    expect(rows.find((r) => r.supportHash === 50)!.strataCount).toBe(0);
  });

  it("counts each skill set as its own stratum", () => {
    const rows = buildCorpus([
      ...stratum([1, 2], 20, 10, 1000, 10),
      ...stratum([3, 4], 20, 10, 1000, 10),
    ]);
    const p = rows.find((r) => r.supportHash === 50)!;
    expect(p.strataCount).toBe(2);
    expect(p.strataAbove).toBe(2);
  });

  it("finds an effect the league-wide contrast hides", () => {
    // The confound this column exists for, in miniature. Pierce is worth 10x
    // inside BOTH skill sets. But it is rare on the expensive build and common
    // on the cheap one, so pooling the league mixes the two populations and
    // the league-wide AUC lands near chance while the truth is 1.0.
    const rows = buildCorpus([
      // Expensive skill set: only 5 of 20 carry Pierce.
      ...stratum([1, 2], 20, 5, 10_000, 1_000),
      // Cheap skill set: 15 of 20 carry it.
      ...stratum([3, 4], 20, 15, 1_000, 100),
    ]);
    const p = rows.find((r) => r.supportHash === 50)!;

    expect(p.stratifiedAuc).toBe(1);
    expect(p.strataAbove).toBe(2);
    // The pooled figure is much weaker than the truth — that is the point.
    expect(p.separationAuc).toBeLessThan(0.75);
  });

  it("reports 0.5 for a support that separates nothing inside its skill set", () => {
    const rows = buildCorpus(stratum([1, 2], 20, 10, 500, 500));
    const p = rows.find((r) => r.supportHash === 50)!;
    expect(p.stratifiedAuc).toBe(0.5);
    expect(p.strataAbove).toBe(0);
  });
});
