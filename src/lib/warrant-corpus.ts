/**
 * The corpus: observations in, one bounded table of (support, tier) rows out.
 *
 * ADR 0060 left one question open, and set the bar for answering it: *show
 * that the extra filter separates prices, the way Infamous was shown not to.*
 * This module is that measurement, and its shape follows from it.
 *
 * **Why the row is a (support, tier) pair and not a Warrant.** A Warrant is a
 * combination — six skills, ten-to-eighteen distinct supports, each tiered —
 * so every copy is unique and a per-Warrant table is a log, not an aggregate.
 * At ~866 listed Warrants a minute a log is ~1.25M rows a day. Keying on the
 * pair collapses that to at most (supports × tiers) rows per league — 198 in
 * the first live sample — which stays flat however long the worker runs.
 *
 * **Why every row carries a baseline.** A support's own median price says
 * nothing on its own: the whole Warrant market could be expensive that day.
 * What answers ADR 0060 is the contrast — Warrants carrying the pair against
 * Warrants that do not, in the same league, in the same sample.
 *
 * **Why that contrast is a rank statistic and not a ratio of medians.** The
 * ratio was the obvious choice and the first live sample killed it. Warrants
 * are priced in round divine: 6,998 Allflame listings had a median of exactly
 * 1 divine, and so did nearly every subgroup, so a median ratio could only
 * ever return 1.00 or 2.00. Two orders of magnitude of real spread collapsed
 * into two possible answers, and a support that genuinely shifts the
 * distribution reads the same as one that does nothing.
 *
 * `separationAuc` is the ratio's replacement: the probability that a Warrant
 * carrying the pair is priced above one that is not, ties counted as half
 * (Mann-Whitney). **0.5 is "this axis separates nothing"**, 1.0 is "it always
 * costs more", 0.0 "it always costs less". Ties are exactly what quantised
 * prices produce, and a rank statistic absorbs them instead of being destroyed
 * by them. The medians and quartiles stay on the row because they are what a
 * human reads; the AUC is what a claim gets made on.
 *
 * **Why there are two contrasts and not one.** The league-wide AUC above
 * compares a pair's Warrants against every other Warrant in the league, and
 * that comparison is confounded: a support only rolls on some builds, so its
 * baseline is a different population rather than the same population minus the
 * support. The confound is not theoretical. `Return T3` scores 0.574
 * league-wide — indistinguishable from noise — and 0.668 once the comparison is
 * made *within* identical skill sets, favouring the support in 26 of 28 of
 * them. Pooling hid a real effect.
 *
 * So every row also carries `stratifiedAuc`: the same statistic computed
 * separately inside each identical-skill-set stratum and pooled by weight.
 * That stratum is not an arbitrary choice — an identical skill set is exactly
 * the comparable set ADR 0060's own query returns, so it is the population a
 * player actually chooses within. `strataCount` and `strataAbove` ship beside
 * it because the count of strata favouring the pair is a sign test that does
 * not depend on the size of the effect, and it is the more robust of the two.
 *
 * **What this deliberately does not do** is decide anything. It emits counts
 * and statistics; whether a separation is real, and whether a filter should
 * ever go into a player's trade query, is judged in the write-up. A pair seen
 * four times has an AUC and it means nothing, which is why `sampleCount` ships
 * beside every figure rather than being filtered out here.
 *
 * A caveat the write-up has to carry and the arithmetic cannot: supports are
 * not independent of the rest of the Mercenary. A support that only ever rolls
 * on an expensive Archetype will separate prices without causing the price.
 */

import { supportTierKey, type WarrantObservation } from "./warrant-observation";

/** An observation with its price resolved to chaos. */
export interface PricedObservation {
  observation: WarrantObservation;
  chaos: number;
}

/** One (league, support, tier) row: the corpus as it is stored. */
export interface CorpusRow {
  league: string;
  supportHash: number;
  supportName: string;
  tier: number;
  /** Priced Warrants in this league's sample carrying this pair. */
  sampleCount: number;
  medianChaos: number;
  p25Chaos: number;
  p75Chaos: number;
  /** Priced Warrants in the same sample that do NOT carry it. */
  baselineCount: number;
  baselineMedianChaos: number;
  /**
   * P(a Warrant with this pair costs more than one without), ties as half.
   * **0.5 is "this axis separates nothing."** See the module note for why this
   * is a rank statistic rather than a ratio of medians.
   */
  separationAuc: number;
  /**
   * The same probability, computed inside each identical-skill-set stratum and
   * pooled — the comparison ADR 0060's own query actually puts in front of a
   * player. **This is the one to read**: the league-wide figure compares a pair
   * against a different population and hides real effects. 0.5 separates
   * nothing. Falls back to 0.5 when no stratum is big enough to say anything.
   */
  stratifiedAuc: number;
  /** Strata that could be measured at all — both sides above the floor. */
  strataCount: number;
  /** Of those, how many favoured the pair. A sign test, size-independent. */
  strataAbove: number;
  /** Every priced Warrant in the league's sample, so a row is readable alone. */
  leagueSampleCount: number;
}

/** A stratum needs this many Warrants before it is worth splitting at all. */
const MIN_STRATUM = 20;
/** And this many on each side of the split, or its AUC is noise. */
const MIN_STRATUM_SIDE = 5;

/** One identical-skill-set group, pre-indexed so every pair can be tested
 *  against it without walking the league again. */
interface Stratum {
  /** Prices, aligned with `carries`. */
  prices: number[];
  /** The (support, tier) keys each of those Warrants carries. */
  carries: Set<string>[];
}

/** The nearest-rank quantile of an already-sorted ascending array. */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Observations deduped by GGG item id, last write winning.
 *
 * The river is not a set. One stash tab crossing it twice in a run — a
 * reprice, an unrelated edit — republishes every item in it, and two runs
 * whose windows overlap see the same listings again. Deduping here is what
 * makes a repeated or overlapping run idempotent rather than a way to weight
 * one seller's tab twice.
 */
export function dedupeObservations(observations: WarrantObservation[]): WarrantObservation[] {
  const byId = new Map<string, WarrantObservation>();
  for (const o of observations) byId.set(o.itemId, o);
  return [...byId.values()];
}

/**
 * Midranks of an ascending array: tied values share the average of the ranks
 * they occupy. This is the whole reason the statistic survives a market that
 * prices everything at exactly one divine.
 */
function midranks(sorted: number[]): number[] {
  const ranks = new Array<number>(sorted.length);
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[i]) j++;
    // Ranks are 1-based; the shared rank is the average of i+1 … j+1.
    const shared = (i + 1 + j + 1) / 2;
    for (let k = i; k <= j; k++) ranks[k] = shared;
    i = j + 1;
  }
  return ranks;
}

/**
 * P(a > b), ties as half, counted directly. Strata hold tens of Warrants, so
 * the quadratic count is cheaper and clearer than ranking, and it handles ties
 * by construction.
 */
function pairwiseAuc(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0.5;
  let wins = 0;
  for (const x of a) for (const y of b) wins += x > y ? 1 : x === y ? 0.5 : 0;
  return wins / (a.length * b.length);
}

/** The league's identical-skill-set strata, built once and reused by every
 *  pair. Strata too small to split are dropped here rather than per pair. */
function buildStrata(sample: PricedObservation[]): Stratum[] {
  const bySkills = new Map<string, PricedObservation[]>();
  for (const p of sample) {
    const key = p.observation.skillHashes.join(",");
    const bucket = bySkills.get(key);
    if (bucket) bucket.push(p);
    else bySkills.set(key, [p]);
  }

  const strata: Stratum[] = [];
  for (const group of bySkills.values()) {
    if (group.length < MIN_STRATUM) continue;
    strata.push({
      prices: group.map((p) => p.chaos),
      carries: group.map((p) => new Set(p.observation.supports.map(supportTierKey))),
    });
  }
  return strata;
}

/**
 * One pair's contrast within the strata, pooled.
 *
 * Weighting by `n1 * n2` is the number of pairwise comparisons the stratum
 * actually contributes, so a stratum splitting 20/20 counts for more than one
 * splitting 5/35 — which is what "pooled" has to mean for a rank statistic.
 */
function stratifiedContrast(
  key: string,
  strata: Stratum[],
): { auc: number; strataCount: number; strataAbove: number } {
  let weighted = 0;
  let weight = 0;
  let strataCount = 0;
  let strataAbove = 0;

  for (const stratum of strata) {
    const withPair: number[] = [];
    const without: number[] = [];
    for (let i = 0; i < stratum.prices.length; i++) {
      (stratum.carries[i].has(key) ? withPair : without).push(stratum.prices[i]);
    }
    if (withPair.length < MIN_STRATUM_SIDE || without.length < MIN_STRATUM_SIDE) continue;

    const a = pairwiseAuc(withPair, without);
    const w = withPair.length * without.length;
    weighted += a * w;
    weight += w;
    strataCount++;
    if (a > 0.5) strataAbove++;
  }

  return { auc: weight > 0 ? weighted / weight : 0.5, strataCount, strataAbove };
}

/**
 * The corpus for one run: every (league, support, tier) pair the sample saw,
 * with its price contrast against the rest of that league's sample, and
 * against the same-skill-set Warrants that lack it.
 */
export function buildCorpus(priced: PricedObservation[]): CorpusRow[] {
  const byLeague = new Map<string, PricedObservation[]>();
  for (const p of priced) {
    const bucket = byLeague.get(p.observation.league);
    if (bucket) bucket.push(p);
    else byLeague.set(p.observation.league, [p]);
  }

  const rows: CorpusRow[] = [];
  for (const [league, unsorted] of byLeague) {
    // Sort the sample once. Every pair below reads ranks out of this one
    // ordering, so the whole league costs one sort rather than one per pair.
    const sample = [...unsorted].sort((a, b) => a.chaos - b.chaos);
    const all = sample.map((p) => p.chaos);
    const ranks = midranks(all);
    const strata = buildStrata(sample);

    // Positions in the sorted sample, per pair — positions rather than prices,
    // because the rank statistic needs to know which Warrant, not just which
    // price. Plus the pair's display name, in the same pass.
    const positions = new Map<string, number[]>();
    const names = new Map<string, { hash: number; name: string; tier: number }>();
    for (let i = 0; i < sample.length; i++) {
      for (const s of sample[i].observation.supports) {
        const key = supportTierKey(s);
        const bucket = positions.get(key);
        if (bucket) bucket.push(i);
        else positions.set(key, [i]);
        // Names can differ in case across payloads; the last one wins, and the
        // hash is what anything downstream actually keys on.
        names.set(key, s);
      }
    }

    for (const [key, idx] of positions) {
      const s = names.get(key)!;
      const n1 = idx.length;
      const n2 = all.length - n1;

      // `idx` is ascending, so the prices it selects already are too.
      const prices = idx.map((i) => all[i]);
      const without = complement(all, idx);

      let rankSum = 0;
      for (const i of idx) rankSum += ranks[i];
      // Mann-Whitney U over the pair's Warrants, normalised to a probability.
      // With no baseline to compare against there is nothing to separate, so
      // the answer is 0.5 — "this axis tells you nothing" — never a divide by
      // zero and never a spurious 1.0.
      const auc = n2 > 0 ? (rankSum - (n1 * (n1 + 1)) / 2) / (n1 * n2) : 0.5;
      const stratified = stratifiedContrast(key, strata);

      rows.push({
        league,
        supportHash: s.hash,
        supportName: s.name,
        tier: s.tier,
        sampleCount: n1,
        medianChaos: median(prices),
        p25Chaos: quantile(prices, 0.25),
        p75Chaos: quantile(prices, 0.75),
        baselineCount: n2,
        baselineMedianChaos: median(without),
        separationAuc: auc,
        stratifiedAuc: stratified.auc,
        strataCount: stratified.strataCount,
        strataAbove: stratified.strataAbove,
        leagueSampleCount: sample.length,
      });
    }
  }

  return rows.sort(
    (a, b) =>
      a.league.localeCompare(b.league) || a.supportHash - b.supportHash || a.tier - b.tier,
  );
}

/** The values of `all` at every position `idx` does not name. Both ascending. */
function complement(all: number[], idx: number[]): number[] {
  const out: number[] = [];
  let k = 0;
  for (let i = 0; i < all.length; i++) {
    if (k < idx.length && idx[k] === i) k++;
    else out.push(all[i]);
  }
  return out;
}
