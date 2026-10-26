/**
 * Tests of `decision:record`: what the owner narrates reaches the
 * decision log with origin, related proposal, broken rules and silo benchmark
 * computed by the engine. Temporary vault, fake provider, no network.
 * Same pattern as pending.test.ts: VAULT_PROJECT_DIR before the first import.
 */
import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Decision } from "../decisions.js";
import type { HistoricalBar } from "../providers/types.js";
import { lotsSection } from "./fixtures/lots.js";
import { parseTicker as tk } from "../ticker.js";

const TODAY = "2026-09-14";

const WATCHLIST_MD = `---
schema_version: 1
---

# Watchlist

\`\`\`yaml
watchlist:
  - ticker: ADBE
    name: Applied Materials
    market: NASDAQ
    currency: USD
    horizon: medium
    thesis: "Capex de IA."
\`\`\`
`;

/** An empty portfolio in the v2 shape: an entry adds its lot to it, a sale consumes the lots (#42). */
const PORTFOLIO_MD = `---
schema_version: 2
last_manual_sync: 2026-09-10T18:00:00Z
account_env: demo
---

${["EUR", "USD"]
  .map(
    (c) => `## ${c} — Cash

| Item | Value |
|---|---|
| Available cash | 1000.00 |

## ${c} — Positions

| Ticker | Volume | Avg price | Current price | P/L | Stop loss |
|---|---|---|---|---|---|

${lotsSection(c as "EUR" | "USD")}`,
  )
  .join("\n")}`;

/** 30 sessions up to 12-Sep with a daily range of 20: ATR14 = 20. */
function bars(): HistoricalBar[] {
  return Array.from({ length: 30 }, (_, i) => {
    const date = new Date(Date.UTC(2026, 7, 14 + i)).toISOString().slice(0, 10);
    return { date, close: 100 + i, high: 100 + i + 10, low: 100 + i - 10 };
  });
}

const fakeProvider = {
  getPrices: async (tickers: string[]) => new Map(tickers.map((t) => [t, 700])),
  getHistorical: async () => bars(),
};

describe("decision:record (recordOwnerDecision)", () => {
  let vaultDir: string;
  let recordOwnerDecision: (raw: unknown, provider?: typeof fakeProvider, today?: string) => Promise<Decision[]>;
  let proposal: Decision;

  const decisionsPath = () => join(vaultDir, "logs", "decisions.jsonl");
  const readLines = async (): Promise<Decision[]> =>
    (await readFile(decisionsPath(), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  const recordAll = (raw: unknown) => recordOwnerDecision(raw, fakeProvider, TODAY);
  /** The decision a trade records; a sale that spans several lots records one per lot (`recordAll`). */
  const record = async (raw: unknown) => (await recordAll(raw))[0];

  before(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "finance-agent-decision-record-"));
    process.env.VAULT_PROJECT_DIR = vaultDir;
    ({ recordOwnerDecision } = await import("../decision.js"));
    const { buildDecision } = await import("../decisions.js");
    proposal = buildDecision({
      date: "2026-09-10",
      ticker: tk("ADBE"),
      currency: "USD",
      origin: "sistema",
      source: "heartbeat",
      type: "buy_proposal",
      price: 505,
      setup: { pattern: "pullback", state: "triggered", level: 505 },
      assumptions: ["El capex de IA se mantiene"],
      rules_version: "0.2",
    });
  });

  after(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await rm(join(vaultDir, "logs"), { recursive: true, force: true });
    await mkdir(join(vaultDir, "logs"), { recursive: true });
    await mkdir(join(vaultDir, "strategies"), { recursive: true });
    await writeFile(join(vaultDir, "strategies", "base.md"), `---\nversion: "0.2"\n---\n`, "utf8");
    await writeFile(join(vaultDir, "watchlist.md"), WATCHLIST_MD, "utf8");
    await writeFile(decisionsPath(), JSON.stringify(proposal) + "\n", "utf8");
    await writeFile(join(vaultDir, "portfolio.md"), PORTFOLIO_MD, "utf8");
  });

  it("an entry after a system proposal is the system's and cites it", async () => {
    const d = await record({ type: "entry", ticker: "ADBE", currency: "USD", price: 500, units: 1, stop: 440 });

    assert.equal(d.origin, "sistema");
    assert.equal(d.source, "portfolio-sync");
    assert.equal(d.related_id, proposal.id);
    assert.equal(d.amount, 500);
    assert.equal(d.stop_initial, 440);
    assert.equal(d.date, TODAY);
    assert.equal(d.rules_version, "0.2");
    assert.deepEqual(d.rule_violations, []);
    assert.deepEqual(d.benchmark, { ticker: "VOO", price: 700 });

    const lines = await readLines();
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[1], d);
  });

  it("an entry without a proposal is discretionary and gets its broken rules computed", async () => {
    const d = await record({ type: "entry", ticker: "CAT", currency: "USD", price: 30, amount: 60, stop: 20 });

    assert.equal(d.origin, "propietario");
    assert.equal(d.related_id, undefined);
    // Stop 10 away with ATR 20: 0.5 ATR.
    assert.deepEqual(d.rule_violations, ["not_in_watchlist", "stop_below_min_atr"]);
  });

  it("the exit cites the open entry; whoever closes decides the origin", async () => {
    const entry = await record({ type: "entry", ticker: "ADBE", currency: "USD", price: 560, units: 1, stop: 530 });
    assert.deepEqual(entry.rule_violations, ["stop_below_min_atr"]);

    const exit = await record({
      type: "exit",
      ticker: "ADBE",
      currency: "USD",
      price: 530,
      units: 1,
      origin: "sistema",
    });
    assert.equal(exit.related_id, entry.id);
    assert.equal(exit.origin, "sistema");
    assert.equal(exit.amount, 530);
  });

  it("a sale that spans two lots records one exit per lot, each citing its own entry", async () => {
    const first = await record({ type: "entry", ticker: "ADBE", currency: "USD", price: 500, units: 2, stop: 440 });
    const second = await record({ type: "entry", ticker: "ADBE", currency: "USD", price: 520, units: 2, stop: 460 });

    const exits = await recordAll({ type: "exit", ticker: "ADBE", currency: "USD", price: 540, units: 3 });
    assert.deepEqual(
      exits.map((e) => [e.related_id, e.amount, e.lot_units_left]),
      [
        [first.id, 1080, 0],
        [second.id, 540, 1],
      ],
    );
    assert.equal((await readLines()).filter((d) => d.type === "exit").length, 2);
  });

  it("the portfolio is parsed from the one text the recorder read (parsePortfolioText)", async () => {
    const { parsePortfolioText } = await import("../vault-io.js");
    const portfolio = parsePortfolioText(PORTFOLIO_MD, "USD");
    assert.equal(portfolio.currency, "USD");
    assert.deepEqual([portfolio.positions, portfolio.lots], [[], []]);
  });

  describe("portfolio.md is read again right before the record writes it (R1-E of #67)", () => {
    const entryOf = { type: "entry", ticker: "ADBE", currency: "USD", price: 500, units: 1, stop: 440 };
    /** A provider that changes portfolio.md while the recorder waits on it for the ATR. */
    const providerThatWrites = (change: (text: string) => string) => ({
      ...fakeProvider,
      getHistorical: async () => {
        const path = join(vaultDir, "portfolio.md");
        await writeFile(path, change(await readFile(path, "utf8")), "utf8");
        return bars();
      },
    });

    it("a write made while the recorder waits on the market-data provider survives the record", async () => {
      const provider = providerThatWrites((text) =>
        text.replace("| Available cash | 1000.00 |", "| Available cash | 1234.50 |"),
      );
      await recordOwnerDecision(entryOf, provider, TODAY);

      const text = await readFile(join(vaultDir, "portfolio.md"), "utf8");
      assert.match(text, /\| Available cash \| 1234\.50 \|/, "the concurrent write is not lost");
      assert.match(text, /\| ADBE \| [^|]+ \| 2026-09-14 \|/, "and the lot is recorded");
      assert.equal((await readLines()).length, 2);
    });

    it("a change to the Lots meanwhile (a unit sold at the broker and typed in by hand) is refused with nothing recorded", async () => {
      await record({ ...entryOf, units: 2 });
      const provider = providerThatWrites((text) =>
        text.replace(/(\| ADBE \| [^|]+\| 2026-09-14 \| )2( \|)/, "$11$2").replace(/(\| ADBE \| )2( \|)/, "$11$2"),
      );
      await assert.rejects(
        recordOwnerDecision({ ...entryOf, ticker: "CAT", stop: 440 }, provider, TODAY),
        /Lots changed while the trade was being recorded.*nothing was recorded/,
      );
      assert.equal((await readLines()).length, 2, "the log has the proposal and the first entry, nothing else");
    });
  });

  describe("the owner edits portfolio.md while the log is being appended (the window after the last check)", () => {
    const entryOf = { type: "entry", ticker: "ADBE", currency: "USD", price: 500, units: 1, stop: 440 };

    /** Runs `during` once, at the moment the decisions log is appended to. */
    async function withEditDuringAppend(during: (text: string) => string, run: () => Promise<unknown>) {
      const fsp = (await import("node:fs/promises")).default;
      const original = fsp.appendFile;
      const path = join(vaultDir, "portfolio.md");
      mock.method(fsp, "appendFile", async (...args: Parameters<typeof original>) => {
        await writeFile(path, during(await readFile(path, "utf8")), "utf8");
        return original(...args);
      });
      (await import("node:module")).syncBuiltinESMExports();
      try {
        await run();
      } finally {
        mock.restoreAll();
        (await import("node:module")).syncBuiltinESMExports();
      }
    }

    it("a change to the Lots in that window is not overwritten; the error says the entry is in the log", async () => {
      await record({ ...entryOf, units: 2 });
      const edited = (text: string) => text.replace(/(\| ADBE \| [^|]+\| 2026-09-14 \| )2( \|)/, "$11$2");
      let after = "";
      await assert
        .rejects(
          withEditDuringAppend(edited, () => recordAll({ ...entryOf, ticker: "CAT" })),
          (err: Error) =>
            err.message.includes("IS recorded in the log") && !err.message.includes("nothing was recorded"),
        )
        .finally(async () => {
          after = await readFile(join(vaultDir, "portfolio.md"), "utf8");
        });
      assert.ok(!after.includes("CAT"), "portfolio.md keeps the owner's edit, with no CAT lot written over it");
      assert.equal((await readLines()).length, 3, "the CAT entry is in the log");
    });

    it("a half-typed Lots row in that window is reported as recorded, not as 'nothing was recorded'", async () => {
      await assert.rejects(
        withEditDuringAppend(
          (text) => text.replace(/(## USD — Lots[\s\S]*?\|---[^\n]*\n)/, "$1| half-typed\n"),
          () => recordAll(entryOf),
        ),
        (err: Error) => err.message.includes("IS recorded in the log") && !err.message.includes("nothing was recorded"),
      );
    });
  });

  it("portfolio.md is replaced atomically: a temp file renamed over it, nothing left behind", async () => {
    const { stat, readdir } = await import("node:fs/promises");
    const before = (await stat(join(vaultDir, "portfolio.md"))).ino;
    await record({ type: "entry", ticker: "ADBE", currency: "USD", price: 50, units: 1, stop: 40 });
    assert.notEqual((await stat(join(vaultDir, "portfolio.md"))).ino, before, "a new file was renamed into place");
    assert.deepEqual(
      (await readdir(vaultDir)).filter((f) => f.startsWith("portfolio.md") && f !== "portfolio.md"),
      [],
    );
  });

  describe("a Lots table that does not read is refused (the strict reader; only the heartbeat tolerates it, ADR-0015)", () => {
    const entryOf = { type: "entry", ticker: "ADBE", currency: "USD", price: 500, units: 1, stop: 440 };
    for (const [name, from, to] of [
      ["a misspelled column in the header", "| Entry units |", "| Entry unitz |"],
      ["a misspelled Lots heading", "## USD — Lots", "## USD — Lot"],
    ] as const) {
      it(`${name} refuses the entry and leaves portfolio.md and the log as they were`, async () => {
        const text = PORTFOLIO_MD.replaceAll(from, to);
        assert.notEqual(text, PORTFOLIO_MD);
        await writeFile(join(vaultDir, "portfolio.md"), text, "utf8");
        const log = await readFile(decisionsPath(), "utf8");

        await assert.rejects(record(entryOf), /Lots/);

        assert.equal(await readFile(join(vaultDir, "portfolio.md"), "utf8"), text);
        assert.equal(await readFile(decisionsPath(), "utf8"), log);
      });
    }

    it("a lot row that does not read refuses the entry and names the row and the reason", async () => {
      const text = `${PORTFOLIO_MD}| ADBE | adbe-1 | 2026-01-01 | 1 | 1 | 1 | — | — | Sistema | 1.0 | — |\n`;
      await writeFile(join(vaultDir, "portfolio.md"), text, "utf8");
      await assert.rejects(
        record(entryOf),
        /portfolio\.md \(USD\): Lots row 1 \(ADBE, adbe-1\): Origin "Sistema" is not sistema or propietario/,
      );
    });

    it("a ticker on two Positions rows, tck and TCK, is refused on read, naming both, before any write (#68)", async () => {
      const rows = "| tck | 4 | 100.00 | 100.00 | 0 | — |\n| TCK | 6 | 100.00 | 100.00 | 0 | — |\n";
      const text = PORTFOLIO_MD.replace(/(## USD — Positions\n\n[^\n]*\n[^\n]*\n)/, `$1${rows}`);
      assert.notEqual(text, PORTFOLIO_MD);
      await writeFile(join(vaultDir, "portfolio.md"), text, "utf8");
      const log = await readFile(decisionsPath(), "utf8");

      await assert.rejects(record(entryOf), (err: Error) => {
        assert.match(err.message, /TCK is on 2 rows of "## USD — Positions" \(tck, TCK\)/);
        assert.doesNotMatch(err.message, /internal error/);
        return true;
      });

      assert.equal(await readFile(join(vaultDir, "portfolio.md"), "utf8"), text);
      assert.equal(await readFile(decisionsPath(), "utf8"), log);
    });

    it("a deleted Lots section refuses the entry", async () => {
      const text = PORTFOLIO_MD.slice(0, PORTFOLIO_MD.indexOf("## USD — Lots"));
      await writeFile(join(vaultDir, "portfolio.md"), text, "utf8");
      await assert.rejects(record(entryOf), /missing section "## USD — Lots"/);
    });
  });

  describe("units and amount agree (reviews of PR #56)", () => {
    const entryOf = (extra: object) => ({
      type: "entry",
      ticker: "ADBE",
      currency: "USD",
      price: 50,
      stop: 40,
      ...extra,
    });
    const sell = (extra: object) => ({ type: "exit", ticker: "ADBE", currency: "USD", price: 50, ...extra });

    it("every entry's log line carries its units: given, or derived from the amount", async () => {
      assert.equal((await record(entryOf({ units: 10 }))).units, 10);
      assert.equal((await record(entryOf({ amount: 505 }))).units, 10.1);
      assert.equal((await record(entryOf({ units: 10, amount: 500 }))).units, 10);
    });

    it("an entry with units and an amount that is not units × price is refused, naming both, and nothing is written", async () => {
      const log = await readFile(decisionsPath(), "utf8");
      const portfolio = await readFile(join(vaultDir, "portfolio.md"), "utf8");
      await assert.rejects(() => record(entryOf({ units: 10, amount: 505 })), /units 10.*amount 505/);
      assert.equal(await readFile(decisionsPath(), "utf8"), log);
      assert.equal(await readFile(join(vaultDir, "portfolio.md"), "utf8"), portfolio);
    });

    it("a sale with units and an amount that is not units × price is refused too", async () => {
      await record(entryOf({ units: 20 }));
      await assert.rejects(() => record(sell({ units: 10, amount: 495 })), /units 10.*amount 495/);
    });

    it("units × price within a cent of the amount passes", async () => {
      await record(entryOf({ units: 10, amount: 500.0 }));
      const exits = await recordAll(sell({ units: 3.333, price: 50.01, amount: 166.68 }));
      assert.equal(exits[0].amount, 166.68);
    });

    it("lot_units_left falls by the units the evaluation measures (amount / price)", async () => {
      await record(entryOf({ units: 10 }));
      const [exit] = await recordAll(sell({ amount: 495 }));
      assert.ok(Math.abs(exit.lot_units_left! - 0.1) < 1e-9, String(exit.lot_units_left));
      assert.ok(Math.abs(exit.amount! / exit.price! - 9.9) < 1e-9);
    });

    it("a sale by amount that leaves less than half a cent of price in the lot uses it up: no Lots or Positions row stays", async () => {
      await record(entryOf({ units: 7, price: 12.345, stop: 11 }));
      const [exit] = await recordAll(sell({ price: 12.345, amount: 86.41 }));
      assert.equal(exit.lot_units_left, 0);
      const md = await readFile(join(vaultDir, "portfolio.md"), "utf8");
      assert.doesNotMatch(md, /ADBE/);
    });
  });

  describe("a sale is not dated before the entry of a lot it consumes (#48)", () => {
    const entryOf = (extra: object) => ({
      type: "entry",
      ticker: "ADBE",
      currency: "USD",
      price: 25,
      stop: 20,
      ...extra,
    });
    const sell = (extra: object) => ({ type: "exit", ticker: "ADBE", currency: "USD", price: 27.98, ...extra });

    it("refuses it, naming both dates, and writes neither the log nor portfolio.md", async () => {
      await record(entryOf({ units: 2, date: "2026-09-10" }));
      const log = await readFile(decisionsPath(), "utf8");
      const portfolio = await readFile(join(vaultDir, "portfolio.md"), "utf8");

      await assert.rejects(
        record(sell({ units: 1, date: "2026-09-09" })),
        /entry_date 2026-09-10 is after the exit's date 2026-09-09.*\(nothing was recorded\)/,
      );

      assert.equal(await readFile(decisionsPath(), "utf8"), log);
      assert.equal(await readFile(join(vaultDir, "portfolio.md"), "utf8"), portfolio);
    });

    it("refuses it before any call to the market data provider", async () => {
      await record(entryOf({ units: 2, date: "2026-09-10" }));
      const calls: string[] = [];
      const counting = {
        getPrices: async (tickers: string[]) => {
          calls.push("getPrices");
          return fakeProvider.getPrices(tickers);
        },
        getHistorical: async () => {
          calls.push("getHistorical");
          return bars();
        },
      };

      await assert.rejects(
        recordOwnerDecision(sell({ units: 1, date: "2026-09-09" }), counting, TODAY),
        /is after the exit's date/,
      );
      assert.deepEqual(calls, []);
    });

    it("refuses a sale that reaches into a later lot even if the first lot is old enough", async () => {
      await record(entryOf({ units: 1, date: "2026-09-01" }));
      await record(entryOf({ units: 1, date: "2026-09-10" }));
      const log = await readFile(decisionsPath(), "utf8");

      await assert.rejects(record(sell({ units: 2, date: "2026-09-05" })), /entry_date 2026-09-10 is after/);
      assert.equal(await readFile(decisionsPath(), "utf8"), log);
    });

    it("accepts a sale on the entry date and one that only consumes the older lot", async () => {
      await record(entryOf({ units: 1, date: "2026-09-01" }));
      await record(entryOf({ units: 1, date: "2026-09-10" }));
      const [onlyOld] = await recordAll(sell({ units: 1, date: "2026-09-05" }));
      assert.equal(onlyOld.entry_date, "2026-09-01");
      const [sameDay] = await recordAll(sell({ units: 1, date: "2026-09-10" }));
      assert.equal(sameDay.entry_date, "2026-09-10");
    });
  });

  describe("every exit carries the units it sold (B1 of PR #56)", () => {
    const entryOf = (extra: object) => ({
      type: "entry",
      ticker: "ADBE",
      currency: "USD",
      price: 25,
      stop: 20,
      ...extra,
    });
    const sell = (extra: object) => ({ type: "exit", ticker: "ADBE", currency: "USD", price: 27.98, ...extra });
    const lotsOf = async (units: number[]) => {
      for (const u of units) await record(entryOf({ units: u }));
    };

    for (const [name, sale] of [
      ["by units", { units: 2.5 }],
      ["by amount", { amount: 69.95 }],
    ] as const) {
      it(`a sale of all 2.5 units over four lots, ${name}: the units add up, every lot closes and is measured`, async () => {
        await lotsOf([0.502, 0.428, 1.007, 0.563]);
        const exits = await recordAll(sell(sale));
        assert.deepEqual(
          exits.map((e) => e.units),
          [0.502, 0.428, 1.007, 0.563],
        );
        assert.deepEqual(
          exits.map((e) => e.lot_units_left),
          [0, 0, 0, 0],
        );
        assert.equal(exits.reduce((sum, e) => sum + e.amount!, 0).toFixed(2), "69.95");
        const { measureTrades } = await import("../utils/decisions-evaluation.js");
        const measured = measureTrades(await readLines());
        assert.equal(measured.trades.length, 4);
        assert.deepEqual(measured.unmeasured.inconsistent, []);
        assert.deepEqual(measured.unmeasured.oversold, []);
      });
    }

    it("a partial sale across lots: units sum to the units sold and lot_units_left steps by them", async () => {
      await lotsOf([0.502, 0.428, 1.007]);
      const exits = await recordAll(sell({ units: 1.2 }));
      assert.deepEqual(
        exits.map((e) => e.units),
        [0.502, 0.428, 0.27],
      );
      assert.ok(Math.abs(exits[2].lot_units_left! - (1.007 - 0.27)) < 1e-9);
    });

    it("exact units that leave dust in a low-priced lot keep it: nothing is snapped", async () => {
      await record(entryOf({ units: 10, price: 0.001, stop: 0.0008 }));
      const [exit] = await recordAll(sell({ units: 6, price: 0.001 }));
      assert.equal(exit.units, 6);
      assert.equal(exit.lot_units_left, 4);
      const md = await readFile(join(vaultDir, "portfolio.md"), "utf8");
      assert.match(md, /ADBE/);
    });
  });

  describe("an amount too large to count in cents is refused with a message (#87)", () => {
    const entryOf = { type: "entry", ticker: "ADBE", currency: "USD", price: 25, units: 3, stop: 20 };
    const sell = { type: "exit", ticker: "ADBE", currency: "USD", price: 27.98, units: 1 };
    /** Sets only the Entry price cell of the `Lots` table (the Avg price of `Positions` is also 25). */
    const setEntryPriceCell = (portfolio: string, value: string): string => {
      const lines = portfolio.split("\n");
      const section = lines.findIndex((l) => l.startsWith("## USD") && l.includes("Lots"));
      assert.ok(section >= 0, "portfolio.md has the USD Lots section");
      const header = lines.findIndex((l, i) => i > section && l.startsWith("|"));
      const column = lines[header].split("|").findIndex((c) => c.trim() === "Entry price");
      assert.ok(column > 0, "the Lots table has an Entry price column");
      const row = header + 2;
      const cells = lines[row].split("|");
      cells[column] = ` ${value} `;
      lines[row] = cells.join("|");
      return lines.join("\n");
    };
    /** Rewrites the log and portfolio.md as the owner could have left them, then expects the refusal and no write. */
    const refused = async (edit: (log: string, portfolio: string) => [string, string], message: RegExp) => {
      const [log, portfolio] = edit(
        await readFile(decisionsPath(), "utf8"),
        await readFile(join(vaultDir, "portfolio.md"), "utf8"),
      );
      await writeFile(decisionsPath(), log, "utf8");
      await writeFile(join(vaultDir, "portfolio.md"), portfolio, "utf8");
      await assert.rejects(record(sell), (err: Error) => {
        assert.equal(err.constructor, Error);
        assert.match(err.message, message);
        assert.match(err.message, /nothing was recorded/);
        return true;
      });
      assert.equal(await readFile(decisionsPath(), "utf8"), log);
      assert.equal(await readFile(join(vaultDir, "portfolio.md"), "utf8"), portfolio);
    };

    it("a lot whose Entry price is too large to count in cents refuses the sale, naming the lot", async () => {
      const entry = await record(entryOf);
      await refused(
        (log, portfolio) => [log.replace('"price":25,', '"price":5e306,'), setEntryPriceCell(portfolio, "5e306")],
        new RegExp(`lot ${entry.id} \\(ADBE\\).*Entry price.*too large to count in cents`),
      );
    });

    it("entry costs that the exits of a lot took, too large together, refuse the sale, naming the entry", async () => {
      const entry = await record(entryOf);
      await record(sell);
      await record(sell);
      await refused(
        (log, portfolio) => [log.replaceAll('"type":"exit",', '"type":"exit","entry_costs":9e305,'), portfolio],
        new RegExp(`entry_costs.*${entry.id}.*too large to count in cents`),
      );
    });
  });

  it("an exit refuses related_id: a sale consumes the lots first in, first out, and nothing is written", async () => {
    const entry = await record({ type: "entry", ticker: "ADBE", currency: "USD", price: 500, units: 2, stop: 440 });
    const before = await readFile(decisionsPath(), "utf8");
    await assert.rejects(
      () => record({ type: "exit", ticker: "ADBE", currency: "USD", price: 540, units: 1, related_id: entry.id }),
      /related_id does not apply to an exit/,
    );
    assert.equal(await readFile(decisionsPath(), "utf8"), before);
  });

  it("an entry after an engine block is the owner's, cites it and flags it as broken", async () => {
    const { buildDecision } = await import("../decisions.js");
    const blocked = buildDecision({
      date: "2026-09-12",
      ticker: tk("ADBE"),
      currency: "USD",
      origin: "sistema",
      source: "heartbeat",
      type: "buy_blocked",
      price: 505,
      setup: { pattern: "pullback", state: "triggered", level: 505 },
      eligibility: { verdict: "blocked", reasons: ["rr_below_min"] },
      rules_version: "0.2",
    });
    await writeFile(decisionsPath(), JSON.stringify(blocked) + "\n", "utf8");

    const d = await record({ type: "entry", ticker: "ADBE", currency: "USD", price: 500, units: 1, stop: 440 });
    assert.equal(d.origin, "propietario");
    assert.equal(d.related_id, blocked.id);
    assert.deepEqual(d.rule_violations, ["overrode_block"]);
  });

  it("the Buy Stop of an eligible armed breakout that fills is the system's (ADR-0013)", async () => {
    const { buildDecision } = await import("../decisions.js");
    const armed = buildDecision({
      date: "2026-09-12",
      ticker: tk("ADBE"),
      currency: "USD",
      origin: "sistema",
      source: "heartbeat",
      type: "setup_armed",
      price: 495,
      target: 560,
      setup: { pattern: "breakout", state: "armed", level: 500 },
      eligibility: { verdict: "eligible", reasons: [] },
      rules_version: "0.2",
    });
    await writeFile(decisionsPath(), JSON.stringify(armed) + "\n", "utf8");

    const d = await record({ type: "entry", ticker: "ADBE", currency: "USD", price: 500.5, units: 1, stop: 440 });
    assert.equal(d.origin, "sistema");
    assert.equal(d.related_id, armed.id);
    assert.deepEqual(d.rule_violations, []);
  });

  it("the Buy Stop of a blocked armed breakout is the owner's and skips the block", async () => {
    const { buildDecision } = await import("../decisions.js");
    const armed = buildDecision({
      date: "2026-09-12",
      ticker: tk("ADBE"),
      currency: "USD",
      origin: "sistema",
      source: "heartbeat",
      type: "setup_armed",
      price: 495,
      target: 560,
      setup: { pattern: "breakout", state: "armed", level: 500 },
      eligibility: { verdict: "blocked", reasons: ["regime_adverse"] },
      rules_version: "0.2",
    });
    await writeFile(decisionsPath(), JSON.stringify(armed) + "\n", "utf8");

    const d = await record({ type: "entry", ticker: "ADBE", currency: "USD", price: 500.5, units: 1, stop: 440 });
    assert.equal(d.origin, "propietario");
    assert.deepEqual(d.rule_violations, ["overrode_block"]);
  });

  it("a stop adjustment after a system proposal is the system's and cites it", async () => {
    const { buildDecision } = await import("../decisions.js");
    const adjust = buildDecision({
      date: "2026-09-11",
      ticker: tk("ADBE"),
      currency: "USD",
      origin: "sistema",
      source: "heartbeat",
      type: "adjust_stop",
      stop: 470,
      rules_version: "0.2",
    });
    await writeFile(decisionsPath(), JSON.stringify(adjust) + "\n", "utf8");

    const d = await record({ type: "adjust_stop", ticker: "ADBE", currency: "USD", stop: 470 });
    assert.equal(d.type, "adjust_stop");
    assert.equal(d.stop, 470);
    assert.equal(d.origin, "sistema");
    assert.equal(d.related_id, adjust.id);
  });

  it("a conversion at the market rate applies the default fee; on a Sunday, the benchmark is the previous close", async () => {
    const d = await record({ type: "fx_conversion", currency: "EUR", amount: 200, fx_rate: 1.17, date: "2026-09-13" });
    assert.equal(d.fx_rate, 1.17);
    assert.equal(d.costs, 1);
    // No session on 13-Sep: the 12-Sep close.
    assert.deepEqual(d.benchmark, { ticker: "EXSA.DE", price: 129 });
  });

  it("a corrupt log line is ignored with a warning and does not prevent attributing or recording", async () => {
    await writeFile(
      decisionsPath(),
      `{"id":"roto"\n${JSON.stringify(proposal)}\n{"id":"x","type":"desconocido"}\n`,
      "utf8",
    );
    const warn = mock.method(console, "warn", () => {});
    try {
      const d = await record({ type: "entry", ticker: "ADBE", currency: "USD", price: 500, units: 1, stop: 440 });
      assert.equal(d.related_id, proposal.id);
      assert.equal(warn.mock.calls.filter((c) => /line \d+ ignored/.test(String(c.arguments[0]))).length, 2);
    } finally {
      warn.mock.restore();
    }
    const raw = await readFile(decisionsPath(), "utf8");
    assert.ok(raw.startsWith(`{"id":"roto"\n`), "the log is not rewritten");
    assert.equal(raw.trim().split("\n").length, 4);
  });

  it("a conversion with the received amount infers the fee and the rate, with that day's benchmark", async () => {
    const d = await record({
      type: "fx_conversion",
      currency: "EUR",
      amount: 100,
      received: 115.42,
      date: "2026-09-12",
    });

    assert.equal(d.ticker, null);
    assert.equal(d.origin, "propietario");
    assert.equal(d.costs, 0.5);
    assert.equal(d.fx_rate, 1.16);
    // Past date: that session's close, not the current price (700).
    assert.deepEqual(d.benchmark, { ticker: "EXSA.DE", price: 129 });
  });

  it("a deposit or a withdrawal is a flow without a ticker", async () => {
    const d = await record({ type: "deposit", currency: "EUR", amount: 50 });
    assert.equal(d.type, "deposit");
    assert.equal(d.ticker, null);
    assert.equal(d.amount, 50);

    const w = await record({ type: "withdrawal", currency: "USD", amount: 20 });
    assert.equal(w.type, "withdrawal");
    assert.equal(w.ticker, null);
    assert.equal(w.origin, "propietario");
  });

  it("an invalid entry or one with a nonexistent related_id does not touch the log", async () => {
    const warn = mock.method(console, "warn", () => {});
    try {
      await assert.rejects(() => record({ type: "entry", ticker: "ADBE", currency: "USD" }), /price is required/);
      await assert.rejects(
        () => record({ type: "entry", ticker: "ADBE", currency: "USD", price: 500, units: 1, related_id: "no-existe" }),
        /related_id no-existe does not exist/,
      );
    } finally {
      warn.mock.restore();
    }
    assert.equal((await readLines()).length, 1);
  });
});
