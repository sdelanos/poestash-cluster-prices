import { describe, expect, it } from "vitest";
import { decodeDictionaryNames } from "./poeninja-builds";

const DICT_URL =
  "https://poe.ninja/poe1/api/builds/dictionary/0d6b347d6a6ce194788c74fb450dbc02e6c28697";

const enc = new TextEncoder();

/** Minimal NDIC container. Deliberately narrow — up to 16 entries, each under
 *  128 bytes — so it stays a one-block, one-byte-per-length case. The full
 *  layout, including the two-byte varint branch, is covered in
 *  ndic-dictionary.test.ts. */
function tinyNdic(names: string[]): Uint8Array {
  const bodies = names.map((n) => enc.encode(n));
  const header = new Uint8Array(36);
  header.set(enc.encode("NDIC"), 0);
  const dv = new DataView(header.buffer);
  dv.setUint32(4 + 0 * 4, 2, true); // format version
  dv.setUint32(4 + 2 * 4, names.length, true); // count
  dv.setUint32(4 + 6 * 4, 1, true); // one skip block
  dv.setUint32(4 + 7 * 4, names.length, true); // length table bytes
  return Uint8Array.from([
    ...header,
    ...new Array(8).fill(0), // the single skip-index entry
    ...bodies.map((b) => b.length),
    ...bodies.flatMap((b) => Array.from(b)),
  ]);
}

/** The pre-2026-08-03 shape: field 1 type label, field 2 repeated names. */
function protobufDictionary(names: string[]): Uint8Array {
  const out: number[] = [0x0a, 3, ...enc.encode("gem")];
  for (const name of names) {
    const b = enc.encode(name);
    out.push(0x12, b.length, ...Array.from(b));
  }
  return Uint8Array.from(out);
}

describe("decodeDictionaryNames", () => {
  it("decodes the NDIC container", () => {
    const names = ["Absolution", "Blade Vortex", "Zealotry"];
    expect(decodeDictionaryNames(tinyNdic(names), DICT_URL)).toEqual(names);
  });

  it("still decodes the legacy bare protobuf shape", () => {
    const names = ["Absolution", "Blade Vortex", "Zealotry"];
    expect(decodeDictionaryNames(protobufDictionary(names), DICT_URL)).toEqual(
      names,
    );
  });

  it("names the endpoint and leading bytes when the shape is neither", () => {
    // What an error page or a rewritten API actually looks like on the wire.
    const html = enc.encode("<!DOCTYPE html><html><body>502</body></html>");

    let message = "";
    try {
      decodeDictionaryNames(html, DICT_URL);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain(DICT_URL);
    expect(message).toContain("NDIC");
    expect(message).toContain("3c 21 44 4f"); // hex of "<!DO"
    expect(message).toContain("<!DOCTYP"); // first 8 bytes, as ASCII
    // Not the bare wire-type error that made the original outage unreadable.
    expect(message).not.toMatch(/^unsupported wire type/);
  });

  it("rejects a protobuf message that carries no names", () => {
    // Parses cleanly, but field 2 is absent: the endpoint moved on.
    expect(() =>
      decodeDictionaryNames(Uint8Array.from([0x0a, 3, ...enc.encode("gem")]), DICT_URL),
    ).toThrow(/neither an "NDIC" container nor a protobuf name list/);
  });

  it("names the endpoint when an NDIC container fails to decode", () => {
    const buf = tinyNdic(["Absolution", "Zealotry"]);
    // Truncate into the string data so the lengths overrun the buffer.
    expect(() => decodeDictionaryNames(buf.subarray(0, buf.length - 4), DICT_URL)).toThrow(
      new RegExp(`dictionary ${DICT_URL}: .*string data`),
    );
  });
});
