import { describe, expect, it } from "vitest";
import page from "./__fixtures__/warrant-river-page.json";
import {
  readWarrantObservation,
  readWarrantObservations,
  type RiverItem,
  type RiverStash,
} from "./warrant-observation";

/** The captured page, by the label the capture gave each stash. */
const stashes = page.stashes as RiverStash[];
const at = (label: string) => stashes[page.labels.indexOf(label)];

describe("readWarrantObservation, against a captured Allflame page", () => {
  it("reads the Mercenary off a Warrant priced by its own note", () => {
    const stash = at("byNote");
    const obs = readWarrantObservation(stash, stash.items![0]);

    expect(obs).toMatchObject({
      league: "Allflame",
      archetype: "Flamequiver",
      infamous: false,
      level: "82",
      price: { amount: 100, currency: "chaos" },
    });
    expect(obs!.skillHashes).toHaveLength(6);
    // Eleven support entries across the six skills, but only ten distinct
    // (support, tier) pairs: two skills share one. The axis is the pair.
    expect(obs!.supports).toHaveLength(10);
  });

  it("takes the price from the tab name when the item carries no note", () => {
    const stash = at("byTab");
    const obs = readWarrantObservation(stash, stash.items![0]);
    expect(obs!.price).toEqual({ amount: 20, currency: "divine" });
  });

  it("keeps the Infamous strain on the Archetype rather than splitting it out", () => {
    const stash = at("infamous");
    const obs = readWarrantObservation(stash, stash.items![0]);
    expect(obs!.archetype).toBe("Infamous Shock Ambusher");
    expect(obs!.infamous).toBe(true);
  });

  it("drops a Warrant nobody priced", () => {
    const stash = at("unpriced");
    expect(readWarrantObservation(stash, stash.items![0])).toBeNull();
  });

  it("reads every priced Warrant on a page and no others", () => {
    // Three of the four captured Warrants carry a price.
    expect(readWarrantObservations(stashes)).toHaveLength(3);
  });
});

describe("readWarrantObservation, on shapes the river also serves", () => {
  const warrant = at("byNote").items![0];
  const stash = { league: "Allflame", stash: null } as RiverStash;

  it("ignores any other base type", () => {
    const chaos: RiverItem = { id: "x", baseType: "Chaos Orb", note: "~b/o 1 chaos" };
    expect(readWarrantObservation(stash, chaos)).toBeNull();
  });

  it("drops an item with no id, since the corpus dedupes on it", () => {
    expect(readWarrantObservation(stash, { ...warrant, id: undefined })).toBeNull();
  });

  it("drops a stash with no league", () => {
    expect(readWarrantObservation({ league: null }, warrant)).toBeNull();
  });

  it("survives a Warrant whose Mercenary fields are absent", () => {
    const bare: RiverItem = {
      id: "bare",
      baseType: "Mercenary Warrant",
      note: "~b/o 1 chaos",
    };
    expect(readWarrantObservation(stash, bare)).toMatchObject({
      archetype: null,
      level: null,
      skillHashes: [],
      supports: [],
    });
  });

  it("counts a (support, tier) pair once however many skills carry it", () => {
    const shared: RiverItem = {
      id: "shared",
      baseType: "Mercenary Warrant",
      note: "~b/o 1 chaos",
      mercenarySkills: [
        { hash: 1, supports: [{ hash: 50, name: "Pierce", tier: 2 }] },
        { hash: 2, supports: [{ hash: 50, name: "Pierce", tier: 2 }] },
      ],
    };
    expect(readWarrantObservation(stash, shared)!.supports).toEqual([
      { hash: 50, name: "Pierce", tier: 2 },
    ]);
  });

  it("keeps the same support at two different tiers apart", () => {
    const twoTiers: RiverItem = {
      id: "two",
      baseType: "Mercenary Warrant",
      note: "~b/o 1 chaos",
      mercenarySkills: [
        { hash: 1, supports: [{ hash: 50, name: "Pierce", tier: 3 }] },
        { hash: 2, supports: [{ hash: 50, name: "Pierce", tier: 1 }] },
      ],
    };
    expect(readWarrantObservation(stash, twoTiers)!.supports).toEqual([
      { hash: 50, name: "Pierce", tier: 1 },
      { hash: 50, name: "Pierce", tier: 3 },
    ]);
  });

  it("reads a skill that carries no supports at all", () => {
    const noSupports: RiverItem = {
      id: "none",
      baseType: "Mercenary Warrant",
      note: "~b/o 1 chaos",
      mercenarySkills: [{ hash: 7, name: "Burning Arrow" }],
    };
    const obs = readWarrantObservation(stash, noSupports)!;
    expect(obs.skillHashes).toEqual([7]);
    expect(obs.supports).toEqual([]);
  });
});
