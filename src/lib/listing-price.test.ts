import { describe, expect, it } from "vitest";
import { readListingPrice, toChaos } from "./listing-price";

describe("readListingPrice", () => {
  it("reads a buyout note", () => {
    expect(readListingPrice("~b/o 100 chaos", null)).toEqual({ amount: 100, currency: "chaos" });
  });

  it("reads a fixed-price note", () => {
    expect(readListingPrice("~price 3 divine", null)).toEqual({ amount: 3, currency: "divine" });
  });

  it("falls back to the stash tab name when the item carries no note", () => {
    expect(readListingPrice(null, "~price 5 chaos")).toEqual({ amount: 5, currency: "chaos" });
  });

  it("prefers the item's own note over the tab name", () => {
    expect(readListingPrice("~b/o 1 divine", "~price 5 chaos")).toEqual({
      amount: 1,
      currency: "divine",
    });
  });

  it("reads a price token embedded in a longer tab name", () => {
    // Measured live: "~price 3 chaos Bulk Sales" is a real Allflame tab name.
    expect(readListingPrice(null, "~price 3 chaos Bulk Sales")).toEqual({
      amount: 3,
      currency: "chaos",
    });
  });

  it("reads a fractional amount", () => {
    expect(readListingPrice("~b/o 0.5 divine", null)).toEqual({ amount: 0.5, currency: "divine" });
  });

  it("excludes a Currency Exchange offer rather than reading it as an amount", () => {
    expect(readListingPrice("~price 1 offer", null)).toBeNull();
  });

  it("does not fall back to the tab name when the item's own note is an offer", () => {
    // The item is explicitly on the exchange. The tab's asking price is not
    // this item's price, so the observation is dropped, not rescued.
    expect(readListingPrice("~price 1 offer", "~b/o 40 chaos")).toBeNull();
  });

  it("returns null for an unpriced tab name", () => {
    expect(readListingPrice(null, "Potential Mercs")).toBeNull();
  });

  it("returns null when neither note nor tab name exists", () => {
    expect(readListingPrice(null, null)).toBeNull();
  });

  it("reads a European decimal comma", () => {
    expect(readListingPrice("~b/o 1,5 divine", null)).toEqual({ amount: 1.5, currency: "divine" });
  });

  it("drops an amount whose comma could be thousands or a decimal", () => {
    // `1,500` is 1500 to an English seller and 1.5 to a European one, and the
    // token does not say. Halving it silently is the same cheap-direction
    // error the exchange trap is refused for, so the listing is dropped.
    expect(readListingPrice("~b/o 1,500 chaos", null)).toBeNull();
  });

  it("returns null for a non-positive or unparseable amount", () => {
    expect(readListingPrice("~b/o 0 chaos", null)).toBeNull();
    expect(readListingPrice("~b/o many chaos", null)).toBeNull();
  });

  it("lowercases the currency slug", () => {
    expect(readListingPrice("~b/o 2 Divine", null)).toEqual({ amount: 2, currency: "divine" });
  });
});

describe("toChaos", () => {
  const rates = new Map([
    ["chaos", 1],
    ["divine", 185],
  ]);

  it("converts a known currency", () => {
    expect(toChaos({ amount: 2, currency: "divine" }, rates)).toBe(370);
  });

  it("passes chaos through", () => {
    expect(toChaos({ amount: 40, currency: "chaos" }, rates)).toBe(40);
  });

  it("returns null for a currency the league has no rate for", () => {
    // Mirror listings are real and rare. Without a rate we drop the
    // observation rather than guess a number into the corpus.
    expect(toChaos({ amount: 1, currency: "mirror" }, rates)).toBeNull();
  });
});
