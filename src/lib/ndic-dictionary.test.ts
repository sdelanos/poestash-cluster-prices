import { describe, expect, it } from "vitest";
import { decodeNdicDictionary, hasNdicMagic } from "./ndic-dictionary";

// ---------------------------------------------------------------------------
// Fixture builder: encodes the NDIC v2 layout the decoder is meant to read.
//
// Written independently of the decoder so a round-trip actually asserts the
// layout rather than the decoder's own arithmetic. The golden test below
// anchors both against bytes poe.ninja really served.
// ---------------------------------------------------------------------------

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

function buildNdic(
  names: string[],
  opts: { version?: number } = {},
): Uint8Array {
  const enc = new TextEncoder();
  const bodies = names.map((n) => enc.encode(n));
  const lengths = bodies.flatMap((b) => varint(b.length));
  const skipBlocks = Math.ceil(names.length / 16);

  // Skip index: one (stringOffset, lengthTableOffset) u32 pair per 16 entries.
  // Real dictionaries carry meaningful values here; the decoder must derive its
  // own offsets from the header and step over this block untouched.
  const skip: number[] = [];
  let strOff = 0;
  let tabOff = 0;
  for (let i = 0; i < names.length; i++) {
    if (i % 16 === 0) {
      skip.push(...u32(strOff), ...u32(tabOff));
    }
    strOff += bodies[i].length;
    tabOff += varint(bodies[i].length).length;
  }

  const header = [
    opts.version ?? 2, // u0 format version
    0, // u1
    names.length, // u2 count
    0xdeadbeef, // u3 content hash
    0x0badf00d, // u4 content hash
    16, // u5
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

function u32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

/** The real `class` dictionary poe.ninja served on 2026-08-12: 311 bytes,
 *  28 entries, every name comfortably under 128 bytes. */
const REAL_CLASS_DICTIONARY = Buffer.from(
  "TkRJQwIAAAAAAAAAHAAAANt/dFTRsPvLEAAAAAIAAAAcAAAAAAAAAAAAAACPAAAAEAAAAAkICQgJ" +
    "BwcMCQgKCgoICAsJCgYLCAUGBgcJBgVBc2NlbmRhbnRBc3Nhc3NpbkJlcnNlcmtlckNoYW1wa" +
    "W9uQ2hpZWZ0YWluRGVhZGV5ZUR1ZWxpc3RFbGVtZW50YWxpc3RHbGFkaWF0b3JHdWFyZGlhbk" +
    "hpZXJvcGhhbnRJbnF1aXNpdG9ySnVnZ2VybmF1dEx1bWluYXJ5TWFyYXVkZXJOZWNyb21hbmN" +
    "lck9jY3VsdGlzdFBhdGhmaW5kZXJSYW5nZXJSZWxpcXVhcmlhblNhYm90ZXVyU2Npb25TaGFk" +
    "b3dTbGF5ZXJUZW1wbGFyVHJpY2tzdGVyV2FyZGVuV2l0Y2g=",
  "base64",
);

describe("hasNdicMagic", () => {
  it("recognises the NDIC container", () => {
    expect(hasNdicMagic(buildNdic(["Zealotry"]))).toBe(true);
  });

  it("rejects bare protobuf and short buffers", () => {
    // A protobuf dictionary starts with tag 0x0A (field 1, wire type 2).
    expect(hasNdicMagic(Uint8Array.from([0x0a, 0x03, 0x67, 0x65, 0x6d]))).toBe(
      false,
    );
    expect(hasNdicMagic(Uint8Array.from([0x4e, 0x44]))).toBe(false);
  });
});

describe("decodeNdicDictionary", () => {
  it("decodes the real class dictionary poe.ninja served", () => {
    const names = decodeNdicDictionary(new Uint8Array(REAL_CLASS_DICTIONARY));

    expect(names).toHaveLength(28);
    expect(names[0]).toBe("Ascendant");
    expect(names[names.length - 1]).toBe("Witch");
    expect(names).toContain("Necromancer");
    expect(names.filter((n) => n.length === 0)).toHaveLength(0);
  });

  it("decodes a dictionary whose names are all under 128 bytes", () => {
    // 20 entries, so the skip index spans two blocks and must be stepped over.
    const names = Array.from({ length: 20 }, (_, i) => `Gem ${i}`);
    const buf = buildNdic(names);

    // One varint byte per length: the length table is exactly `count` bytes.
    const lenTableBytes = new DataView(
      buf.buffer,
      buf.byteOffset,
      buf.byteLength,
    ).getUint32(4 + 7 * 4, true);
    expect(lenTableBytes).toBe(names.length);

    expect(decodeNdicDictionary(buf)).toEqual(names);
  });

  it("decodes a dictionary containing names of 128 bytes or more", () => {
    // The two-byte varint branch: anything >= 128 bytes costs a second byte,
    // so the length table grows past `count` and every later offset shifts.
    const names = [
      "Absolution",
      "L".repeat(128),
      "Blade Vortex",
      "M".repeat(300),
      "Zealotry",
    ];
    const buf = buildNdic(names);

    const lenTableBytes = new DataView(
      buf.buffer,
      buf.byteOffset,
      buf.byteLength,
    ).getUint32(4 + 7 * 4, true);
    // 3 short names at 1 byte + 2 long names at 2 bytes = 7 > count of 5.
    expect(lenTableBytes).toBe(7);

    expect(decodeNdicDictionary(buf)).toEqual(names);
  });

  it("decodes multi-byte UTF-8 names by byte length, not code-point count", () => {
    const names = ["Всплеск", "召喚', 骸骨", "Ätherische Wut"];
    expect(decodeNdicDictionary(buildNdic(names))).toEqual(names);
  });

  it("handles an empty dictionary", () => {
    expect(decodeNdicDictionary(buildNdic([]))).toEqual([]);
  });

  it("rejects a buffer without the magic", () => {
    expect(() =>
      decodeNdicDictionary(Uint8Array.from([0x0a, 0x03, 0x67])),
    ).toThrow(/NDIC/);
  });

  it("rejects an unsupported format version rather than mis-decoding it", () => {
    expect(() => decodeNdicDictionary(buildNdic(["Zealotry"], { version: 3 }))).toThrow(
      /version 3/,
    );
  });

  it("rejects a truncated header", () => {
    expect(() =>
      decodeNdicDictionary(buildNdic(["Zealotry"]).subarray(0, 20)),
    ).toThrow(/truncated/i);
  });

  it("rejects a length table that disagrees with the header", () => {
    const buf = buildNdic(["Absolution", "Zealotry"]);
    // Claim a longer length table than the varints actually occupy.
    new DataView(buf.buffer, buf.byteOffset, buf.byteLength).setUint32(
      4 + 7 * 4,
      5,
      true,
    );
    expect(() => decodeNdicDictionary(buf)).toThrow(/length table/i);
  });

  it("rejects string data that overruns the buffer", () => {
    const names = ["Absolution", "Zealotry"];
    const buf = buildNdic(names);
    expect(() =>
      decodeNdicDictionary(buf.subarray(0, buf.length - 3)),
    ).toThrow(/string data/i);
  });
});
