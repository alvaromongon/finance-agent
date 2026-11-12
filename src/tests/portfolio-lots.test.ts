/**
 * The pure core of `decision:record`'s lot keeping (ADR-0015, #42): which lots a sale consumes (first
 * in, first out) and what each exit carries, and the edits to the `Lots` and `Positions` tables of
 * portfolio.md. Hand-calculated expectations; the recorder itself is tested in measurable-exits.test.ts
 * and decision-record.test.ts.
 */
import { addCounted, money, zero, type Money } from "../money.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lotOfEntry, planSale, type SalePlanInput, SaleRefusal } from "../utils/portfolio-lots.js";
import { buildDecision } from "../decisions.js";
import type { Lot } from "../types.js";
import { parseTicker as tk } from "../ticker.js";

const lot = (entryId: string, units: number, overrides: Partial<Lot> = {}): Lot => ({
  ticker: tk("TCK"),
  entryId,
  date: "2026-06-15",
  units,
  entryUnits: units,
  entryPrice: 100,
  initialStop: 90,
  entryCosts: null,
  origin: "sistema",
  rulesVersion: "1.0",
  rulesViolations: [],
  ...overrides,
});

const sale = (units: number, overrides: Partial<SalePlanInput> = {}): SalePlanInput => ({
  ticker: tk("TCK"),
  currency: "USD",
  units,
  price: 130,
  amount: Math.round(units * 130 * 100) / 100,
  ...overrides,
});

describe("lotOfEntry", () => {
  it("builds the lot of an entry: Units = Entry units, the entry's own snapshot", () => {
    const entry = buildDecision({
      id: "e1",
      date: "2026-06-15",
      ticker: tk("TCK"),
      currency: "USD",
      origin: "propietario",
      source: "portfolio-sync",
      type: "entry",
      price: 100,
      amount: 1000,
      costs: money(2.5, "USD"),
      stop_initial: 90,
      rule_violations: ["no_stop", "overrode_block"],
      rules_version: "1.1",
    });
    assert.deepEqual(lotOfEntry(entry, 10), {
      ticker: "TCK",
      entryId: "e1",
      date: "2026-06-15",
      units: 10,
      entryUnits: 10,
      entryPrice: 100,
      initialStop: 90,
      entryCosts: 2.5,
      origin: "propietario",
      rulesVersion: "1.1",
      rulesViolations: ["no_stop", "overrode_block"],
    });
  });

  it("an entry without stop, costs or violations has no stop, no costs and no violations", () => {
    const entry = buildDecision({
      id: "e2",
      date: "2026-06-15",
      ticker: tk("TCK"),
      currency: "USD",
      origin: "sistema",
      source: "portfolio-sync",
      type: "entry",
      price: 100,
      amount: 100,
      rules_version: "1.0",
    });
    const l = lotOfEntry(entry, 1);
    assert.equal(l.initialStop, null);
    assert.equal(l.entryCosts, null);
    assert.deepEqual(l.rulesViolations, []);
  });
});

describe("planSale: first in, first out", () => {
  it("a sale inside the first lot shrinks only that lot", () => {
    const shares = planSale([lot("a", 10), lot("b", 10)], sale(4), new Map());
    assert.deepEqual(
      shares.map((s) => [s.lot.entryId, s.unitsSold, s.unitsLeft]),
      [["a", 4, 6]],
    );
  });

  it("a sale across two lots consumes the first and part of the second, in order", () => {
    const shares = planSale([lot("a", 10), lot("b", 10)], sale(15), new Map());
    assert.deepEqual(
      shares.map((s) => [s.lot.entryId, s.unitsSold, s.unitsLeft]),
      [
        ["a", 10, 0],
        ["b", 5, 5],
      ],
    );
  });

  it("the oldest entry date goes first, whatever the order of the table; ties keep the table's order", () => {
    const lots = [
      lot("late", 5, { date: "2026-07-01" }),
      lot("tie-1", 5, { date: "2026-06-15" }),
      lot("early", 5, { date: "2026-06-01" }),
      lot("tie-2", 5, { date: "2026-06-15" }),
    ];
    const shares = planSale(lots, sale(20), new Map());
    assert.deepEqual(
      shares.map((s) => s.lot.entryId),
      ["early", "tie-1", "tie-2", "late"],
    );
  });

  it("only the lots of the sold ticker are consumed", () => {
    const shares = planSale(
      [lot("x", 10, { ticker: tk("OTH"), date: "2026-01-01" }), lot("a", 10)],
      sale(5),
      new Map(),
    );
    assert.deepEqual(
      shares.map((s) => s.lot.entryId),
      ["a"],
    );
  });

  it("selling every unit leaves the last lot at exactly 0, also with float noise", () => {
    const shares = planSale([lot("a", 0.1), lot("b", 0.2)], sale(0.30000000000000004), new Map());
    assert.deepEqual(
      shares.map((s) => s.unitsLeft),
      [0, 0],
    );
  });

  it("a sale with no lots for the ticker is an error naming the ticker", () => {
    assert.throws(() => planSale([lot("x", 10, { ticker: tk("OTH") })], sale(1), new Map()), /no open lots for TCK/);
    assert.throws(() => planSale([], sale(1), new Map()), /no open lots for TCK/);
  });

  it("a sale narrated by amount alone, whose units are known to half a cent of price, can use the lot up", () => {
    // 1.333 units at 100.50 are 133.9665, booked as 133.97: 1.333034 units, a hair more than the lot.
    const amount = 133.97;
    const shares = planSale(
      [lot("a", 1.333)],
      sale(amount / 100.5, { price: 100.5, amount, unitsFromAmount: true }),
      new Map(),
    );
    assert.deepEqual(
      shares.map((s) => [s.unitsSold, s.unitsLeft]),
      [[1.333, 0]],
    );
    // A cent more than that is a sale of more than the lot.
    assert.throws(() => planSale([lot("a", 1.333)], sale(1.3331, { price: 100.5 }), new Map()), /1\.3331.*TCK.*1\.333/);
  });

  it("a sale narrated by amount alone that leaves less than half a cent of price uses the lot up too", () => {
    // 7 units at 12.345 are 86.415; booked as 86.41 the units are 6.999595, 0.000405 short of the lot.
    const shares = planSale(
      [lot("a", 7)],
      sale(86.41 / 12.345, { price: 12.345, amount: 86.41, unitsFromAmount: true }),
      new Map(),
    );
    assert.deepEqual(
      shares.map((s) => [s.unitsSold, s.unitsLeft]),
      [[7, 0]],
    );
  });

  it("a sale that leaves more than half a cent of price in the lot leaves it open", () => {
    const shares = planSale([lot("a", 7)], sale(86.4 / 12.345, { price: 12.345, amount: 86.4 }), new Map());
    assert.equal(shares[0].unitsLeft > 0, true);
  });

  it("a sale of more units than the ticker's open units is an error naming both", () => {
    assert.throws(() => planSale([lot("a", 10), lot("b", 10)], sale(21), new Map()), /21.*TCK.*20/);
  });
});

describe("planSale: an amount too large to count in cents, or entry units of 0, is refused with a message (#87)", () => {
  it("a lot whose entry price makes the result too large to count in cents is refused, naming the lot", () => {
    assert.throws(
      () => planSale([lot("big-1", 10, { entryPrice: 1e307 })], sale(4), new Map()),
      (err: Error) => {
        assert.equal(err.constructor, Error);
        assert.match(err.message, /lot big-1 \(TCK\).*Entry price.*too large to count in cents/);
        return true;
      },
    );
  });

  it("a sale over several lots whose results are too large together is refused with a message, even with pnl 0", () => {
    const lots = [lot("big-a", 1, { entryPrice: 1.5e306 }), lot("big-b", 1, { entryPrice: 1.5e306 })];
    assert.throws(
      () => planSale(lots, sale(2, { price: 10, pnl: money(0, "EUR") }), new Map()),
      (err: Error) => {
        assert.equal(err.constructor, Error);
        assert.match(err.message, /TCK.*too large to count in cents/);
        return true;
      },
    );
  });

  it("a partial sale of a lot whose Entry units are 0 is refused, naming the lot and its entry units", () => {
    assert.throws(
      () => planSale([lot("zero-1", 10, { entryUnits: 0, entryCosts: money(5, "EUR") })], sale(4), new Map()),
      (err: Error) => {
        assert.ok(err instanceof SaleRefusal, "a domain refusal, not a bug");
        assert.match(err.message, /lot zero-1 \(TCK\).*Entry units.* 0/);
        return true;
      },
    );
  });

  it("names a lot's entry id escaped in a refusal, as any owner-supplied text (S4)", () => {
    assert.throws(
      () => planSale([lot("x\u001b[31m", 10, { entryUnits: 0, entryCosts: money(5, "EUR") })], sale(4), new Map()),
      (err: Error) => {
        // eslint-disable-next-line no-control-regex
        assert.doesNotMatch(err.message, /[\u0000-\u001f]/);
        assert.match(err.message, /lot x\\u001b\[31m \(TCK\)/);
        return true;
      },
    );
  });

  it("names the file of the lots one way, whichever refusal, unless the caller says where they come from", () => {
    const refusal = (fn: () => unknown): SaleRefusal => {
      try {
        fn();
      } catch (err) {
        if (err instanceof SaleRefusal) return err;
      }
      throw new Error("expected a SaleRefusal");
    };
    const none = refusal(() => planSale([], sale(1), new Map()));
    const tooMany = refusal(() => planSale([lot("a", 2)], sale(3), new Map()));
    assert.match(none.message, /no open lots for TCK in portfolio\.md$/);
    assert.match(tooMany.message, /only 2 are open in portfolio\.md$/);
    assert.match(none.named("command 1 of this batch"), /in command 1 of this batch$/);
    assert.match(tooMany.named("command 1 of this batch"), /open in command 1 of this batch$/);
  });

  it("a lot whose Entry units are 0 and is used up, or has no entry costs, is sold as before", () => {
    assert.equal(
      planSale([lot("zero-2", 10, { entryUnits: 0, entryCosts: money(5, "EUR") })], sale(10), new Map())[0].entryCosts,
      5,
    );
    assert.equal(planSale([lot("zero-3", 10, { entryUnits: 0 })], sale(4), new Map())[0].entryCosts, undefined);
  });
});

describe("planSale: what each exit carries", () => {
  it("the amounts of the exits are exact shares by units and add up to the sale amount, the remainder on the last", () => {
    // 3 lots of 1 unit; 1000.01 over 3 equal shares: not rounded to the cent.
    const lots = [lot("a", 1), lot("b", 1), lot("c", 1)];
    const shares = planSale(lots, sale(3, { amount: 1000.01 }), new Map());
    assert.ok(Math.abs(shares[0].amount - 1000.01 / 3) < 1e-7);
    assert.ok(Math.abs(shares[0].amount - shares[1].amount) <= 1e-8 + 1e-12, "equal to the 8th decimal");
    assert.ok(Math.abs(shares.reduce((sum, s) => sum + s.amount, 0) - 1000.01) < 1e-9);
  });

  it("an exit's amount is its exact share, not rounded to the cent: a lot of 0.0001 units keeps a positive amount", () => {
    // 0.0001 and 1 unit at 27.98: the sale amount is 27.980 + 0.003 (rounded to the cent it is 0.00 and 27.98).
    const shares = planSale([lot("a", 0.0001), lot("b", 1)], sale(1.0001, { price: 27.98, amount: 27.98 }), new Map());
    assert.ok(shares[0].amount > 0, `first share ${shares[0].amount}`);
    assert.ok(Math.abs(shares[0].amount - (27.98 * 0.0001) / 1.0001) < 1e-9);
    assert.ok(Math.abs(shares[0].amount + shares[1].amount - 27.98) < 1e-12, "the shares add up to the sale amount");
  });

  it("an exit's amount keeps its sub-cent value when the units are tiny and the price low", () => {
    const shares = planSale(
      [lot("a", 4)],
      { ticker: tk("TCK"), currency: "USD", units: 4, price: 0.001, amount: 0.004 },
      new Map(),
    );
    assert.equal(shares[0].amount, 0.004);
  });

  it("the costs of the sale are split the same way and stay absent when there are none", () => {
    const lots = [lot("a", 1), lot("b", 1), lot("c", 1)];
    assert.deepEqual(
      planSale(lots, sale(3, { costs: money(1, "EUR") }), new Map()).map((s) => s.costs),
      [0.33, 0.33, 0.34],
    );
    assert.deepEqual(
      planSale(lots, sale(3), new Map()).map((s) => s.costs),
      [undefined, undefined, undefined],
    );
  });

  it("pnl comes from the lot's own entry price", () => {
    // Sell 15 at 130: 10 of a (entry 100) and 5 of b (entry 110): 300 and 100.
    const shares = planSale([lot("a", 10), lot("b", 10, { entryPrice: 110 })], sale(15), new Map());
    assert.deepEqual(
      shares.map((s) => s.pnl),
      [300, 100],
    );
  });

  it("a pnl the owner gives for the whole sale is split by units, the remainder on the last", () => {
    const shares = planSale([lot("a", 10), lot("b", 10)], sale(15, { pnl: money(100, "EUR") }), new Map());
    assert.deepEqual(
      shares.map((s) => s.pnl),
      [66.67, 33.33],
    );
  });

  describe("an owner-given pnl keeps each lot's entry costs with the lot (#90)", () => {
    // A: 5 units at 100 with entry costs of 20; B: 5 units at 130 with none; both sold at 120.
    const lots = [
      lot("a", 5, { entryPrice: 100, entryCosts: money(20, "EUR") }),
      lot("b", 5, { entryPrice: 130, date: "2026-06-22" }),
    ];
    const pnls = (given?: number, over: Partial<SalePlanInput> = {}) =>
      planSale(
        lots,
        sale(10, { price: 120, ...(given === undefined ? {} : { pnl: money(given, "EUR") }), ...over }),
        new Map(),
      ).map((s) => s.pnl);

    it("+30 given: each exit is its result minus its own entry costs: +80 and -50 (not +90 and -60)", () =>
      assert.deepEqual(pnls(30), [80, -50]));
    it("what remains of the difference (exit costs, FX) is shared by units on top: +25 given", () =>
      assert.deepEqual(pnls(25), [77.5, -52.5]));
    it("with no pnl given, nothing changes: the computed results, before entry costs", () =>
      assert.deepEqual(pnls(), [100, -50]));
    it("the entry costs already taken by earlier exits are not taken twice", () => {
      const taken = new Map([["a", money(15, "EUR")]]);
      const shares = planSale(lots, sale(10, { price: 120, pnl: money(35, "EUR") }), taken);
      // The sale uses lot a up: it takes the 5 that are left of its 20.
      // Net of what is left of its entry costs: 100 - 5 = 95 and -50; the owner's 35 is 10 less than 45: -5 each.
      assert.deepEqual(
        shares.map((s) => s.pnl),
        [90, -55],
      );
    });
    it("a sale without entry costs gives the same exits as before", () => {
      const plain = [lot("a", 5), lot("b", 5, { entryPrice: 130, date: "2026-06-22" })];
      assert.deepEqual(
        planSale(plain, sale(10, { price: 120, pnl: money(48, "EUR") }), new Map()).map((s) => s.pnl),
        [99, -51],
      );
    });
    it("the exits add up to the owner's total in whole cents, and a lot's sign can still flip with costs or FX", () => {
      // +0.40 and +100 computed (units 1 and 1), owner gives +90: entry costs of 5 on the first lot.
      const flip = [
        lot("a", 1, { entryPrice: 99.6, entryCosts: money(5, "EUR") }),
        lot("b", 1, { entryPrice: 0, date: "2026-06-22" }),
      ];
      const shares = planSale(flip, sale(2, { price: 100, pnl: money(90, "EUR") }), new Map());
      assert.equal(
        shares.reduce((sum, s) => sum + s.pnl, 0),
        90,
      );
      assert.deepEqual(
        shares.map((s) => s.pnl),
        [-7.3, 97.3],
      );
    });
  });

  describe("an owner-given pnl keeps each lot's own result and shares only the difference (#71)", () => {
    // Two lots of 5 units sold together at 120.
    const gain = [lot("a", 5, { entryPrice: 100 }), lot("b", 5, { entryPrice: 130, date: "2026-06-22" })];
    const loss = [lot("a", 5, { entryPrice: 110 }), lot("b", 5, { entryPrice: 150, date: "2026-06-22" })];
    const pnls = (lots: Lot[], pnl?: number) =>
      planSale(lots, sale(10, { price: 120, ...(pnl === undefined ? {} : { pnl: money(pnl, "EUR") }) }), new Map()).map(
        (s) => s.pnl,
      );

    it("net gain, computed: +100 and -50", () => assert.deepEqual(pnls(gain), [100, -50]));
    it("net gain, +50 given: the same, the losing lot stays a loss", () =>
      assert.deepEqual(pnls(gain, 50), [100, -50]));
    it("net loss, computed: +50 and -150", () => assert.deepEqual(pnls(loss), [50, -150]));
    it("net loss, -100 given: the same, the winning lot stays a gain", () =>
      assert.deepEqual(pnls(loss, -100), [50, -150]));

    it("a total that differs by costs (+48 against +50): each lot keeps its sign and they add up to +48", () => {
      // Difference -2 shared 5/5: -1 each.
      assert.deepEqual(pnls(gain, 48), [99, -51]);
    });

    it("the difference is shared by units in whole cents, adding up to the owner's total", () => {
      // Lots of 1 and 2 units (entry 100): computed 20 and 40 at 120; +61 given: difference +1 -> 0.33/0.67.
      const lots = [lot("a", 1), lot("b", 2, { date: "2026-06-22" })];
      assert.deepEqual(
        planSale(lots, sale(3, { price: 120, pnl: money(61, "EUR") }), new Map()).map((s) => s.pnl),
        [20.33, 40.67],
      );
    });
  });

  it("the entry costs are shared pro rata to the units sold, the remainder on the last exit of the lot", () => {
    // Entry costs 1 over 3 units: 0.33 + 0.33 + 0.34, so the three exits add up exactly to 1.
    const l = lot("a", 3, { entryCosts: money(1, "EUR") });
    const prior = new Map<string, Money>();
    let current = l;
    const shares: (number | undefined)[] = [];
    for (let i = 0; i < 3; i++) {
      const [share] = planSale([current], sale(1), prior);
      shares.push(share.entryCosts);
      prior.set("a", addCounted(prior.get("a") ?? zero("USD"), share.entryCosts ?? zero("USD"), "x"));
      current = { ...current, units: share.unitsLeft };
    }
    assert.deepEqual(shares, [0.33, 0.33, 0.34]);
  });

  it("a lot without entry costs gives exits without entry costs", () => {
    assert.equal(planSale([lot("a", 10)], sale(4), new Map())[0].entryCosts, undefined);
  });
});

describe("planSale: exact units are never snapped (N1 of PR #56)", () => {
  it("a lot of 10 at 0.001 sold 6 units keeps its 4 units when the owner gave the units", () => {
    const shares = planSale(
      [lot("a", 10)],
      { ticker: tk("TCK"), currency: "USD", units: 6, price: 0.001, amount: 0.01 },
      new Map(),
    );
    assert.deepEqual(
      shares.map((s) => [s.unitsSold, s.unitsLeft]),
      [[6, 4]],
    );
  });

  it("derived from an amount, the same remainder is dust and the lot is used up", () => {
    const shares = planSale(
      [lot("a", 10)],
      { ticker: tk("TCK"), currency: "USD", units: 6, price: 0.001, amount: 0.01, unitsFromAmount: true },
      new Map(),
    );
    assert.deepEqual(
      shares.map((s) => [s.unitsSold, s.unitsLeft]),
      [[10, 0]],
    );
  });

  it("exact units above the open units are refused even by less than half a cent of price", () => {
    assert.throws(
      () =>
        planSale(
          [lot("a", 10)],
          { ticker: tk("TCK"), currency: "USD", units: 10.001, price: 1, amount: 10 },
          new Map(),
        ),
      /Cannot sell 10\.001/,
    );
  });
});

describe("planSale: the costs of a sale never go negative (BLOCKING of the 4th review of PR #56)", () => {
  it("a sale of 100 units over lots of 30/30/30/10 with costs 0.02 gives non-negative shares adding up to 0.02", () => {
    const lots = [lot("a", 30), lot("b", 30), lot("c", 30), lot("d", 10)];
    const costs = planSale(lots, sale(100, { costs: money(0.02, "EUR") }), new Map()).map((s) => s.costs);
    assert.deepEqual(costs, [0, 0.01, 0.01, 0]);
  });

  it("the difference to an owner-given pnl is split by the same helper: whole cents, adding up to the sale's", () => {
    // Sold at the entry price (computed 0 each), so the whole 0.02 is the difference.
    const lots = [lot("a", 30), lot("b", 30), lot("c", 30), lot("d", 10)];
    const pnl = planSale(lots, sale(100, { price: 100, pnl: money(0.02, "EUR") }), new Map()).map((s) => s.pnl);
    assert.deepEqual(pnl, [0, 0.01, 0.01, 0]);
  });
});

describe("planSale: a lot's entry costs shared across several partial sales", () => {
  const sellInParts = (entryCosts: Money, entryUnits: number, parts: number[]): number[] => {
    let current = lot("a", entryUnits, { entryCosts });
    const prior = new Map<string, Money>();
    const shares: number[] = [];
    for (const units of parts) {
      const [share] = planSale([current], sale(units), prior);
      shares.push(share.entryCosts!);
      prior.set("a", addCounted(prior.get("a") ?? zero("USD"), share.entryCosts!, "x"));
      current = { ...current, units: share.unitsLeft };
    }
    return shares;
  };

  it("never yields a negative share and adds up exactly to Entry costs", () => {
    const cases: [number, number, number[]][] = [
      [0.02, 100, [30, 30, 30, 10]],
      [0.01, 3, [1, 1, 1]],
      [1, 7, [1, 1, 1, 1, 1, 1, 1]],
      [12.34, 10, [3, 3, 3, 1]],
      [0.05, 9, [2, 2, 2, 2, 1]],
    ];
    for (const [costs, units, parts] of cases) {
      const shares = sellInParts(money(costs, "EUR"), units, parts);
      assert.ok(
        shares.every((x) => x >= 0),
        `${costs} ${JSON.stringify(parts)}: ${JSON.stringify(shares)}`,
      );
      assert.equal(
        Math.round(shares.reduce((a, b) => a + b, 0) * 100),
        Math.round(costs * 100),
        `${costs} ${JSON.stringify(parts)}`,
      );
    }
  });
});
