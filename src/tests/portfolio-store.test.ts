/**
 * The portfolio state port (#130, ADR-0015, ADR-0017): one read for every flow, whose result says what of
 * the file could not be read, the two policies a flow applies to that result, and the writes (lots and
 * prices) that take the model's values, never text. Temporary vault, no network. VAULT_PROJECT_DIR is set
 * before the first import of the engine.
 */
import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, stat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseTicker as tk } from "../ticker.js";
import type { PortfolioSnapshot } from "../types.js";
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

    it("the strict flows (the evaluation) refuse a Lots table that does not read, with the parser's own error", async () => {
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

  describe("refreshing the prices", () => {
    const prices = new Map([[tk("TCK"), 110]]);

    it("writes the current price and the P/L of the priced positions, and nothing else", async () => {
      const md = portfolioMd([TCK_ROW, "| OTH | 1 | 10 | 10 | 0 | — |"], [TCK_LOT]);
      await put(md);

      await store.recordPrices("USD", prices);

      const text = await readFile(file(), "utf8");
      assert.ok(text.includes("| TCK | 2 | 100 | 110,00 | 20,00 | 80 |"), text);
      assert.ok(text.includes("| OTH | 1 | 10 | 10 | 0 | — |"), "a ticker without a price is left alone");
      assert.equal(text.replace("| TCK | 2 | 100 | 110,00 | 20,00 | 80 |", TCK_ROW), md);
      const { portfolio } = await store.readPortfolio("USD");
      assert.deepEqual([portfolio.positions[0].currentPrice, portfolio.positions[0].pl], [110, 20]);
    });

    it("writes nothing when no value changes, or when there is no portfolio.md", async () => {
      await put(portfolioMd([TCK_ROW], [TCK_LOT]));
      await store.recordPrices("USD", new Map());
      assert.equal(await readFile(file(), "utf8"), portfolioMd([TCK_ROW], [TCK_LOT]));

      await rm(file(), { force: true });
      await store.recordPrices("USD", prices);
      await assert.rejects(() => readFile(file(), "utf8"), { code: "ENOENT" });
    });

    it("refuses a file in another schema_version", async () => {
      await put(portfolioMd([TCK_ROW], [TCK_LOT]).replace("schema_version: 2", "schema_version: 1"));
      await assert.rejects(() => store.recordPrices("USD", prices), /schema_version/);
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

    describe("how stale a silo is (#138): the age of its latest snapshot, and a silo with none is stale", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the test edits a document of a shape it makes
      const edit = async (change: (doc: any) => void): Promise<void> => {
        const doc = JSON.parse(await stored());
        change(doc);
        await writeFile(storeFile(), JSON.stringify(doc), "utf8");
      };
      const staleWarnings = () => warnings.filter((w) => w.includes("snapshot"));

      it("names a silo with trades and no snapshot stale, and says so once per silo", async () => {
        await seed();
        await edit((d) => {
          delete d.silos.USD.reconciled;
          delete d.silos.EUR.reconciled;
        });
        const usd = await store.readPortfolio("USD");
        assert.deepEqual(usd.staleness, { asOf: null, ageDays: null, stale: true });
        assert.equal(usd.portfolio.lots.length, 1, "the silo has trades");
        assert.match(staleWarnings().join("\n"), /the USD silo has no snapshot of the broker, so it is stale/);
        warnings.length = 0;
        const both = await store.readBothPortfolios();
        assert.deepEqual([both.EUR?.staleness?.stale, both.USD?.staleness?.stale], [true, true]);
        assert.equal(staleWarnings().length, 2);
      });

      it("does not name a silo with no trades stale while its snapshot is recent, whatever its last change", async () => {
        await store.seedStore(new Date());
        await edit((d) => {
          d.silos.EUR.synced_at = "2020-01-01T00:00:00.000Z";
        });
        const eur = await store.readPortfolio("EUR");
        assert.equal(eur.portfolio.lots.length, 0, "the silo has no trades");
        assert.equal(eur.staleness?.stale, false);
        assert.deepEqual(staleWarnings(), []);
      });

      it("names a silo stale when its latest snapshot is older than the limit, with its date", async () => {
        await store.seedStore(new Date("2020-01-01T00:00:00Z"));
        const read = await store.readPortfolio("USD");
        assert.equal(read.staleness?.stale, true);
        assert.equal(read.staleness?.asOf, "2020-01-01");
        assert.match(
          staleWarnings().join("\n"),
          /the USD silo's latest snapshot is from 2020-01-01, \d+ days ago: it is stale/,
        );
      });

      it("a store made from portfolio.md without last_manual_sync is stale, not synced now", async () => {
        await put(portfolioMd([TCK_ROW], [TCK_LOT]).replace(/last_manual_sync:.*\n/, ""));
        const { storeFromPortfolioFile } = store;
        const seeded = await storeFromPortfolioFile();
        assert.equal(seeded.silos.USD?.reconciled, undefined);
        await store.saveStore(seeded);
        assert.equal((await store.readPortfolio("USD")).staleness?.stale, true);
      });
    });

    describe("prices are telemetry, never state (#133)", () => {
      const telemetryFile = () => join(vaultDir, "telemetry", "prices-usd.json");
      const TCK_AT_110 = new Map([[tk("TCK"), 110]]);
      const viewRow = (price: string, pl: string) =>
        new RegExp(`\\| TCK \\| 2 \\| 100\\.00 \\| ${price} \\| ${pl} \\| 80\\.00 \\|`);
      const quiet = async <T>(fn: () => Promise<T>): Promise<[T, string[]]> => {
        const warn = mock.method(console, "warn", () => {});
        try {
          return [await fn(), warn.mock.calls.map((c) => String(c.arguments[0]))];
        } finally {
          warn.mock.restore();
        }
      };

      beforeEach(async () => {
        await rm(join(vaultDir, "telemetry"), { recursive: true, force: true });
      });

      it("a refresh writes no byte of the store: the last price goes to telemetry/prices-usd.json", async () => {
        await seed();
        const state = [await stored(), await readFile(join(vaultDir, "state", "portfolio.last-readable.json"), "utf8")];

        await store.recordPrices("USD", TCK_AT_110);

        assert.deepEqual(
          [await stored(), await readFile(join(vaultDir, "state", "portfolio.last-readable.json"), "utf8")],
          state,
        );
        assert.deepEqual(JSON.parse(await readFile(telemetryFile(), "utf8")).silos.USD.TCK, {
          price: "110",
          volume: "2",
          avg_price: "100",
        });
      });

      it("every read, and the view, still show the last price and its P/L", async () => {
        await seed();
        await store.recordPrices("USD", TCK_AT_110);

        const { portfolio } = await store.readPortfolio("USD");
        assert.deepEqual([portfolio.positions[0].currentPrice, portfolio.positions[0].pl], [110, 20]);
        const last = await store.readPortfolio("USD", { lastReadable: true });
        assert.deepEqual([last.portfolio.positions[0].currentPrice, last.portfolio.positions[0].pl], [110, 20]);
        assert.match(await readFile(file(), "utf8"), viewRow("110\\.00", "20\\.00"));
        assert.match(await store.readPortfolioView(), viewRow("110\\.00", "20\\.00"));
        assert.deepEqual(
          (await store.readStoreIfAny())?.silos.USD?.positions.map((p) => p.currentPrice),
          [100],
          "the store, the state ingest works on, is as the owner last told it",
        );
      });

      it("writes nothing when no price changes", async () => {
        await seed();
        await store.recordPrices("USD", TCK_AT_110);
        const before = [await readFile(telemetryFile(), "utf8"), await readFile(file(), "utf8")];
        const mtime = (await stat(telemetryFile())).mtimeMs;

        await store.recordPrices("USD", TCK_AT_110);
        await store.recordPrices("USD", new Map());

        assert.deepEqual([await readFile(telemetryFile(), "utf8"), await readFile(file(), "utf8")], before);
        assert.equal((await stat(telemetryFile())).mtimeMs, mtime);
      });

      it("does not show a price seen before the position changed: an ingest that buys shows the buy price until the next refresh", async () => {
        await seed();
        await store.recordPrices("USD", TCK_AT_110);
        const state = (await store.readStoreIfAny())!;
        const usd = state.silos.USD!;
        await store.saveStore({
          ...state,
          silos: {
            ...state.silos,
            USD: { ...usd, positions: usd.positions.map((p) => ({ ...p, volume: 3, avgPrice: 104 })) },
          },
        });

        assert.equal((await store.readPortfolio("USD")).portfolio.positions[0].currentPrice, 100);
        assert.match(await readFile(file(), "utf8"), /\| TCK \| 3 \| 104\.00 \| 100\.00 \|/);

        await store.recordPrices("USD", new Map([[tk("TCK"), 112]]));
        assert.equal((await store.readPortfolio("USD")).portfolio.positions[0].currentPrice, 112);
      });

      it("a silo's refresh leaves the other silo's last prices, and its file, as they were", async () => {
        await seed();
        await store.recordPrices("USD", TCK_AT_110);
        const usd = await readFile(telemetryFile(), "utf8");
        await store.recordPrices("EUR", new Map([[tk("TCK"), 1]]));
        assert.equal((await store.readPortfolio("USD")).portfolio.positions[0].currentPrice, 110);
        assert.equal(await readFile(telemetryFile(), "utf8"), usd, "each heartbeat writes its own file");
      });

      it("a telemetry file that does not read is said and ignored: it never stops a read, and the next refresh writes it again", async () => {
        await seed();
        await mkdir(join(vaultDir, "telemetry"), { recursive: true });
        await writeFile(telemetryFile(), "{ not json", "utf8");

        const [read, warned] = await quiet(() => store.readPortfolio("USD"));
        assert.equal(read.portfolio.positions[0].currentPrice, 100, "the state's price");
        assert.match(warned.join("\n"), /telemetry\/prices-usd\.json: file: is not valid JSON/);

        await quiet(() => store.recordPrices("USD", TCK_AT_110));
        assert.equal((await store.readPortfolio("USD")).portfolio.positions[0].currentPrice, 110);
      });

      it("the view a refresh generates keeps account_env, where readAccountEnv finds it", async () => {
        await put(
          portfolioMd([TCK_ROW], [TCK_LOT]).replace("schema_version: 2\n", "schema_version: 2\naccount_env: demo\n"),
        );
        await seed();
        await rm(file());
        await store.recordPrices("USD", TCK_AT_110);
        const { readAccountEnv } = await import("../vault-io.js");
        assert.equal(await readAccountEnv(), "demo");
      });

      it("a store that does not read is not the base of a price: nothing is written and the run goes on", async () => {
        await seed();
        await writeFile(storeFile(), "{ not json", "utf8");
        const [, warned] = await quiet(() => store.recordPrices("USD", TCK_AT_110));
        assert.match(warned.join("\n"), /prices not updated/);
        await assert.rejects(() => stat(telemetryFile()), { code: "ENOENT" });
      });

      it("a silo the store does not hold is not priced", async () => {
        await seed();
        const doc = JSON.parse(await stored());
        delete doc.silos.USD;
        await writeFile(storeFile(), JSON.stringify(doc), "utf8");
        await store.recordPrices("USD", TCK_AT_110);
        await assert.rejects(() => stat(telemetryFile()), { code: "ENOENT" });
      });
    });

    it("the view is the state in the tables the old reader reads: written, then read back, the model is the same", async () => {
      await seed();
      // The snapshot of the broker (#138) is the store's alone: the tables of the view do not carry it.
      const withoutSnapshot = <C extends "EUR" | "USD">(read: { portfolio: PortfolioSnapshot<C> }) => {
        const { reconciled: _reconciled, ...rest } = read.portfolio;
        return rest;
      };
      const fromStore = withoutSnapshot(await store.readPortfolio("USD"));
      const fromStoreEur = withoutSnapshot(await store.readPortfolio("EUR"));
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
