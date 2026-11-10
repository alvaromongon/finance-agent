/**
 * The command handlers of the inbox (#131): pure, one per command, `(state, command) -> state or a reason`.
 * No I/O, so no vault: the state is built in memory.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { money } from "../money.js";
import { parseTicker as tk, type Ticker } from "../ticker.js";
import {
  applyCommand,
  buy,
  deposit,
  initialStopBreaches,
  sale,
  withdrawal,
  type InboxState,
} from "../utils/inbox-handlers.js";
import type { Buy, ClearStop, Command, OpenedLot, OpenedLots, Sale, SetStop } from "../utils/inbox-handlers.js";
import { crossedState, lot, stateOf } from "./fixtures/inbox.js";

/** The state after a command the handler accepts; the states of these tests have both silos. */
const ok = (state: InboxState, command: Command): Required<InboxState> => {
  const result = applyCommand(state, command);
  assert.ok("state" in result, `expected ${command.kind} to be accepted: ${"reason" in result ? result.reason : ""}`);
  return result.state as Required<InboxState>;
};
/** The lots a command opened, as `inbox:check` keeps them: the key a handler gave and where the lot comes from. */
const openedBy = (opened: string | undefined, over: Partial<OpenedLot> = {}): Map<string, OpenedLot> =>
  new Map(
    opened === undefined ? [] : [[opened, { currency: "EUR", ticker: tk("SAP.DE"), command: 1, line: 3, ...over }]],
  );
const reason = (state: InboxState, command: Command, opened?: OpenedLots): string => {
  const result = applyCommand(state, command, opened);
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
const setStopOf = (over: Partial<SetStop<"EUR">> = {}): SetStop<"EUR"> => ({
  kind: "set_stop",
  currency: "EUR",
  ticker: tk("SAP.DE"),
  price: 170,
  ...over,
});
const clearStopOf = (over: Partial<ClearStop> = {}): ClearStop => ({
  kind: "clear_stop",
  ticker: tk("SAP.DE"),
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
      const next = ok(stateOf(), buyOf({ costs: eur(1.5) }));
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
        [["SAP.DE", "20260915-sapde-entry", "2026-09-15", 2, 2, 180, null, 1.5]],
      );
      assert.deepEqual(
        next.EUR.positions.map((p) => [p.ticker, p.volume, p.avgPrice, p.stopLoss]),
        [["SAP.DE", 2, 180, null]],
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

    it("keeps the stop of the position when the scale-in gives none, and the new lot starts with it", () => {
      const held = stateOf({}, { EUR: [lot("EUR", { ticker: "SAP.DE", units: 2, initialStop: 168 })] });
      const next = ok(held, buyOf());
      assert.equal(next.EUR.positions[0].stopLoss, 168);
      assert.deepEqual(
        next.EUR.lots.map((l) => l.initialStop),
        [168, 168],
      );
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

  describe("set_stop", () => {
    const held = () =>
      stateOf({}, { EUR: [lot("EUR", { ticker: "SAP.DE", units: 2, initialStop: 168, entryId: "old" })] });

    it("moves the one stop of the position and leaves the initial stop of the lots already open", () => {
      const next = ok(held(), setStopOf({ price: 175 }));
      assert.equal(next.EUR.positions[0].stopLoss, 175);
      assert.deepEqual(
        next.EUR.lots.map((l) => l.initialStop),
        [168],
      );
    });

    it("gives the lots the same batch opened that initial stop, not the older ones", () => {
      const first = applyCommand(held(), buyOf());
      assert.ok("state" in first && first.opened !== undefined);
      const second = applyCommand(first.state, setStopOf({ price: 172 }), openedBy(first.opened));
      assert.ok("state" in second);
      const next = second.state as Required<InboxState>;
      assert.deepEqual(
        next.EUR.lots.map((l) => [l.entryId, l.initialStop]),
        [
          ["old", 168],
          ["20260915-sapde-entry", 172],
        ],
      );
      assert.equal(next.EUR.positions[0].stopLoss, 172);
    });

    it("refuses a ticker with no open position", () => {
      assert.match(reason(stateOf(), setStopOf()), /no open position in SAP\.DE in the EUR silo/);
    });

    it("refuses a price that is not above zero, whatever reaches the handler (the parser is not its only caller)", () => {
      const state = held();
      for (const price of [0, -5, Number.NaN]) {
        assert.match(reason(state, setStopOf({ price })), /stop of SAP\.DE must be greater than zero/, String(price));
      }
    });

    it("prints the ticker escaped in its refusal, as any owner-supplied text (S4)", () => {
      const wild = "A\u001b[31m" as Ticker;
      assert.match(reason(stateOf(), setStopOf({ ticker: wild })), /no open position in A\\u001b\[31m in the EUR silo/);
      assert.match(reason(stateOf(), clearStopOf({ ticker: wild })), /no open position in A\\u001b\[31m$/);
    });

    it("does not touch a position of another silo, and checks the currency explicitly", () => {
      const state = held();
      assert.match(reason(state, { ...setStopOf(), currency: "USD" }), /no open position/);
      assert.match(reason(crossedState(state), { ...setStopOf(), currency: "USD" }), /no USD silo/);
    });
  });

  describe("clear_stop", () => {
    it("removes the stop of the position", () => {
      const held = stateOf({}, { EUR: [lot("EUR", { ticker: "SAP.DE", units: 2, initialStop: 168 })] });
      const next = ok(held, clearStopOf());
      assert.equal(next.EUR.positions[0].stopLoss, null);
      assert.deepEqual(
        next.EUR.lots.map((l) => l.initialStop),
        [168],
      );
    });

    it("leaves the lots this batch opened with no initial stop, the older ones keeping theirs", () => {
      const held = stateOf({}, { EUR: [lot("EUR", { ticker: "SAP.DE", units: 2, initialStop: 168, entryId: "old" })] });
      const bought = applyCommand(held, buyOf());
      assert.ok("state" in bought && bought.opened !== undefined);
      const cleared = applyCommand(bought.state, clearStopOf(), openedBy(bought.opened));
      assert.ok("state" in cleared);
      const next = cleared.state as Required<InboxState>;
      assert.equal(next.EUR.positions[0].stopLoss, null);
      assert.deepEqual(
        next.EUR.lots.map((l) => [l.entryId, l.initialStop]),
        [
          ["old", 168],
          ["20260915-sapde-entry", null],
        ],
      );
    });

    it("leaves a new lot with no initial stop after a buy, set_stop and clear_stop", () => {
      const other = stateOf({}, { EUR: [lot("EUR", { ticker: "OTHER", units: 1 })] });
      const bought = applyCommand(other, buyOf());
      assert.ok("state" in bought && bought.opened !== undefined);
      const opened = openedBy(bought.opened);
      const stopped = applyCommand(bought.state, setStopOf({ price: 170 }), opened);
      assert.ok("state" in stopped);
      const cleared = applyCommand(stopped.state, clearStopOf(), opened);
      assert.ok("state" in cleared);
      const next = cleared.state as Required<InboxState>;
      assert.deepEqual(
        next.EUR.lots.filter((l) => l.ticker === "SAP.DE").map((l) => l.initialStop),
        [null],
      );
      assert.equal(next.EUR.positions.find((p) => p.ticker === "SAP.DE")?.stopLoss, null);
    });

    it("clears the stop in every silo that holds the ticker with one, and leaves the others", () => {
      const both = stateOf(
        {},
        {
          EUR: [lot("EUR", { ticker: "SAP.DE", units: 2, initialStop: 168 })],
          USD: [lot("USD", { ticker: "SAP.DE", units: 2, initialStop: 168 })],
        },
      );
      const next = ok(both, clearStopOf());
      assert.deepEqual([next.EUR.positions[0].stopLoss, next.USD.positions[0].stopLoss], [null, null]);
      const oneStopped = ok(
        stateOf(
          {},
          {
            EUR: [lot("EUR", { ticker: "SAP.DE", units: 2, initialStop: 168 })],
            USD: [lot("USD", { ticker: "SAP.DE", units: 2 })],
          },
        ),
        clearStopOf(),
      );
      assert.equal(oneStopped.EUR.positions[0].stopLoss, null);
    });

    it("reports the state's error for a silo that fails to read, not 'no open position' or 'no stop to clear'", () => {
      assert.match(reason(crossedState(stateOf()), clearStopOf()), /^there is no USD silo in the portfolio$/);
      const unstopped = stateOf({}, { EUR: [lot("EUR", { ticker: "SAP.DE", units: 2 })] });
      assert.match(reason(crossedState(unstopped), clearStopOf()), /^there is no USD silo in the portfolio$/);
    });

    it("clears a ticker held in a silo that reads although the other silo does not", () => {
      const held = stateOf({}, { EUR: [lot("EUR", { ticker: "SAP.DE", units: 2, initialStop: 168 })] });
      const result = applyCommand(crossedState(held), clearStopOf());
      assert.ok("state" in result, "reason" in result ? result.reason : "");
      assert.equal(result.state.EUR?.positions[0].stopLoss, null);
    });

    it("works with the silos the portfolio has: a silo it does not have holds nothing", () => {
      const { USD: _usd, ...eurOnly } = stateOf(
        {},
        { EUR: [lot("EUR", { ticker: "SAP.DE", units: 2, initialStop: 168 })] },
      );
      const next = applyCommand(eurOnly, clearStopOf());
      assert.ok("state" in next);
      assert.match(reason(eurOnly, clearStopOf({ ticker: tk("NOPE") })), /no open position in NOPE$/);
    });

    it("counts a stop that is not above zero as no stop, like the rest of the check", () => {
      const zero = stateOf({}, { EUR: [lot("EUR", { ticker: "SAP.DE", units: 2 })] });
      zero.EUR.positions[0] = { ...zero.EUR.positions[0], stopLoss: 0 };
      assert.match(reason(zero, clearStopOf()), /SAP\.DE has no stop to clear/);
      const bought = ok(zero, buyOf());
      assert.deepEqual(
        bought.EUR.lots.map((l) => l.initialStop),
        [null, null],
      );
    });

    it("is refused for a position without a stop, and for a ticker with no position", () => {
      const noStop = stateOf({}, { EUR: [lot("EUR", { ticker: "SAP.DE", units: 2 })] });
      assert.match(reason(noStop, clearStopOf()), /SAP\.DE has no stop to clear/);
      assert.match(reason(stateOf(), clearStopOf()), /no open position in SAP\.DE/);
    });
  });

  describe("initialStopBreaches (#159)", () => {
    const held = () =>
      stateOf(
        {},
        { EUR: [lot("EUR", { ticker: "SAP.DE", units: 2, initialStop: 168, entryId: "old", entryPrice: 150 })] },
      );
    /** The state after the commands, with the keys of the lots they opened. */
    const run = (...commands: Command[]) => {
      let state: InboxState = held();
      const opened = new Map<string, OpenedLot>();
      for (const command of commands) {
        const result = applyCommand(state, command, opened);
        assert.ok("state" in result, "reason" in result ? result.reason : "");
        state = result.state;
        if (result.opened !== undefined)
          opened.set(result.opened, { currency: "EUR", ticker: tk("SAP.DE"), command: 1, line: 3 });
      }
      return { state, opened };
    };

    it("names a lot the batch opened whose initial stop is at or above its entry price", () => {
      const { state, opened } = run(buyOf({ price: 180 }), setStopOf({ price: 180 }));
      assert.deepEqual(initialStopBreaches(state, opened), [
        { currency: "EUR", ticker: "SAP.DE", entryId: "20260915-sapde-entry", entryPrice: 180, stop: 180 },
      ]);
      const above = run(buyOf({ price: 180 }), setStopOf({ price: 200 }));
      assert.equal(initialStopBreaches(above.state, above.opened).length, 1);
    });

    it("accepts a stop below the entry price, and a stop above the entry of a lot the batch did not open", () => {
      const below = run(buyOf({ price: 180 }), setStopOf({ price: 179 }));
      assert.deepEqual(initialStopBreaches(below.state, below.opened), []);
      const trailing = run(setStopOf({ price: 200 }));
      assert.deepEqual(initialStopBreaches(trailing.state, trailing.opened), []);
    });

    it("judges the stop the position ends the batch with: a later set_stop or a clear_stop replaces it", () => {
      const fixed = run(buyOf({ price: 180 }), setStopOf({ price: 190 }), setStopOf({ price: 170 }));
      assert.deepEqual(initialStopBreaches(fixed.state, fixed.opened), []);
      const cleared = run(buyOf({ price: 180 }), setStopOf({ price: 190 }), clearStopOf());
      assert.deepEqual(initialStopBreaches(cleared.state, cleared.opened), []);
    });

    it("a scale-in under a stop at or above the new price takes that stop, unless a set_stop moves it below", () => {
      const raised = ok(held(), setStopOf({ price: 190 }));
      const bought = applyCommand(raised, buyOf({ price: 180 }));
      assert.ok("state" in bought && bought.opened !== undefined);
      const opened = openedBy(bought.opened);
      assert.deepEqual(initialStopBreaches(bought.state, opened), [
        { currency: "EUR", ticker: "SAP.DE", entryId: "20260915-sapde-entry", entryPrice: 180, stop: 190 },
      ]);
      const moved = applyCommand(bought.state, setStopOf({ price: 175 }), opened);
      assert.ok("state" in moved);
      assert.deepEqual(initialStopBreaches(moved.state, opened), []);
    });
  });

  describe("buy limits (N2/S6)", () => {
    it("refuses a buy that costs nothing and units no sale could ever close", () => {
      assert.match(reason(stateOf(), buyOf({ units: 0.001, price: 1 })), /costs nothing/);
      assert.match(reason(stateOf(), buyOf({ units: 1e-9, price: 1e9 })), /below the units tolerance/);
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
      assert.match(reason(held(), saleOf({ ticker: tk("TCK") })), /no open lots for TCK/);
      assert.match(reason(held(), saleOf({ lot: "zzz" })), /no open lot with that id/);
      assert.match(reason(held(), saleOf({ lot: "a", units: 3 })), /only 2 are open/);
      assert.match(reason(held(), saleOf({ units: 6 })), /only 5 are open/);
    });

    it("refuses a sale whose costs exceed its proceeds, whatever the cash (B2)", () => {
      const state = stateOf(
        { eurCash: 8 },
        { EUR: [lot("EUR", { ticker: "SAP.DE", units: 1, entryPrice: 2, entryId: "a" })] },
      );
      assert.match(
        reason(state, saleOf({ units: 1, price: 1, costs: eur(50) })),
        /costs of 50\.00 EUR exceed the proceeds of 1\.00 EUR/,
      );
      assert.equal(ok(state, saleOf({ units: 1, price: 1, costs: eur(1) })).EUR.cash, 8);
    });

    it("never refuses a sale that raises the cash, even when the cash is already negative (#149)", () => {
      const negative = stateOf(
        { eurCash: -5 },
        { EUR: [lot("EUR", { ticker: "SAP.DE", units: 1, entryPrice: 2, entryId: "a" })] },
      );
      assert.equal(ok(negative, saleOf({ units: 1, price: 1 })).EUR.cash, -4);
      assert.equal(ok(negative, saleOf({ units: 1, price: 1, costs: eur(1) })).EUR.cash, -5);
    });

    it("refuses a sale whose proceeds round to zero cents, as a buy of a sub-cent amount is (#149)", () => {
      const state = stateOf({}, { EUR: [lot("EUR", { ticker: "SAP.DE", units: 1, entryPrice: 2, entryId: "a" })] });
      assert.match(
        reason(state, saleOf({ units: 0.0001, price: 0.04 })),
        /sale of SAP\.DE yields nothing: 0\.0001 units at 0\.04 EUR is below half a cent/,
      );
    });

    it("prints the ticker of a sub-cent refusal escaped and the price with its currency, for a buy and a sale alike", () => {
      const wild = "A\u001b[31m" as Ticker;
      const state = stateOf(
        {},
        { EUR: [{ ...lot("EUR", { ticker: "SAP.DE", units: 1, entryPrice: 2, entryId: "a" }), ticker: wild }] },
      );
      assert.match(
        reason(state, saleOf({ ticker: wild, units: 0.0001, price: 0.04 })),
        /^the sale of A\\u001b\[31m yields nothing: 0\.0001 units at 0\.04 EUR is below half a cent$/,
      );
      assert.match(
        reason(stateOf(), buyOf({ ticker: wild, units: 0.0001, price: 0.04 })),
        /^the buy of A\\u001b\[31m costs nothing: 0\.0001 units at 0\.04 EUR is below half a cent$/,
      );
    });

    it("accepts a sale that closes a dust lot worth under a cent: it credits 0.00 and closes the lot (#149)", () => {
      const state = stateOf(
        { eurCash: 5 },
        {
          EUR: [
            lot("EUR", { ticker: "SAP.DE", units: 0.0001, entryPrice: 2, entryId: "dust", date: "2026-09-01" }),
            lot("EUR", { ticker: "SAP.DE", units: 1, entryPrice: 2, entryId: "a", date: "2026-09-02" }),
          ],
        },
      );
      const after = ok(state, saleOf({ units: 0.0001, price: 0.04, lot: "dust" })).EUR;
      assert.equal(after.cash, 5);
      assert.deepEqual(
        after.lots.map((l) => l.entryId),
        ["a"],
      );
      // Selling the oldest lot first reaches the same dust lot; a sale that leaves it part-sold is still refused.
      assert.equal(ok(state, saleOf({ units: 0.0001, price: 0.04 })).EUR.lots.length, 1);
      assert.match(reason(state, saleOf({ units: 0.00005, price: 0.04, lot: "dust" })), /yields nothing/);
    });

    it("closes a whole position of dust with a sale of nothing (#149)", () => {
      const state = stateOf(
        {},
        { EUR: [lot("EUR", { ticker: "SAP.DE", units: 0.0001, entryPrice: 2, entryId: "a" })] },
      );
      const after = ok(state, saleOf({ units: 0.0001, price: 0.04 })).EUR;
      assert.deepEqual(after.lots, []);
      assert.deepEqual(after.positions, []);
    });

    describe("says where the lots a refusal talks about come from (#149)", () => {
      const state = stateOf({}, { EUR: [lot("EUR", { ticker: "SAP.DE", units: 2, entryId: "a" })] });
      const mixed = ok(state, buyOf({ units: 1, date: "2026-09-16" }));
      const key = `EUR/${mixed.EUR.lots.find((l) => l.entryId !== "a")!.entryId}`;

      it("names the portfolio, the commands that opened the lots, or both", () => {
        assert.match(reason(state, saleOf({ units: 3 })), /only 2 are open in portfolio\.md$/);
        const here = openedBy(key);
        assert.match(
          reason(mixed, saleOf({ units: 4 }), here),
          /only 3 are open in portfolio\.md and command 1 of this batch$/,
        );
        assert.match(
          reason(mixed, saleOf({ units: 2, lot: key.slice(4) }), here),
          /only 1 are open in command 1 of this batch$/,
        );
      });

      it("names the file of a lot an earlier file opened", () => {
        const earlier = openedBy(key, { file: "a\u001b.yaml", command: 2 });
        assert.match(
          reason(mixed, saleOf({ units: 2, lot: key.slice(4) }), earlier),
          /only 1 are open in command 2 of inbox\/a\\u001b\.yaml$/,
        );
      });

      it("says nothing of the commands for a ticker they did not open, though they opened another in the currency", () => {
        const bought = ok(stateOf(), buyOf({ ticker: tk("TCK") }));
        const opened = openedBy(`EUR/${bought.EUR.lots[0].entryId}`, { ticker: tk("TCK") });
        assert.match(reason(bought, saleOf(), opened), /no open lots for SAP\.DE in portfolio\.md$/);
        // The same ticker, sold out by the commands: they are named, with the portfolio.
        const sold = ok(bought, saleOf({ ticker: tk("TCK"), units: 2 }));
        assert.match(
          reason(sold, saleOf({ ticker: tk("TCK") }), opened),
          /no open lots for TCK in portfolio\.md and the earlier commands$/,
        );
      });

      it("calls the lots an earlier file opened and sold out 'an earlier file', not the earlier commands", () => {
        const bought = ok(stateOf(), buyOf({ ticker: tk("TCK") }));
        const earlier = openedBy(`EUR/${bought.EUR.lots[0].entryId}`, { ticker: tk("TCK"), file: "a.yaml" });
        const sold = ok(bought, saleOf({ ticker: tk("TCK"), units: 2 }));
        assert.match(reason(sold, saleOf({ ticker: tk("TCK") }), earlier), /in portfolio\.md and an earlier file$/);
      });

      it("is worked out only for a refusal that names it", () => {
        const throwing = new Map<string, OpenedLot>();
        Object.defineProperty(throwing, "get", {
          value: () => {
            throw new Error("looked at the sources");
          },
        });
        assert.match(reason(state, saleOf({ units: 1, costs: eur(500) }), throwing), /costs of 500\.00 EUR exceed/);
      });
    });

    it("recomputes the position's volume and average price from the lots left (N1)", () => {
      const state = stateOf(
        {},
        {
          EUR: [
            lot("EUR", { ticker: "SAP.DE", units: 10, entryPrice: 100, entryId: "a", date: "2026-01-10" }),
            lot("EUR", { ticker: "SAP.DE", units: 10, entryPrice: 200, entryId: "b", date: "2026-02-10" }),
          ],
        },
      );
      const [position] = ok(state, saleOf({ units: 10 })).EUR.positions;
      assert.deepEqual([position.volume, position.avgPrice], [10, 200]);
    });

    it("lets planSale judge the units and the tolerance, and tells its refusal from a bug (N6)", () => {
      assert.match(reason(held(), saleOf({ units: 6 })), /Cannot sell 6 units of SAP\.DE: only 5 are open/);
      // A bug is not a reason: it crashes instead of being reported as the owner's mistake.
      const broken = held();
      Object.assign(broken.EUR.lots[0], { entryUnits: 0, entryCosts: eur(4) });
      assert.match(reason(broken, saleOf({ units: 1 })), /Entry units 0/);
      const corrupt = { ...held(), EUR: { ...held().EUR, lots: null } } as unknown as InboxState;
      assert.throws(() => applyCommand(corrupt, saleOf()), TypeError);
    });

    it("refuses units below the units tolerance, which no sale could close (N2/S6)", () => {
      assert.match(reason(held(), saleOf({ units: 1e-9 })), /below the units tolerance/);
    });

    it("prints a lot id as JSON, never raw (S4)", () => {
      assert.match(reason(held(), saleOf({ lot: "x\u001b[31m" })), /lot "x\\u001b\[31m"/);
    });

    it("does not sell a lot held in the other silo", () => {
      const state = stateOf({}, { USD: [lot("USD", { ticker: "SAP.DE", units: 5 })] });
      assert.match(reason(state, saleOf()), /no open lots for SAP\.DE/);
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

  it("prints a ticker escaped in every refusal that names it, as any owner-supplied text (S4)", () => {
    // A `Ticker` is only made by parsing, which refuses control characters; a value cast past that must still
    // not reach the terminal raw, whichever handler names it.
    const wild = 'A\u001b[31m"\\' as Ticker;
    const escaped = 'A\\u001b[31m\\"\\\\';
    const held = stateOf({}, { EUR: [lot("EUR", { ticker: "SAP.DE", units: 2 })] });
    const refusals = [
      reason(stateOf(), buyOf({ ticker: wild, units: 1e-7, price: 0.01 })), // costs nothing
      reason(stateOf({ eurCash: 1 }), buyOf({ ticker: wild })), // more than the cash
      reason(stateOf(), saleOf({ ticker: wild })), // no open lot
      reason(held, saleOf({ ticker: wild, lot: "x" })), // no open lot with that id
      reason(held, saleOf({ units: 9, ticker: wild })), // no lot of it, whatever the units
    ];
    for (const text of refusals) {
      // eslint-disable-next-line no-control-regex
      assert.doesNotMatch(text, /[\u0000-\u001f]/, text);
      assert.ok(text.includes(escaped), text);
    }
  });

  it("each handler is exported on its own", () => {
    assert.deepEqual([typeof deposit, typeof withdrawal, typeof buy, typeof sale], Array(4).fill("function"));
  });
});
