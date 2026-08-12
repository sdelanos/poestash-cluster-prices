/**
 * Test fixtures for the NDIC dictionary container.
 *
 * Deliberately not named `*.test.ts`: vitest would collect it as a suite, and
 * importing one test file from another re-registers its cases. Shared rather
 * than copied because the builder below hand-encodes a reverse-engineered wire
 * format — two copies would mean two places to edit when poe.ninja moves, and
 * a drifted copy would fail its suite for the wrong reason.
 *
 * Not imported by production code.
 */

import { readFileSync } from "node:fs";

/**
 * A dictionary poe.ninja really served, byte for byte, captured 2026-08-12.
 *
 * `class` is the small all-short-names case (28 entries, u7 == count).
 * `mastery` is the one that pins the varint length table: 350 entries against
 * u7 = 358, because 8 of its names run to 128 bytes or more and each costs a
 * second varint byte. Decoding it is the only check of that branch that isn't
 * circular — `buildNdic` below could encode the format wrongly in exactly the
 * same way a decoder reads it wrongly.
 */
export function readRealDictionary(facet: "class" | "mastery"): Uint8Array {
  const path = new URL(
    `./__fixtures__/${facet}-dictionary.ndic`,
    import.meta.url,
  );
  return new Uint8Array(readFileSync(path));
}

/**
 * Encode names into the NDIC v2 layout.
 *
 * Written from the format description rather than from the decoder, so a
 * round-trip asserts the layout instead of the decoder's own arithmetic.
 */
export function buildNdic(names: string[], version = 2): Uint8Array {
  const enc = new TextEncoder();
  const bodies = names.map((n) => enc.encode(n));
  const lengths = bodies.flatMap((b) => varint(b.length));
  const skipBlocks = Math.ceil(names.length / 16);

  // Skip index: one (stringOffset, lengthTableOffset) uint32 pair per 16
  // entries. Real dictionaries carry meaningful values here, so fill it
  // honestly — the decoder must derive its own offsets and step over it.
  const skip: number[] = [];
  let stringOffset = 0;
  let tableOffset = 0;
  for (let i = 0; i < names.length; i++) {
    if (i % 16 === 0) skip.push(...u32(stringOffset), ...u32(tableOffset));
    stringOffset += bodies[i].length;
    tableOffset += varint(bodies[i].length).length;
  }

  const header = [
    version, // u0 format version
    0, // u1
    names.length, // u2 count
    0xdeadbeef, // u3 content hash
    0x0badf00d, // u4 content hash
    16, // u5 entries per skip block
    skipBlocks, // u6 skip-index block count
    lengths.length, // u7 length-table byte length
  ].flatMap(u32);

  return Uint8Array.from([
    ...enc.encode("NDIC"),
    ...header,
    ...skip,
    ...lengths,
    ...bodies.flatMap((b) => Array.from(b)),
  ]);
}

/** Byte offset of header field `i`, for tests that poke at the header. */
export function headerOffset(i: number): number {
  return 4 + i * 4;
}

function varint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return out;
}

function u32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}
