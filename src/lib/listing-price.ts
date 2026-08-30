/**
 * The seller's asking price, read off the public stash river.
 *
 * The river carries no price field. What it carries is GGG's listing
 * convention, verbatim: a `~b/o N currency` or `~price N currency` token
 * written by the seller into the item's own `note`, or — for a whole tab
 * priced at once — into the stash tab's name. The item's note wins when both
 * exist, because that is what the trade site itself does.
 *
 * Two things this refuses to do, both measured against a live Allflame slice:
 *
 *  - **A Currency Exchange offer is not a price.** `~price 1 offer` means the
 *    seller listed the item on the exchange; the number is a ratio against a
 *    currency the token does not name. Read as an amount it is a 1-chaos
 *    Warrant, which is wrong by orders of magnitude and always in the cheap
 *    direction. Such a listing is dropped, and it is dropped even when the tab
 *    around it carries a real buyout — the item said where it lives.
 *  - **An unknown currency is not guessed.** Mirror-priced Warrants exist
 *    (one in a 714-item sample). Without a chaos rate for the league the
 *    observation leaves the corpus rather than entering it at a made-up value.
 *  - **An ambiguous comma is not guessed either.** Sellers write both `1,5`
 *    (a European decimal) and `1,500` (an English thousands separator), and
 *    the token does not say which. Reading the second as 1.5 is a 1000x error
 *    in the same cheap direction as the exchange trap above, so a comma with
 *    exactly three digits behind it drops the listing instead of halving it.
 */

/** A price exactly as the seller wrote it: an amount and a currency slug. */
export interface ListingPrice {
  amount: number;
  /** GGG's lowercase slug: `chaos`, `divine`, `exalted`, `mirror`, … */
  currency: string;
}

/**
 * GGG's own token, anywhere in the string — sellers routinely append prose
 * ("~price 3 chaos Bulk Sales"). The currency is a slug, so letters only.
 */
const PRICE_TOKEN = /~(?:b\/o|price)\s+(\d+(?:[.,]\d+)?)\s+([a-z-]+)/i;

/** The Currency Exchange marker. Not a currency, and never an amount. */
const EXCHANGE_CURRENCY = "offer";

/** A comma with exactly three digits behind it: `1,500`. Thousands or decimal,
 *  the token cannot say, so the listing is dropped rather than read either way. */
const AMBIGUOUS_COMMA = /,\d{3}$/;

function readToken(text: string | null | undefined): ListingPrice | "exchange" | null {
  if (!text) return null;
  const m = PRICE_TOKEN.exec(text);
  if (!m) return null;

  const currency = m[2].toLowerCase();
  if (currency === EXCHANGE_CURRENCY) return "exchange";

  if (AMBIGUOUS_COMMA.test(m[1])) return null;
  const amount = Number(m[1].replace(",", "."));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return { amount, currency };
}

/**
 * The asking price for one listed item: its own note, else the tab it sits in.
 * Null when the seller named no price, or named one we refuse to read.
 */
export function readListingPrice(
  note: string | null | undefined,
  stashName: string | null | undefined,
): ListingPrice | null {
  const own = readToken(note);
  if (own === "exchange") return null;
  if (own) return own;

  const tab = readToken(stashName);
  return tab && tab !== "exchange" ? tab : null;
}

/**
 * The price in chaos, or null when the league has no rate for that currency.
 * Rates come from `ninja_prices`, the same conversion the other trade workers
 * use, so a Warrant and a cluster jewel are denominated the same way.
 */
export function toChaos(price: ListingPrice, rates: Map<string, number>): number | null {
  const rate = rates.get(price.currency);
  if (rate == null || !Number.isFinite(rate) || rate <= 0) return null;
  return price.amount * rate;
}
