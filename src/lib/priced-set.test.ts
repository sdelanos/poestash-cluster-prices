import { describe, it, expect } from "vitest";
import {
  selectPricedSet,
  selectCurrentChallengeLeague,
  type LeagueLike,
} from "./priced-set";

const named = (names: string[]): LeagueLike[] => names.map((name) => ({ name }));

const NOW = Date.parse("2026-07-22T00:00:00Z");
const FUTURE = "2026-09-01T00:00:00Z";
const PAST = "2026-06-01T00:00:00Z";

describe("selectPricedSet", () => {
  it("between leagues: only permanent leagues listed -> Standard + Hardcore", () => {
    // The current incident state: no challenge league is live.
    const leagues = named(["Standard", "Hardcore", "Solo Self-Found", "Hardcore SSF"]);
    expect(selectPricedSet(leagues, { now: NOW })).toEqual(["Standard", "Hardcore"]);
  });

  it("live challenge league: adds the challenge and its Hardcore variant", () => {
    const leagues = named([
      "Standard",
      "Hardcore",
      "Solo Self-Found",
      "Mirage",
      "Hardcore Mirage",
      "SSF Mirage",
      "HC SSF Mirage",
    ]);
    expect(selectPricedSet(leagues, { now: NOW })).toEqual([
      "Standard",
      "Hardcore",
      "Mirage",
      "Hardcore Mirage",
    ]);
  });

  it("never prices SSF or Ruthless variants", () => {
    const leagues = named([
      "Standard",
      "Hardcore",
      "Ruthless",
      "Hardcore Ruthless",
      "SSF Ruthless",
      "Mirage",
      "Ruthless Mirage",
      "SSF Mirage",
    ]);
    expect(selectPricedSet(leagues, { now: NOW })).toEqual([
      "Standard",
      "Hardcore",
      "Mirage",
    ]);
  });

  it("includes the challenge even if its Hardcore variant is missing", () => {
    const leagues = named(["Standard", "Hardcore", "Mirage"]);
    expect(selectPricedSet(leagues, { now: NOW })).toEqual([
      "Standard",
      "Hardcore",
      "Mirage",
    ]);
  });

  it("dual-list window: old + new challenge both live -> prices both", () => {
    // During a rollover the source briefly lists the outgoing and incoming
    // leagues together. Both are still live, so both are priced.
    const leagues: LeagueLike[] = [
      { name: "Standard" },
      { name: "Hardcore" },
      { name: "Mirage", endAt: FUTURE },
      { name: "Hardcore Mirage", endAt: FUTURE },
      { name: "Fate of the Vaal", endAt: null },
      { name: "Hardcore Fate of the Vaal", endAt: null },
    ];
    expect(selectPricedSet(leagues, { now: NOW })).toEqual([
      "Standard",
      "Hardcore",
      "Mirage",
      "Hardcore Mirage",
      "Fate of the Vaal",
      "Hardcore Fate of the Vaal",
    ]);
  });

  it("event overlap: prices both the challenge league and the event", () => {
    // An Ancestors-style event running next to the main league. Both are live
    // economies, so both are priced. The main league is never dropped.
    const leagues: LeagueLike[] = [
      { name: "Standard" },
      { name: "Hardcore" },
      { name: "Mirage", endAt: FUTURE },
      { name: "Hardcore Mirage", endAt: FUTURE },
      { name: "Return of the Ancestors", endAt: FUTURE },
    ];
    expect(selectPricedSet(leagues, { now: NOW })).toEqual([
      "Standard",
      "Hardcore",
      "Mirage",
      "Hardcore Mirage",
      "Return of the Ancestors",
    ]);
  });

  it("ignores an ended challenge league still listed by the source", () => {
    const leagues: LeagueLike[] = [
      { name: "Standard" },
      { name: "Hardcore" },
      { name: "Mirage", endAt: PAST },
      { name: "Hardcore Mirage", endAt: PAST },
    ];
    expect(selectPricedSet(leagues, { now: NOW })).toEqual(["Standard", "Hardcore"]);
  });

  it("drops permanent Hardcore when asked (gem-usage), keeps the HC challenge", () => {
    const leagues = named(["Standard", "Hardcore", "Mirage", "Hardcore Mirage", "SSF Mirage"]);
    expect(
      selectPricedSet(leagues, { now: NOW, includePermanentHardcore: false }),
    ).toEqual(["Standard", "Mirage", "Hardcore Mirage"]);
  });

  it("names-only input (poe.ninja index-state, no dates): single live challenge", () => {
    const leagues = named(["Standard", "Mirage", "Hardcore Mirage", "SSF Mirage"]);
    expect(selectPricedSet(leagues)).toEqual(["Standard", "Mirage", "Hardcore Mirage"]);
  });

  it("returns only leagues actually present (never fabricates Standard/Hardcore)", () => {
    const leagues = named(["Mirage", "Hardcore Mirage"]);
    expect(selectPricedSet(leagues, { now: NOW })).toEqual(["Mirage", "Hardcore Mirage"]);
  });

  it("deduplicates repeated names", () => {
    const leagues = named(["Standard", "Standard", "Hardcore"]);
    expect(selectPricedSet(leagues, { now: NOW })).toEqual(["Standard", "Hardcore"]);
  });
});

describe("selectCurrentChallengeLeague", () => {
  /** After Allflame went live, so the fixtures below read as "now". */
  const AFTER_LAUNCH = Date.parse("2026-07-25T00:00:00Z");

  /** Softcore challenge names as GGG lists them, with start dates. */
  const dated = (entries: [string, string | null][]): LeagueLike[] =>
    entries.map(([name, startAt]) => ({ name, startAt }));

  it("picks the only live challenge league", () => {
    const leagues = dated([
      ["Standard", "2013-01-23T21:00:00Z"],
      ["Hardcore", "2013-01-23T21:00:00Z"],
      ["Allflame", "2026-07-24T20:00:00Z"],
      ["Hardcore Allflame", "2026-07-24T20:00:00Z"],
    ]);
    expect(selectCurrentChallengeLeague(leagues, { now: AFTER_LAUNCH })).toBe("Allflame");
  });

  it("rollover dual-list: takes the newest challenge league by start date", () => {
    // GGG lists the ending and starting league together for hours-to-days.
    // Order is deliberately oldest-last to prove we sort, not take index 0.
    const leagues = dated([
      ["Standard", "2013-01-23T21:00:00Z"],
      ["Allflame", "2026-07-24T20:00:00Z"],
      ["Mirage", "2026-04-04T20:00:00Z"],
    ]);
    expect(selectCurrentChallengeLeague(leagues, { now: AFTER_LAUNCH })).toBe("Allflame");
  });

  it("never returns a Hardcore, SSF or Ruthless variant", () => {
    const leagues = dated([
      ["Standard", "2013-01-23T21:00:00Z"],
      ["Hardcore Allflame", "2026-07-24T20:00:00Z"],
      ["HC SSF Allflame", "2026-07-24T20:00:00Z"],
      ["Ruthless Allflame", "2026-07-24T20:00:00Z"],
      ["SSF R Allflame", "2026-07-24T20:00:00Z"],
      ["SSF Allflame", "2026-07-24T20:00:00Z"],
      ["Allflame", "2026-07-24T20:00:00Z"],
    ]);
    expect(selectCurrentChallengeLeague(leagues, { now: AFTER_LAUNCH })).toBe("Allflame");
  });

  it("between leagues: no challenge league live -> null, never a permanent league", () => {
    // Returning "Standard" here would silently price the wrong economy for
    // months, so the caller must be told there is nothing to price instead.
    const leagues = dated([
      ["Standard", "2013-01-23T21:00:00Z"],
      ["Hardcore", "2013-01-23T21:00:00Z"],
      ["Solo Self-Found", "2013-01-23T21:00:00Z"],
    ]);
    expect(selectCurrentChallengeLeague(leagues, { now: AFTER_LAUNCH })).toBeNull();
  });

  it("skips a challenge league that has already ended", () => {
    const leagues = dated([["Standard", "2013-01-23T21:00:00Z"]]).concat([
      { name: "Mirage", startAt: "2026-04-04T20:00:00Z", endAt: PAST },
    ]);
    expect(selectCurrentChallengeLeague(leagues, { now: AFTER_LAUNCH })).toBeNull();
  });

  it("ignores a challenge league whose start date is still in the future", () => {
    // GGG publishes the next league before it goes live; pricing it early
    // means querying trade for a league with no listings.
    const leagues = dated([
      ["Standard", "2013-01-23T21:00:00Z"],
      ["Mirage", "2026-04-04T20:00:00Z"],
      ["Allflame", FUTURE],
    ]);
    expect(selectCurrentChallengeLeague(leagues, { now: AFTER_LAUNCH })).toBe("Mirage");
  });

  it("falls back to the first challenge league when no start dates are exposed", () => {
    const leagues = named(["Standard", "Mirage", "Hardcore Mirage"]);
    expect(selectCurrentChallengeLeague(leagues, { now: AFTER_LAUNCH })).toBe("Mirage");
  });

  it("empty input -> null", () => {
    expect(selectCurrentChallengeLeague([], { now: AFTER_LAUNCH })).toBeNull();
  });

  it("the just-started league beats an older one regardless of list order", () => {
    // Regression guard for the rollover bug. `resolveTradeLeague` must pick
    // from GGG's full list and only then ask whether poe.ninja priced the
    // winner. Pre-filtering to "leagues poe.ninja has data for" leaves the
    // ended league as the only candidate (ninja_price_meta retains it for
    // days), and it wins — which is how the rollover kept pricing Mirage.
    const preFilteredToStaleOnly = dated([["Mirage", "2026-04-04T20:00:00Z"]]);
    expect(
      selectCurrentChallengeLeague(preFilteredToStaleOnly, { now: AFTER_LAUNCH }),
    ).toBe("Mirage");

    const fullList = dated([
      ["Mirage", "2026-04-04T20:00:00Z"],
      ["Allflame", "2026-07-24T20:00:00Z"],
    ]);
    expect(selectCurrentChallengeLeague(fullList, { now: AFTER_LAUNCH })).toBe(
      "Allflame",
    );
  });
});
