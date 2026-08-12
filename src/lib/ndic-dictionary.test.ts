import { describe, expect, it } from "vitest";
import { decodeNdicDictionary, hasNdicMagic } from "./ndic-dictionary";
import {
  buildNdic,
  headerOffset,
  readRealDictionary,
} from "./ndic-dictionary.fixture";

const LEN_TABLE_BYTES = headerOffset(7);

/** Declared length-table size, straight from the container header. */
function lenTableBytes(buf: Uint8Array): number {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(
    LEN_TABLE_BYTES,
    true,
  );
}

const byteLength = (s: string) => new TextEncoder().encode(s).length;

describe("hasNdicMagic", () => {
  it("recognises the NDIC container", () => {
    expect(hasNdicMagic(buildNdic(["Zealotry"]))).toBe(true);
    expect(hasNdicMagic(readRealDictionary("class"))).toBe(true);
  });

  it("rejects bare protobuf and short buffers", () => {
    // A protobuf dictionary starts with tag 0x0A (field 1, wire type 2).
    expect(hasNdicMagic(Uint8Array.from([0x0a, 0x03, 0x67, 0x65, 0x6d]))).toBe(
      false,
    );
    expect(hasNdicMagic(Uint8Array.from([0x4e, 0x44]))).toBe(false);
  });
});

describe("decodeNdicDictionary, against dictionaries poe.ninja really served", () => {
  it("decodes `class`, whose names are all under 128 bytes", () => {
    const buf = readRealDictionary("class");
    const names = decodeNdicDictionary(buf);

    // One varint byte per length, so the table is exactly `count` bytes.
    expect(lenTableBytes(buf)).toBe(28);
    expect(names).toHaveLength(28);
    expect(names[0]).toBe("Ascendant");
    expect(names[names.length - 1]).toBe("Witch");
    expect(names).toContain("Necromancer");
    expect(names.filter((n) => n.length === 0)).toHaveLength(0);
  });

  it("decodes `mastery`, which carries names of 128 bytes or more", () => {
    const buf = readRealDictionary("mastery");
    const names = decodeNdicDictionary(buf);

    // The real proof that the length table is varint-encoded: 350 entries but
    // 358 table bytes, because 8 names cost a second byte. Read from actual
    // poe.ninja bytes, so it cannot agree with a wrong encoder in the tests.
    expect(lenTableBytes(buf)).toBe(358);
    expect(names).toHaveLength(350);
    expect(names.filter((n) => byteLength(n) >= 128)).toHaveLength(8);

    expect(names[0]).toBe("+0.3 metres to Melee Strike Range");
    expect(names[names.length - 1]).toBe(
      "Your Movement Speed is equal to the highest Movement Speed among Linked Players",
    );
    expect(names.filter((n) => n.length === 0)).toHaveLength(0);
  });
});

describe("decodeNdicDictionary", () => {
  it("decodes a dictionary whose names are all under 128 bytes", () => {
    // 20 entries, so the skip index spans two blocks and must be stepped over.
    const names = Array.from({ length: 20 }, (_, i) => `Gem ${i}`);
    const buf = buildNdic(names);

    expect(lenTableBytes(buf)).toBe(names.length);
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

    // 3 short names at 1 byte + 2 long names at 2 bytes = 7 > count of 5.
    expect(lenTableBytes(buf)).toBe(7);
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
    expect(() => decodeNdicDictionary(buildNdic(["Zealotry"], 3))).toThrow(
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
      LEN_TABLE_BYTES,
      5,
      true,
    );
    expect(() => decodeNdicDictionary(buf)).toThrow(/length table/i);
  });

  it("rejects string data that overruns the buffer", () => {
    const buf = buildNdic(["Absolution", "Zealotry"]);
    expect(() => decodeNdicDictionary(buf.subarray(0, buf.length - 3))).toThrow(
      /string data/i,
    );
  });
});
