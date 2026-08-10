import { describe, expect, it } from "vitest";
import { sustainableIntervalMs, describeLimits } from "./rate-limit";

const headers = (h: Record<string, string>) => new Headers(h);

describe("sustainableIntervalMs", () => {
  // 30 hits per 300s is one request every 10s. The old worker read this same
  // rule and paused 10s per *combo* — two requests — so it ran at double the
  // allowed rate and eventually ate the rule's 3600s penalty.
  it("turns one rule into its per-request interval", () => {
    const ms = sustainableIntervalMs(
      headers({
        "X-Rate-Limit-Rules": "ip",
        "X-Rate-Limit-Ip": "30:300:3600",
        "X-Rate-Limit-Ip-State": "5:300:0",
      }),
    );
    expect(ms).toBe(10_000);
  });

  it("takes the tightest window when a rule carries several", () => {
    const ms = sustainableIntervalMs(
      headers({
        "X-Rate-Limit-Rules": "ip",
        // 5:10 = 2s, 15:60 = 4s, 30:300 = 10s. The long window binds.
        "X-Rate-Limit-Ip": "5:10:60,15:60:120,30:300:3600",
        "X-Rate-Limit-Ip-State": "1:10:0,1:60:0,1:300:0",
      }),
    );
    expect(ms).toBe(10_000);
  });

  it("takes the tightest across every applicable rule", () => {
    const ms = sustainableIntervalMs(
      headers({
        "X-Rate-Limit-Rules": "ip,account",
        "X-Rate-Limit-Ip": "30:300:3600",
        "X-Rate-Limit-Ip-State": "1:300:0",
        // 600 per hour is 6s, looser than the ip rule's 10s.
        "X-Rate-Limit-Account": "600:3600:3600",
        "X-Rate-Limit-Account-State": "1:3600:0",
      }),
    );
    expect(ms).toBe(10_000);
  });

  it("is case-insensitive about rule names", () => {
    const ms = sustainableIntervalMs(
      headers({
        "X-Rate-Limit-Rules": "IP",
        "X-Rate-Limit-Ip": "30:300:3600",
        "X-Rate-Limit-Ip-State": "1:300:0",
      }),
    );
    expect(ms).toBe(10_000);
  });

  // The trade API is not the documented one; if it ever stops sending these,
  // the caller must not speed up to unlimited. Null means "keep your default".
  it("returns null when the headers say nothing", () => {
    expect(sustainableIntervalMs(headers({}))).toBeNull();
    expect(sustainableIntervalMs(headers({ "X-Rate-Limit-Rules": "ip" }))).toBeNull();
  });

  it("ignores a malformed rule rather than pacing off garbage", () => {
    const ms = sustainableIntervalMs(
      headers({
        "X-Rate-Limit-Rules": "ip,account",
        "X-Rate-Limit-Ip": "not:a:rule",
        "X-Rate-Limit-Account": "30:300:3600",
      }),
    );
    expect(ms).toBe(10_000);
  });

  it("ignores a zero-hit rule rather than dividing by zero", () => {
    const ms = sustainableIntervalMs(
      headers({
        "X-Rate-Limit-Rules": "ip",
        "X-Rate-Limit-Ip": "0:300:3600",
      }),
    );
    expect(ms).toBeNull();
  });
});

describe("describeLimits", () => {
  it("names each rule and its windows for the run log", () => {
    const text = describeLimits(
      headers({
        "X-Rate-Limit-Policy": "trade-search",
        "X-Rate-Limit-Rules": "ip",
        "X-Rate-Limit-Ip": "5:10:60,30:300:3600",
        "X-Rate-Limit-Ip-State": "1:10:0,1:300:0",
      }),
    );
    expect(text).toContain("trade-search");
    expect(text).toContain("ip=5:10:60,30:300:3600");
  });

  it("says so plainly when there are no headers to describe", () => {
    expect(describeLimits(headers({}))).toContain("none");
  });
});
