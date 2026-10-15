import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  barIndexOnOrBefore,
  closeOnOrBefore,
  closedBars,
  excessReturn,
  forwardReturn,
  historyRangeCovering,
  returnBetween,
} from "../utils/forward-returns.js";
import type { HistoricalBar } from "../providers/types.js";
import { weekdayBars } from "./fixtures/weekday-bars.js";

function assertClose(actual: number | null | undefined, expected: number) {
  assert.ok(actual != null && Math.abs(actual - expected) < 1e-9, `expected ${expected}, got ${actual}`);
}

// Wed 07-01 … Wed 07-08 (07-04 is a Saturday: screening day).
const STOCK = weekdayBars("2026-07-01", [90, 95, 100, 105, 110, 120]);

// ─── closeOnOrBefore ─────────────────────────────────────────────────────────

describe("closeOnOrBefore", () => {
  it("on a Saturday takes Friday's close", () => {
    assert.equal(closeOnOrBefore(STOCK, "2026-07-04")?.date, "2026-07-03");
  });

  it("if the date is a session day, takes that same close", () => {
    assert.equal(closeOnOrBefore(STOCK, "2026-07-06")?.close, 105);
  });

  it("never looks ahead: before the first bar there is no close", () => {
    assert.equal(closeOnOrBefore(STOCK, "2026-06-30"), null);
  });

  it("drops a base close that is too old (gap in the history)", () => {
    assert.equal(closeOnOrBefore(STOCK, "2026-07-20"), null, "12 days after the last close");
    assert.equal(barIndexOnOrBefore(STOCK, "2026-07-15"), 5, "7 days is still valid");
  });

  it("empty series: no close", () => {
    assert.equal(closeOnOrBefore([], "2026-07-04"), null);
  });
});

// ─── forwardReturn ───────────────────────────────────────────────────────────

describe("forwardReturn", () => {
  it("complete horizon: measures N sessions from the base close", () => {
    const r = forwardReturn(STOCK, "2026-07-04", 2);
    assert.ok(r);
    assert.equal(r.baseDate, "2026-07-03");
    assert.equal(r.endDate, "2026-07-07");
    assert.equal(r.sessions, 2);
    assert.equal(r.partial, false);
    assertClose(r.pct, 10);
  });

  it("partial horizon: if the series falls short, measures up to the last close and flags it", () => {
    const r = forwardReturn(STOCK, "2026-07-04", 20);
    assert.ok(r);
    assert.equal(r.endDate, "2026-07-08");
    assert.equal(r.sessions, 3);
    assert.equal(r.partial, true);
    assertClose(r.pct, 20);
  });

  it("exactly at the session limit is not partial", () => {
    assert.equal(forwardReturn(STOCK, "2026-07-04", 3)?.partial, false);
  });

  it("without any session after the base close returns null (pending)", () => {
    assert.equal(forwardReturn(STOCK, "2026-07-11", 20), null);
  });

  it("without a base close returns null", () => {
    assert.equal(forwardReturn(STOCK, "2026-06-27", 20), null);
  });
});

// ─── returnBetween / excessReturn ────────────────────────────────────────────

describe("excessReturn", () => {
  // The index does not trade on 07-07 (holiday in its market): the excess must
  // align by date, not by number of sessions.
  const INDEX: HistoricalBar[] = [
    { date: "2026-07-02", close: 990, high: 990, low: 990 },
    { date: "2026-07-03", close: 1000, high: 1000, low: 1000 },
    { date: "2026-07-06", close: 1010, high: 1010, low: 1010 },
    { date: "2026-07-08", close: 1030, high: 1030, low: 1030 },
  ];

  it("subtracts the index return between the same dates as the asset", () => {
    const r = forwardReturn(STOCK, "2026-07-04", 2)!; // 07-03 → 07-07, +10%
    assert.equal(r.endDate, "2026-07-07");
    // Index: 07-03 (1000) → last close ≤ 07-07 = 07-06 (1010) → +1%
    assertClose(excessReturn(r, INDEX), 9);
  });

  it("negative excess when the index rises more", () => {
    const flat = weekdayBars("2026-07-01", [100, 100, 100, 100, 100, 100]);
    const r = forwardReturn(flat, "2026-07-04", 3)!; // 07-03 → 07-08, 0%
    assertClose(excessReturn(r, INDEX), -3);
  });

  it("without a benchmark series (commodities) the excess is null", () => {
    const r = forwardReturn(STOCK, "2026-07-04", 2)!;
    assert.equal(excessReturn(r, undefined), null);
  });

  it("if the index has no close on those dates, null instead of a made-up excess", () => {
    const r = forwardReturn(STOCK, "2026-07-04", 2)!;
    assert.equal(excessReturn(r, []), null);
    assert.equal(returnBetween(INDEX, "2026-06-01", "2026-07-06"), null);
  });
});

// ─── closedBars / historyRangeCovering ───────────────────────────────────────

describe("closedBars", () => {
  it("the day's bar does not count until every market has closed (22:00 UTC)", () => {
    assert.equal(closedBars(STOCK, new Date("2026-07-08T21:59:00Z")).at(-1)?.date, "2026-07-07");
    assert.equal(closedBars(STOCK, new Date("2026-07-08T22:00:00Z")).at(-1)?.date, "2026-07-08");
  });

  it("does not depend on the day's date: Friday at 23:00 UTC keeps Friday's close", () => {
    // Early Saturday in Madrid. With the UTC date as the cutoff, this close was lost.
    assert.equal(closedBars(STOCK, new Date("2026-07-03T23:00:00Z")).at(-1)?.date, "2026-07-03");
  });
});

describe("historyRangeCovering", () => {
  it("picks the shortest range covering the oldest date with margin", () => {
    assert.equal(historyRangeCovering("2026-07-04", "2026-09-12"), "1y");
    assert.equal(historyRangeCovering("2025-09-20", "2026-09-12"), "2y", "357 days + margin no longer fit in 1y");
    assert.equal(historyRangeCovering("2023-01-01", "2026-09-12"), "5y");
    assert.equal(historyRangeCovering("2019-01-01", "2026-09-12"), "max");
  });
});
