/**
 * How stale a silo is (#138): the age of its latest snapshot of the broker, and a silo with none is stale. Pure.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stalenessOf } from "../utils/staleness.js";

const NOW = new Date("2026-11-26T12:00:00Z");

describe("stalenessOf", () => {
  it("is stale when there is no snapshot, never fresh by default", () => {
    assert.deepEqual(stalenessOf(undefined, NOW, 7), { asOf: null, ageDays: null, stale: true });
    assert.deepEqual(stalenessOf(null, NOW, 7), { asOf: null, ageDays: null, stale: true });
  });

  it("is fresh up to the limit of days and stale after it, measured from the start of the day the snapshot is as of", () => {
    assert.equal(stalenessOf("2026-11-26", NOW, 7).stale, false);
    assert.equal(stalenessOf("2026-11-20", NOW, 7).stale, false, "6.5 days");
    assert.equal(stalenessOf("2026-11-19", NOW, 7).stale, true, "7.5 days");
    assert.equal(stalenessOf("2026-11-19T12:00:00Z", NOW, 7).stale, false, "exactly 7 days");
    assert.deepEqual(stalenessOf("2026-11-21", NOW, 7), { asOf: "2026-11-21", ageDays: 5.5, stale: false });
  });

  it("is stale for a date that does not read: an unreadable snapshot is no proof of freshness", () => {
    assert.deepEqual(stalenessOf("not a date", NOW, 7), { asOf: null, ageDays: null, stale: true });
  });
});
