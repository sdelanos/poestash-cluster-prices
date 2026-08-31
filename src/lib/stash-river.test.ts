import { describe, expect, it } from "vitest";
import { seekToTail, syntheticChangeId } from "./stash-river";

describe("syntheticChangeId", () => {
  it("builds the five-component id GGG seeks on", () => {
    expect(syntheticChangeId(3_450_000_000)).toBe(
      "3450000000-3450000000-3450000000-3450000000-3450000000",
    );
  });

  it("floors a fractional position, since a component is an integer", () => {
    expect(syntheticChangeId(10.9)).toBe("10-10-10-10-10");
  });
});

/** A stream whose stashes run out past `tail`. */
const streamEndingAt = (tail: number) => {
  const probed: number[] = [];
  const hasStashes = async (id: string) => {
    const n = Number(id.split("-")[0]);
    probed.push(n);
    return n <= tail;
  };
  return { hasStashes, probed };
};

describe("seekToTail", () => {
  it("finds the tail within the requested precision", async () => {
    const { hasStashes } = streamEndingAt(3_460_000_000);
    const { position } = await seekToTail(hasStashes, { precision: 5_000_000 });
    expect(position).toBeLessThanOrEqual(3_460_000_000);
    expect(3_460_000_000 - position).toBeLessThanOrEqual(5_000_000);
  });

  it("lands on a position that still has stashes, never past the end", async () => {
    const { hasStashes } = streamEndingAt(3_460_000_000);
    const { position } = await seekToTail(hasStashes);
    expect(await hasStashes(syntheticChangeId(position))).toBe(true);
  });

  it("costs a handful of probes over the default bracket", async () => {
    // Bisection over 1e9..2e10 to 5e6 is ~12 requests: seconds of budget,
    // against a walk from 2013 that would never finish.
    const { probes } = await seekToTail(streamEndingAt(3_460_000_000).hasStashes);
    expect(probes).toBeLessThanOrEqual(13);
  });

  it("follows a tail that has moved, rather than trusting a past measurement", async () => {
    // The issue measured ~5.2e9; by implementation the live tail was 3.46e9.
    const early = await seekToTail(streamEndingAt(3_460_000_000).hasStashes);
    const later = await seekToTail(streamEndingAt(5_200_000_000).hasStashes);
    expect(later.position).toBeGreaterThan(early.position);
  });

  it("returns the bracket floor when the whole bracket reads empty", async () => {
    const { position } = await seekToTail(async () => false, {
      low: 1_000,
      high: 9_000,
      precision: 100,
    });
    expect(position).toBe(1_000);
  });

  it("honours an explicit bracket", async () => {
    const { position } = await seekToTail(streamEndingAt(500).hasStashes, {
      low: 0,
      high: 1_000,
      precision: 10,
    });
    expect(position).toBeGreaterThan(490);
    expect(position).toBeLessThanOrEqual(500);
  });
});
