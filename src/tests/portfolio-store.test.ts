/**
 * The portfolio state port (#130, ADR-0015, ADR-0017): one read for every flow, whose result says what of
 * the file could not be read, the two policies a flow applies to that result, and the writes (lots and
 * prices) that take the model's values, never text. Temporary vault, no network. VAULT_PROJECT_DIR is set
 * before the first import of the engine.
 */
import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Lot } from "../types.js";
import { parseTicker as tk } from "../ticker.js";
import { brokenUsdLots, lotsSection, mdTable, type HeldLot } from "./fixtures/lots.js";

const POSITIONS_HEADER = ["Ticker", "Volume", "Avg price", "Current price", "P/L", "Stop loss"];

/** A portfolio.md: the USD silo holds the given position rows and lots; the EUR silo is empty. */
function portfolioMd(positions: string[], held: HeldLot[], { usdCash = "1000.00" } = {}): string {
  return `---
schema_version: 2
last_manual_sync: 2099-01-01T00:00:00Z
---

## EUR — Cash

| Item | Value |
|---|---|
| Available cash | 500,00 |

## EUR — Positions

${mdTable(POSITIONS_HEADER, [])}

${lotsSection("EUR")}
## USD — Cash

| Item | Value |
|---|---|
| Available cash | ${usdCash} |

## USD — Positions

${mdTable(POSITIONS_HEADER, positions)}

${lotsSection("USD", held)}`;
}

const TCK_LOT: HeldLot = { ticker: "TCK", units: 2, price: 100, stop: 80 };
const TCK_ROW = "| TCK | 2 | 100 | 100 | 0 | 80 |";

describe("the portfolio state port", () => {
  let vaultDir: string;
  let store: typeof import("../portfolio-store.js");
  const file = () => join(vaultDir, "portfolio.md");
  const put = (text: string) => writeFile(file(), text, "utf8");
  const warnings: string[] = [];

  before(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "finance-agent-portfolio-store-"));
    process.env.VAULT_PROJECT_DIR = vaultDir;
    store = await import("../portfolio-store.js");
  });

  after(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    warnings.length = 0;
    mock.method(console, "warn", (message: string) => warnings.push(String(message)));
    mock.method(console, "log", () => undefined);
  });

  describe("the one read", () => {
    it("gives the silo's model with every amount in the silo's currency, and nothing unread", async () => {
      await put(portfolioMd([TCK_ROW], [TCK_LOT]));

      const usd = await store.readPortfolio("USD");
      const eur = await store.readPortfolio("EUR");

      assert.deepEqual(
        [usd.portfolio.currency, usd.portfolio.cash, usd.portfolio.positions.map((p) => [p.ticker, p.volume, p.pl])],
        ["USD", 1000, [["TCK", 2, 0]]],
      );
      assert.deepEqual([eur.portfolio.currency, eur.portfolio.cash, eur.portfolio.positions], ["EUR", 500, []]);
      assert.deepEqual(
        usd.portfolio.lots.map((l) => [l.ticker, l.entryId, l.units]),
        [[tk("TCK"), "lot-tck", 2]],
      );
      assert.deepEqual([usd.lotsProblem, usd.skippedRows, usd.unreadableCells], [null, [], []]);
      assert.equal(usd.portfolio.skippedLotRows, undefined);
    });

    it("says which lots could not be read: the table as such, or the rows of it", async () => {
      const [heading, header, row] = brokenUsdLots(portfolioMd([TCK_ROW], [TCK_LOT]));

      await put(heading[1]);
      const noSection = await store.readPortfolio("USD");
      assert.match(noSection.lotsProblem ?? "", /^portfolio\.md \(USD\): missing section "## USD — Lots"/);
      assert.deepEqual(noSection.portfolio.lots, []);

      await put(header[1]);
      assert.match(
        (await store.readPortfolio("USD")).lotsProblem ?? "",
        /portfolio\.md \(USD\): ## USD — Lots: columns/,
      );

      await put(row[1]);
      const badRow = await store.readPortfolio("USD");
      assert.equal(badRow.lotsProblem, null, "the table reads");
      assert.deepEqual(badRow.portfolio.lots, []);
      assert.match(badRow.portfolio.skippedLotRows?.[0]?.message ?? "", /Units "TBD" is not a number/);
    });

    it("reads the silos of one file independently, and one that is empty is not an error", async () => {
      await put(portfolioMd([], []));
      const read = await store.readPortfolio("EUR");
      assert.deepEqual([read.portfolio.positions, read.portfolio.lots, read.lotsProblem], [[], [], null]);
    });

    it("lists the Positions rows whose ticker does not parse and the cells too large to count in cents", async () => {
      await put(
        portfolioMd([TCK_ROW, "| M&M.NS | 1 | 5 | 5 | 0 | 4 |", "| ABC | 1 | 5 | 5 | 1e307 | 4 |"], [], {
          usdCash: "1e307",
        }),
      );

      const read = await store.readPortfolio("USD");

      assert.deepEqual(
        read.portfolio.positions.map((p) => p.ticker),
        ["TCK", "ABC"],
      );
      assert.equal(read.skippedRows.length, 1);
      assert.match(read.skippedRows[0], /## USD — Positions: Ticker "M&M\.NS".*row skipped/);
      assert.equal(read.unreadableCells.length, 2);
      assert.match(read.unreadableCells.join("\n"), /Available cash.*too large to count in cents/);
      assert.match(read.unreadableCells.join("\n"), /ABC P\/L.*too large to count in cents/);
    });

    it("refuses a file that cannot be the portfolio at all, whatever the flow", async () => {
      await put(portfolioMd([TCK_ROW], [TCK_LOT]).replace("schema_version: 2", "schema_version: 1"));
      await assert.rejects(() => store.readPortfolio("USD"), /portfolio\.md.*schema_version 1.*version 2/);

      await put(portfolioMd([TCK_ROW], [TCK_LOT]).replace("## USD — Positions", "## USD — Posiciones"));
      await assert.rejects(() => store.readPortfolio("USD"), /## USD — Positions/);
    });

    it("rejects with ENOENT without a portfolio.md", async () => {
      await rm(file(), { force: true });
      await assert.rejects(
        () => store.readPortfolio("USD"),
        (err: NodeJS.ErrnoException) => err.code === "ENOENT",
      );
    });
  });

  describe("what each flow does with what could not be read", () => {
    const broken = () => brokenUsdLots(portfolioMd([TCK_ROW, "| M&M.NS | 1 | 5 | 5 | 0 | 4 |"], [TCK_LOT]));

    it("the strict flows (decision:record, the evaluation) refuse a Lots table that does not read, with the parser's own error", async () => {
      for (const [label, md] of broken().slice(0, 2)) {
        await put(md.replace("| M&M.NS | 1 | 5 | 5 | 0 | 4 |\n", ""));
        await assert.rejects(
          () => store.readPortfolio("USD").then(store.requireReadable),
          (err: Error) => err.name === "LotsTableError" && err.message.includes("portfolio.md (USD)"),
          label,
        );
      }
    });

    it("the strict flows keep a bad Lots row as a skipped row, for the lots check to name", async () => {
      const [, md] = broken()[2];
      await put(md.replace("| M&M.NS | 1 | 5 | 5 | 0 | 4 |\n", ""));
      const portfolio = store.requireReadable(await store.readPortfolio("USD"));
      assert.equal(portfolio.skippedLotRows?.length, 1);
    });

    it("the strict flows refuse a Positions row that is not a ticker, naming it, without the skipped-row suffix", async () => {
      await put(portfolioMd(["| M&M.NS | 1 | 5 | 5 | 0 | 4 |"], []));
      await assert.rejects(
        () => store.readPortfolio("USD").then(store.requireReadable),
        (err: Error) =>
          err.message.includes('## USD — Positions: Ticker "M&M.NS"') && !err.message.includes("row skipped"),
      );
    });

    it("the flows that do not use the lots carry on through every way the Lots can be broken, and warn of the rest", async () => {
      for (const [label, md] of broken()) {
        warnings.length = 0;
        await put(md);
        const portfolio = store.ignoringLots(await store.readPortfolio("USD"));
        assert.deepEqual(
          portfolio.positions.map((p) => p.ticker),
          ["TCK"],
          label,
        );
        assert.equal(portfolio.cash, 1000, label);
        assert.ok(
          warnings.some((w) => w.includes("M&M.NS")),
          `${label}: the skipped row is warned of`,
        );
      }
    });

    it("the heartbeat reads the same result as it is and decides for itself", async () => {
      for (const [label, md] of broken()) {
        await put(md);
        const read = await store.readPortfolio("USD");
        assert.deepEqual(
          read.portfolio.positions.map((p) => p.ticker),
          ["TCK"],
          label,
        );
        assert.equal(read.skippedRows.length, 1, label);
      }
    });
  });

  describe("changing the lots", () => {
    const lotOf = (units: number): Lot<"USD"> => ({
      ticker: tk("TCK"),
      entryId: "lot-tck",
      date: "2026-06-15",
      units,
      entryUnits: 2,
      entryPrice: 100,
      initialStop: 80,
      entryCosts: null,
      origin: "sistema",
      rulesVersion: "1.0",
      rulesViolations: [],
    });
    const change = { ticker: tk("TCK"), volume: 1, avgPrice: 100 };

    it("writes the new lots and the position change, if the lots on disk are the ones it was planned on", async () => {
      await put(portfolioMd([TCK_ROW], [TCK_LOT]));
      const { portfolio } = await store.readPortfolio("USD");

      await store.changeLots("USD", portfolio.lots, [lotOf(1)], change);

      const after = (await store.readPortfolio("USD")).portfolio;
      assert.deepEqual([after.lots.map((l) => l.units), after.positions.map((p) => p.volume)], [[1], [1]]);
      assert.deepEqual(
        (await readdir(vaultDir)).filter((f) => f.endsWith(".tmp")),
        [],
        "no temp file is left",
      );
    });

    it("with dryRun refuses what it would refuse, and writes nothing", async () => {
      await put(portfolioMd([TCK_ROW], [TCK_LOT]));
      const before = await readFile(file(), "utf8");
      const { portfolio } = await store.readPortfolio("USD");

      await store.changeLots("USD", portfolio.lots, [lotOf(1)], change, { dryRun: true });
      assert.equal(await readFile(file(), "utf8"), before);

      await assert.rejects(
        () => store.changeLots("USD", [lotOf(99)], [lotOf(1)], change, { dryRun: true }),
        store.LotsMovedError,
      );
      assert.equal(await readFile(file(), "utf8"), before);
    });

    it("refuses, writing nothing, when the lots moved since the plan was made", async () => {
      await put(portfolioMd([TCK_ROW], [TCK_LOT]));
      const { portfolio } = await store.readPortfolio("USD");
      await put(portfolioMd([TCK_ROW], [{ ...TCK_LOT, units: 3 }]));
      const moved = await readFile(file(), "utf8");

      await assert.rejects(
        () => store.changeLots("USD", portfolio.lots, [lotOf(1)], change),
        (err: Error) =>
          err instanceof store.LotsMovedError && err.message.includes("portfolio.md (USD): Lots changed meanwhile"),
      );
      assert.equal(await readFile(file(), "utf8"), moved);
    });

    it("refuses a Lots table that does not read, and a row of it that does not, as the strict flows do", async () => {
      const [heading, , row] = brokenUsdLots(portfolioMd([TCK_ROW], [TCK_LOT]));
      await put(heading[1]);
      await assert.rejects(() => store.changeLots("USD", [], [lotOf(1)], change), /missing section "## USD — Lots"/);
      await put(row[1]);
      const text = await readFile(file(), "utf8");
      await assert.rejects(() => store.changeLots("USD", [], [lotOf(1)], change), /the Lots table is not rewritten/);
      assert.equal(await readFile(file(), "utf8"), text);
    });
  });

  describe("refreshing the prices", () => {
    const prices = new Map([[tk("TCK"), 110]]);

    it("writes the current price and the P/L of the priced positions, and nothing else", async () => {
      const md = portfolioMd([TCK_ROW, "| OTH | 1 | 10 | 10 | 0 | — |"], [TCK_LOT]);
      await put(md);

      await store.refreshPrices("USD", prices);

      const text = await readFile(file(), "utf8");
      assert.ok(text.includes("| TCK | 2 | 100 | 110,00 | 20,00 | 80 |"), text);
      assert.ok(text.includes("| OTH | 1 | 10 | 10 | 0 | — |"), "a ticker without a price is left alone");
      assert.equal(text.replace("| TCK | 2 | 100 | 110,00 | 20,00 | 80 |", TCK_ROW), md);
      const { portfolio } = await store.readPortfolio("USD");
      assert.deepEqual([portfolio.positions[0].currentPrice, portfolio.positions[0].pl], [110, 20]);
    });

    it("writes nothing when no value changes, or when there is no portfolio.md", async () => {
      await put(portfolioMd([TCK_ROW], [TCK_LOT]));
      await store.refreshPrices("USD", new Map());
      assert.equal(await readFile(file(), "utf8"), portfolioMd([TCK_ROW], [TCK_LOT]));

      await rm(file(), { force: true });
      await store.refreshPrices("USD", prices);
      await assert.rejects(() => readFile(file(), "utf8"), { code: "ENOENT" });
    });

    it("refuses a file in another schema_version", async () => {
      await put(portfolioMd([TCK_ROW], [TCK_LOT]).replace("schema_version: 2", "schema_version: 1"));
      await assert.rejects(() => store.refreshPrices("USD", prices), /schema_version/);
    });
  });
});
