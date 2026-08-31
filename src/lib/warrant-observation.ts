/**
 * One listed Warrant, as the river hands it over.
 *
 * A Warrant's name identifies nothing — every copy in the game is called
 * "Mercenary Warrant" — so an observation is only worth anything once the
 * **Mercenary** printed on it has been read: the Archetype (with its Infamous
 * strain, kept as one string), the mercenary level, the skill hashes, and the
 * (support, tier) pairs riding along. That read is duplicated from the app's
 * `lib/stash/warrant.ts`, deliberately: the two repos cannot import each
 * other, and this is the same handful of property lookups.
 *
 * Two shapes fall out of the payload and are kept as they are:
 *
 *  - the mercenary's proper name is an **unnamed** property, findable only by
 *    having a value among the named ones;
 *  - a skill may legitimately carry zero supports. Nothing in the payload says
 *    what kind of skill it is, so an empty support list is not evidence.
 *
 * `readWarrantObservation` returns null for anything that is not a priced
 * Warrant, which is every other item in the river and most Warrants in it.
 */

import { readListingPrice, type ListingPrice } from "./listing-price";

/** The one base type every Warrant shares. Also its `typeLine`. */
export const WARRANT_BASE_TYPE = "Mercenary Warrant";

const ARCHETYPE_PROPERTY = "Build";
const LEVEL_PROPERTY = "Mercenary Level";
const INFAMOUS_PREFIX = "Infamous ";

/** The slice of GGG's `Item` this worker reads. */
export interface RiverItem {
  id?: string;
  baseType?: string;
  note?: string;
  /** GGG's property list. `values` is a list of `[text, displayFlag]` pairs,
   *  typed loosely because that is how it arrives — the reader only ever
   *  reaches for the first text of the first pair. */
  properties?: { name?: string; values?: (string | number)[][] }[];
  mercenarySkills?: {
    hash: number;
    name?: string;
    supports?: { hash: number; name?: string; tier: number }[];
  }[];
}

/** The slice of GGG's public stash tab this worker reads. */
export interface RiverStash {
  league?: string | null;
  /** The tab's name. GGG calls it `stash`, and a whole-tab price lives here. */
  stash?: string | null;
  items?: RiverItem[];
}

/** A (support, tier) pair: the axis ADR 0060 left open. */
export interface SupportTier {
  hash: number;
  name: string;
  tier: number;
}

/** The pair's identity, for grouping. The name is deliberately not in it: the
 *  hash is what the corpus keys on and what `mercenary.support_<hash>`
 *  interpolates, and payloads have been seen disagreeing on capitalisation. */
export function supportTierKey(s: SupportTier): string {
  return `${s.hash}:${s.tier}`;
}

export interface WarrantObservation {
  /** GGG's item id. The corpus dedupes on it — a relisted tab reappears. */
  itemId: string;
  league: string;
  archetype: string | null;
  infamous: boolean;
  /** Kept as the printed string, the way the app keeps it. */
  level: string | null;
  skillHashes: number[];
  /** Deduped and sorted, so the same Mercenary always reads the same way. */
  supports: SupportTier[];
  price: ListingPrice;
}

function namedProperty(item: RiverItem, name: string): string | null {
  const p = item.properties?.find((prop) => prop.name === name);
  const v = p?.values?.[0]?.[0];
  return v != null && v !== "" ? String(v) : null;
}

/** Every distinct (support, tier) on the Mercenary, in a stable order. */
function readSupports(item: RiverItem): SupportTier[] {
  const byKey = new Map<string, SupportTier>();
  for (const skill of item.mercenarySkills ?? []) {
    for (const s of skill.supports ?? []) {
      if (s?.hash == null || !Number.isFinite(s.tier)) continue;
      const pair = { hash: s.hash, name: s.name ?? "", tier: s.tier };
      byKey.set(supportTierKey(pair), pair);
    }
  }
  return [...byKey.values()].sort((a, b) => a.hash - b.hash || a.tier - b.tier);
}

/**
 * One priced Warrant, or null. Null covers, in order: any other base type, an
 * item with no id to dedupe on, a stash with no league, and — the common case
 * — a Warrant its seller never named a price for.
 */
export function readWarrantObservation(
  stash: RiverStash,
  item: RiverItem,
): WarrantObservation | null {
  if (item.baseType !== WARRANT_BASE_TYPE) return null;
  if (!item.id || !stash.league) return null;

  const price = readListingPrice(item.note, stash.stash);
  if (!price) return null;

  const archetype = namedProperty(item, ARCHETYPE_PROPERTY);

  return {
    itemId: item.id,
    league: stash.league,
    archetype,
    infamous: archetype?.startsWith(INFAMOUS_PREFIX) ?? false,
    level: namedProperty(item, LEVEL_PROPERTY),
    skillHashes: (item.mercenarySkills ?? []).map((s) => s.hash).sort((a, b) => a - b),
    supports: readSupports(item),
    price,
  };
}

/** Every priced Warrant on one river page. */
export function readWarrantObservations(stashes: RiverStash[]): WarrantObservation[] {
  const out: WarrantObservation[] = [];
  for (const stash of stashes) {
    for (const item of stash.items ?? []) {
      const obs = readWarrantObservation(stash, item);
      if (obs) out.push(obs);
    }
  }
  return out;
}
