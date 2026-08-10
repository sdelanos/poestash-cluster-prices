/**
 * Pacing read off GGG's rate-limit headers (poestash-workers #7).
 *
 * The shape is documented under "Rate Limits" on developer.pathofexile.com:
 * `X-Rate-Limit-Rules` names the rules that apply (`ip`, `account`, `client`),
 * `X-Rate-Limit-{rule}` carries one or more `maxHits:period:penaltySeconds`
 * windows, and `X-Rate-Limit-{rule}-State` the matching
 * `currentHits:period:activeRestriction`.
 *
 * What matters here is that the budget is counted **per request**. The cluster
 * worker used to pause a hardcoded 10s per *combo*, and a combo is two requests
 * — a search and a fetch for the cheapest listing — so it ran at twice the
 * allowed rate, tripped the third field of `30:300:3600`, and lost an hour.
 * Sleeping the hour didn't clear it either: the long window's counter hadn't
 * decayed by the time it retried, so it tripped again, four times over, until
 * the job hit its own 5.5h ceiling. Every run did ~600 of 2814 combos.
 *
 * So: derive the interval from the headers rather than hardcoding one. Nothing
 * here knows a specific number — if GGG retunes a window, the pacing follows.
 */

/** One `maxHits:period:penalty` triple. */
interface Window {
  maxHits: number;
  periodSeconds: number;
}

function parseWindows(value: string | null): Window[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => {
      const [maxHits, periodSeconds] = part.split(":").map(Number);
      return { maxHits, periodSeconds };
    })
    .filter(
      (w) =>
        Number.isFinite(w.maxHits) &&
        Number.isFinite(w.periodSeconds) &&
        w.maxHits > 0 &&
        w.periodSeconds > 0,
    );
}

function applicableRules(headers: Headers): string[] {
  const rules = headers.get("X-Rate-Limit-Rules");
  if (!rules) return [];
  return rules
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
}

/**
 * The slowest per-request interval any applicable window demands, in ms.
 *
 * Null when the response carries no usable rule — the caller keeps its own
 * default rather than treating silence as permission to go flat out.
 */
export function sustainableIntervalMs(headers: Headers): number | null {
  const intervals = applicableRules(headers)
    .flatMap((rule) => parseWindows(headers.get(`X-Rate-Limit-${rule}`)))
    .map((w) => (w.periodSeconds / w.maxHits) * 1000);

  return intervals.length > 0 ? Math.max(...intervals) : null;
}

/** One line for the run log, so the limits actually in force are visible. */
export function describeLimits(headers: Headers): string {
  const rules = applicableRules(headers);
  if (rules.length === 0) return "rate limits: none advertised";

  const parts = rules.map((rule) => `${rule}=${headers.get(`X-Rate-Limit-${rule}`) ?? "?"}`);
  const policy = headers.get("X-Rate-Limit-Policy") ?? "unknown";
  return `rate limits: policy=${policy} ${parts.join(" ")}`;
}
