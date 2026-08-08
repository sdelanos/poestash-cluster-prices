import { describe, expect, it } from "vitest";
import { selectScryingOrbRows, type PoeWatchCurrencyItem } from "./scrying-orbs";

const item = (over: Partial<PoeWatchCurrencyItem>): PoeWatchCurrencyItem => ({
  name: "Scrying Orb (Dunes)",
  mean: 42.5,
  daily: 7,
  lowConfidence: false,
  ...over,
});

describe("selectScryingOrbRows", () => {
  it("extracts the map area from a Scrying Orb variant name", () => {
    const rows = selectScryingOrbRows([item({ name: "Scrying Orb (Bramble Valley)" })]);
    expect(rows).toEqual([
      { mapArea: "Bramble Valley", mean: 42.5, daily: 7, lowConfidence: false },
    ]);
  });

  it("keeps nested parentheses inside the map area intact", () => {
    const rows = selectScryingOrbRows([item({ name: "Scrying Orb (Lair (Tier 14))" })]);
    expect(rows[0]?.mapArea).toBe("Lair (Tier 14)");
  });

  it("drops the bare Scrying Orb entry with no map area", () => {
    expect(selectScryingOrbRows([item({ name: "Scrying Orb" })])).toEqual([]);
  });

  it("drops non-orb currency entries", () => {
    expect(selectScryingOrbRows([item({ name: "Divine Orb" })])).toEqual([]);
  });

  it("drops entries missing a numeric mean or daily", () => {
    const missingMean = item({ mean: undefined as unknown as number });
    const missingDaily = item({ daily: undefined as unknown as number });
    expect(selectScryingOrbRows([missingMean, missingDaily])).toEqual([]);
  });

  it("passes lowConfidence through", () => {
    const rows = selectScryingOrbRows([item({ lowConfidence: true })]);
    expect(rows[0]?.lowConfidence).toBe(true);
  });
});
