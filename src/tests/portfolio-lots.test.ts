/**
 * The pure core of `decision:record`'s lot keeping (ADR-0015, #42): which lots a sale consumes (first
 * in, first out) and what each exit carries, and the edits to the `Lots` and `Positions` tables of
 * portfolio.md. Hand-calculated expectations; the recorder itself is tested in measurable-exits.test.ts
 * and decision-record.test.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  allocateByWeight,
  applyLotChange,
  lotOfEntry,
  planSale,
  type SalePlanInput,
  type PositionChange,
} from "../utils/portfolio-lots.js";
import { parseLots, parsePositions } from "../utils/vault-parser.js";
import { buildDecision } from "../decisions.js";
import type { Lot } from "../types.js";

const lot = (entryId: string, units: number, overrides: Partial<Lot> = {}): Lot => ({
  ticker: "TCK",
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
  ticker: "TCK",
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
      ticker: "TCK",
      currency: "USD",
      origin: "propietario",
      source: "portfolio-sync",
      type: "entry",
      price: 100,
      amount: 1000,
      costs: 2.5,
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
      ticker: "TCK",
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
    const shares = planSale([lot("x", 10, { ticker: "OTH", date: "2026-01-01" }), lot("a", 10)], sale(5), new Map());
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
    assert.throws(() => planSale([lot("x", 10, { ticker: "OTH" })], sale(1), new Map()), /no open lots for TCK/);
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
    const shares = planSale([lot("a", 4)], { ticker: "TCK", units: 4, price: 0.001, amount: 0.004 }, new Map());
    assert.equal(shares[0].amount, 0.004);
  });

  it("the costs of the sale are split the same way and stay absent when there are none", () => {
    const lots = [lot("a", 1), lot("b", 1), lot("c", 1)];
    assert.deepEqual(
      planSale(lots, sale(3, { costs: 1 }), new Map()).map((s) => s.costs),
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
    const shares = planSale([lot("a", 10), lot("b", 10)], sale(15, { pnl: 100 }), new Map());
    assert.deepEqual(
      shares.map((s) => s.pnl),
      [66.67, 33.33],
    );
  });

  it("the entry costs are shared pro rata to the units sold, the remainder on the last exit of the lot", () => {
    // Entry costs 1 over 3 units: 0.33 + 0.33 + 0.34, so the three exits add up exactly to 1.
    const l = lot("a", 3, { entryCosts: 1 });
    const prior = new Map<string, number>();
    let current = l;
    const shares: (number | undefined)[] = [];
    for (let i = 0; i < 3; i++) {
      const [share] = planSale([current], sale(1), prior);
      shares.push(share.entryCosts);
      prior.set("a", (prior.get("a") ?? 0) + (share.entryCosts ?? 0));
      current = { ...current, units: share.unitsLeft };
    }
    assert.deepEqual(shares, [0.33, 0.33, 0.34]);
  });

  it("a lot without entry costs gives exits without entry costs", () => {
    assert.equal(planSale([lot("a", 10)], sale(4), new Map())[0].entryCosts, undefined);
  });
});

describe("applyLotChange: the Lots and Positions tables of portfolio.md", () => {
  const PORTFOLIO = `---
schema_version: 2
last_manual_sync: 2026-10-16T18:00:00Z
---

# Portfolio

## EUR — Cash

| Item | Value |
|---|---|
| Available cash | 1.000,00 € |

## EUR — Positions

| Ticker | Volume | Avg price | Current price | P/L | Stop loss |
|---|---|---|---|---|---|
| SAP.DE | 2 | 180,00 | 186,40 | 12,80 | 168,00 |

## EUR — Lots

| Ticker | Entry id | Date | Units | Entry units | Entry price | Initial stop | Entry costs | Origin | Rules version | Rules violations |
|---|---|---|---|---|---|---|---|---|---|---|
| SAP.DE | sap-1 | 2026-09-15 | 2 | 2 | 180,00 | 168,00 | — | sistema | 1.0 | — |

---

## USD — Cash

| Item | Value |
|---|---|
| Available cash | $900.00 |

## USD — Positions

| Ticker | Volume | Avg price | Current price | P/L | Stop loss |
|---|---|---|---|---|---|
| — | — | — | — | — | — |

## USD — Lots

| Ticker | Entry id | Date | Units | Entry units | Entry price | Initial stop | Entry costs | Origin | Rules version | Rules violations |
|---|---|---|---|---|---|---|---|---|---|---|
`;
  const usdLots = (md: string) => parseLots(md, "USD");
  const usdPositions = (md: string) => parsePositions(md, "USD");
  const change = (overrides: Partial<PositionChange> = {}): PositionChange => ({
    ticker: "TCK",
    volume: 10,
    avgPrice: 100,
    ...overrides,
  });

  it("a first lot creates the ticker's row with the lot's initial stop, and replaces the placeholder rows", () => {
    const md = applyLotChange(PORTFOLIO, "USD", [lot("a", 10)], change({ newStopLoss: 90, currentPrice: 100 }));
    assert.deepEqual(
      usdLots(md).map((l) => [l.ticker, l.entryId, l.units, l.entryUnits, l.entryPrice, l.initialStop]),
      [["TCK", "a", 10, 10, 100, 90]],
    );
    assert.deepEqual(usdPositions(md), [
      { ticker: "TCK", currency: "USD", volume: 10, avgPrice: 100, currentPrice: 100, pl: 0, stopLoss: 90 },
    ]);
    assert.match(md, /\| TCK \| 10 \| 100\.00 \| 100\.00 \| 0\.00 \| 90\.00 \|/, "US notation, two decimals");
  });

  it("a later lot updates Volume and Avg price and leaves the stop, the price and the P/L cells alone", () => {
    let md = applyLotChange(PORTFOLIO, "USD", [lot("a", 10)], change({ newStopLoss: 90, currentPrice: 100 }));
    md = md.replace("| TCK | 10 | 100.00 | 100.00 | 0.00 | 90.00 |", "| TCK | 10 | 100.00 | 120.00 | 200.00 | 95.00 |");
    md = applyLotChange(
      md,
      "USD",
      [lot("a", 10), lot("b", 10, { entryPrice: 110, initialStop: 100 })],
      change({ volume: 20, avgPrice: 105 }),
    );
    const [position] = usdPositions(md);
    assert.equal(position.volume, 20);
    assert.equal(position.avgPrice, 105);
    assert.equal(position.stopLoss, 95, "the stop is the owner's after the first entry");
    assert.equal(position.currentPrice, 120);
    assert.equal(usdLots(md).length, 2);
  });

  it("a position with no initial stop gets — as Stop loss", () => {
    const md = applyLotChange(
      PORTFOLIO,
      "USD",
      [lot("a", 10, { initialStop: null })],
      change({ newStopLoss: null, currentPrice: 100 }),
    );
    assert.equal(usdPositions(md)[0].stopLoss, null);
  });

  it("consuming a lot partly rewrites its Units and keeps the rest of the row", () => {
    const first = lot("a", 10, {
      entryCosts: 2.5,
      rulesViolations: ["no_stop", "overrode_block"],
      origin: "propietario",
    });
    let md = applyLotChange(PORTFOLIO, "USD", [first], change({ newStopLoss: null, currentPrice: 100 }));
    md = applyLotChange(md, "USD", [{ ...first, units: 6 }], change({ volume: 6 }));
    const [l] = usdLots(md);
    assert.deepEqual(
      [l.units, l.entryUnits, l.entryCosts, l.origin, l.rulesViolations],
      [6, 10, 2.5, "propietario", ["no_stop", "overrode_block"]],
    );
    assert.equal(usdPositions(md)[0].volume, 6);
  });

  it("when the last lot goes, its Positions row is deleted and the tables stay readable", () => {
    let md = applyLotChange(PORTFOLIO, "USD", [lot("a", 10)], change({ newStopLoss: 90, currentPrice: 100 }));
    md = applyLotChange(md, "USD", [], { ticker: "TCK", volume: 0 });
    assert.deepEqual(usdLots(md), []);
    assert.deepEqual(usdPositions(md), []);
    assert.match(md, /## USD — Positions\n\n\| Ticker \| Volume/);
  });

  it("touches only the silo it is asked for, and keeps the file's other text", () => {
    const md = applyLotChange(PORTFOLIO, "USD", [lot("a", 10)], change({ newStopLoss: 90, currentPrice: 100 }));
    assert.equal(
      md.slice(0, md.indexOf("## USD — Positions")),
      PORTFOLIO.slice(0, PORTFOLIO.indexOf("## USD — Positions")),
    );
    assert.ok(md.includes("| SAP.DE | sap-1 | 2026-09-15 | 2 | 2 | 180,00 |"));
  });

  it("writes EUR with the decimal comma and fractions of a unit without float noise", () => {
    const md = applyLotChange(
      PORTFOLIO,
      "EUR",
      [
        parseLots(PORTFOLIO, "EUR")[0],
        lot("b", 0.30000000000000004, { ticker: "IBE.MC", entryPrice: 12.5, initialStop: 11.25, entryCosts: 1.5 }),
      ],
      change({ ticker: "IBE.MC", volume: 0.3, avgPrice: 12.5, newStopLoss: 11.25, currentPrice: 12.5 }),
    );
    assert.match(
      md,
      /\| IBE\.MC \| b \| 2026-06-15 \| 0,3 \| 0,3 \| 12,50 \| 11,25 \| 1,50 \| sistema \| 1\.0 \| — \|/,
    );
    assert.match(md, /\| IBE\.MC \| 0,3 \| 12,50 \| 12,50 \| 0,00 \| 11,25 \|/);
  });

  it("keeps the precision of a low price: 0.0234 is not written as 0.02", () => {
    const md = applyLotChange(
      PORTFOLIO,
      "USD",
      [lot("a", 1000, { entryPrice: 0.0234, initialStop: 0.0201 })],
      change({ volume: 1000, avgPrice: 0.0234, newStopLoss: 0.0201, currentPrice: 0.0234 }),
    );
    const [l] = usdLots(md);
    assert.equal(l.entryPrice, 0.0234);
    assert.equal(l.initialStop, 0.0201);
    assert.equal(usdPositions(md)[0].avgPrice, 0.0234);
  });

  it("reads the columns by name: a table in another column order is written in that order", () => {
    const swapped = PORTFOLIO.replace("| Ticker | Entry id | Date | Units |", "| Entry id | Ticker | Date | Units |");
    const md = applyLotChange(swapped, "USD", [lot("a", 10)], change({ newStopLoss: 90, currentPrice: 100 }));
    assert.equal(usdLots(md)[0].ticker, "TCK");
    assert.equal(usdLots(md)[0].entryId, "a");
  });

  it("refuses a Lots table with a row that does not read: it is never rewritten around the row", () => {
    const withBadRow = PORTFOLIO.replace(
      "| SAP.DE | sap-1 |",
      "| SAP.DE | sap-0 | 2026-09-01 | TBD | 5 | 1 | — | — | sistema | 1.0 | — |\n| SAP.DE | sap-1 |",
    );
    assert.throws(
      () => applyLotChange(withBadRow, "EUR", [], { ticker: "SAP.DE", volume: 2, avgPrice: 180 }),
      /portfolio\.md \(EUR\): Lots row 1 \(SAP\.DE, sap-0\): Units "TBD" is not a number.*nothing was recorded/,
    );
  });

  it("refuses a ticker on several Positions rows: which one to update is the owner's to say", () => {
    const twice = PORTFOLIO.replace(
      "| SAP.DE | 2 | 180,00 | 186,40 | 12,80 | 168,00 |",
      "| SAP.DE | 1 | 180,00 | 186,40 | 6,40 | 168,00 |\n| SAP.DE | 1 | 180,00 | 186,40 | 6,40 | 168,00 |",
    );
    assert.throws(
      () => applyLotChange(twice, "EUR", parseLots(twice, "EUR"), { ticker: "SAP.DE", volume: 2, avgPrice: 180 }),
      /SAP\.DE is on 2 rows of "## EUR — Positions".*nothing was recorded/,
    );
  });

  describe("a Lots table split by blank lines or notes is one table", () => {
    const rowOf = (id: string, date: string) =>
      `| TCK | ${id} | ${date} | 10 | 10 | 100,00 | — | — | sistema | 1.0 | — |`;
    const split = (rows: string[]) =>
      PORTFOLIO.replace(/(## USD — Lots\n\n\|[^\n]*\n\|[^\n]*\n)/, (head) => `${head}${rows.join("\n")}\n`).replace(
        "USD — Cash",
        "USD — Cash",
      );
    const lotIds = (md: string) => parseLots(md, "USD").map((l) => l.entryId);

    it("a blank line between the separator and the first lot: the next entry is added once, the table is contiguous", () => {
      const md = split(["", rowOf("a", "2026-06-01"), rowOf("b", "2026-06-02")]);
      assert.deepEqual(lotIds(md), ["a", "b"], "the reader sees one table");
      const out = applyLotChange(md, "USD", [...parseLots(md, "USD"), lot("c", 10)], change({ currentPrice: 100 }));
      assert.deepEqual(lotIds(out), ["a", "b", "c"]);
      assert.equal(out.match(/^\| TCK \| [abc] \|/gm)?.length, 3, "no lot is written twice");
      assert.match(out, /\|---\|\n\| TCK \| a \|[^\n]*\n\| TCK \| b \|[^\n]*\n\| TCK \| c \|/, "one block");
    });

    it("a blank line between two lots: the same", () => {
      const md = split([rowOf("a", "2026-06-01"), "", rowOf("b", "2026-06-02")]);
      assert.deepEqual(lotIds(md), ["a", "b"]);
      const out = applyLotChange(md, "USD", [...parseLots(md, "USD"), lot("c", 10)], change({ currentPrice: 100 }));
      assert.deepEqual(lotIds(out), ["a", "b", "c"]);
      assert.equal(out.match(/^\| TCK \| [abc] \|/gm)?.length, 3, "no lot is written twice");
      assert.match(out, /\|---\|\n\| TCK \| a \|[^\n]*\n\| TCK \| b \|[^\n]*\n\| TCK \| c \|/, "one block");
    });

    it("a note between two lots stays, under the table", () => {
      const md = split([rowOf("a", "2026-06-01"), "Checked with the broker.", rowOf("b", "2026-06-02")]);
      const out = applyLotChange(md, "USD", parseLots(md, "USD"), change({ currentPrice: 100 }));
      assert.deepEqual(lotIds(out), ["a", "b"]);
      assert.match(out, /\| TCK \| b \|[^\n]*\nChecked with the broker\.\n/);
    });
  });

  it("works with CRLF line ends, as the rest of the vault reads them", () => {
    const md = applyLotChange(PORTFOLIO.replace(/\n/g, "\r\n"), "USD", [lot("a", 10)], change({ newStopLoss: 90 }));
    assert.equal(usdLots(md).length, 1);
    assert.ok(!/[^\r]\n/.test(md), "every line end of the file is still CRLF");
  });
});

describe("planSale: exact units are never snapped (N1 of PR #56)", () => {
  it("a lot of 10 at 0.001 sold 6 units keeps its 4 units when the owner gave the units", () => {
    const shares = planSale([lot("a", 10)], { ticker: "TCK", units: 6, price: 0.001, amount: 0.01 }, new Map());
    assert.deepEqual(
      shares.map((s) => [s.unitsSold, s.unitsLeft]),
      [[6, 4]],
    );
  });

  it("derived from an amount, the same remainder is dust and the lot is used up", () => {
    const shares = planSale(
      [lot("a", 10)],
      { ticker: "TCK", units: 6, price: 0.001, amount: 0.01, unitsFromAmount: true },
      new Map(),
    );
    assert.deepEqual(
      shares.map((s) => [s.unitsSold, s.unitsLeft]),
      [[10, 0]],
    );
  });

  it("exact units above the open units are refused even by less than half a cent of price", () => {
    assert.throws(
      () => planSale([lot("a", 10)], { ticker: "TCK", units: 10.001, price: 1, amount: 10 }, new Map()),
      /Cannot sell 10\.001/,
    );
  });
});

describe("allocateByWeight: shares in whole units of the last decimal, never negative, adding up exactly", () => {
  it("shares 0.02 of costs over lots of 30/30/30/10 as 0, 0.01, 0.01, 0 (BLOCKING of the 4th review of PR #56)", () => {
    assert.deepEqual(allocateByWeight(0.02, [30, 30, 30, 10], 2), [0, 0.01, 0.01, 0]);
  });

  it("gives the leftover cents to the largest remainders, the later one on a tie", () => {
    assert.deepEqual(allocateByWeight(1, [1, 1, 1], 2), [0.33, 0.33, 0.34]);
    assert.deepEqual(allocateByWeight(100, [10, 5], 2), [66.67, 33.33]);
  });

  it("a negative total gives shares that are all <= 0 and add up to it", () => {
    assert.deepEqual(allocateByWeight(-100, [10, 5], 2), [-66.67, -33.33]);
    assert.deepEqual(allocateByWeight(-0.02, [30, 30, 30, 10], 2), [0, -0.01, -0.01, 0]);
  });

  it("every share is a whole number of units of the last decimal and they add up to the total, for any split", () => {
    for (const total of [0.01, 0.02, 0.07, 1, 3.33, 1000.01]) {
      for (const weights of [
        [30, 30, 30, 10],
        [1, 1, 1, 1, 1, 1, 1],
        [0.1, 0.2, 0.3],
        [5, 1e-6, 5],
      ]) {
        const shares = allocateByWeight(total, weights, 2);
        assert.ok(
          shares.every((x) => x >= 0 && Math.abs(x * 100 - Math.round(x * 100)) < 1e-9),
          `${total} ${JSON.stringify(weights)}`,
        );
        assert.equal(
          Math.round(shares.reduce((a, b) => a + b, 0) * 100),
          Math.round(total * 100),
          `${total} ${JSON.stringify(weights)}`,
        );
      }
    }
  });

  it("works at 8 decimals, as the amount of an exit is shared", () => {
    const shares = allocateByWeight(0.00000003, [1, 1, 1, 1], 8);
    assert.deepEqual(shares, [0, 1e-8, 1e-8, 1e-8]);
  });
});

describe("planSale: the costs of a sale never go negative (BLOCKING of the 4th review of PR #56)", () => {
  it("a sale of 100 units over lots of 30/30/30/10 with costs 0.02 gives non-negative shares adding up to 0.02", () => {
    const lots = [lot("a", 30), lot("b", 30), lot("c", 30), lot("d", 10)];
    const costs = planSale(lots, sale(100, { costs: 0.02 }), new Map()).map((s) => s.costs);
    assert.deepEqual(costs, [0, 0.01, 0.01, 0]);
  });

  it("an owner-given pnl is split by the same helper: whole cents, adding up to the sale's", () => {
    const lots = [lot("a", 30), lot("b", 30), lot("c", 30), lot("d", 10)];
    const pnl = planSale(lots, sale(100, { pnl: 0.02 }), new Map()).map((s) => s.pnl);
    assert.deepEqual(pnl, [0, 0.01, 0.01, 0]);
  });
});

describe("planSale: a lot's entry costs shared across several partial sales", () => {
  const sellInParts = (entryCosts: number, entryUnits: number, parts: number[]): number[] => {
    let current = lot("a", entryUnits, { entryCosts });
    const prior = new Map<string, number>();
    const shares: number[] = [];
    for (const units of parts) {
      const [share] = planSale([current], sale(units), prior);
      shares.push(share.entryCosts!);
      prior.set("a", (prior.get("a") ?? 0) + share.entryCosts!);
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
      const shares = sellInParts(costs, units, parts);
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

describe("applyLotChange: a section with no table gets one and keeps the blank line before the next heading", () => {
  it("renders the table, a blank line, then the next heading", () => {
    const md = [
      "# P",
      "",
      "## USD — Cash",
      "",
      "| Item | Value |",
      "|---|---|",
      "| Available cash | $1.00 |",
      "",
      "## USD — Positions",
      "",
      "## USD — Lots",
      "",
      "## EUR — Cash",
      "",
    ].join("\n");
    const out = applyLotChange(md, "USD", [lot("a", 10)], { ticker: "TCK", volume: 10, avgPrice: 100 });
    assert.match(
      out,
      /## USD — Positions\n\n\| Ticker \|[^\n]*\n\|[^\n]*\n\| TCK \|[^\n]*\n\n## USD — Lots\n\n\| Ticker \| Entry id[^\n]*\n[^\n]*\n\| TCK \| a \|[^\n]*\n\n## EUR — Cash/,
    );
  });

  it("keeps a note of the section after the table, with a blank line between", () => {
    const md = [
      "# P",
      "",
      "## USD — Cash",
      "",
      "| Item | Value |",
      "|---|---|",
      "| Available cash | $1.00 |",
      "",
      "## USD — Positions",
      "",
      "Nothing yet.",
      "",
      "## USD — Lots",
      "",
      "",
    ].join("\n");
    const out = applyLotChange(md, "USD", [lot("a", 10)], { ticker: "TCK", volume: 10, avgPrice: 100 });
    assert.match(out, /\| TCK \| 10[^\n]*\n\nNothing yet\.\n\n## USD — Lots/);
  });
});
