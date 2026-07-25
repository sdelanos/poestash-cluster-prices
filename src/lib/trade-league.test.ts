import { describe, it, expect, vi } from "vitest";
import type postgres from "postgres";
import { resolveTradeLeague } from "./trade-league";

/**
 * Minimal stand-in for the `postgres` tagged-template client. Routes on the
 * table named in the query, which is all `resolveTradeLeague` distinguishes.
 */
function fakeSql(opts: {
  /** Contents of poe_leagues_cache.leagues, or null for "no poe1/pc row". */
  listed: { id: string; startAt?: string | null }[] | null;
  /** League names present in ninja_price_meta. */
  priced: string[];
}) {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    if (text.includes("poe_leagues_cache")) {
      return Promise.resolve(
        opts.listed === null ? [] : [{ leagues: opts.listed }],
      );
    }
    if (text.includes("ninja_price_meta")) {
      // Answer truthfully whether the query names one league or asks for all,
      // so this fake does not quietly bless one implementation's query shape.
      const asked = values.filter((v): v is string => typeof v === "string");
      const rows = (asked.length > 0 ? asked : opts.priced)
        .filter((league) => opts.priced.includes(league))
        .map((league) => ({ league }));
      return Promise.resolve(rows);
    }
    throw new Error(`unexpected query: ${text}`);
  };
  return sql as unknown as postgres.Sql;
}

const GGG_AT_ROLLOVER = [
  { id: "Standard", startAt: "2013-01-23T21:00:00Z" },
  { id: "Hardcore", startAt: "2013-01-23T21:00:00Z" },
  { id: "Mirage", startAt: "2026-04-04T20:00:00Z" },
  { id: "Allflame", startAt: "2026-07-24T20:00:00Z" },
  { id: "Hardcore Allflame", startAt: "2026-07-24T20:00:00Z" },
  { id: "SSF Allflame", startAt: "2026-07-24T20:00:00Z" },
];

describe("resolveTradeLeague", () => {
  it("picks the newest league GGG lists once poe.ninja has priced it", async () => {
    const sql = fakeSql({
      listed: GGG_AT_ROLLOVER,
      priced: ["Standard", "Mirage", "Allflame"],
    });
    await expect(resolveTradeLeague(sql, undefined)).resolves.toBe("Allflame");
  });

  it("skips rather than falling back to the ended league poe.ninja still holds", async () => {
    // The regression this module exists to prevent. GGG has moved on to
    // Allflame; poe.ninja has not priced it yet but still holds Mirage rows.
    // Gating before picking would leave Mirage as the only candidate and it
    // would win, which is how the rollover kept writing the dead league.
    const sql = fakeSql({
      listed: GGG_AT_ROLLOVER,
      priced: ["Standard", "Mirage"],
    });
    await expect(resolveTradeLeague(sql, undefined)).resolves.toBeNull();
  });

  it("returns null between leagues, never a permanent league", async () => {
    const sql = fakeSql({
      listed: [
        { id: "Standard", startAt: "2013-01-23T21:00:00Z" },
        { id: "Hardcore", startAt: "2013-01-23T21:00:00Z" },
      ],
      priced: ["Standard", "Hardcore"],
    });
    await expect(resolveTradeLeague(sql, undefined)).resolves.toBeNull();
  });

  it("an explicit league bypasses discovery and the poe.ninja veto", async () => {
    const sql = vi.fn(() => {
      throw new Error("should not query");
    }) as unknown as postgres.Sql;
    await expect(resolveTradeLeague(sql, "Ancestors")).resolves.toBe(
      "Ancestors",
    );
  });

  it("throws when the league cache has no poe1/pc row (discovery broken)", async () => {
    const sql = fakeSql({ listed: null, priced: [] });
    await expect(resolveTradeLeague(sql, undefined)).rejects.toThrow(
      /poe_leagues_cache/,
    );
  });
});
