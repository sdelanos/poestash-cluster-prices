import { describe, expect, it } from "vitest";
import { decodeDictionaryNames } from "./poeninja-builds";
import { buildNdic, readRealDictionary } from "./ndic-dictionary.fixture";

const DICT_URL =
  "https://poe.ninja/poe1/api/builds/dictionary/0d6b347d6a6ce194788c74fb450dbc02e6c28697";

const enc = new TextEncoder();

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
    expect(decodeDictionaryNames(buildNdic(names), DICT_URL)).toEqual(names);
  });

  it("decodes a real NDIC response end to end", () => {
    const names = decodeDictionaryNames(readRealDictionary("class"), DICT_URL);
    expect(names).toHaveLength(28);
    expect(names[0]).toBe("Ascendant");
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
      decodeDictionaryNames(
        Uint8Array.from([0x0a, 3, ...enc.encode("gem")]),
        DICT_URL,
      ),
    ).toThrow(/neither an "NDIC" container nor a protobuf name list/);
  });

  it("rejects a truncated protobuf outright, rather than returning the names it did read", () => {
    // Cutting mid-name leaves a length-delimited field running past the end.
    // Returning the prefix would sail past MIN_PLAUSIBLE_GEM_COUNT on a real
    // dictionary and then prune every gem missing from the partial list.
    const full = protobufDictionary(["Absolution", "Blade Vortex", "Zealotry"]);
    expect(() =>
      decodeDictionaryNames(full.subarray(0, full.length - 4), DICT_URL),
    ).toThrow(/neither an "NDIC" container nor a protobuf name list/);
  });

  it("names the endpoint when an NDIC container fails to decode", () => {
    const buf = buildNdic(["Absolution", "Zealotry"]);
    // Truncate into the string data so the lengths overrun the buffer.
    expect(() =>
      decodeDictionaryNames(buf.subarray(0, buf.length - 4), DICT_URL),
    ).toThrow(new RegExp(`dictionary ${DICT_URL}: .*string data`));
  });
});
