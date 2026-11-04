/**
 * The command handlers of the inbox (#131): pure, one per command, `(state, command) -> state or a reason`.
 * No I/O, so no vault: the state is built in memory.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { money } from "../money.js";
import { parseTicker as tk } from "../ticker.js";
import { applyCommand, buy, deposit, sale, withdrawal, type InboxState } from "../utils/inbox-handlers.js";
import type { Buy, Command, Sale } from "../utils/inbox-handlers.js";
import { crossedState, lot, stateOf } from "./fixtures/inbox.js";

const ok = (state: InboxState, command: Command): InboxState => {
  const result = applyCommand(state, command);
  assert.ok("state" in result, `expected ${command.kind} to be accepted: ${"reason" in result ? result.reason : ""}`);
  return result.state;
};
const reason = (state: InboxState, command: Command): string => {
  const result = applyCommand(state, command);
  assert.ok("reason" in result, `expected ${command.kind} to be refused`);
  return result.reason;
};

const eur = (n: number) => money(n, "EUR");
const usd = (n: number) => money(n, "USD");
const buyOf = (over: Partial<Buy<"EUR">> = {}): Buy<"EUR"> => ({
  kind: "buy",
  currency: "EUR",
  ticker: tk("SAP.DE"),
  date: "2026-09-15",
  units: 2,
  price: 180,
  ...over,
});
const saleOf = (over: Partial<Sale<"EUR">> = {}): Sale<"EUR"> => ({
  kind: "sale",
  currency: "EUR",
  ticker: tk("SAP.DE"),
  date: "2026-09-20",
  units: 2,
  price: 190,
  stopExecuted: false,
  ...over,
});

describe("inbox handlers", () => {
  describe("deposit", () => {
    it("adds the amount to the cash of its currency and leaves the other silo alone", () => {
      const next = ok(stateOf(), { kind: "deposit", currency: "USD", amount: usd(250.5) });
      assert.deepEqual([next.USD.cash, next.EUR.cash], [750.5, 1000]);
    });

    it("moves the total cash with the available cash when the portfolio tells it", () => {
      const state = stateOf();
      const withTotal: InboxState = { ...state, EUR: { ...state.EUR, totalCash: eur(1200) } };
      const next = ok(withTotal, { kind: "deposit", currency: "EUR", amount: eur(100) });
      assert.deepEqual([next.EUR.cash, next.EUR.totalCash], [1100, 1300]);
    });

    it("checks the currency explicitly: an amount of another silo is refused, not added", () => {
      // A silo whose `currency` does not match the one asked for: the type alone does not catch it (#145).
      const state = stateOf();
      const crossed = crossedState(state);
      assert.match(reason(crossed, { kind: "deposit", currency: "USD", amount: usd(10) }), /no USD silo/);
      assert.equal(crossed.EUR.cash, 1000);
    });
  });

  describe("withdrawal", () => {
    it("takes the amount from the cash of its currency", () => {
      const next = ok(stateOf(), { kind: "withdrawal", currency: "EUR", amount: eur(400) });
      assert.deepEqual([next.EUR.cash, next.USD.cash], [600, 500]);
    });

    it("may take all the cash, never more", () => {
      assert.equal(ok(stateOf(), { kind: "withdrawal", currency: "EUR", amount: eur(1000) }).EUR.cash, 0);
      assert.match(
        reason(stateOf(), { kind: "withdrawal", currency: "EUR", amount: eur(1000.01) }),
        /withdrawal of 1000\.01 EUR exceeds the available cash of 1000\.00 EUR/,
      );
    });

    it("compares with the cash of its own currency: EUR cash does not cover a USD withdrawal", () => {
      const state = stateOf({ eurCash: 5000, usdCash: 100 });
      assert.match(reason(state, { kind: "withdrawal", currency: "USD", amount: usd(200) }), /exceeds .* 100\.00 USD/);
    });

    it("checks the currency explicitly", () => {
      const state = stateOf();
      const crossed = crossedState(state);
      assert.match(reason(crossed, { kind: "withdrawal", currency: "USD", amount: usd(10) }), /no USD silo/);
    });
  });

  describe("buy", () => {
    it("pays amount and costs from the cash, opens a lot and a position", () => {
      const next = ok(stateOf(), buyOf({ costs: eur(1.5), stop: 170 }));
      assert.equal(next.EUR.cash, 1000 - 360 - 1.5);
      assert.deepEqual(
        next.EUR.lots.map((l) => [
          l.ticker,
          l.entryId,
          l.date,
          l.units,
          l.entryUnits,
          l.entryPrice,
          l.initialStop,
          l.entryCosts,
        ]),
        [["SAP.DE", "20260915-sapde-entry", "2026-09-15", 2, 2, 180, 170, 1.5]],
      );
      assert.deepEqual(
        next.EUR.positions.map((p) => [p.ticker, p.volume, p.avgPrice, p.stopLoss]),
        [["SAP.DE", 2, 180, 170]],
      );
    });

    it("refuses a buy that exceeds the cash of its currency, costs included", () => {
      assert.match(
        reason(stateOf({ eurCash: 360 }), buyOf({ costs: eur(1) })),
        /costs 361\.00 EUR, more than the available cash of 360\.00 EUR/,
      );
      assert.equal(ok(stateOf({ eurCash: 360 }), buyOf()).EUR.cash, 0);
    });

    it("does not pay a USD buy with the EUR cash", () => {
      const state = stateOf({ eurCash: 10_000, usdCash: 100 });
      const usdBuy = {
        ...buyOf(),
        currency: "USD",
        ticker: tk("MSFT"),
        price: 400,
        units: 1,
        costs: undefined,
      } as Buy<"USD">;
      assert.match(reason(state, usdBuy), /more than the available cash of 100\.00 USD/);
    });

    it("scales in: a second buy of a held ticker adds a lot and averages the position", () => {
      const held = stateOf(
        {},
        { EUR: [lot("EUR", { ticker: "SAP.DE", units: 2, entryPrice: 180, entryId: "20260915-sapde-entry" })] },
      );
      const next = ok(held, buyOf({ units: 2, price: 200 }));
      assert.deepEqual(
        next.EUR.lots.map((l) => [l.entryId, l.units]),
        [
          ["20260915-sapde-entry", 2],
          ["20260915-sapde-entry-2", 2],
        ],
      );
      assert.deepEqual(
        next.EUR.positions.map((p) => [p.volume, p.avgPrice]),
        [[4, 190]],
      );
    });

    it("keeps the stop of the position when the scale-in gives none", () => {
      const held = stateOf({}, { EUR: [lot("EUR", { ticker: "SAP.DE", units: 2, initialStop: 168 })] });
      assert.equal(ok(held, buyOf()).EUR.positions[0].stopLoss, 168);
    });

    it("checks the currency explicitly", () => {
      const state = stateOf();
      const crossed = crossedState(state);
      assert.match(reason(crossed, { ...buyOf(), currency: "USD", costs: undefined }), /no USD silo/);
    });

    it("refuses an amount too large to count instead of crashing", () => {
      assert.match(reason(stateOf(), buyOf({ units: 1e307, price: 1e5 })), /too large to count in cents/);
    });
  });

  describe("sale", () => {
    const held = () =>
      stateOf(
        {},
        {
          EUR: [
            lot("EUR", { ticker: "SAP.DE", units: 2, entryPrice: 180, entryId: "a", date: "2026-01-10" }),
            lot("EUR", { ticker: "SAP.DE", units: 3, entryPrice: 200, entryId: "b", date: "2026-02-10" }),
            lot("EUR", { ticker: "ASML.AS", units: 1, entryId: "c" }),
          ],
        },
      );

    it("sells first in, first out, credits the proceeds net of costs and shrinks lots and position", () => {
      const next = ok(held(), saleOf({ units: 3, price: 190, costs: eur(2) }));
      assert.equal(next.EUR.cash, 1000 + 570 - 2);
      assert.deepEqual(
        next.EUR.lots.map((l) => [l.entryId, l.units]),
        [
          ["b", 2],
          ["c", 1],
        ],
      );
      assert.deepEqual(
        next.EUR.positions.map((p) => [p.ticker, p.volume]),
        [
          ["SAP.DE", 2],
          ["ASML.AS", 1],
        ],
      );
    });

    it("sells a named lot only", () => {
      const next = ok(held(), saleOf({ units: 3, lot: "b" }));
      assert.deepEqual(
        next.EUR.lots.map((l) => [l.entryId, l.units]),
        [
          ["a", 2],
          ["c", 1],
        ],
      );
    });

    it("removes the position when the last unit goes (an executed stop is a sale like any other)", () => {
      const next = ok(held(), saleOf({ units: 5, price: 170, stopExecuted: true }));
      assert.deepEqual(
        next.EUR.positions.map((p) => p.ticker),
        ["ASML.AS"],
      );
      assert.equal(next.EUR.cash, 1000 + 850);
    });

    it("refuses a ticker not held, a lot not held and more units than are open", () => {
      assert.match(reason(held(), saleOf({ ticker: tk("TCK") })), /no open lot of TCK in the EUR silo/);
      assert.match(reason(held(), saleOf({ lot: "zzz" })), /no open lot with that id/);
      assert.match(reason(held(), saleOf({ lot: "a", units: 3 })), /only 2 are open in lot a/);
      assert.match(reason(held(), saleOf({ units: 6 })), /only 5 are open/);
    });

    it("does not sell a lot held in the other silo", () => {
      const state = stateOf({}, { USD: [lot("USD", { ticker: "SAP.DE", units: 5 })] });
      assert.match(reason(state, saleOf()), /no open lot of SAP\.DE in the EUR silo/);
    });

    it("checks the currency explicitly", () => {
      const crossed = crossedState(held());
      assert.match(reason(crossed, { ...saleOf(), currency: "USD" }), /no USD silo/);
    });
  });

  it("a handler never mutates the state it is given", () => {
    const state = stateOf({}, { EUR: [lot("EUR", { ticker: "SAP.DE", units: 2 })] });
    const before = JSON.stringify(state);
    ok(state, buyOf());
    ok(state, saleOf({ units: 1 }));
    ok(state, { kind: "deposit", currency: "EUR", amount: eur(5) });
    ok(state, { kind: "withdrawal", currency: "EUR", amount: eur(5) });
    assert.equal(JSON.stringify(state), before);
  });

  it("each handler is exported on its own", () => {
    assert.deepEqual([typeof deposit, typeof withdrawal, typeof buy, typeof sale], Array(4).fill("function"));
  });
});
