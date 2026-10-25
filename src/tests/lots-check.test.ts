import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertLotsMatch, lotsMismatches, volumeMismatches } from "../utils/lots-check.js";
import { buildDecision, type Decision } from "../decisions.js";
import type { Lot, PortfolioSnapshot, Position } from "../types.js";
import { parseTicker as tk } from "../ticker.js";

const entry = (id: string, ticker: string, currency: "EUR" | "USD" = "USD"): Decision =>
  buildDecision({
    id,
    date: "2026-06-15",
    ticker: tk(ticker),
    currency,
    origin: "sistema",
    source: "portfolio-sync",
    type: "entry",
    price: 100,
    amount: 1000,
    units: 10,
    stop_initial: 90,
    rules_version: "1.0",
  });

/** An entry recorded before the lot contract (#52): its log line carries no `units`. */
const earlierEntry = (id: string, ticker: string): Decision => {
  const { units: _units, ...rest } = entry(id, ticker);
  return rest;
};

const position = (ticker: string, volume: number): Position => ({
  ticker: tk(ticker),
  currency: "USD",
  volume,
  avgPrice: 100,
  currentPrice: 100,
  pl: 0,
  stopLoss: null,
});

const lot = (entryId: string, units: number, ticker = "TCK"): Lot => ({
  ticker: tk(ticker),
  entryId,
  date: "2026-06-15",
  units,
  entryUnits: 10,
  entryPrice: 100,
  initialStop: 90,
  entryCosts: null,
  origin: "sistema",
  rulesVersion: "1.0",
  rulesViolations: [],
});

const portfolio = (positions: Position[], lots: Lot[]): PortfolioSnapshot => ({
  currency: "USD",
  cash: 0,
  positions,
  lots,
  syncedAt: "2026-10-16T18:00:00.000Z",
});

describe("lotsMismatches", () => {
  const log = [entry("a", "TCK"), entry("b", "TCK"), entry("c", "OTH")];

  it("is empty when every Volume is the sum of the units of its lots", () => {
    const p = portfolio([position("TCK", 15), position("OTH", 5)], [lot("a", 10), lot("b", 5), lot("c", 5, "OTH")]);
    assert.deepEqual(lotsMismatches(p, log), []);
  });

  it("is empty for an empty silo", () => {
    assert.deepEqual(lotsMismatches(portfolio([], []), []), []);
  });

  it("names the ticker whose Volume is not the sum of its lots", () => {
    const p = portfolio([position("TCK", 7)], [lot("a", 5)]);
    const messages = lotsMismatches(p, [entry("a", "TCK"), entry("b", "TCK")]).filter((m) => m.includes("Volume"));
    assert.equal(messages.length, 1);
    assert.match(messages[0], /TCK.*Volume 7.*5/);
  });

  it("flags a position with no lots at all", () => {
    const [message] = lotsMismatches(portfolio([position("TCK", 3)], []), log);
    assert.match(message, /TCK.*Volume 3.*0/);
  });

  it("flags lots of a ticker that has no position row", () => {
    const [message] = lotsMismatches(portfolio([], [lot("c", 5, "OTH")]), log);
    assert.match(message, /OTH.*Volume 0.*5/);
  });

  it("flags a lot whose entry id is not in the decision log, naming the id", () => {
    const messages = lotsMismatches(portfolio([position("TCK", 7)], [lot("a", 5), lot("ghost", 2)]), [
      entry("a", "TCK"),
    ]);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /ghost.*decision log/);
  });

  it("flags a lot whose id belongs to a decision that is not an entry", () => {
    const sell = buildDecision({
      id: "s",
      date: "2026-06-15",
      ticker: tk("TCK"),
      currency: "USD",
      origin: "sistema",
      source: "portfolio-sync",
      type: "exit",
      price: 100,
      amount: 100,
      rules_version: "1.0",
    });
    const [message] = lotsMismatches(portfolio([position("TCK", 5)], [lot("s", 5)]), [sell]);
    assert.match(message, /s.*not an entry/);
  });

  it("says an entry without a ticker has none, instead of calling it not an entry", () => {
    const noTicker: Decision = { ...entry("e", "TCK"), ticker: null };
    const [message] = lotsMismatches(portfolio([position("TCK", 5)], [lot("e", 5)]), [noTicker]);
    assert.match(message, /lot e is an entry in the decision log that has no ticker/);
    assert.doesNotMatch(message, /a entry|not an entry/);
  });

  it("names the type of a decision that is not an entry", () => {
    const sell = { ...entry("s", "TCK"), type: "exit" as const };
    const [message] = lotsMismatches(portfolio([position("TCK", 5)], [lot("s", 5)]), [sell]);
    assert.match(message, /lot s is a decision of type exit in the decision log, not an entry/);
  });

  it("reports the rows of Lots the reader skipped, with the file prefix", () => {
    const p = {
      ...portfolio([], []),
      skippedLotRows: ['Lots row 2 (XOM, x1): Origin "Sistema" is not sistema or propietario'],
    };
    assert.deepEqual(volumeMismatches(p), [
      'portfolio.md (USD): Lots row 2 (XOM, x1): Origin "Sistema" is not sistema or propietario',
    ]);
    assert.equal(lotsMismatches(p, []).length, 1);
  });

  it("flags a lot whose entry was recorded in the other currency", () => {
    const [message] = lotsMismatches(portfolio([position("TCK", 5)], [lot("e", 5)]), [entry("e", "TCK", "EUR")]);
    assert.match(message, /e.*EUR.*USD/);
  });

  it("tolerates float noise in the sum", () => {
    const p = portfolio([position("TCK", 0.3)], [lot("a", 0.1), lot("b", 0.2)]);
    assert.deepEqual(lotsMismatches(p, [entry("a", "TCK"), entry("b", "TCK")]), []);
  });
});

describe("lotsMismatches: the lots against their entries in the log (C3 of PR #50, #52)", () => {
  const log = [entry("a", "TCK")];
  const held = (overrides: Partial<Lot> = {}) =>
    portfolio([position("TCK", overrides.units ?? 10)], [{ ...lot("a", 10), ...overrides }]);

  it("a lot with more Units than Entry units is refused, naming the ticker and the entry id", () => {
    const [message] = lotsMismatches(portfolio([position("TCK", 12)], [{ ...lot("a", 12), entryUnits: 10 }]), log);
    assert.match(message, /TCK.*lot a.*Units 12.*Entry units 10/);
  });

  it("an Entry id on two rows is refused", () => {
    const p = portfolio([position("TCK", 10)], [lot("a", 5), lot("a", 5)]);
    const messages = lotsMismatches(p, log);
    assert.equal(messages.length, 1, JSON.stringify(messages));
    assert.match(messages[0], /Entry id a.*two rows/);
  });

  it("a lot whose Ticker is not the one of its entry in the log is refused", () => {
    const [message] = lotsMismatches(portfolio([position("OTH", 10)], [lot("a", 10, "OTH")]), log);
    assert.match(message, /lot a.*OTH.*entry.*TCK/);
  });

  const differing: [name: string, change: Partial<Lot>, pattern: RegExp][] = [
    ["entry price", { entryPrice: 101 }, /TCK.*lot a.*Entry price 101.*100/],
    ["initial stop", { initialStop: 80 }, /TCK.*lot a.*Initial stop 80/],
    ["date", { date: "2026-06-16" }, /TCK.*lot a.*Date 2026-06-16.*2026-06-15/],
    ["origin", { origin: "propietario" }, /TCK.*lot a.*Origin propietario.*sistema/],
    ["rules version", { rulesVersion: "2.0" }, /TCK.*lot a.*Rules version 2\.0.*1\.0/],
    ["rules violations", { rulesViolations: ["no_stop"] }, /TCK.*lot a.*Rules violations no_stop/],
    ["entry units", { entryUnits: 11, units: 10 }, /TCK.*lot a.*Entry units 11.*10/],
  ];
  for (const [name, change, pattern] of differing) {
    it(`a snapshot field that differs from the entry in the log is refused: ${name}`, () => {
      const messages = lotsMismatches(held(change), log);
      assert.ok(
        messages.some((m) => pattern.test(m)),
        JSON.stringify(messages),
      );
    });
  }

  describe("a split correction scales units, price and stop by one ratio (B2 of PR #56)", () => {
    it("a 2:1 split passes: units × 2, entry price and initial stop ÷ 2", () => {
      const p = portfolio(
        [position("TCK", 20)],
        [{ ...lot("a", 20), entryUnits: 20, entryPrice: 50, initialStop: 45 }],
      );
      assert.deepEqual(lotsMismatches(p, log), []);
    });

    it("a 1:10 reverse split passes too (ratio below 1), also on a part-sold lot", () => {
      const p = portfolio(
        [position("TCK", 0.6)],
        [{ ...lot("a", 0.6), entryUnits: 1, entryPrice: 1000, initialStop: 900 }],
      );
      assert.deepEqual(lotsMismatches(p, log), []);
    });

    it("a split of a lot with no initial stop passes when the log has none either", () => {
      const noStop = [{ ...entry("a", "TCK"), stop_initial: undefined }];
      const p = portfolio(
        [position("TCK", 20)],
        [{ ...lot("a", 20), entryUnits: 20, entryPrice: 50, initialStop: null }],
      );
      assert.deepEqual(lotsMismatches(p, noStop), []);
    });

    it("scaling only the units is refused", () => {
      const messages = lotsMismatches(portfolio([position("TCK", 20)], [{ ...lot("a", 20), entryUnits: 20 }]), log);
      assert.ok(
        messages.some((m) => m.includes("Entry units 20")),
        JSON.stringify(messages),
      );
    });

    it("scaling units and price by different ratios is refused", () => {
      const p = portfolio(
        [position("TCK", 20)],
        [{ ...lot("a", 20), entryUnits: 20, entryPrice: 40, initialStop: 45 }],
      );
      assert.ok(lotsMismatches(p, log).length > 0);
    });

    it("scaling units and price but not the stop is refused", () => {
      const p = portfolio(
        [position("TCK", 20)],
        [{ ...lot("a", 20), entryUnits: 20, entryPrice: 50, initialStop: 90 }],
      );
      assert.ok(lotsMismatches(p, log).some((m) => m.includes("Entry price 50")));
    });

    it("a stop added to a split lot that had none in the log is refused", () => {
      const noStop = [{ ...entry("a", "TCK"), stop_initial: undefined }];
      const p = portfolio(
        [position("TCK", 20)],
        [{ ...lot("a", 20), entryUnits: 20, entryPrice: 50, initialStop: 45 }],
      );
      assert.ok(lotsMismatches(p, noStop).length > 0);
    });
  });

  it("a lot that agrees with its entry passes, with the entry units known to the cent (no units in the line)", () => {
    // 3.3333333 units at 100.12 are booked as 333.73 (rounded to the cent): 3.33333... units.
    const e = { ...earlierEntry("a", "TCK"), price: 100.12, amount: 333.73 };
    const p = portfolio(
      [position("TCK", 3.3333333)],
      [{ ...lot("a", 3.3333333), entryUnits: 3.3333333, entryPrice: 100.12 }],
    );
    assert.deepEqual(lotsMismatches(p, [e]), []);
  });

  describe("an entry that is open in the log has a lot", () => {
    const exitOf = (entryId: string, left?: number): Decision =>
      buildDecision({
        date: "2026-08-10",
        ticker: tk("TCK"),
        currency: "USD",
        origin: "sistema",
        source: "portfolio-sync",
        type: "exit",
        price: 110,
        amount: 550,
        rules_version: "1.0",
        related_id: entryId,
        entry_price: 100,
        entry_units: 10,
        entry_date: "2026-06-15",
        entry_origin: "sistema",
        entry_rules_version: "1.0",
        ...(left != null ? { lot_units_left: left } : {}),
      });
    const empty = portfolio([], []);

    it("an entry with no exit and no lot is refused, naming the ticker and the entry id", () => {
      const [message] = lotsMismatches(empty, log);
      assert.match(message, /TCK.*entry a.*no lot/);
    });

    it("an entry whose last exit left units in the lot is still open", () => {
      assert.equal(lotsMismatches(empty, [...log, exitOf("a", 5)]).length, 1);
    });

    it("a lot that an exit used up (lot_units_left = 0) is refused: the portfolio write after the exit never happened", () => {
      const p = portfolio([position("TCK", 10)], [lot("a", 10)]);
      const [message] = lotsMismatches(p, [...log, exitOf("a", 0)]);
      assert.match(message, /TCK.*lot a.*used it up.*lot_units_left 0/);
      assert.deepEqual(lotsMismatches(p, [...log, exitOf("a", 5)]), [], "a lot with units left is fine");
    });

    it("an entry whose exit used the lot up (lot_units_left = 0) needs no lot", () => {
      assert.deepEqual(lotsMismatches(empty, [...log, exitOf("a", 5), exitOf("a", 0)]), []);
    });

    it("an entry whose log line carries no units predates the lot contract: out of the check, cited or not", () => {
      assert.deepEqual(lotsMismatches(empty, [earlierEntry("a", "TCK")]), [], "no exit cites it");
      assert.deepEqual(lotsMismatches(empty, [earlierEntry("a", "TCK"), exitOf("a")]), [], "cited without a left");
    });

    it("a v1 position still open: its old entries are out of the check, and a new entry beside them is checked", () => {
      const old = [earlierEntry("old1", "TCK"), earlierEntry("old2", "TCK")];
      assert.deepEqual(lotsMismatches(empty, old), []);
      const [message] = lotsMismatches(empty, [...old, entry("new", "TCK")]);
      assert.match(message, /TCK.*entry new.*no lot/);
    });

    it("only the entries of the silo's currency count", () => {
      assert.deepEqual(lotsMismatches(empty, [entry("e", "SAP.DE", "EUR")]), []);
    });
  });
});

describe("volumeMismatches: Volume against the lots, from portfolio.md alone", () => {
  it("is empty when every Volume is the sum of the Units of its lots, by the lots' own Ticker", () => {
    const p = portfolio([position("TCK", 15), position("OTH", 5)], [lot("a", 10), lot("b", 5), lot("c", 5, "OTH")]);
    assert.deepEqual(volumeMismatches(p), []);
  });

  it("names the ticker whose Volume is not the sum of its lots, without the decision log", () => {
    const [message, ...rest] = volumeMismatches(portfolio([position("TCK", 7)], [lot("a", 5)]));
    assert.equal(rest.length, 0);
    assert.match(message, /TCK.*Volume 7.*5/);
  });

  it("flags lots of a ticker that has no position row", () => {
    const [message] = volumeMismatches(portfolio([], [lot("c", 5, "OTH")]));
    assert.match(message, /OTH.*Volume 0.*5/);
  });
});

describe("assertLotsMatch", () => {
  it("throws one error naming every problem", () => {
    const p = portfolio([position("TCK", 7)], [lot("ghost", 2)]);
    assert.throws(
      () => assertLotsMatch(p, [entry("a", "TCK")]),
      (err: Error) =>
        err.message.includes("TCK") && err.message.includes("ghost") && err.message.includes("portfolio.md"),
    );
  });

  it("does not throw when everything matches", () => {
    assert.doesNotThrow(() => assertLotsMatch(portfolio([], []), []));
  });
});
