/**
 * The writer of portfolio.md (ADR-0015): the edits to its `Lots` and `Positions` tables and the refreshed
 * prices. Pure text in, text out; hand-calculated expectations. The recorder itself is tested in
 * measurable-exits.test.ts and decision-record.test.ts, the store that uses it in portfolio-store.test.ts.
 */
import { money } from "../money.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyLotChange, applyPrices, type PositionChange } from "../utils/portfolio-writer.js";
import { parseLots, parsePositions } from "../utils/vault-parser.js";
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
    ticker: tk("TCK"),
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
      entryCosts: money(2.5, "USD"),
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
    md = applyLotChange(md, "USD", [], { ticker: tk("TCK"), volume: 0 });
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
        lot("b", 0.30000000000000004, {
          ticker: tk("IBE.MC"),
          entryPrice: 12.5,
          initialStop: 11.25,
          entryCosts: money(1.5, "EUR"),
        }),
      ],
      change({ ticker: tk("IBE.MC"), volume: 0.3, avgPrice: 12.5, newStopLoss: 11.25, currentPrice: 12.5 }),
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
      () => applyLotChange(withBadRow, "EUR", [], { ticker: tk("SAP.DE"), volume: 2, avgPrice: 180 }),
      /portfolio\.md \(EUR\): Lots row 1 \(SAP\.DE, sap-0\): Units "TBD" is not a number.*nothing was recorded/,
    );
  });

  it("a ticker on several Positions rows is an internal error: the lots check refuses it first", () => {
    const twice = PORTFOLIO.replace(
      "| SAP.DE | 2 | 180,00 | 186,40 | 12,80 | 168,00 |",
      "| SAP.DE | 1 | 180,00 | 186,40 | 6,40 | 168,00 |\n| SAP.DE | 1 | 180,00 | 186,40 | 6,40 | 168,00 |",
    );
    assert.throws(
      () => applyLotChange(twice, "EUR", parseLots(twice, "EUR"), { ticker: tk("SAP.DE"), volume: 2, avgPrice: 180 }),
      /portfolio\.md \(EUR\): internal error: SAP\.DE is on 2 rows of Positions.*nothing was recorded/,
    );
  });

  describe("a Lots table split by blank lines or notes is one table", () => {
    const rowOf = (id: string, date: string) =>
      `| TCK | ${id} | ${date} | 10 | 10 | 100,00 | — | — | sistema | 1.0 | — |`;
    const split = (rows: string[]) =>
      PORTFOLIO.replace(/(## USD — Lots\n\n\|[^\n]*\n\|[^\n]*\n)/, (head) => `${head}${rows.join("\n")}\n`);
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
    const out = applyLotChange(md, "USD", [lot("a", 10)], { ticker: tk("TCK"), volume: 10, avgPrice: 100 });
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
    const out = applyLotChange(md, "USD", [lot("a", 10)], { ticker: tk("TCK"), volume: 10, avgPrice: 100 });
    assert.match(out, /\| TCK \| 10[^\n]*\n\nNothing yet\.\n\n## USD — Lots/);
  });
});

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
