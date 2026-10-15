// Tests of the market session guard: tells a delayed cron (good data, to be
// processed) from a real holiday (market closed since earlier).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkMarketSession, DEFAULT_MAX_SESSION_AGE_HOURS } from "../utils/market-session.js";

const at = (iso: string) => new Date(iso);

describe("checkMarketSession", () => {
  it("on-time run after the US close: current session", () => {
    // Cron 21:30 UTC, last tick 20:10 UTC the same day.
    const check = checkMarketSession(at("2026-08-28T20:10:00Z"), at("2026-08-28T21:30:00Z"));
    assert.equal(check.stale, false);
    assert.ok(check.ageHours < 2);
  });

  it("a delayed cron crossing UTC midnight: current session (regression of the August bug)", () => {
    // Real case: Friday's 21:30 cron fired at 03:13 on Saturday.
    // The previous guard flagged it as a holiday by comparing calendar dates.
    const check = checkMarketSession(at("2026-08-28T20:10:00Z"), at("2026-08-29T03:13:00Z"));
    assert.equal(check.stale, false, "7h-old data is not a closed market");
  });

  it("cron delayed to the maximum observed (05:31 UTC): still current", () => {
    const check = checkMarketSession(at("2026-08-27T20:10:00Z"), at("2026-08-28T05:31:00Z"));
    assert.equal(check.stale, false);
    assert.ok(check.ageHours > 9 && check.ageHours < DEFAULT_MAX_SESSION_AGE_HOURS);
  });

  it("single-day weekday holiday: stale session", () => {
    // Tuesday holiday: the last tick is Monday's.
    const check = checkMarketSession(at("2026-08-24T20:10:00Z"), at("2026-08-25T21:30:00Z"));
    assert.equal(check.stale, true);
    assert.ok(check.ageHours > 24);
  });

  it("weekend: stale session", () => {
    const check = checkMarketSession(at("2026-08-28T20:10:00Z"), at("2026-08-30T21:30:00Z"));
    assert.equal(check.stale, true);
  });

  it("right at the threshold: not considered stale", () => {
    const now = at("2026-08-28T20:00:00Z");
    const border = new Date(now.getTime() - DEFAULT_MAX_SESSION_AGE_HOURS * 3_600_000);
    assert.equal(checkMarketSession(border, now).stale, false);
    assert.equal(checkMarketSession(new Date(border.getTime() - 60_000), now).stale, true);
  });

  it("configurable threshold", () => {
    const check = checkMarketSession(at("2026-08-28T10:00:00Z"), at("2026-08-28T20:00:00Z"), 6);
    assert.equal(check.stale, true, "10h old with a 6h threshold");
  });

  it("without a market date the run is not blocked", () => {
    assert.deepEqual(checkMarketSession(null, at("2026-08-28T20:00:00Z")), { stale: false, ageHours: 0 });
  });
});
