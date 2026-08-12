/**
 * Decoder for poe.ninja's "NDIC" dictionary container.
 *
 * On 2026-08-03 poe.ninja stopped serving /poe1/api/builds/dictionary/{hash}
 * as bare protobuf and started wrapping the name list in a custom container,
 * while still advertising `content-type: application/x-protobuf`. The magic
 * bytes are ASCII "NDIC"; the leading 0x4E parses as protobuf field 9 / wire
 * type 6, so the old decoder died on byte 0 with "unsupported wire type 6".
 *
 * No public schema exists. The layout below was derived empirically from four
 * live dictionaries (class 28, mastery 350, gem 821, item 1323 entries) and is
 * pinned by tests, including a golden copy of a real response:
 *
 *   [0, 4)                  magic "NDIC" (ASCII)
 *   [4, 36)                 header, 8 x uint32 little-endian:
 *                             u0 = 2                 format version
 *                             u2 = count             number of entries
 *                             u3, u4                 content hash
 *                             u5 = 16                entries per skip block
 *                             u6 = ceil(count/16)    skip-index block count
 *                             u7 = lenTableBytes     length-table byte length
 *   [36, tableStart)        skip index, u6 * 8 bytes: one (stringOffset,
 *                           lengthTableOffset) uint32 pair per 16 entries
 *   [tableStart, strStart)  length table: `count` varint byte lengths,
 *                           occupying exactly u7 bytes
 *   [strStart, EOF)         concatenated UTF-8 string data
 *
 *   tableStart = 36 + 8 * u6
 *   strStart   = tableStart + u7
 *
 * The skip index only exists to let poe.ninja's WASM client seek to entry
 * N without walking the length table; decoding sequentially we step over it.
 *
 * The length table is varint-encoded, not one byte per entry. `mastery` is the
 * facet that proves it: 350 entries against u7 = 358, because it carries
 * exactly 8 names of >= 128 bytes, each costing a second varint byte.
 */

const MAGIC = [0x4e, 0x44, 0x49, 0x43]; // "NDIC"

/** Byte offset of the skip index, i.e. magic + the 8-uint32 header. */
const HEADER_END = 36;

/** The only container version we know how to read. */
const SUPPORTED_VERSION = 2;

/** True when `buf` opens with the NDIC container magic. */
export function hasNdicMagic(buf: Uint8Array): boolean {
  return (
    buf.length >= MAGIC.length && MAGIC.every((byte, i) => buf[i] === byte)
  );
}

/**
 * Decode an NDIC container into its ordered list of names. The index a
 * manifest facet entry refers to is a position in the returned array.
 *
 * Throws when the buffer is not an NDIC container, announces a version we
 * have not reverse-engineered, or is internally inconsistent — a silent
 * mis-decode would poison the gem-usage table, which is worse than a failed
 * run.
 */
export function decodeNdicDictionary(buf: Uint8Array): string[] {
  if (!hasNdicMagic(buf)) {
    throw new Error(
      `not an NDIC container: expected magic "NDIC", got ${leadingBytes(buf)}`,
    );
  }
  if (buf.length < HEADER_END) {
    throw new Error(
      `NDIC dictionary: truncated header, need ${HEADER_END} bytes, got ${buf.length}`,
    );
  }

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u = (i: number) => view.getUint32(4 + i * 4, true);

  const version = u(0);
  if (version !== SUPPORTED_VERSION) {
    throw new Error(
      `NDIC dictionary: unsupported format version ${version}, expected ${SUPPORTED_VERSION}`,
    );
  }

  const count = u(2);
  const skipBlocks = u(6);
  const lenTableBytes = u(7);

  const tableStart = HEADER_END + 8 * skipBlocks;
  const strStart = tableStart + lenTableBytes;
  if (strStart > buf.length) {
    throw new Error(
      `NDIC dictionary: header points past the buffer (count=${count}, skipBlocks=${skipBlocks}, lenTableBytes=${lenTableBytes}, string data would start at ${strStart} of ${buf.length} bytes)`,
    );
  }

  // Length table: `count` varints that must consume exactly u7 bytes. A
  // disagreement means we are reading the wrong region, so refuse to guess.
  const lengths: number[] = [];
  let pos = tableStart;
  let total = 0;
  for (let i = 0; i < count; i++) {
    const { value, next } = readVarint(buf, pos, strStart, i);
    lengths.push(value);
    total += value;
    pos = next;
  }
  if (pos !== strStart) {
    throw new Error(
      `NDIC dictionary: length table for ${count} entries consumed ${pos - tableStart} bytes, header declared ${lenTableBytes}`,
    );
  }

  const available = buf.length - strStart;
  if (total > available) {
    throw new Error(
      `NDIC dictionary: string data overruns the buffer, lengths sum to ${total} but only ${available} bytes follow the length table`,
    );
  }
  if (total < available) {
    // Every dictionary observed so far ends exactly on the last name. Trailing
    // bytes are harmless to us but signal the format moved on, so say so.
    console.warn(
      `[ndic-dictionary] ${available - total} trailing bytes after the last of ${count} names. poe.ninja may have extended the container.`,
    );
  }

  const decoder = new TextDecoder("utf-8");
  const names: string[] = [];
  let at = strStart;
  for (const len of lengths) {
    names.push(decoder.decode(buf.subarray(at, at + len)));
    at += len;
  }
  return names;
}

function readVarint(
  buf: Uint8Array,
  start: number,
  limit: number,
  entry: number,
): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let pos = start;
  while (pos < limit) {
    const byte = buf[pos++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: pos };
    shift += 7;
    if (shift > 28) {
      throw new Error(
        `NDIC dictionary: length varint for entry ${entry} is too long`,
      );
    }
  }
  throw new Error(
    `NDIC dictionary: length table ended mid-varint at entry ${entry}`,
  );
}

/** First bytes of a buffer as hex plus their printable ASCII, for errors. */
export function leadingBytes(buf: Uint8Array): string {
  const head = Array.from(buf.subarray(0, 8));
  const hex = head.map((b) => b.toString(16).padStart(2, "0")).join(" ");
  const ascii = head
    .map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : "."))
    .join("");
  return `${hex || "<empty>"} (${JSON.stringify(ascii)})`;
}
