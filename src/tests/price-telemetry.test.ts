/**
 * The last prices as telemetry (#133): what a refresh observes, when an observation still applies to a position, and the
 * text of the file. Pure: no I/O.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { money } from "../money.js";
import { parseTicker as tk } from "../ticker.js";
import type { PortfolioSnapshot } from "../types.js";
import {
  decodeTelemetry,
  encodeTelemetry,
  observePrices,
  withObservedPrices,
  type PriceTelemetry,
} from "../utils/price-telemetry.js";

const silo = (positions: { ticker: string; volume: number; avgPrice: number; price?: number }[]) =>
  ({
    currency: "USD",
    cash: money(100, "USD"),
    positions: positions.map((p) => ({
      ticker: tk(p.ticker),
      currency: "USD",
      volume: p.volume,
      avgPrice: p.avgPrice,
      currentPrice: p.price ?? p.avgPrice,
      pl: money(0, "USD"),
      stopLoss: null,
    })),
    lots: [],
    syncedAt: "2026-11-01T00:00:00.000Z",
  }) as PortfolioSnapshot<"USD">;

const TCK = { ticker: "TCK", volume: 2, avgPrice: 100 };

describe("observePrices", () => {
  it("records the price of each position with the position it was seen against", () => {
    assert.deepEqual(observePrices(silo([TCK]), new Map([[tk("TCK"), 110]])), {
      TCK: { price: 110, volume: 2, avgPrice: 100 },
    });
  });

  it("is null when nothing changes: a run that sees the same prices writes nothing", () => {
    const seen = { TCK: { price: 110, volume: 2, avgPrice: 100 } };
    assert.equal(observePrices(silo([TCK]), new Map([[tk("TCK"), 110]]), seen), null);
    assert.equal(observePrices(silo([TCK]), new Map(), seen), null, "no price this time: the last one stands");
    assert.equal(observePrices(silo([]), new Map()), null, "no position, no observation, no file change");
  });

  it("keeps the last price of a position the run has no price for, while it still applies", () => {
    const previous = { TCK: { price: 110, volume: 2, avgPrice: 100 }, OTH: { price: 12, volume: 1, avgPrice: 10 } };
    const positions = [TCK, { ticker: "OTH", volume: 1, avgPrice: 10 }];
    assert.deepEqual(observePrices(silo(positions), new Map([[tk("TCK"), 120]]), previous), {
      TCK: { price: 120, volume: 2, avgPrice: 100 },
      OTH: previous.OTH,
    });
    // OTH was sold in part: the price seen against the old volume is dropped.
    assert.deepEqual(observePrices(silo([TCK, { ticker: "OTH", volume: 0.5, avgPrice: 10 }]), new Map(), previous), {
      TCK: previous.TCK,
    });
  });

  it("drops a ticker that is no longer a position, and ignores a price that is not finite", () => {
    const previous = { GONE: { price: 5, volume: 1, avgPrice: 5 } };
    assert.deepEqual(observePrices(silo([TCK]), new Map([[tk("TCK"), Number.NaN]]), previous), {});
    assert.deepEqual(observePrices(silo([TCK]), new Map([[tk("TCK"), 110]]), previous), {
      TCK: { price: 110, volume: 2, avgPrice: 100 },
    });
  });
});

describe("withObservedPrices", () => {
  const seen = { TCK: { price: 110, volume: 2, avgPrice: 100 } };

  it("shows the last price and the P/L it gives over the position it was seen against", () => {
    const [p] = withObservedPrices(silo([{ ...TCK }]), seen).positions;
    assert.deepEqual([p.currentPrice, p.pl], [110, 20]);
  });

  it("does not show a price seen before the position changed (a buy, a sale, a split)", () => {
    for (const changed of [
      { ...TCK, volume: 3, avgPrice: 103.33 },
      { ...TCK, volume: 1 },
      { ...TCK, volume: 4, avgPrice: 50 },
    ]) {
      const read = silo([{ ...changed, price: 99 }]);
      assert.equal(withObservedPrices(read, seen), read, "the silo is the state's, untouched");
    }
  });

  it("is the state's silo when there is no observation", () => {
    const read = silo([TCK]);
    assert.equal(withObservedPrices(read, undefined), read);
    assert.equal(withObservedPrices(read, {}), read);
  });

  it("does not move the stop, the lots or the cash: only the price and the P/L", () => {
    const read = silo([TCK]);
    const shown = withObservedPrices(read, seen);
    assert.deepEqual({ ...shown, positions: [] }, { ...read, positions: [] });
    assert.equal(shown.positions[0].stopLoss, read.positions[0].stopLoss);
  });
});

describe("the telemetry file", () => {
  const telemetry: PriceTelemetry = {
    USD: {
      TCK: { price: 110.5, volume: 2, avgPrice: 100 },
      AAA: { price: 0.00001234, volume: 0.5, avgPrice: 0.00001 },
    },
    EUR: {},
  };

  it("reads back what it wrote, as plain decimals and tickers in order", () => {
    const text = encodeTelemetry(telemetry);
    assert.deepEqual(decodeTelemetry(text, "telemetry/prices.json"), telemetry);
    assert.ok(text.indexOf('"AAA"') < text.indexOf('"TCK"'));
    assert.match(text, /"price": "0\.00001234"/, "never an exponent");
    assert.equal(encodeTelemetry(decodeTelemetry(text, "t")), text, "the same prices are the same bytes");
  });

  it("refuses what it cannot read whole, naming the file and the field", () => {
    const refused: [string, RegExp][] = [
      ["{", /telemetry\/prices\.json: file: is not valid JSON/],
      ["[]", /file: must be an object/],
      ['{"schema_version":2,"silos":{}}', /schema_version: must be 1/],
      ['{"schema_version":1,"silos":{"GBP":{}}}', /silos\.GBP: is not a silo/],
      [
        '{"schema_version":1,"silos":{"USD":{"TCK":{"price":1,"volume":"1","avg_price":"1"}}}}',
        /silos\.USD\.TCK\.price/,
      ],
      [
        '{"schema_version":1,"silos":{"USD":{"TCK":{"price":"1e5","volume":"1","avg_price":"1"}}}}',
        /price: must be a plain/,
      ],
    ];
    for (const [text, problem] of refused) assert.throws(() => decodeTelemetry(text, "telemetry/prices.json"), problem);
  });
});
