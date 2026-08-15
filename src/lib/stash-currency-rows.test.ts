import { describe, it, expect } from "vitest";
import { mapStashCurrencyRows } from "./stash-currency-rows";
import type { NinjaCurrencyLine, NinjaCurrencyResponse } from "./ninja-types";
import fixture from "./__fixtures__/stash-currency-allflame.json";

// Captured 2026-08-15 from
// /economy/stash/current/currency/overview?league=Allflame&type=Currency,
// trimmed to seven lines: five both-sided (one of them crossed), two
// receive-only. Values are verbatim — nothing here is tidied up.
const PAYLOAD: NinjaCurrencyResponse = fixture;

const CTX = { game: "poe1", league: "Allflame", type: "Currency" as const, divineRate: 185.4 };

const map = (payload: NinjaCurrencyResponse = PAYLOAD) =>
  mapStashCurrencyRows(payload, CTX);

const byName = (name: string, payload?: NinjaCurrencyResponse) => {
  const row = map(payload).find((r) => r.itemName === name);
  if (!row) throw new Error(`no row for ${name}`);
  return row;
};

/** Builds a payload of one synthetic line, cloned off a captured one so the
 *  shape stays honest while the sides are varied. */
function oneLine(overrides: Partial<NinjaCurrencyLine>): NinjaCurrencyResponse {
  const base = PAYLOAD.lines.find((l) => l.currencyTypeName === "Divine Orb")!;
  return {
    lines: [{ ...structuredClone(base), ...overrides } as NinjaCurrencyLine],
    currencyDetails: PAYLOAD.currencyDetails,
  };
}

describe("mapStashCurrencyRows", () => {
  it("normalizes the feed's inverted pay units to chaos per unit", () => {
    // The feed quotes the two sides in mutually inverted units: `receive` is
    // already chaos per unit, `pay` is units per chaos. Divine Orb was
    // captured as pay 0.0055 / receive 193.4.
    const divine = byName("divine orb");

    expect(divine.payValue).toBeCloseTo(1 / 0.0055, 6);
    expect(divine.payValue).toBeCloseTo(181.8, 1);
    expect(divine.receiveValue).toBe(193.4);
  });

  it("puts both sides in chaos per unit, pay below receive", () => {
    // The four uncrossed both-sided rows in the capture: a seller who crosses
    // the spread gets the pay side and a buyer pays the receive side, so
    // pay < receive. Ancient Orb is the fifth and is deliberately absent —
    // it was captured crossed, and has its own test below.
    for (const name of ["mirror of kalandra", "divine orb", "chromatic orb", "exalted orb"]) {
      const row = byName(name);
      expect(row.payValue).toBeGreaterThan(0);
      expect(row.receiveValue).toBeGreaterThan(0);
      expect(row.payValue!).toBeLessThan(row.receiveValue!);
      // Both sides land in the same units as the row's own chaos value. A
      // pay side left inverted misses by a factor of the price squared —
      // 0.0055 against 185.4 for Divine Orb — so any sane bound catches it.
      // The bound is loose because real spreads on cheap, coarsely-rounded
      // currency are wide: Exalted Orb was captured at 1.25 pay / 2.0 chaos.
      expect(row.payValue! / row.chaosValue).toBeGreaterThan(0.3);
      expect(row.receiveValue! / row.chaosValue).toBeGreaterThan(0.9);
    }
  });

  it("carries each side's listing count", () => {
    const divine = byName("divine orb");
    expect(divine.payListingCount).toBe(240);
    expect(divine.receiveListingCount).toBe(57);
  });

  it("leaves the legacy listingCount on the receive side", () => {
    // No consumer may see a different value here than before the spread
    // columns existed.
    expect(byName("divine orb").listingCount).toBe(57);
    expect(byName("scrying orb").listingCount).toBe(14587);
  });

  it("a one-sided row carries only the side it has", () => {
    // Orb of Annulment was captured receive-only: the feed omits the `pay`
    // key entirely rather than sending it as null.
    const annul = byName("orb of annulment");
    expect(annul.payValue).toBeNull();
    expect(annul.payListingCount).toBeNull();
    expect(annul.receiveValue).toBe(7.0);
    expect(annul.receiveListingCount).toBe(95);
  });

  it("a row with no sides at all carries neither, and still prices", () => {
    const row = map(oneLine({ pay: null, receive: null }))[0];
    expect(row.payValue).toBeNull();
    expect(row.receiveValue).toBeNull();
    expect(row.payListingCount).toBeNull();
    expect(row.receiveListingCount).toBeNull();
    expect(row.listingCount).toBe(0);
    expect(row.chaosValue).toBe(185.4);
  });

  it("treats a non-positive quote as no side, on either side", () => {
    // A zero pay quote would invert to Infinity; a zero receive quote would
    // read as free. Neither is a price, and the count goes with the price.
    const zeroPay = map(oneLine({ pay: { value: 0, listing_count: 3 } }))[0];
    expect(zeroPay.payValue).toBeNull();
    expect(zeroPay.payListingCount).toBeNull();

    const zeroReceive = map(oneLine({ receive: { value: 0, listing_count: 3 } }))[0];
    expect(zeroReceive.receiveValue).toBeNull();
    expect(zeroReceive.receiveListingCount).toBeNull();
  });

  it("does not treat the receive side as a copy of chaosValue", () => {
    // chaosEquivalent is the feed's own smoothed figure and matches the
    // receive side on most rows but not all. Divine Orb was captured 185.4
    // against a 193.4 receive side. A downstream spread computed from
    // chaosValue instead of receiveValue would be wrong by that 4%.
    const divine = byName("divine orb");
    expect(divine.chaosValue).toBe(185.4);
    expect(divine.receiveValue).toBe(193.4);
    expect(divine.receiveValue).not.toBe(divine.chaosValue);
  });

  it("records a crossed quote rather than sanitizing it", () => {
    // Ancient Orb was captured crossed: the pay side (6.0c, 5 listings) sits
    // *above* the receive side (5.0c). Thin real markets do this, and it is
    // not ingestion's call to hide it — ADR 0042 puts the volume floor and
    // the exchange-feed referee downstream, where they can see the volume
    // this feed does not carry. Ingestion reports; the strategy judges.
    const ancient = byName("ancient orb");
    expect(ancient.payValue).toBeCloseTo(1 / 0.1667, 6);
    expect(ancient.receiveValue).toBe(5.0);
    expect(ancient.payValue!).toBeGreaterThan(ancient.receiveValue!);
  });

  it("maps the fields it already mapped, unchanged", () => {
    const divine = byName("divine orb");
    expect(divine).toMatchObject({
      game: "poe1",
      league: "Allflame",
      itemName: "divine orb",
      chaosValue: 185.4,
      source: "stash",
      ninjaCategory: "Currency",
      detailsId: "divine-orb",
    });
    expect(divine.divineValue).toBeCloseTo(1, 6);
    expect(divine.icon).toContain("http");
    expect(divine.sparklineData).toEqual(
      PAYLOAD.lines.find((l) => l.currencyTypeName === "Divine Orb")!.receiveSparkLine.data,
    );
  });

  it("maps every line in the payload", () => {
    expect(map()).toHaveLength(PAYLOAD.lines.length);
  });
});
