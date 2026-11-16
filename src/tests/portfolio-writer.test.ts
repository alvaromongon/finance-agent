/**
 * The writer of portfolio.md (ADR-0015): the refreshed prices. Pure text in, text out; hand-calculated
 * expectations. The store that uses it is tested in portfolio-store.test.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyPrices } from "../utils/portfolio-writer.js";
import { parsePositions } from "../utils/vault-parser.js";
import { parseTicker as tk } from "../ticker.js";

describe("applyPrices: Current price and P/L of the priced positions", () => {
  const md = (avg: string, volume = "2") => `---
schema_version: 2
last_manual_sync: 2026-10-16T18:00:00Z
---

## USD — Cash

| Item | Value |
|---|---|
| Available cash | $900.00 |

## USD — Positions

| Ticker | Volume | Avg price | Current price | P/L | Stop loss |
|---|---|---|---|---|---|
| TCK | ${volume} | ${avg} | 100,00 | 0,00 | 80 |
| OTH | 1 | 10 | 10 | 0 | — |
| M&M.NS | 1 | 10 | 10 | 0 | — |

## USD — Lots

| Ticker | Entry id | Date | Units | Entry units | Entry price | Initial stop | Entry costs | Origin | Rules version | Rules violations |
|---|---|---|---|---|---|---|---|---|---|---|
`;
  const prices = (price: number) => new Map([[tk("TCK"), price]]);

  it("writes Current price and P/L as (price - Avg price) x Volume, European style, and touches no other row", () => {
    const out = applyPrices(md("100"), "USD", prices(1234.5))!;
    assert.ok(out.includes("| TCK | 2 | 100 | 1.234,50 | 2.269,00 | 80 |"), out);
    assert.ok(out.includes("| OTH | 1 | 10 | 10 | 0 | — |"));
    assert.ok(out.includes("| M&M.NS | 1 | 10 | 10 | 0 | — |"), "a row whose ticker does not parse is left alone");
    assert.ok(out.includes("last_manual_sync: 2026-10-16T18:00:00Z"));
    assert.deepEqual(
      parsePositions(out, "USD", () => undefined).map((p) => [p.ticker, p.currentPrice, p.pl]),
      [
        ["TCK", 1234.5, 2269],
        ["OTH", 10, 0],
      ],
    );
  });

  it("returns null when nothing changes or no row is priced", () => {
    assert.equal(applyPrices(md("100"), "USD", new Map()), null);
    assert.equal(applyPrices(md("100"), "USD", new Map([[tk("TCK"), 100]])), null);
  });

  it("never throws on a value too large to count in cents or a non-finite price: a typo must not stop the run (ADR-0015)", () => {
    for (const [label, text, price] of [
      ["an Avg price of 1e307", md("1e307"), 100],
      ["a Volume of 1e307", md("100", "1e307"), 1e300],
      ["a NaN price", md("100"), Number.NaN],
      ["an infinite price", md("100"), Number.POSITIVE_INFINITY],
    ] as const) {
      assert.doesNotThrow(() => applyPrices(text, "USD", prices(price)), label);
    }
  });
});
