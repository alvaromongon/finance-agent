/**
 * Tests of utils/market-regime.ts: market regime per silo from the
 * benchmark, no network. Each series is a year of daily closes.
 */
// These tests assert the owner's Spanish output; English is covered in i18n.test.ts.
process.env.OUTPUT_LANGUAGE = "es";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyRegime, formatRegimeLines } from "../utils/market-regime.js";

const flat = (n: number, value: number) => Array<number>(n).fill(value);

describe("classifyRegime", () => {
  it("favorable: above the SMA200 and with the SMA50 higher than 20 sessions ago", () => {
    const rising = Array.from({ length: 250 }, (_, i) => 100 + i);
    assert.equal(classifyRegime(rising, 349, 20), "favorable");
  });

  it("adverso: below the SMA200, even if the SMA50 rises", () => {
    // 1 Sep: a flat year at 200 and a drop to 180 in the last sessions.
    assert.equal(classifyRegime([...flat(240, 200), ...flat(10, 180)], 180, 20), "adverso");
    const rising = Array.from({ length: 250 }, (_, i) => 100 + i);
    assert.equal(classifyRegime(rising, 150, 20), "adverso");
  });

  it("neutral: above the SMA200 with the SMA50 falling", () => {
    // SMA200 = 108.5; SMA50 today 122 against 130 20 sessions ago.
    const closes = [...flat(180, 100), ...flat(50, 130), ...flat(20, 110)];
    assert.equal(classifyRegime(closes, 110, 20), "neutral");
  });

  it("neutral: right at the SMA200 or with a flat SMA50", () => {
    assert.equal(classifyRegime(flat(250, 100), 100, 20), "neutral");
    assert.equal(classifyRegime(flat(250, 100), 105, 20), "neutral");
  });

  it("without history for the SMA200 or for the SMA50 slope: null", () => {
    assert.equal(classifyRegime(flat(199, 100), 90, 20), null);
    assert.equal(classifyRegime(flat(60, 100), 90, 20), null);
  });

  // A non-positive parameter would silently disable the rule (without a
  // window there is no slope, and "no regime" means "does not block").
  it("a non-positive or non-integer sma50SlopeSessions throws instead of returning null", () => {
    for (const sessions of [0, -20, 1.5]) {
      assert.throws(() => classifyRegime(flat(250, 100), 100, sessions), /sma50SlopeSessions must be an integer > 0/);
    }
  });
});

describe("formatRegimeLines", () => {
  it("one line per silo with its effect, and without a regime it warns that it does not block", () => {
    const lines = formatRegimeLines({
      EUR: { ticker: "EXSA.DE", price: 300, regime: "adverso" },
      USD: { ticker: "VOO", price: 700 },
    });
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^Régimen EUR \(EXSA\.DE\): ADVERSO .*BLOQUEADA/);
    assert.equal(lines[1], "Régimen USD (VOO): sin datos, no bloquea");
    assert.equal(formatRegimeLines({})[0], "Régimen EUR: sin datos, no bloquea");
  });
});
