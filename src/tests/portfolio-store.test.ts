/**
 * The portfolio state port (#130, ADR-0015, ADR-0017): one read for every flow, whose result says what of
 * the file could not be read, the two policies a flow applies to that result, and the writes (lots and
 * prices) that take the model's values, never text. Temporary vault, no network. VAULT_PROJECT_DIR is set
 * before the first import of the engine.
 */
import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, readdir, stat } from "node:fs/promises";
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

    it("checks the very read it writes: `check` sees the portfolio of that read, and a refusal writes nothing", async () => {
      await put(portfolioMd([TCK_ROW], [TCK_LOT]));
      const before = await readFile(file(), "utf8");
      const { portfolio } = await store.readPortfolio("USD");
      const seen: number[] = [];

      await store.changeLots("USD", portfolio.lots, [lotOf(1)], change, {
        check: (read) => void seen.push(read.positions[0].volume),
      });
      assert.deepEqual(seen, [2]);

      await put(before);
      await assert.rejects(
        () =>
          store.changeLots("USD", portfolio.lots, [lotOf(1)], change, {
            check: () => {
              throw new Error("does not match the log");
            },
          }),
        /does not match the log/,
      );
      assert.equal(await readFile(file(), "utf8"), before);
    });

    it("with dryRun refuses what it would refuse (the guard, `check`, the edit), and writes nothing", async () => {
      await put(portfolioMd([TCK_ROW], [TCK_LOT]));
      const before = await readFile(file(), "utf8");
      const { portfolio } = await store.readPortfolio("USD");

      await store.changeLots("USD", portfolio.lots, [lotOf(1)], change, { dryRun: true });
      assert.equal(await readFile(file(), "utf8"), before);

      await assert.rejects(
        () => store.changeLots("USD", [lotOf(99)], [lotOf(1)], change, { dryRun: true }),
        store.LotsMovedError,
      );
      await assert.rejects(
        () =>
          store.changeLots("USD", portfolio.lots, [lotOf(1)], change, { check: () => assert.fail("no"), dryRun: true }),
        /no/,
      );
      assert.equal(await readFile(file(), "utf8"), before);
    });

    it("checks and edits one read: a Volume the owner edited is refused by `check`, not overwritten", async () => {
      await put(portfolioMd([TCK_ROW], [TCK_LOT]));
      const { portfolio } = await store.readPortfolio("USD");
      // The Lots are as planned; only the Positions Volume moved. A check on another read than the edit would pass.
      await put(portfolioMd([TCK_ROW.replace("| 2 |", "| 5 |")], [TCK_LOT]));
      const edited = await readFile(file(), "utf8");

      await assert.rejects(
        () =>
          store.changeLots("USD", portfolio.lots, [lotOf(1)], change, {
            check: (read) => assert.equal(read.positions[0].volume, 2, "Volume does not match its lots"),
          }),
        /Volume does not match its lots/,
      );
      assert.equal(await readFile(file(), "utf8"), edited);
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

  describe("with the engine's own store (#132, spec #124)", () => {
    const storeFile = () => join(vaultDir, "state", "portfolio.json");
    const seed = () => store.seedStore(new Date("2026-11-12T00:00:00Z"));
    const stored = () => readFile(storeFile(), "utf8");

    beforeEach(async () => {
      await rm(join(vaultDir, "state"), { recursive: true, force: true });
      await put(portfolioMd([TCK_ROW], [TCK_LOT]));
    });

    it("is made from the old portfolio.md once: every silo synced at the given time, a store that exists is left alone", async () => {
      await seed();
      const doc = JSON.parse(await stored());
      assert.deepEqual([doc.silos.EUR.synced_at, doc.silos.USD.synced_at], Array(2).fill("2026-11-12T00:00:00.000Z"));
      assert.equal(doc.silos.USD.cash, "1000.00 USD");
      assert.deepEqual(
        doc.silos.USD.lots.map((l: { entry_id: string }) => l.entry_id),
        ["lot-tck"],
      );

      const before = await stored();
      await store.seedStore(new Date("2030-01-01T00:00:00Z"));
      assert.equal(await stored(), before);
    });

    it("refuses to make it from a portfolio.md that does not read whole: a row lost on the way would stop being watched", async () => {
      await put(portfolioMd(["| M&M.NS | 4 | 100 | 100 | 0 | 90 |", TCK_ROW], [TCK_LOT]));
      await assert.rejects(() => store.seedStore(new Date()), /M&M\.NS/);
      await assert.rejects(() => stat(storeFile()), { code: "ENOENT" });
    });

    it("is what every read gives from then on; portfolio.md is a view and is never read", async () => {
      await seed();
      await put("this is not a portfolio any more");
      const usd = (await store.readPortfolio("USD")).portfolio;
      assert.deepEqual(
        [usd.cash, usd.positions.map((p) => p.ticker), usd.lots.map((l) => l.entryId)],
        [1000, ["TCK"], ["lot-tck"]],
      );
      const both = await store.readBothPortfolios();
      assert.deepEqual([both.EUR?.portfolio.cash, both.USD?.portfolio.cash], [500, 1000]);
      assert.deepEqual(both.USD?.skippedRows, []);
    });

    it("says a silo it does not hold is absent, as the old file did", async () => {
      await seed();
      const doc = JSON.parse(await stored());
      delete doc.silos.EUR;
      await writeFile(storeFile(), JSON.stringify(doc), "utf8");
      assert.deepEqual(Object.keys(await store.readBothPortfolios()), ["USD"]);
      await assert.rejects(() => store.readPortfolio("EUR"), { name: "SiloAbsentError", message: /no EUR silo/ });
    });

    it("refuses a store it cannot read whole, naming the file and the field", async () => {
      await seed();
      const doc = JSON.parse(await stored());
      doc.silos.USD.cash = "1000 USD";
      await writeFile(storeFile(), JSON.stringify(doc), "utf8");
      await assert.rejects(() => store.readPortfolio("USD"), /state\/portfolio\.json: silos\.USD\.cash/);
    });

    it("warns when the state has not changed for a long time, with the time of the store", async () => {
      await store.seedStore(new Date("2020-01-01T00:00:00Z"));
      await store.readPortfolio("USD");
      assert.match(warnings.join("\n"), /portfolio\.md has not been updated for \d+ days/);
    });

    it("refreshes the prices in the store and regenerates the view, and writes nothing when no value changes", async () => {
      await seed();
      await store.refreshPrices("USD", new Map([[tk("TCK"), 110]]));
      const { portfolio } = await store.readPortfolio("USD");
      assert.deepEqual([portfolio.positions[0].currentPrice, portfolio.positions[0].pl], [110, 20]);
      assert.match(await readFile(file(), "utf8"), /\| TCK \| 2 \| 100\.00 \| 110\.00 \| 20\.00 \| 80\.00 \|/);

      const before = [await stored(), await readFile(file(), "utf8")];
      await store.refreshPrices("USD", new Map([[tk("TCK"), 110]]));
      await store.refreshPrices("USD", new Map());
      assert.deepEqual([await stored(), await readFile(file(), "utf8")], before);
    });

    describe("changing the lots", () => {
      const change = { ticker: tk("TCK"), volume: 1, avgPrice: 100 };
      const lotAfter = (units: number): Lot<"USD"> => ({
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

      it("writes the lots and the position change to the store and the view, if the lots are the ones it was planned on", async () => {
        await seed();
        const { portfolio } = await store.readPortfolio("USD");
        await store.changeLots("USD", portfolio.lots, [lotAfter(1)], change);
        const after = (await store.readPortfolio("USD")).portfolio;
        assert.deepEqual([after.lots.map((l) => l.units), after.positions.map((p) => p.volume)], [[1], [1]]);
        assert.match(await readFile(file(), "utf8"), /\| TCK \| lot-tck \| 2026-06-15 \| 1 \| 2 \|/);
      });

      it("checks the very read it writes, refuses when the lots moved, and with dryRun writes nothing", async () => {
        await seed();
        const { portfolio } = await store.readPortfolio("USD");
        const before = await stored();
        await assert.rejects(
          () =>
            store.changeLots("USD", portfolio.lots, [lotAfter(1)], change, {
              check: () => {
                throw new Error("no");
              },
            }),
          /no/,
        );
        await store.changeLots("USD", portfolio.lots, [lotAfter(1)], change, { dryRun: true });
        await assert.rejects(
          () => store.changeLots("USD", [lotAfter(7)], [lotAfter(1)], change),
          (err: Error) => err instanceof store.LotsMovedError,
        );
        assert.equal(await stored(), before);
      });
    });

    it("the view is the state in the tables the old reader reads: written, then read back, the model is the same", async () => {
      await seed();
      const { portfolio: fromStore } = await store.readPortfolio("USD");
      const { portfolio: fromStoreEur } = await store.readPortfolio("EUR");
      await rm(join(vaultDir, "state"), { recursive: true });
      const viewRead = await store.readPortfolio("USD");
      const viewReadEur = await store.readPortfolio("EUR");
      assert.deepEqual(viewRead.portfolio, fromStore);
      assert.deepEqual(viewReadEur.portfolio, fromStoreEur);
      assert.deepEqual([viewRead.lotsProblem, viewRead.skippedRows, viewRead.unreadableCells], [null, [], []]);
    });

    it("gives the Monday briefing the view as text: generated from the store, the old file without one, nothing without either", async () => {
      assert.match(await store.readPortfolioView(), /^---\nschema_version: 2/);
      await seed();
      await put("stale text");
      assert.match(await store.readPortfolioView(), /Generated by the engine from `state\/portfolio\.json`/);
      await rm(join(vaultDir, "state"), { recursive: true });
      await rm(file());
      assert.equal(await store.readPortfolioView(), "");
    });
  });
});
