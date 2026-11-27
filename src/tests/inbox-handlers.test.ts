/**
 * The command handlers of the inbox (#131): pure, one per command, `(state, command) -> state or a reason`.
 * No I/O, so no vault: the state is built in memory.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDecision, type Decision } from "../decisions.js";
import { money } from "../money.js";
import type { Lot, WatchlistEntry } from "../types.js";
import { parseTicker as tk, tickerIdPart, type Ticker } from "../ticker.js";
import {
  applyCommand,
  buy,
  deposit,
  initialStopBreaches,
  sale,
  saleShares,
  withdrawal,
  type InboxState,
  type StopSource,
} from "../utils/inbox-handlers.js";
import type {
  BatchContext,
  Buy,
  EntryContext,
  ClearStop,
  Conversion,
  Command,
  OpenedLot,
  OpenedLots,
  Sale,
  SetStop,
  Snapshot,
  Split,
} from "../utils/inbox-handlers.js";
import { crossedState, entryContext, lot, stateOf } from "./fixtures/inbox.js";

/**
 * What a run gives the handlers. The ids are the readable `YYYYMMDD-ticker-entry`, with a counter when one is
 * taken, so the tests can name the lots; the real source is `uniqueDecisionIds` (tested in inbox-ingest.test.ts).
 */
const ctx = (over: Partial<BatchContext> = {}, state: InboxState = {}): BatchContext => {
  const taken = new Set(Object.values(state).flatMap((silo) => silo.lots.map((l) => l.entryId)));
  return {
    opened: new Map(),
    earlierTickers: new Set(),
    newEntryId: (date, ticker) => {
      const base = `${date.replace(/-/g, "")}-${tickerIdPart(ticker)}-entry`;
      let id = base;
      for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
      taken.add(id);
      return id;
    },
    rulesVersion: "1.0",
    entryCostsTaken: new Map(),
    awaiting: new Set(),
    escalations: new Set(),
    entry: entryContext(),
    today: "2026-11-26",
    ...over,
  };
};
/** The state after a command the handler accepts; the states of these tests have both silos. */
const ok = (state: InboxState, command: Command): Required<InboxState> => {
  const result = applyCommand(state, command, ctx({}, state));
  assert.ok("state" in result, `expected ${command.kind} to be accepted: ${"reason" in result ? result.reason : ""}`);
  return result.state as Required<InboxState>;
};
/** The lots a command opened, as `inbox:check` keeps them: the key a handler gave and where the lot comes from. */
const openedBy = (opened: string | undefined, over: Partial<OpenedLot> = {}): Map<string, OpenedLot> =>
  new Map(
    opened === undefined ? [] : [[opened, { currency: "EUR", ticker: tk("SAP.DE"), command: 1, line: 3, ...over }]],
  );
const reason = (state: InboxState, command: Command, opened?: OpenedLots): string => {
  const result = applyCommand(state, command, ctx({ opened: opened ?? new Map() }, state));
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

const splitOf = (over: Partial<Split> = {}): Split => ({
  kind: "split",
  ticker: tk("SAP.DE"),
  date: "2026-07-01",
  ratio: { new: 4, old: 1 },
  ...over,
});

const snapshotOf = (over: Partial<Snapshot<"EUR">> = {}): Snapshot<"EUR"> => ({
  kind: "snapshot",
  currency: "EUR",
  date: "2026-11-20",
  cash: 1000,
  positions: [],
  ...over,
});

describe("inbox handlers", () => {
  describe("snapshot (#138)", () => {
    const held = stateOf({ eurCash: 1000 }, { EUR: [lot("EUR", { ticker: "SAP.DE", units: 10 })] });
    const result = (state: InboxState, command: Snapshot): ReturnType<typeof applyCommand> =>
      applyCommand(state, command, ctx({}, state));

    it("changes no cash, position or lot: only records that the broker was compared, and when", () => {
      const out = result(held, snapshotOf({ cash: 1000, positions: [{ ticker: tk("SAP.DE"), units: 10 }] }));
      assert.ok("state" in out);
      const { reconciled, ...silo } = out.state.EUR!;
      const { reconciled: _before, ...was } = held.EUR;
      assert.deepEqual(silo, was);
      assert.deepEqual(reconciled, { date: "2026-11-20", recordedOn: "2026-11-26", differences: [] });
      assert.deepEqual(out.state.USD, held.USD);
      assert.deepEqual(out.snapshot, { currency: "EUR", date: "2026-11-20", differences: [] });
    });

    it("reports a difference in the cash with what each side holds", () => {
      const out = result(held, snapshotOf({ cash: 1010.5, positions: [{ ticker: tk("SAP.DE"), units: 10 }] }));
      assert.ok("state" in out);
      assert.deepEqual(out.snapshot?.differences, [{ kind: "cash", broker: eur(1010.5), engine: eur(1000) }]);
      assert.equal(out.state.EUR!.cash, eur(1000), "the engine's cash is the same");
    });

    it("reports the units of a ticker the sides disagree on, one the broker lacks and one the engine lacks", () => {
      const out = result(
        held,
        snapshotOf({
          positions: [
            { ticker: tk("SAP.DE"), units: 8 },
            { ticker: tk("KO"), units: 3 },
          ],
        }),
      );
      assert.ok("state" in out);
      assert.deepEqual(out.snapshot?.differences, [
        { kind: "position", ticker: "SAP.DE", broker: 8, engine: 10 },
        { kind: "position", ticker: "KO", broker: 3, engine: 0 },
      ]);
      const missing = result(held, snapshotOf({ positions: [] }));
      assert.ok("state" in missing);
      assert.deepEqual(missing.snapshot?.differences, [{ kind: "position", ticker: "SAP.DE", broker: 0, engine: 10 }]);
    });

    it("does not count float noise below the units tolerance, nor less than a cent of cash", () => {
      const out = result(
        held,
        snapshotOf({ cash: 1000.001, positions: [{ ticker: tk("SAP.DE"), units: 10 + 1e-10 }] }),
      );
      assert.ok("state" in out);
      assert.deepEqual(out.snapshot?.differences, []);
    });

    it("compares with the state after the commands before it: a buy in the same batch counts", () => {
      const bought = ok(held, buyOf({ units: 2, price: 100 }));
      const out = result(bought, snapshotOf({ cash: 800, positions: [{ ticker: tk("SAP.DE"), units: 12 }] }));
      assert.ok("state" in out);
      assert.deepEqual(out.snapshot?.differences, []);
    });

    it("is refused for a silo the portfolio lacks, and for a silo that is not the one named", () => {
      const { USD: _usd, ...eurOnly } = held;
      assert.match(
        reason(eurOnly, snapshotOf({ currency: "USD" } as unknown as Partial<Snapshot<"EUR">>)),
        /there is no USD silo/,
      );
      assert.match(
        reason(crossedState(held), snapshotOf({ currency: "USD" } as unknown as Partial<Snapshot<"EUR">>)),
        /there is no USD silo/,
      );
    });

    it("is refused for a date in the future, whoever built the command; today is accepted", () => {
      assert.match(
        reason(held, snapshotOf({ date: "2026-11-27" })),
        /the snapshot's date 2026-11-27 is in the future \(today is 2026-11-26\)/,
      );
      assert.ok("state" in result(held, snapshotOf({ date: "2026-11-26" })));
    });

    it("is refused for a ticker listed twice, whoever built the command", () => {
      assert.match(
        reason(
          held,
          snapshotOf({
            positions: [
              { ticker: tk("KO"), units: 1 },
              { ticker: tk("KO"), units: 2 },
            ],
          }),
        ),
        /"KO" is listed twice/,
      );
    });

    it("records the day it was recorded, and a later snapshot replaces the earlier one", () => {
      const first = ok(held, snapshotOf({ date: "2026-11-20" }));
      assert.equal(first.EUR.reconciled?.recordedOn, "2026-11-26");
      const later = ok(first, snapshotOf({ date: "2026-11-24" }));
      assert.equal(later.EUR.reconciled?.date, "2026-11-24");
    });
  });

  describe("split (#137)", () => {
    const held = (units: number, over: Omit<Partial<Lot<"EUR">>, "ticker" | "units"> = {}) =>
      lot("EUR", { ticker: "SAP.DE", units, entryPrice: 100, initialStop: 90, ...over });

    it("multiplies the units of every open lot, divides its entry price and stop, and leaves the amounts alone", () => {
      const costs = eur(5);
      const before = stateOf({}, { EUR: [held(10, { entryCosts: costs })] });
      const after = ok(before, splitOf());
      const [l] = after.EUR.lots;
      assert.deepEqual(
        [l.units, l.entryUnits, l.entryPrice, l.initialStop, l.entryCosts, l.date, l.entryId],
        [40, 40, 25, 22.5, costs, "2026-06-15", "lot-sap.de"],
      );
      // What was invested and R in cents do not change: units x price, units x (price - stop).
      const [old] = before.EUR.lots;
      assert.equal(l.units * l.entryPrice, old.units * old.entryPrice);
      assert.equal(l.units * (l.entryPrice - l.initialStop!), old.units * (old.entryPrice - old.initialStop!));
      assert.equal(after.EUR.cash, before.EUR.cash);
      assert.equal(after.USD, before.USD, "a silo that holds nothing of the ticker is the very same object");
    });

    it("moves the position with its lots: volume, average price, current price and the stop; the P/L stays", () => {
      const before = stateOf({}, { EUR: [held(10)] });
      const [p] = before.EUR.positions;
      const withPrice = { ...before, EUR: { ...before.EUR, positions: [{ ...p, currentPrice: 120, pl: eur(200) }] } };
      const [after] = ok(withPrice, splitOf()).EUR.positions;
      assert.deepEqual(
        [after.volume, after.avgPrice, after.currentPrice, after.stopLoss, after.pl],
        [40, 25, 30, 22.5, eur(200)],
      );
    });

    it("keeps a position with no stop without one", () => {
      const state = stateOf({}, { EUR: [held(10, { initialStop: null })] });
      const after = ok(state, splitOf());
      assert.equal(after.EUR.positions[0].stopLoss, null);
      assert.equal(after.EUR.lots[0].initialStop, null);
    });

    it("scales a reverse split: 1 for 10 gives a tenth of the units at ten times the price", () => {
      const after = ok(
        stateOf({}, { EUR: [held(100, { entryPrice: 10, initialStop: 9 })] }),
        splitOf({ ratio: { new: 1, old: 10 } }),
      );
      const [l] = after.EUR.lots;
      assert.deepEqual([l.units, l.entryUnits, l.entryPrice, l.initialStop], [10, 10, 100, 90]);
      assert.deepEqual([after.EUR.positions[0].volume, after.EUR.positions[0].avgPrice], [10, 100]);
    });

    it("scales a lot that was partly sold in the same proportion, and every lot of the ticker in the order it had", () => {
      const state = stateOf(
        {},
        {
          EUR: [
            held(6, { entryId: "old", entryUnits: 10, date: "2026-05-01" }),
            lot("EUR", { ticker: "OTHER", units: 3, entryId: "other" }),
            held(4, { entryId: "new", date: "2026-06-20", entryPrice: 120, initialStop: null }),
          ],
        },
      );
      const after = ok(state, splitOf({ ratio: { new: 3, old: 2 } }));
      assert.deepEqual(
        after.EUR.lots.map((l) => [l.entryId, l.units, l.entryUnits, l.entryPrice]),
        [
          ["old", 9, 15, (100 * 2) / 3],
          ["other", 3, 3, 100],
          ["new", 6, 6, 80],
        ],
      );
      const sap = after.EUR.positions.find((p) => p.ticker === tk("SAP.DE"))!;
      assert.equal(sap.volume, 15);
    });

    it("splits the ticker in each silo that holds it", () => {
      const state = stateOf({}, { EUR: [held(10)], USD: [lot("USD", { ticker: "SAP.DE", units: 4, entryPrice: 50 })] });
      const result = applyCommand(state, splitOf(), ctx({}, state));
      assert.ok("state" in result);
      assert.deepEqual([result.state.EUR!.lots[0].units, result.state.USD!.lots[0].units], [40, 16]);
      assert.deepEqual(result.split, { silos: ["EUR", "USD"], lots: ["EUR/lot-sap.de", "USD/lot-sap.de"] });
    });

    it("is refused for a ticker with no open lot, naming it", () => {
      assert.match(reason(stateOf(), splitOf()), /cannot split SAP\.DE: there is no open lot of it in the portfolio/);
      assert.match(
        reason(stateOf({}, { EUR: [lot("EUR", { ticker: "OTHER", units: 3 })] }), splitOf()),
        /cannot split SAP\.DE: there is no open lot of it/,
      );
    });

    it("is refused for a ratio of 1, zero or negative, whoever built the command", () => {
      const state = stateOf({}, { EUR: [held(10)] });
      assert.match(reason(state, splitOf({ ratio: { new: 2, old: 2 } })), /a ratio of 1 changes nothing/);
      assert.match(reason(state, splitOf({ ratio: { new: 0, old: 1 } })), /split ratio must be greater than zero/);
      assert.match(reason(state, splitOf({ ratio: { new: 4, old: -1 } })), /split ratio must be greater than zero/);
      assert.match(
        reason(state, splitOf({ ratio: { new: Number.NaN, old: 1 } })),
        /split ratio must be greater than zero/,
      );
    });

    it("is refused when units that are whole would stop being whole: the owner settles the fraction with a sale", () => {
      const state = stateOf({}, { EUR: [held(15, { entryId: "L1" })] });
      const text = reason(state, splitOf({ ratio: { new: 1, old: 10 } }));
      assert.match(text, /cannot split SAP\.DE 1 for 10: lot "L1" would be left with 1\.5 units/);
      assert.match(text, /sell the fraction first/);
      assert.equal(ok(state, splitOf({ ratio: { new: 1, old: 5 } })).EUR.lots[0].units, 3);
    });

    it("lets a lot that already holds a fraction keep one", () => {
      const state = stateOf({}, { EUR: [held(2.5)] });
      assert.equal(ok(state, splitOf({ ratio: { new: 3, old: 2 } })).EUR.lots[0].units, 3.75);
    });

    it("refuses the whole split when one silo cannot take it: neither silo changes", () => {
      const state = stateOf({}, { EUR: [held(10)], USD: [lot("USD", { ticker: "SAP.DE", units: 15, entryId: "U1" })] });
      assert.match(reason(state, splitOf({ ratio: { new: 1, old: 10 } })), /lot "U1"/);
    });

    it("is refused when its date is before the oldest lot was bought, or before any lot of the ticker was", () => {
      const state = stateOf({}, { EUR: [held(10, { date: "2026-06-15" })] });
      assert.match(
        reason(state, splitOf({ date: "2026-06-14" })),
        /cannot split SAP\.DE: its date 2026-06-14 is before the day the oldest open lot was bought \(2026-06-15\)/,
      );
      const later = stateOf(
        {},
        { EUR: [held(10, { entryId: "a", date: "2026-05-01" }), held(5, { entryId: "b", date: "2026-07-05" })] },
      );
      assert.match(
        reason(later, splitOf({ date: "2026-07-01" })),
        /cannot split SAP\.DE: lot "b" was bought on 2026-07-05, after the split's date 2026-07-01: it is already at the prices after the split/,
      );
    });

    it("accepts a lot bought on the day of the split", () => {
      const state = stateOf({}, { EUR: [held(10, { date: "2026-07-01" })] });
      assert.equal(ok(state, splitOf({ date: "2026-07-01" })).EUR.lots[0].units, 40);
    });

    it("is refused for a silo it cannot read, and ignores a silo the portfolio lacks", () => {
      const { USD: _usd, ...eurOnly } = stateOf({}, { EUR: [held(10)] });
      assert.equal(ok(eurOnly as InboxState, splitOf()).EUR.lots[0].units, 40);
      assert.match(reason(eurOnly, splitOf({ ticker: tk("KO") })), /cannot split KO/);
    });
  });

  describe("convert (#135)", () => {
    const conversion = (over: Partial<Conversion> = {}): Conversion => ({
      kind: "convert",
      from: "EUR",
      to: "USD",
      amount: eur(100),
      received: usd(116),
      ...over,
    });

    it("moves cash out of one silo and into the other in one step", () => {
      const state = ok(stateOf({ eurCash: 1000, usdCash: 500 }), conversion());
      assert.equal(state.EUR.cash, 900);
      assert.equal(state.USD.cash, 616);
    });

    it("works out what arrives from the rate and the costs: (amount - costs) x rate, to the cent", () => {
      const state = ok(stateOf(), conversion({ received: undefined, rate: 1.17, costs: eur(0.8) }));
      assert.equal(state.EUR.cash, 900);
      assert.equal(state.USD.cash, 500 + 116.06); // 99.20 x 1.17 = 116.064
    });

    it("moves USD into EUR as well, and moves the total cash the portfolio tells", () => {
      const state = stateOf();
      const withTotal = { ...state, USD: { ...state.USD, totalCash: usd(520) } };
      const after = ok(withTotal, conversion({ from: "USD", to: "EUR", amount: usd(200), received: eur(180) }));
      assert.equal(after.USD.cash, 300);
      assert.equal(after.USD.totalCash, 320);
      assert.equal(after.EUR.cash, 1180);
    });

    it("refuses the same currency on both sides", () => {
      assert.match(
        reason(stateOf(), conversion({ to: "EUR", received: eur(100) })),
        /a conversion needs two currencies/,
      );
    });

    it("refuses an amount that is not positive, and a source silo without enough cash", () => {
      assert.match(reason(stateOf(), conversion({ amount: eur(0) })), /amount greater than zero/);
      assert.match(
        reason(stateOf({ eurCash: 50 }), conversion()),
        /the conversion of 100\.00 EUR exceeds the available cash of 50\.00 EUR/,
      );
    });

    it("refuses costs not below the amount: nothing would arrive", () => {
      for (const costs of [eur(100), eur(150)]) {
        assert.match(
          reason(stateOf(), conversion({ received: undefined, rate: 1.1, costs })),
          /the costs of \d+\.\d\d EUR are not below the amount of 100\.00 EUR converted: nothing would reach the USD silo/,
        );
      }
    });

    it("refuses what arrives as nothing, a missing or a doubled way of saying it, and a silo the portfolio lacks", () => {
      assert.match(reason(stateOf(), conversion({ received: undefined, rate: 0.00001 })), /delivers nothing/);
      assert.match(reason(stateOf(), conversion({ received: undefined })), /"received" or with "rate"/);
      assert.match(reason(stateOf(), conversion({ rate: 1.1 })), /"received" or with "rate"/);
      const { USD: _usd, ...eurOnly } = stateOf();
      assert.match(reason(eurOnly, conversion()), /there is no USD silo in the portfolio/);
    });

    it("refuses an amount too large to count instead of crashing", () => {
      assert.match(
        reason(stateOf({ eurCash: 1e15 }), conversion({ amount: eur(1e15), received: undefined, rate: 1e300 })),
        /too large to count/,
      );
    });
  });

  describe("what the handlers are run with", () => {
    it("`opened` has no default: a caller that leaves it out does not compile (found in #151)", () => {
      const withoutOpened = {
        earlierTickers: new Set<string>(),
        newEntryId: () => "x",
        rulesVersion: "1.0",
        entryCostsTaken: new Map(),
        entry: entryContext(),
      };
      // @ts-expect-error `opened` is required: this call must not compile
      const result = applyCommand(stateOf(), buyOf(), withoutOpened);
      // At run time it is the caller's `undefined` that a handler would read: only the stop handlers use it.
      assert.ok("state" in result);
    });

    it("a buy returns the lot it opened itself, with the id the run gave it, the rules version and no_stop", () => {
      const result = applyCommand(stateOf(), buyOf(), ctx({ rulesVersion: "2.1" }, stateOf()));
      assert.ok("state" in result && result.lot !== undefined && result.opened !== undefined);
      assert.deepEqual(
        [result.lot.entryId, result.lot.rulesVersion, result.lot.rulesViolations, result.opened],
        ["20260915-sapde-entry", "2.1", ["entry_without_setup", "no_stop"], "EUR/20260915-sapde-entry"],
      );
      const lots = (result.state as Required<InboxState>).EUR.lots;
      assert.deepEqual(lots, [result.lot]);
    });

    it("a set_stop gives the lots of the batch their stop, and takes no_stop off them; a clear_stop puts it back", () => {
      const bought = applyCommand(stateOf(), buyOf(), ctx());
      assert.ok("state" in bought);
      const opened = openedBy(bought.opened);
      const set = applyCommand(bought.state, setStopOf({ price: 170 }), ctx({ opened }));
      assert.ok("state" in set);
      assert.deepEqual(
        (set.state as Required<InboxState>).EUR.lots.map((l) => [l.initialStop, l.rulesViolations]),
        [[170, ["entry_without_setup"]]],
      );
      const cleared = applyCommand(set.state, clearStopOf(), ctx({ opened }));
      assert.ok("state" in cleared);
      assert.deepEqual(
        (cleared.state as Required<InboxState>).EUR.lots.map((l) => [l.initialStop, l.rulesViolations]),
        [[null, ["entry_without_setup", "no_stop"]]],
      );
    });

    it("a sale returns the exit of each lot it touched, and takes the entry costs earlier exits already took", () => {
      const held = stateOf(
        {},
        { EUR: [lot("EUR", { ticker: "SAP.DE", units: 2, entryPrice: 180, entryId: "a", entryCosts: eur(3) })] },
      );
      const first = applyCommand(held, saleOf({ units: 1 }), ctx());
      assert.ok("state" in first && first.exits !== undefined);
      assert.deepEqual(
        first.exits.map((exit) => [exit.lot.entryId, exit.unitsSold, exit.unitsLeft, exit.entryCosts]),
        [["a", 1, 1, 1.5]],
      );
      const taken = new Map([["a", eur(1.5)]]);
      const second = applyCommand(first.state, saleOf({ units: 1 }), ctx({ entryCostsTaken: taken }));
      assert.ok("state" in second && second.exits !== undefined);
      assert.deepEqual(
        second.exits.map((exit) => [exit.unitsLeft, exit.entryCosts]),
        [[0, 1.5]],
        "the last exit takes what is left of the lot's entry costs",
      );
    });
  });

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

  describe("the rules of an entry and the proposal a trade follows (ADR-0013 §4, ADR-0009 §5 and §8)", () => {
    const proposal = (over: Partial<Decision> = {}): Decision =>
      buildDecision({
        date: "2026-09-10",
        ticker: tk("SAP.DE"),
        currency: "EUR",
        origin: "sistema",
        source: "heartbeat",
        type: "buy_proposal",
        price: 180,
        setup: { pattern: "pullback", state: "triggered", level: 180 },
        assumptions: ["the thesis holds"],
        rules_version: "1.0",
        ...over,
      });
    const bought = (command: Buy<"EUR">, over: Partial<EntryContext> = {}) => {
      const result = applyCommand(stateOf(), command, ctx({ entry: entryContext(over) }));
      assert.ok("state" in result && result.lot !== undefined);
      return result;
    };
    const entryEntry = (ticker: string): WatchlistEntry => ({
      ticker: tk(ticker),
      name: ticker,
      market: "TEST",
      currency: "EUR",
      horizon: "medium",
      thesis: "test",
    });

    it("flags a ticker that is not in the watchlist of its silo, and only that", () => {
      const { lot: opened } = bought(buyOf(), { watchlist: { EUR: [entryEntry("KO")], USD: [entryEntry("SAP.DE")] } });
      assert.deepEqual(opened!.rulesViolations, ["not_in_watchlist", "no_stop"]);
    });

    it("flags an entry in the watchlist that follows no system setup", () => {
      assert.deepEqual(bought(buyOf()).lot!.rulesViolations, ["entry_without_setup", "no_stop"]);
    });

    it("a buy that follows a proposal with a setup is the system's, cites it, and breaks nothing but the stop", () => {
      const followed = proposal();
      const result = bought(buyOf(), { history: [followed] });
      assert.deepEqual(
        [result.lot!.origin, result.proposal, result.lot!.rulesViolations],
        ["sistema", followed.id, ["no_stop"]],
      );
    });

    it("follows an armed breakout too, and a proposal of the same day", () => {
      const armed = proposal({
        type: "setup_armed",
        date: "2026-09-15",
        setup: { pattern: "breakout", state: "armed", level: 180 },
        target: 200,
        assumptions: undefined,
        eligibility: { verdict: "eligible", reasons: [] },
      });
      assert.equal(bought(buyOf(), { history: [armed] }).lot!.origin, "sistema");
    });

    it("a buy of what the engine blocked is the owner's, cites the block and says it overrode it", () => {
      const blocked = proposal({
        type: "buy_blocked",
        eligibility: { verdict: "blocked", reasons: ["risk"] },
      });
      const result = bought(buyOf(), { history: [blocked] });
      assert.deepEqual(
        [result.lot!.origin, result.proposal, result.lot!.rulesViolations],
        ["propietario", blocked.id, ["no_stop", "overrode_block"]],
      );
    });

    it("does not follow a proposal of another ticker, one after the buy, one past the window or one a trade already cited", () => {
      const history = [
        proposal({ ticker: tk("KO") }),
        proposal({ date: "2026-09-16" }),
        proposal({ date: "2026-09-04" }),
        proposal({ id: "taken" }),
      ];
      const cited = buildDecision({
        date: "2026-09-11",
        ticker: tk("SAP.DE"),
        currency: "EUR",
        origin: "propietario",
        source: "portfolio-sync",
        type: "entry",
        price: 180,
        amount: 360,
        related_id: "taken",
        rules_version: "1.0",
      });
      const result = bought(buyOf(), { history: [...history, cited] });
      assert.equal(result.lot!.origin, "propietario");
      assert.equal(result.proposal, undefined);
    });

    it("a proposal an earlier buy of the run cited is not followed again", () => {
      const followed = proposal();
      assert.equal(bought(buyOf(), { history: [followed], cited: new Set([followed.id]) }).lot!.origin, "propietario");
    });

    it("flags a stop closer than the minimum ATRs once the batch has set it, and only then", () => {
      const entry = entryContext({ atr: new Map([[tk("SAP.DE"), 10]]), minStopAtr: 2 });
      const first = applyCommand(stateOf(), buyOf({ price: 180 }), ctx({ entry }));
      assert.ok("state" in first);
      const opened = openedBy(first.opened);
      const violationsAfter = (price: number) => {
        const set = applyCommand(first.state, setStopOf({ price }), ctx({ opened, entry }));
        assert.ok("state" in set);
        return (set.state as Required<InboxState>).EUR.lots[0].rulesViolations;
      };
      // The entry is at 180 and an ATR is 10: a stop at 165 is 1.5 ATRs away (below 2), one at 150 is 3.
      assert.deepEqual(violationsAfter(165), ["entry_without_setup", "stop_below_min_atr"]);
      assert.deepEqual(violationsAfter(150), ["entry_without_setup"]);
      // Without an ATR the distance is not judged.
      const unknown = applyCommand(first.state, setStopOf({ price: 179 }), ctx({ opened, entry: entryContext() }));
      assert.ok("state" in unknown);
      assert.deepEqual((unknown.state as Required<InboxState>).EUR.lots[0].rulesViolations, ["entry_without_setup"]);
    });

    it("a sale that follows a sell proposal is the system's; any other is the owner's", () => {
      const held = stateOf({}, { EUR: [lot("EUR", { ticker: "SAP.DE", units: 2, entryPrice: 180, entryId: "a" })] });
      const sell = proposal({ type: "sell", setup: undefined, assumptions: undefined });
      const follows = applyCommand(held, saleOf(), ctx({ entry: entryContext({ history: [sell] }) }, held));
      const alone = applyCommand(held, saleOf(), ctx({}, held));
      assert.ok("state" in follows && "state" in alone);
      assert.deepEqual([follows.origin, alone.origin], ["sistema", "propietario"]);
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
      const first = applyCommand(held(), buyOf(), ctx());
      assert.ok("state" in first && first.opened !== undefined);
      const second = applyCommand(first.state, setStopOf({ price: 172 }), ctx({ opened: openedBy(first.opened) }));
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
      const bought = applyCommand(held, buyOf(), ctx());
      assert.ok("state" in bought && bought.opened !== undefined);
      const cleared = applyCommand(bought.state, clearStopOf(), ctx({ opened: openedBy(bought.opened) }));
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
      const bought = applyCommand(other, buyOf(), ctx());
      assert.ok("state" in bought && bought.opened !== undefined);
      const opened = openedBy(bought.opened);
      const stopped = applyCommand(bought.state, setStopOf({ price: 170 }), ctx({ opened }));
      assert.ok("state" in stopped);
      const cleared = applyCommand(stopped.state, clearStopOf(), ctx({ opened }));
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
      const result = applyCommand(crossedState(held), clearStopOf(), ctx());
      assert.ok("state" in result, "reason" in result ? result.reason : "");
      assert.equal(result.state.EUR?.positions[0].stopLoss, null);
    });

    it("works with the silos the portfolio has: a silo it does not have holds nothing", () => {
      const { USD: _usd, ...eurOnly } = stateOf(
        {},
        { EUR: [lot("EUR", { ticker: "SAP.DE", units: 2, initialStop: 168 })] },
      );
      const next = applyCommand(eurOnly, clearStopOf(), ctx());
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
      const stops = new Map<string, StopSource | null>();
      for (const [i, command] of commands.entries()) {
        const result = applyCommand(
          state,
          command,
          ctx({ opened, record: { at: { command: i + 1, line: 3 * (i + 1) }, stops } }),
        );
        assert.ok("state" in result, "reason" in result ? result.reason : "");
        state = result.state;
        if (result.opened !== undefined)
          opened.set(result.opened, { currency: "EUR", ticker: tk("SAP.DE"), command: 1, line: 3 });
      }
      return { state, opened, stops };
    };

    it("names a lot the batch opened whose initial stop is at or above its entry price", () => {
      const { state, opened, stops } = run(buyOf({ price: 180 }), setStopOf({ price: 180 }));
      assert.deepEqual(initialStopBreaches(state, opened, stops), [
        {
          currency: "EUR",
          ticker: "SAP.DE",
          entryId: "20260915-sapde-entry",
          entryPrice: 180,
          stop: 180,
          setBy: { command: 2, line: 6 },
        },
      ]);
      const above = run(buyOf({ price: 180 }), setStopOf({ price: 200 }));
      assert.equal(initialStopBreaches(above.state, above.opened, above.stops).length, 1);
    });

    it("accepts a stop below the entry price, and a stop above the entry of a lot the batch did not open", () => {
      const below = run(buyOf({ price: 180 }), setStopOf({ price: 179 }));
      assert.deepEqual(initialStopBreaches(below.state, below.opened, below.stops), []);
      const trailing = run(setStopOf({ price: 200 }));
      assert.deepEqual(initialStopBreaches(trailing.state, trailing.opened, trailing.stops), []);
    });

    it("judges the stop the position ends the batch with: a later set_stop or a clear_stop replaces it", () => {
      const fixed = run(buyOf({ price: 180 }), setStopOf({ price: 190 }), setStopOf({ price: 170 }));
      assert.deepEqual(initialStopBreaches(fixed.state, fixed.opened, fixed.stops), []);
      const cleared = run(buyOf({ price: 180 }), setStopOf({ price: 190 }), clearStopOf());
      assert.deepEqual(initialStopBreaches(cleared.state, cleared.opened, cleared.stops), []);
    });

    it("a scale-in under a stop at or above the new price takes that stop, unless a set_stop moves it below", () => {
      const raised = ok(held(), setStopOf({ price: 190 }));
      const bought = applyCommand(raised, buyOf({ price: 180 }), ctx());
      assert.ok("state" in bought && bought.opened !== undefined);
      const opened = openedBy(bought.opened);
      const stops = new Map<string, StopSource | null>();
      // The stop the position already had is not the batch's: no source (`setBy: null`, the portfolio's).
      assert.deepEqual(initialStopBreaches(bought.state, opened, stops), [
        { currency: "EUR", ticker: "SAP.DE", entryId: "20260915-sapde-entry", entryPrice: 180, stop: 190, setBy: null },
      ]);
      const moved = applyCommand(
        bought.state,
        setStopOf({ price: 175 }),
        ctx({ opened, record: { at: { command: 2, line: 6 }, stops } }),
      );
      assert.ok("state" in moved);
      assert.deepEqual(initialStopBreaches(moved.state, opened, stops), []);
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

    it("refuses a 0.00 sale unless it uses up every lot it touches, not just one (#162)", () => {
      const state = stateOf(
        { eurCash: 5 },
        {
          EUR: [
            lot("EUR", { ticker: "SAP.DE", units: 0.0001, entryPrice: 2, entryId: "dust", date: "2026-09-01" }),
            lot("EUR", { ticker: "SAP.DE", units: 1, entryPrice: 2, entryId: "a", date: "2026-09-02" }),
          ],
        },
      );
      // Closes the dust lot but takes 0.00005 units from the real lot for nothing.
      assert.match(reason(state, saleOf({ units: 0.00015, price: 0.04 })), /sale of SAP\.DE yields nothing/);
    });

    it("accepts a 0.00 sale that closes several dust lots, giving each exit a non-zero exact amount (#162)", () => {
      const state = stateOf(
        { eurCash: 5 },
        {
          EUR: [
            lot("EUR", { ticker: "SAP.DE", units: 0.0001, entryPrice: 2, entryId: "d1", date: "2026-09-01" }),
            lot("EUR", { ticker: "SAP.DE", units: 0.0001, entryPrice: 2, entryId: "d2", date: "2026-09-02" }),
            lot("EUR", { ticker: "SAP.DE", units: 1, entryPrice: 2, entryId: "a", date: "2026-09-03" }),
          ],
        },
      );
      const after = ok(state, saleOf({ units: 0.0002, price: 0.04 })).EUR;
      assert.equal(after.cash, 5);
      assert.deepEqual(
        after.lots.map((l) => l.entryId),
        ["a"],
      );
    });

    it("gives each exit of a dust-closing sale a non-zero exact amount at 8 decimals (#162)", () => {
      const dust = [
        lot("EUR", { ticker: "SAP.DE", units: 0.0001, entryPrice: 2, entryId: "d1", date: "2026-09-01" }),
        lot("EUR", { ticker: "SAP.DE", units: 0.0001, entryPrice: 2, entryId: "d2", date: "2026-09-02" }),
      ];
      // Proceeds of 0.000008: zero cents, but 800 at 8 decimals; `saleShares` works them out from the command.
      const shares = saleShares(dust, saleOf({ units: 0.0002, price: 0.04 }), new Map());
      assert.deepEqual(
        shares.map((share) => share.amount),
        [0.000004, 0.000004],
      );
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
      assert.throws(() => applyCommand(corrupt, saleOf(), ctx()), TypeError);
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
