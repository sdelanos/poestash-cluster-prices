/**
 * Pick the Scrying Orb map variants out of a poe.watch currency payload.
 *
 * poe.watch lists one entry per scryable map, named "Scrying Orb (<map area>)",
 * alongside a bare "Scrying Orb" aggregate and the rest of the currency
 * category. Only the per-map variants are priced rows; the bare entry has no
 * map to key on and everything else is noise, so both are dropped. An entry
 * poe.watch serves without a numeric mean or daily is dropped too rather than
 * written as a null price.
 */

/** The slice of a poe.watch /get currency entry this worker reads. */
export interface PoeWatchCurrencyItem {
  name: string;
  mean: number;
  daily: number;
  lowConfidence: boolean;
}

export interface ScryingOrbRow {
  mapArea: string;
  mean: number;
  daily: number;
  lowConfidence: boolean;
}

const VARIANT_PATTERN = /^Scrying Orb \((.+)\)$/;

export function selectScryingOrbRows(
  items: PoeWatchCurrencyItem[],
): ScryingOrbRow[] {
  const rows: ScryingOrbRow[] = [];
  for (const item of items) {
    const match = VARIANT_PATTERN.exec(item.name);
    if (!match) continue;
    if (typeof item.mean !== "number" || typeof item.daily !== "number") continue;
    rows.push({
      mapArea: match[1],
      mean: item.mean,
      daily: item.daily,
      lowConfidence: Boolean(item.lowConfidence),
    });
  }
  return rows;
}
