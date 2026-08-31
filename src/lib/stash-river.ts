/**
 * The public stash river (`/public-stash-tabs`), and how a run reaches its live
 * tail without replaying thirteen years of it.
 *
 * The river is a single append-only stream of every public stash tab edit in
 * the game, addressed by an opaque `change_id`. Called with no id it hands back
 * the *beginning* — 2013 — and following `next_change_id` from there is a
 * multi-year walk. That is the usual reason a river consumer never ships.
 *
 * **GGG accepts synthetic change ids.** A well-formed id whose five components
 * are any number at all seeks to the nearest real position and answers with a
 * page from there. So a run finds the tail by bisection: probe a number,
 * observe whether the stream still has stashes past it, halve. Measured
 * 2026-08-30, the tail sat near 3.46e9 and nine probes found it — about five
 * seconds of the rate-limit budget, against a walk that would never finish.
 *
 * **The tail moves, so it is never hardcoded.** The originating issue measured
 * a head near 5.2e9; by implementation that position returned empty, and the
 * live tail was 3.46e9 — the components are per-shard counters, not a clock.
 * A pinned constant would have been stale within days, and silently: an empty
 * page is not an error. Bisection re-derives it every run and costs ~9
 * requests, which is why this module has no magic number in it beyond the
 * bracket it searches.
 *
 * **Why this costs no trade budget.** The river is metered under its own
 * policy — `public-stash-tabs-request-limit-pc`, 2 requests per second per IP,
 * rule `Ip` — verified live. ADR 0022's 30-per-300s trade budget is metered on
 * the application identity and shared by four workers; nothing here touches
 * it. Pacing still comes off the response headers rather than a constant, the
 * way `rate-limit.ts` was written for, so a retune by GGG is followed, not
 * fought.
 *
 * **A run always seeks; it never resumes.** No cursor is persisted. A late,
 * interrupted or re-run job simply samples a later slice of the same market,
 * which is why this worker has no catch-up debt and no staleness bug.
 */

import { describeLimits, sustainableIntervalMs } from "./rate-limit";
import type { RiverStash } from "./warrant-observation";

const RIVER_URL = "https://api.pathofexile.com/public-stash-tabs";
const OAUTH_URL = "https://www.pathofexile.com/oauth/token";

/** Slowest pace we will ever settle to, if a header ever asks for something absurd. */
const MAX_INTERVAL_MS = 10_000;
/** The advertised policy is 2/s. Start there and let the headers correct it. */
const DEFAULT_INTERVAL_MS = 550;

/** The bracket bisection searches. Below `lo` the stream is ancient and
 *  certainly non-empty; above `hi` it has always been empty. Both are outside
 *  any plausible tail, so the search never needs them to be right, only wide. */
const SEEK_LOW = 1_000_000_000;
const SEEK_HIGH = 20_000_000_000;
/** Stop bisecting once the bracket is this tight: further precision buys a
 *  slightly fresher slice for a request each, and the slice is a sample. */
const SEEK_PRECISION = 5_000_000;

export interface RiverPage {
  stashes: RiverStash[];
  nextChangeId: string | null;
}

/** A change id GGG will seek on: five identical components. */
export function syntheticChangeId(position: number): string {
  const n = Math.floor(position);
  return `${n}-${n}-${n}-${n}-${n}`;
}

/**
 * The largest bracket position that still has stashes behind it — the live
 * tail, to within `precision`.
 *
 * `hasStashes` is injected so the search is testable without the network, and
 * so the caller owns the pacing between probes.
 */
export async function seekToTail(
  hasStashes: (changeId: string) => Promise<boolean>,
  opts: { low?: number; high?: number; precision?: number } = {},
): Promise<{ position: number; probes: number }> {
  let low = opts.low ?? SEEK_LOW;
  let high = opts.high ?? SEEK_HIGH;
  const precision = opts.precision ?? SEEK_PRECISION;
  let probes = 0;

  while (high - low > precision) {
    const mid = Math.floor((low + high) / 2);
    const populated = await hasStashes(syntheticChangeId(mid));
    probes++;
    if (populated) low = mid;
    else high = mid;
  }

  return { position: low, probes };
}

/** A client-credentials token for `service:psapi`, the scope we already hold. */
export async function getRiverToken(
  clientId: string,
  clientSecret: string,
  userAgent: string,
): Promise<string> {
  const res = await fetch(OAUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": userAgent },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
      scope: "service:psapi",
    }),
  });
  if (!res.ok) {
    throw new Error(`Client credentials exchange failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("Client credentials exchange returned no token");
  return json.access_token;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A paced reader over the river. It owns the interval between requests and
 * yields on a 429 rather than competing for the window — the same posture the
 * trade workers take, for the same reason: a tripped penalty costs far more
 * than the wait that would have avoided it.
 */
export class StashRiver {
  private intervalMs = DEFAULT_INTERVAL_MS;
  private nextAllowedAt = 0;
  private limitsLogged = false;

  constructor(
    private readonly token: string,
    private readonly userAgent: string,
  ) {}

  /** Requests made, so a run can report what it spent. */
  requests = 0;

  private async pace(): Promise<void> {
    const wait = this.nextAllowedAt - Date.now();
    if (wait > 0) await sleep(wait);
  }

  /**
   * One page. Throws on a genuine API failure so the run fails loud; a 429 is
   * waited out and retried, because it is the API asking us to slow down, not
   * an outage.
   */
  async page(changeId: string): Promise<RiverPage> {
    for (let attempt = 0; ; attempt++) {
      await this.pace();

      const res = await fetch(`${RIVER_URL}?id=${encodeURIComponent(changeId)}`, {
        headers: { Authorization: `Bearer ${this.token}`, "User-Agent": this.userAgent },
      });
      this.requests++;

      // Pace off what the response actually advertises, capped so a malformed
      // header can never stall a run for the length of the job timeout.
      const advertised = sustainableIntervalMs(res.headers);
      if (advertised != null) this.intervalMs = Math.min(advertised, MAX_INTERVAL_MS);
      this.nextAllowedAt = Date.now() + this.intervalMs;

      if (!this.limitsLogged) {
        console.log(`  ${describeLimits(res.headers)} → pacing ${this.intervalMs}ms/request`);
        this.limitsLogged = true;
      }

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 60_000;
        if (attempt >= 2) {
          throw new Error(`river still rate-limited after ${attempt + 1} attempts`);
        }
        console.log(`  429 from the river, yielding ${waitMs / 1000}s`);
        await sleep(waitMs);
        continue;
      }

      if (!res.ok) {
        throw new Error(`river returned ${res.status} ${res.statusText} for ${changeId}`);
      }

      const body = (await res.json()) as {
        stashes?: RiverStash[];
        next_change_id?: string | null;
      };
      return { stashes: body.stashes ?? [], nextChangeId: body.next_change_id ?? null };
    }
  }

  /** Whether the stream still carries stashes at a position. The bisection predicate. */
  async hasStashes(changeId: string): Promise<boolean> {
    return (await this.page(changeId)).stashes.length > 0;
  }
}
