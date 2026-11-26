/**
 * `inbox:ingest` (#132, spec #124, ADR-0018): the batches in `inbox/` applied all or nothing to the engine's own
 * store, the file moved to `applied/` or `rejected/`, `portfolio.md` a generated view. Temporary vault, no network.
 * VAULT_PROJECT_DIR is set before the first import of the engine.
 */
import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { entryContext, portfolioMd, watchlistMd } from "./fixtures/inbox.js";

const batch = (...commands: string[]): string =>
  `schema_version: 1\ncommands:\n${commands.map((c) => `  - ${c.replace(/\n/g, "\n    ")}`).join("\n")}\n`;
const BUY = (over = "") =>
  `command: buy\nticker: SAP.DE\ndate: 2026-09-15\nunits: 2\nprice: 100 EUR${over ? `\n${over}` : ""}`;
const STOP = "command: set_stop\nticker: SAP.DE\nprice: 90 EUR";
const BUY_ON = (date: string) => `command: buy\nticker: SAP.DE\ndate: ${date}\nunits: 2\nprice: 100 EUR`;
const SELL = (units = 2, over = "") =>
  `command: sale\nticker: SAP.DE\ndate: 2026-09-20\nunits: ${units}\nprice: 110 EUR${over ? `\n${over}` : ""}`;

describe("inbox:ingest", () => {
  let vaultDir: string;
  let inbox: typeof import("../inbox.js");
  let store: typeof import("../portfolio-store.js");
  const dir = (...parts: string[]) => join(vaultDir, ...parts);
  const drop = (name: string, text: string) => writeFile(dir("inbox", name), text, "utf8");
  const ls = (...parts: string[]) =>
    readdir(dir(...parts)).then(
      (names) => names.sort(),
      () => [] as string[],
    );
  const read = (...parts: string[]) => readFile(dir(...parts), "utf8");
  const storeText = () => read("state", "portfolio.json");
  const log = async () =>
    (await read("logs", "decisions.jsonl").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  /** The temporary file the store is written through is a folder: the write fails, the read of a store that is not there does not. */
  const blockStoreWrite = () => mkdir(dir("state", `portfolio.json.${process.pid}.tmp`), { recursive: true });

  /** Every file of the vault with its bytes: what "changes nothing" is measured against. */
  async function snapshot(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const entry of await readdir(vaultDir, { withFileTypes: true, recursive: true })) {
      if (entry.isFile())
        out[join(entry.parentPath, entry.name).slice(vaultDir.length)] = await readFile(
          join(entry.parentPath, entry.name),
          "utf8",
        );
    }
    return out;
  }

  before(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "finance-agent-ingest-"));
    process.env.VAULT_PROJECT_DIR = vaultDir;
    mock.method(console, "warn", () => {});
    mock.method(console, "log", () => {});
    inbox = await import("../inbox.js");
    store = await import("../portfolio-store.js");
  });
  after(async () => {
    mock.restoreAll();
    await rm(vaultDir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    for (const name of await readdir(vaultDir)) await rm(dir(name), { recursive: true, force: true });
    await mkdir(dir("inbox"), { recursive: true });
    await mkdir(dir("strategies"), { recursive: true });
    await writeFile(dir("strategies", "base.md"), `---\nversion: "1.4"\n---\n`, "utf8");
    // The old file the first ingest seeds the store from: 1000.00 EUR and 500.00 USD, no positions.
    await writeFile(dir("portfolio.md"), portfolioMd(), "utf8");
    // The file the rules of an entry read: what is bought below is on it, so only the setup is missing.
    await writeFile(
      dir("watchlist.md"),
      watchlistMd([
        ["SAP.DE", "EUR"],
        ["KO", "USD"],
        ["DUST", "EUR"],
      ]),
      "utf8",
    );
  });

  it("says an empty inbox is nothing to apply and writes nothing", async () => {
    const before = await snapshot();
    assert.deepEqual(await inbox.ingestInbox(), { lines: ["Inbox is empty: nothing to apply."], exitCode: 0 });
    assert.deepEqual(await snapshot(), before);
  });

  describe("a clean batch", () => {
    beforeEach(async () => {
      await drop("2026-11-12.yaml", batch("command: deposit\namount: 250.50 EUR", BUY("costs: 1.50 EUR"), STOP));
    });

    it("is applied to the store, moved to applied/, and the view is generated from the store", async () => {
      const result = await inbox.ingestInbox(new Date("2026-11-12T09:00:00Z"));
      assert.equal(result.exitCode, 0);
      assert.match(result.lines.join("\n"), /Applied 1 batch\(es\): inbox\/2026-11-12\.yaml/);
      assert.deepEqual(await ls("inbox"), ["applied"]);
      assert.deepEqual(await ls("inbox", "applied"), ["2026-11-12.yaml"]);

      const doc = JSON.parse(await storeText());
      assert.equal(doc.schema_version, 1);
      assert.equal(doc.silos.EUR.cash, "1049.00 EUR"); // 1000 + 250.50 - 2 x 100 - 1.50
      assert.equal(doc.silos.EUR.synced_at, "2026-11-12T09:00:00.000Z");
      assert.equal(doc.silos.USD.cash, "500.00 USD");
      assert.equal(doc.silos.USD.synced_at, "2099-01-01T00:00:00.000Z", "a silo no command touched keeps its time");
      assert.deepEqual(
        doc.silos.EUR.positions.map((p: Record<string, unknown>) => [p.ticker, p.volume, p.avg_price, p.stop_loss]),
        [["SAP.DE", "2", "100", "90"]],
      );
      const [lot] = doc.silos.EUR.lots;
      assert.deepEqual(
        [
          lot.ticker,
          lot.units,
          lot.entry_price,
          lot.initial_stop,
          lot.entry_costs,
          lot.origin,
          lot.rules_version,
          lot.rules_violations,
        ],
        ["SAP.DE", "2", "100", "90", "1.50 EUR", "propietario", "1.4", ["entry_without_setup"]],
      );
      assert.match(await read("portfolio.md"), /Generated by the engine from `state\/portfolio\.json`/);
      assert.match(await read("portfolio.md"), /\| Available cash \| 1049,00 € \|/);
    });

    it("is what every flow reads afterwards, through the port: portfolio.md is no longer the source", async () => {
      await inbox.ingestInbox();
      // Whatever is edited in the view is overwritten by the engine and never read.
      await writeFile(dir("portfolio.md"), "not a portfolio", "utf8");
      const eur = (await store.readPortfolio("EUR")).portfolio;
      assert.equal(eur.cash, 1049);
      assert.deepEqual(
        eur.lots.map((l) => [l.ticker, l.units, l.rulesVersion]),
        [["SAP.DE", 2, "1.4"]],
      );
      assert.equal((await store.readPortfolio("USD")).portfolio.cash, 500);
    });

    it("leaves the lot's decision-log line: the entry of the lot", async () => {
      await inbox.ingestInbox();
      const lines = await log();
      const [entry] = lines;
      assert.equal(lines.length, 1);
      const doc = JSON.parse(await storeText());
      assert.deepEqual(
        [
          entry.type,
          entry.id,
          entry.source,
          entry.origin,
          entry.units,
          entry.amount,
          entry.costs,
          entry.stop_initial,
          entry.rules_version,
        ],
        ["entry", doc.silos.EUR.lots[0].entry_id, "portfolio-sync", "propietario", 2, 200, 1.5, 90, "1.4"],
      );
      // ... and the lots check, which decision:record and the evaluation refuse a mismatch with, finds none.
      const { lotsMismatches } = await import("../utils/lots-check.js");
      const { readDecisionHistory } = await import("../vault-io.js");
      assert.deepEqual(lotsMismatches((await store.readPortfolio("EUR")).portfolio, await readDecisionHistory()), []);
    });

    it("applied twice by a run that could not move the file: the second run moves it and applies nothing", async () => {
      await mkdir(dir("elsewhere"));
      await symlink(dir("elsewhere"), dir("inbox", "applied")); // a destination that is not a real folder
      await assert.rejects(inbox.ingestInbox(), /inbox\/applied is not a real folder/);
      const applied = await storeText();
      assert.deepEqual(await ls("inbox"), ["2026-11-12.yaml", "applied"]);
      assert.equal((await log()).length, 1);

      await rm(dir("inbox", "applied"));
      const again = await inbox.ingestInbox();
      assert.equal(again.exitCode, 0);
      assert.deepEqual(await ls("inbox", "applied"), ["2026-11-12.yaml"]);
      const doc = JSON.parse(await storeText());
      assert.equal(doc.silos.EUR.cash, "1049.00 EUR", "the deposit and the buy were not applied again");
      assert.equal(doc.silos.EUR.lots.length, 1);
      assert.deepEqual(doc.unmoved_batches, [], "the store forgets a batch once its file has moved");
      assert.equal(JSON.parse(applied).unmoved_batches.length, 1);
      assert.equal((await log()).length, 1, "the decision lines were not written twice");
    });

    it("an identical file dropped again later is a new batch: it is applied again", async () => {
      await inbox.ingestInbox();
      await drop("2026-11-12.yaml", batch("command: deposit\namount: 10 EUR"));
      await inbox.ingestInbox();
      await drop("2026-11-12.yaml", batch("command: deposit\namount: 10 EUR"));
      await inbox.ingestInbox();
      assert.equal(JSON.parse(await storeText()).silos.EUR.cash, "1069.00 EUR");
      assert.deepEqual(await ls("inbox", "applied"), ["2026-11-12-2.yaml", "2026-11-12-3.yaml", "2026-11-12.yaml"]);
    });
  });

  describe("a conversion between the silos (#135)", () => {
    const CONVERT = "command: convert\namount: 1100 EUR\nreceived: 1320 USD\ncosts: 5 EUR";
    const KO_BUY = "command: buy\nticker: KO\ndate: 2026-09-15\nunits: 10\nprice: 100 USD";

    it("moves the cash of both silos in one write: a deposit, a conversion and a buy that spends the converted cash", async () => {
      await drop("a.yaml", batch("command: deposit\namount: 100 EUR", CONVERT, KO_BUY));
      const result = await inbox.ingestInbox(new Date("2026-11-12T09:00:00Z"));
      assert.equal(result.exitCode, 0, result.lines.join("\n"));
      const doc = JSON.parse(await storeText());
      assert.equal(doc.silos.EUR.cash, "0.00 EUR"); // 1000 + 100 - 1100
      assert.equal(doc.silos.USD.cash, "820.00 USD"); // 500 + 1320 - 10 x 100
      assert.equal(doc.silos.EUR.synced_at, "2026-11-12T09:00:00.000Z");
      assert.equal(doc.silos.USD.synced_at, "2026-11-12T09:00:00.000Z");
      assert.deepEqual(await ls("inbox", "applied"), ["a.yaml"]);
    });

    it("applies all or nothing: a batch whose last command fails leaves both silos as they were", async () => {
      await drop("a.yaml", batch("command: deposit\namount: 1 EUR"));
      await inbox.ingestInbox();
      const stored = await storeText();
      await drop("b.yaml", batch(CONVERT, "command: withdrawal\namount: 99999 USD"));
      const result = await inbox.ingestInbox();
      assert.equal(result.exitCode, 1);
      assert.equal(await storeText(), stored);
      assert.deepEqual(await ls("inbox", "rejected"), ["b.yaml", "b.yaml.errors.txt"]);
    });

    it("writes one fx_conversion line per conversion, so the shadow portfolio sees it (ADR-0009 §1)", async () => {
      await drop(
        "a.yaml",
        batch(
          "command: convert\namount: 100 EUR\nrate: 1.17\ncosts: 1 EUR\ndate: 2026-11-10",
          "command: convert\namount: 200 EUR\nreceived: 234 USD",
        ),
      );
      assert.equal((await inbox.ingestInbox(new Date("2026-11-12T09:00:00Z"))).exitCode, 0);
      assert.equal(JSON.parse(await storeText()).silos.USD.cash, "849.83 USD"); // 500 + 99 x 1.17 + 234
      const lines = (await log()).map((d) => ({
        type: d.type,
        date: d.date,
        ticker: d.ticker,
        currency: d.currency,
        amount: d.amount,
        costs: d.costs,
        fx_rate: d.fx_rate,
        source: d.source,
      }));
      assert.deepEqual(lines, [
        {
          type: "fx_conversion",
          date: "2026-11-10",
          ticker: null,
          currency: "EUR",
          amount: 100,
          costs: 1,
          fx_rate: 1.17,
          source: "portfolio-sync",
        },
        // No date: the day of the run. The rate is what arrived over what was converted, before the fee (here no fee).
        {
          type: "fx_conversion",
          date: "2026-11-12",
          ticker: null,
          currency: "EUR",
          amount: 200,
          costs: 0,
          fx_rate: 1.17,
          source: "portfolio-sync",
        },
      ]);
    });

    it("writes no line for a batch that is refused", async () => {
      await drop("a.yaml", batch(CONVERT, "command: withdrawal\namount: 99999 USD"));
      assert.equal((await inbox.ingestInbox()).exitCode, 1);
      assert.deepEqual(await log(), []);
    });
  });

  describe("a snapshot of the broker (#138)", () => {
    const DAY = new Date("2026-11-26T10:00:00Z");
    // The store is seeded with 1000.00 EUR and 500.00 USD and no position; the batch buys 2 SAP.DE for 200 EUR.
    const SNAP = (cash: string, positions: string, date = "2026-11-25", currency = "EUR") =>
      `command: snapshot\ndate: ${date}\ncash: ${cash} ${currency}\npositions: ${positions}`;
    const OWN = "\n  - ticker: SAP.DE\n    units: 2";
    const siloOf = async (currency: "EUR" | "USD" = "EUR") => JSON.parse(await storeText()).silos[currency];
    const reconcileLines = async () => (await log()).filter((d) => d.type === "reconcile");

    it("changes no cash, position or lot: it records the difference and the day, and the state is what the batch left", async () => {
      await drop("a.yaml", batch(BUY(), STOP, SNAP("812.50", "[]")));
      const result = await inbox.ingestInbox(DAY);
      assert.equal(result.exitCode, 0, result.lines.join("\n"));
      const eur = await siloOf();
      assert.equal(eur.cash, "800.00 EUR", "the engine keeps its own cash: 1000 - 200");
      assert.equal(eur.positions.length, 1);
      assert.equal(eur.lots.length, 1);
      assert.deepEqual(eur.reconciled, {
        date: "2026-11-25",
        recorded_on: "2026-11-26",
        differences: [
          { kind: "cash", broker: "812.50 EUR", engine: "800.00 EUR" },
          { kind: "position", ticker: "SAP.DE", broker: "0", engine: "2" },
        ],
      });
      assert.equal((await siloOf("USD")).reconciled, undefined, "the other silo was not compared");
      assert.deepEqual(await ls("inbox", "applied"), ["a.yaml"]);
    });

    it("says each difference in its output, as a warning that does not stop the batch", async () => {
      await drop("a.yaml", batch(SNAP("1010.50", "[]")));
      const { lines, exitCode } = await inbox.ingestInbox(DAY);
      assert.equal(exitCode, 0);
      assert.ok(
        lines.includes(
          "inbox/a.yaml: command 1, line 3: warning: the EUR snapshot as of 2026-11-25 differs from the state in the cash: the broker has 1010.50 EUR, the engine 1000.00 EUR (+10.50 EUR)",
        ),
        lines.join("\n"),
      );
    });

    it("writes one reconcile line per difference: the ticker or no ticker for the cash, what each side holds, its size, the snapshot date", async () => {
      await drop("a.yaml", batch(BUY(), STOP, SNAP("812.50", `\n  - ticker: KO\n    units: 3`, "2026-11-24")));
      assert.equal((await inbox.ingestInbox(DAY)).exitCode, 0);
      const lines = await reconcileLines();
      assert.deepEqual(
        lines.map((d) => [
          d.ticker ?? null,
          d.currency,
          d.date,
          d.broker,
          d.engine,
          d.difference,
          d.origin,
          d.source,
          d.rules_version,
        ]),
        [
          [null, "EUR", "2026-11-24", 812.5, 800, 12.5, "propietario", "portfolio-sync", "1.4"],
          ["KO", "EUR", "2026-11-24", 3, 0, 3, "propietario", "portfolio-sync", "1.4"],
          ["SAP.DE", "EUR", "2026-11-24", 0, 2, -2, "propietario", "portfolio-sync", "1.4"],
        ],
      );
      assert.equal(new Set(lines.map((d) => d.id)).size, 3, "each line has its own id");
    });

    it("a snapshot that agrees with the state writes no line and records an empty list of differences", async () => {
      await drop("a.yaml", batch(BUY(), STOP, SNAP("800.00", OWN)));
      assert.equal((await inbox.ingestInbox(DAY)).exitCode, 0);
      assert.deepEqual(await reconcileLines(), []);
      assert.deepEqual((await siloOf()).reconciled, {
        date: "2026-11-25",
        recorded_on: "2026-11-26",
        differences: [],
      });
    });

    it("a later snapshot replaces the differences of the earlier one", async () => {
      await drop("a.yaml", batch(SNAP("1.00", "[]", "2026-11-20")));
      await inbox.ingestInbox(DAY);
      assert.equal((await siloOf()).reconciled.differences.length, 1);
      await drop("b.yaml", batch(SNAP("1000.00", "[]", "2026-11-25")));
      await inbox.ingestInbox(DAY);
      assert.deepEqual((await siloOf()).reconciled, {
        date: "2026-11-25",
        recorded_on: "2026-11-26",
        differences: [],
      });
    });

    it("rejects a snapshot dated in the future and keeps the state as it was", async () => {
      await drop("a.yaml", batch(SNAP("1000.00", "[]", "2026-11-27")));
      const { lines, exitCode } = await inbox.ingestInbox(DAY);
      assert.equal(exitCode, 1);
      assert.match(lines.join("\n"), /the snapshot's date 2026-11-27 is in the future \(today is 2026-11-26\)/);
      assert.deepEqual(await ls("inbox", "rejected"), ["a.yaml", "a.yaml.errors.txt"]);
      assert.deepEqual(await ls("state"), [], "nothing was applied, so no store was made");
    });
  });

  describe("a split (#137)", () => {
    const SPLIT = (ratio: string, over = "") =>
      `command: split\nticker: SAP.DE\ndate: 2026-10-01\nratio: ${ratio}${over ? `\n${over}` : ""}`;
    const DAY = new Date("2026-11-12T09:00:00Z");
    const eurSilo = async () => JSON.parse(await storeText()).silos.EUR;
    const splitLines = async () => (await log()).filter((d) => d.type === "split");
    /** What the lots check, which the evaluation refuses a mismatch with, says of the store and the log. */
    const mismatches = async () => {
      const { lotsMismatches } = await import("../utils/lots-check.js");
      const { readDecisionHistory } = await import("../vault-io.js");
      const history = await readDecisionHistory();
      return [
        ...lotsMismatches((await store.readPortfolio("EUR")).portfolio, history),
        ...lotsMismatches((await store.readPortfolio("USD")).portfolio, history),
      ];
    };
    const rOfTrades = async () => {
      const { closedTrades } = await import("../utils/decisions-evaluation.js");
      const { readDecisionHistory } = await import("../vault-io.js");
      return closedTrades(await readDecisionHistory()).map((t) => t.rNet);
    };

    it("scales the open lots and the position of a held ticker, and leaves the cash, the costs and the other silo alone", async () => {
      await drop("a.yaml", batch(BUY("costs: 1.50 EUR\nunits: 5").replace("units: 2\n", ""), STOP));
      const first = await inbox.ingestInbox(DAY);
      assert.equal(first.exitCode, 0, first.lines.join("\n"));
      const before = await eurSilo();
      await drop("b.yaml", batch(SPLIT("4 for 1")));
      const result = await inbox.ingestInbox(DAY);
      assert.equal(result.exitCode, 0, result.lines.join("\n"));
      const after = await eurSilo();
      const [lot] = after.lots;
      assert.deepEqual(
        [lot.units, lot.entry_units, lot.entry_price, lot.initial_stop, lot.entry_costs],
        ["20", "20", "25", "22.5", "1.50 EUR"],
      );
      assert.deepEqual(
        after.positions.map((p: Record<string, unknown>) => [p.ticker, p.volume, p.avg_price, p.stop_loss]),
        [["SAP.DE", "20", "25", "22.5"]],
      );
      assert.equal(after.cash, before.cash);
      assert.deepEqual(await ls("inbox", "applied"), ["a.yaml", "b.yaml"]);
      assert.deepEqual(await mismatches(), []);
    });

    it("writes one split line, with the ticker, the silo, the ratio and the date of the split", async () => {
      await drop("a.yaml", batch(BUY("units: 10").replace("units: 2\n", ""), STOP, SPLIT("4 for 1")));
      assert.equal((await inbox.ingestInbox(DAY)).exitCode, 0);
      const [line, ...more] = await splitLines();
      assert.deepEqual(more, []);
      assert.deepEqual(
        [
          line.type,
          line.ticker,
          line.currency,
          line.date,
          line.split_ratio,
          line.source,
          line.origin,
          line.rules_version,
        ],
        ["split", "SAP.DE", "EUR", "2026-10-01", 4, "portfolio-sync", "propietario", "1.4"],
      );
    });

    it("a reverse split divides the units and multiplies the price: 1 for 10", async () => {
      await drop(
        "a.yaml",
        batch(
          "command: buy\nticker: SAP.DE\ndate: 2026-09-15\nunits: 100\nprice: 10 EUR",
          "command: set_stop\nticker: SAP.DE\nprice: 9 EUR",
        ),
      );
      await inbox.ingestInbox(DAY);
      await drop("b.yaml", batch(SPLIT("1 for 10")));
      assert.equal((await inbox.ingestInbox(DAY)).exitCode, 0);
      const [lot] = (await eurSilo()).lots;
      assert.deepEqual([lot.units, lot.entry_units, lot.entry_price, lot.initial_stop], ["10", "10", "100", "90"]);
      assert.equal((await splitLines())[0].split_ratio, 0.1);
      assert.deepEqual(await mismatches(), []);
    });

    it("a split in the same batch as the buy leaves the entry line as it was bought, and the lot split", async () => {
      await drop(
        "a.yaml",
        batch("command: buy\nticker: SAP.DE\ndate: 2026-09-15\nunits: 10\nprice: 100 EUR", STOP, SPLIT("2 for 1")),
      );
      const result = await inbox.ingestInbox(DAY);
      assert.equal(result.exitCode, 0, result.lines.join("\n"));
      const [lot] = (await eurSilo()).lots;
      assert.deepEqual([lot.units, lot.entry_units, lot.entry_price, lot.initial_stop], ["20", "20", "50", "45"]);
      const [entry] = (await log()).filter((d) => d.type === "entry");
      assert.deepEqual([entry.units, entry.price, entry.amount, entry.stop_initial], [10, 100, 1000, 90]);
      assert.deepEqual(await mismatches(), []);
    });

    it("a sale after the split sells the adjusted lots, oldest first, and measures R as if it had never split", async () => {
      await drop(
        "a.yaml",
        batch(
          "command: buy\nticker: SAP.DE\ndate: 2026-09-01\nunits: 4\nprice: 100 EUR",
          "command: buy\nticker: SAP.DE\ndate: 2026-09-10\nunits: 4\nprice: 110 EUR",
          "command: set_stop\nticker: SAP.DE\nprice: 90 EUR",
        ),
      );
      const first = await inbox.ingestInbox(DAY);
      assert.equal(first.exitCode, 0, first.lines.join("\n"));
      await drop(
        "b.yaml",
        batch(SPLIT("2 for 1"), "command: sale\nticker: SAP.DE\ndate: 2026-10-05\nunits: 10\nprice: 60 EUR"),
      );
      const result = await inbox.ingestInbox(DAY);
      assert.equal(result.exitCode, 0, result.lines.join("\n"));
      const silo = await eurSilo();
      assert.deepEqual(
        silo.lots.map((l: Record<string, string>) => [l.units, l.entry_units, l.entry_price]),
        [["6", "8", "55"]],
      );
      const exits = (await log()).filter((d) => d.type === "exit");
      assert.deepEqual(
        exits.map((e) => [e.units, e.entry_price, e.entry_units, e.lot_units_left]),
        [
          [8, 50, 8, 0],
          [2, 55, 8, 6],
        ],
      );
      // The first lot: entry 100, stop 90, sold at 120 (60 x 2): +2R. It is closed; the second lot is still open (6 of 8).
      assert.deepEqual(await rOfTrades(), [2]);
      assert.deepEqual(await mismatches(), []);
    });

    it("a sale before the split in the same batch, and one after it, are one trade of the same R", async () => {
      await drop(
        "a.yaml",
        batch(
          "command: buy\nticker: SAP.DE\ndate: 2026-09-15\nunits: 10\nprice: 100 EUR",
          STOP,
          "command: sale\nticker: SAP.DE\ndate: 2026-09-20\nunits: 4\nprice: 110 EUR",
          SPLIT("2 for 1"),
          "command: sale\nticker: SAP.DE\ndate: 2026-10-05\nunits: 12\nprice: 55 EUR",
        ),
      );
      const result = await inbox.ingestInbox(DAY);
      assert.equal(result.exitCode, 0, result.lines.join("\n"));
      assert.deepEqual((await eurSilo()).lots, []);
      const exits = (await log()).filter((d) => d.type === "exit");
      assert.deepEqual(
        exits.map((e) => [e.units, e.entry_units, e.entry_price, e.stop_initial, e.lot_units_left]),
        [
          [4, 10, 100, 90, 6],
          [12, 20, 50, 45, 0],
        ],
      );
      // 4 of 10 at +1R, and 6 of 10 (12 of 20 after the split) at +1R.
      assert.deepEqual(await rOfTrades(), [1]);
    });

    it("refuses a ticker with no open lot, a ratio of 1 and a date before the lot, and changes nothing", async () => {
      await drop("a.yaml", batch(BUY("units: 10").replace("units: 2\n", ""), STOP));
      await inbox.ingestInbox(DAY);
      const stored = await storeText();
      const logged = await log();
      for (const [name, command] of [
        ["no-lot", "command: split\nticker: KO\ndate: 2026-10-01\nratio: 2 for 1"],
        ["one", SPLIT("3 for 3")],
        ["early", SPLIT("2 for 1").replace("2026-10-01", "2026-09-14")],
      ] as const) {
        await drop(`${name}.yaml`, batch("command: deposit\namount: 5 EUR", command));
        const refused = await inbox.ingestInbox(DAY);
        assert.equal(refused.exitCode, 1, name);
        assert.equal(await storeText(), stored, name);
        assert.deepEqual(await log(), logged, name);
      }
      assert.deepEqual(await ls("inbox", "rejected"), [
        "early.yaml",
        "early.yaml.errors.txt",
        "no-lot.yaml",
        "no-lot.yaml.errors.txt",
        "one.yaml",
        "one.yaml.errors.txt",
      ]);
    });

    it("refuses a reverse split that leaves a fraction and applies all or nothing: the batch before it is not kept", async () => {
      await drop(
        "a.yaml",
        batch(
          "command: buy\nticker: SAP.DE\ndate: 2026-09-15\nunits: 15\nprice: 10 EUR",
          "command: set_stop\nticker: SAP.DE\nprice: 9 EUR",
        ),
      );
      await inbox.ingestInbox(DAY);
      const stored = await storeText();
      await drop("b.yaml", batch("command: deposit\namount: 5 EUR", SPLIT("1 for 10")));
      const result = await inbox.ingestInbox(DAY);
      assert.equal(result.exitCode, 1);
      assert.match(
        result.lines.join("\n"),
        /inbox\/b\.yaml: command 2, line \d+: cannot split SAP\.DE 1 for 10: lot ".*" would be left with 1\.5 units/,
      );
      assert.equal(await storeText(), stored);
      assert.deepEqual(await splitLines(), []);
    });
  });

  describe("a refused batch", () => {
    it("changes nothing: a batch that fails on its last command leaves the store byte-identical", async () => {
      await drop("a-clean.yaml", batch("command: deposit\namount: 1 EUR"));
      await inbox.ingestInbox();
      const stored = await storeText();
      const view = await read("portfolio.md");
      const entries = await log();

      await drop(
        "b-bad.yaml",
        batch("command: deposit\namount: 5 EUR", BUY(), "command: withdrawal\namount: 99999 EUR"),
      );
      const result = await inbox.ingestInbox();

      assert.equal(result.exitCode, 1);
      assert.equal(await storeText(), stored);
      assert.equal(await read("portfolio.md"), view);
      assert.deepEqual(await log(), entries);
    });

    it("is moved to rejected/ with each error as command position, line and reason", async () => {
      await drop("b-bad.yaml", batch("command: deposit\namount: 5 EUR", "command: withdrawal\namount: 99999 EUR"));
      const result = await inbox.ingestInbox();
      assert.equal(result.exitCode, 1);
      assert.deepEqual(await ls("inbox"), ["rejected"]);
      assert.deepEqual(await ls("inbox", "rejected"), ["b-bad.yaml", "b-bad.yaml.errors.txt"]);
      assert.match(
        await read("inbox", "rejected", "b-bad.yaml.errors.txt"),
        /^command 2, line 5: the withdrawal of 99999\.00 EUR exceeds the available cash of 1005\.00 EUR\n$/,
      );
      assert.match(result.lines.join("\n"), /inbox\/b-bad\.yaml: command 2, line 5: the withdrawal/);
      assert.match(result.lines.join("\n"), /Rejected 1 batch\(es\), moved to inbox\/rejected\/: inbox\/b-bad\.yaml/);
      assert.equal(
        await read("inbox", "rejected", "b-bad.yaml"),
        batch("command: deposit\namount: 5 EUR", "command: withdrawal\namount: 99999 EUR"),
        "the engine never edits the batch",
      );
    });

    it("writes no store at all while nothing was applied", async () => {
      await drop("b-bad.yaml", batch("command: withdrawal\namount: 99999 EUR"));
      await inbox.ingestInbox();
      assert.deepEqual(await ls("state"), []);
    });

    it("does not stop the clean batches around it, and a later batch that depends on it fails its own check", async () => {
      await drop("1-ok.yaml", batch("command: deposit\namount: 100 EUR"));
      await drop("2-bad.yaml", batch(BUY("units: 99999"))); // the second units wins in YAML? no: duplicate key
      await drop("3-dependent.yaml", batch(SELL(1)));
      await drop("4-ok.yaml", batch("command: deposit\namount: 1 EUR"));
      const result = await inbox.ingestInbox();
      assert.equal(result.exitCode, 1);
      assert.deepEqual(await ls("inbox", "applied"), ["1-ok.yaml", "4-ok.yaml"]);
      assert.deepEqual(
        (await ls("inbox", "rejected")).filter((n) => !n.endsWith(".txt")),
        ["2-bad.yaml", "3-dependent.yaml"],
      );
      assert.equal(JSON.parse(await storeText()).silos.EUR.cash, "1101.00 EUR");
    });
  });

  describe("a transient failure", () => {
    it("leaves the file in inbox/ for the next run, and the store as it was", async () => {
      await drop("a.yaml", batch("command: deposit\namount: 100 EUR"));
      await blockStoreWrite();
      const before = await snapshot();
      await assert.rejects(inbox.ingestInbox(), /EISDIR/);
      assert.deepEqual(await ls("inbox"), ["a.yaml"]);
      assert.deepEqual(await snapshot(), before);

      await rm(dir("state"), { recursive: true });
      assert.equal((await inbox.ingestInbox()).exitCode, 0);
      assert.deepEqual(await ls("inbox", "applied"), ["a.yaml"]);
      assert.equal(JSON.parse(await storeText()).silos.EUR.cash, "1100.00 EUR");
    });

    it("no decision line is written before the state is: a store that cannot be written leaves the log as it was", async () => {
      await drop("a.yaml", batch("command: deposit\namount: 100 EUR", BUY(), STOP, SELL(1)));
      await blockStoreWrite();
      await assert.rejects(inbox.ingestInbox(), /EISDIR/);
      assert.deepEqual(await log(), []);
      await rm(dir("state"), { recursive: true });
      await inbox.ingestInbox();
      assert.equal((await log()).length, 2); // the entry and the exit
    });

    it("a log that cannot be written after the state was: the next run writes the lines once and applies nothing twice", async () => {
      await drop("a.yaml", batch("command: deposit\namount: 100 EUR", BUY(), STOP, SELL(1)));
      await mkdir(dir("logs", "decisions.jsonl"), { recursive: true });
      await assert.rejects(inbox.ingestInbox(), /EISDIR/);
      assert.deepEqual(await ls("inbox"), ["a.yaml"], "the file stays for the next run");
      const committed = JSON.parse(await storeText());
      assert.equal(committed.silos.EUR.cash, "1010.00 EUR"); // 1000 + 100 - 200 + 110
      assert.equal(committed.pending_decisions.length, 2);
      assert.equal(committed.unmoved_batches.length, 1);

      await rm(dir("logs", "decisions.jsonl"), { recursive: true });
      assert.equal((await inbox.ingestInbox()).exitCode, 0);
      assert.equal(JSON.parse(await storeText()).silos.EUR.cash, "1010.00 EUR", "not applied a second time");
      const lines = await log();
      assert.deepEqual(
        lines.map((l) => l.type),
        ["entry", "exit"],
      );
      const done = JSON.parse(await storeText());
      assert.deepEqual([done.pending_decisions, done.unmoved_batches], [[], []]);
      assert.deepEqual(await ls("inbox", "applied"), ["a.yaml"]);
      assert.equal(lines[1].related_id, lines[0].id);
    });

    it("refuses a batch it cannot apply without the version of the rules, and check goes on without it", async () => {
      await drop("a.yaml", batch("command: deposit\namount: 100 EUR"));
      await rm(dir("strategies", "base.md"));
      await assert.rejects(inbox.ingestInbox(), /strategies\/base\.md has no `version`/);
      assert.deepEqual(await ls("inbox"), ["a.yaml"]);
      assert.equal((await inbox.checkInbox()).exitCode, 0);
    });
  });

  describe("check and ingest are one code path (ADR-0018)", () => {
    it("accept and refuse the same batches, with the same errors", async () => {
      const files: Record<string, string> = {
        "1-deposit.yaml": batch("command: deposit\namount: 100 EUR"),
        "2-buy-sell.yaml": batch(BUY(), STOP, SELL(1)),
        "3-too-much.yaml": batch("command: withdrawal\namount: 99999 EUR"),
        "4-sale-before-buy.yaml": batch(
          BUY("date: 2026-09-30"),
          STOP,
          "command: sale\nticker: SAP.DE\ndate: 2026-09-01\nunits: 1\nprice: 1 EUR",
        ),
        "5-stop-above-entry.yaml": batch(BUY(), "command: set_stop\nticker: SAP.DE\nprice: 120 EUR"),
        "6-not-yaml.yaml": "commands: [\n",
        "7-depends.yaml": batch(SELL(1)),
      };
      for (const [name, text] of Object.entries(files)) await drop(name, text);
      const checked = await inbox.checkInbox();
      const ingested = await inbox.ingestInbox();
      const rejected = (await ls("inbox", "rejected")).filter((n) => !n.endsWith(".txt"));
      const applied = await ls("inbox", "applied");
      assert.equal(checked.exitCode, 1);
      assert.equal(ingested.exitCode, 1);
      // The errors are the same lines.
      const errorLines = (lines: string[]) => lines.filter((l) => /^inbox\/.*: (command|file)/.test(l));
      assert.deepEqual(errorLines(ingested.lines), errorLines(checked.lines));
      // The files check names an error in are the files ingest rejects, and the rest are applied.
      const named = new Set(errorLines(checked.lines).map((l) => /^inbox\/([^:]+):/.exec(l)![1]));
      assert.deepEqual([...named].sort(), rejected);
      assert.deepEqual(
        applied,
        Object.keys(files)
          .filter((n) => !named.has(n))
          .sort(),
      );
      assert.ok(applied.includes("2-buy-sell.yaml"));
    });

    it("an empty or clean inbox is exit 0 for both", async () => {
      await drop("a.yaml", batch("command: deposit\namount: 1 EUR"));
      assert.equal((await inbox.checkInbox()).exitCode, 0);
      assert.equal((await inbox.ingestInbox()).exitCode, 0);
    });
  });

  describe("the rules of an entry and the proposal a trade follows (#152, ADR-0013 §4, ADR-0009 §5 and §8)", () => {
    const decisionsFile = () => dir("logs", "decisions.jsonl");
    /** Writes `lines` as the decision log the run starts from. */
    async function seed(...lines: Record<string, unknown>[]): Promise<void> {
      await mkdir(dir("logs"), { recursive: true });
      await writeFile(decisionsFile(), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
    }
    async function proposal(over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
      const { buildDecision } = await import("../decisions.js");
      const { parseTicker } = await import("../ticker.js");
      return buildDecision({
        date: "2026-09-10",
        ticker: parseTicker("SAP.DE"),
        currency: "EUR",
        origin: "sistema",
        source: "heartbeat",
        type: "buy_proposal",
        price: 100,
        setup: { pattern: "pullback", state: "triggered", level: 100 },
        assumptions: ["the thesis holds"],
        rules_version: "1.4",
        ...over,
      } as never) as unknown as Record<string, unknown>;
    }
    const entries = async () => (await log()).filter((l) => l.type === "entry");
    /** A series whose ATR14 is 10. */
    const bars = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-08-${String(i + 1).padStart(2, "0")}`,
      open: 100,
      high: 105,
      low: 95,
      close: 100,
      volume: 1,
    }));

    it("a buy that follows the system's proposal is logged as the system's and cites it, so it stays in its expectancy", async () => {
      const followed = await proposal();
      await seed(followed);
      await drop("a.yaml", batch(BUY(), STOP));
      assert.equal((await inbox.ingestInbox()).exitCode, 0);
      const [entry] = await entries();
      assert.deepEqual([entry.origin, entry.related_id, entry.rule_violations ?? []], ["sistema", followed.id, []]);
      const doc = JSON.parse(await storeText());
      assert.equal(doc.silos.EUR.lots[0].origin, "sistema");
      assert.deepEqual(doc.silos.EUR.lots[0].rules_violations, []);
    });

    it("a sale of that lot carries the lot's origin, and is the system's when it follows a sell proposal", async () => {
      const sell = await proposal({ type: "sell", setup: undefined, assumptions: undefined, date: "2026-09-19" });
      await seed(await proposal(), sell);
      await drop("a.yaml", batch(BUY(), STOP, SELL(2)));
      assert.equal((await inbox.ingestInbox()).exitCode, 0);
      const [exit] = (await log()).filter((l) => l.type === "exit");
      assert.deepEqual([exit.origin, exit.entry_origin], ["sistema", "sistema"]);
    });

    it("a sale that follows no sell proposal is the owner's, though the lot it sells is the system's", async () => {
      await seed(await proposal());
      await drop("a.yaml", batch(BUY(), STOP, SELL(2)));
      await inbox.ingestInbox();
      const [exit] = (await log()).filter((l) => l.type === "exit");
      assert.deepEqual([exit.origin, exit.entry_origin], ["propietario", "sistema"]);
    });

    it("one proposal is followed by one buy: the second buy of the batch and a buy of a later file are discretionary", async () => {
      await seed(await proposal());
      await drop("a.yaml", batch(BUY(), BUY_ON("2026-09-16"), STOP));
      await drop("b.yaml", batch(BUY_ON("2026-09-17")));
      assert.equal((await inbox.ingestInbox()).exitCode, 0);
      assert.deepEqual(
        (await entries()).map((e) => e.origin),
        ["sistema", "propietario", "propietario"],
      );
    });

    it("what the engine blocked and the owner bought anyway is the owner's, cites the block and overrode it", async () => {
      const blocked = await proposal({
        type: "buy_blocked",
        eligibility: { verdict: "blocked", reasons: ["risk"] },
      });
      await seed(blocked);
      await drop("a.yaml", batch(BUY(), STOP));
      await inbox.ingestInbox();
      const [entry] = await entries();
      assert.deepEqual(
        [entry.origin, entry.related_id, entry.rule_violations],
        ["propietario", blocked.id, ["overrode_block"]],
      );
    });

    it("flags a ticker that is not in the watchlist, and an entry with no setup behind it", async () => {
      await drop("a.yaml", batch(BUY(), "command: buy\nticker: ABC\ndate: 2026-09-15\nunits: 1\nprice: 10 EUR", STOP));
      assert.equal((await inbox.ingestInbox()).exitCode, 0);
      const flagged = Object.fromEntries((await entries()).map((e) => [e.ticker, e.rule_violations]));
      assert.deepEqual(flagged, { "SAP.DE": ["entry_without_setup"], ABC: ["not_in_watchlist", "no_stop"] });
    });

    it("flags a stop closer than the minimum ATRs to the entry, judged with the stop the batch ends with", async () => {
      // ATR 10, minimum 2: the stop at 90 is 1 ATR below the entry at 100.
      await drop("a.yaml", batch(BUY(), STOP));
      await inbox.ingestInbox(new Date(), { getPrices: async () => new Map(), getHistorical: async () => bars });
      const [entry] = await entries();
      assert.deepEqual(entry.rule_violations, ["entry_without_setup", "stop_below_min_atr"]);
      assert.deepEqual(JSON.parse(await storeText()).silos.EUR.lots[0].rules_violations, [
        "entry_without_setup",
        "stop_below_min_atr",
      ]);
    });

    it("without an ATR (no source, or one that fails) the stop distance is not judged", async () => {
      await drop("a.yaml", batch(BUY(), STOP));
      const failing = {
        getPrices: async () => new Map<string, number>(),
        getHistorical: async () => {
          throw new Error("offline");
        },
      };
      await inbox.ingestInbox(new Date(), failing);
      assert.deepEqual((await entries())[0].rule_violations, ["entry_without_setup"]);
    });

    it("the lots check finds the flagged lot and its entry the same", async () => {
      await seed(await proposal());
      await drop("a.yaml", batch(BUY(), STOP, BUY_ON("2026-09-16")));
      await inbox.ingestInbox();
      const { lotsMismatches } = await import("../utils/lots-check.js");
      const { readDecisionHistory } = await import("../vault-io.js");
      assert.deepEqual(lotsMismatches((await store.readPortfolio("EUR")).portfolio, await readDecisionHistory()), []);
    });

    it("inbox:check and inbox:ingest need no watchlist for a batch that buys nothing; an ingest that buys refuses without one", async () => {
      await rm(dir("watchlist.md"));
      await drop("a.yaml", batch("command: deposit\namount: 10 EUR"));
      assert.equal((await inbox.checkInbox()).exitCode, 0);
      assert.equal((await inbox.ingestInbox()).exitCode, 0);
      await drop("b.yaml", batch(BUY(), STOP));
      assert.equal((await inbox.checkInbox()).exitCode, 0, "check goes on: the rules of an entry change no verdict");
      await assert.rejects(inbox.ingestInbox(), /watchlist\.md/);
      assert.deepEqual(await ls("inbox"), ["applied", "b.yaml"], "nothing was moved or applied");
    });
  });

  describe("the inbox is the only way a trade is recorded (#152)", () => {
    const provider = { getPrices: async () => new Map(), getHistorical: async () => [] };

    it("decision:record refuses a sale of a lot the inbox opened, and changes nothing", async () => {
      await drop("a.yaml", batch(BUY(), STOP));
      await inbox.ingestInbox();
      const before = await snapshot();
      const { recordOwnerDecision } = await import("../decision.js");
      await assert.rejects(
        recordOwnerDecision(
          { type: "exit", ticker: "SAP.DE", currency: "EUR", price: 110, units: 1, date: "2026-09-20" },
          provider,
          "2026-09-21",
        ),
        /a sale is told to the engine with a sale command in inbox\//,
      );
      assert.deepEqual(await snapshot(), before);
    });

    it("what decision:record still records keeps working beside the inbox: a deposit moves the store's cash, and the lots check stays clean", async () => {
      await drop("a.yaml", batch(BUY(), STOP));
      await inbox.ingestInbox();
      const { recordOwnerDecision } = await import("../decision.js");
      await recordOwnerDecision({ type: "deposit", currency: "EUR", amount: 50 }, provider, "2026-09-21");
      const eur = (await store.readPortfolio("EUR")).portfolio;
      assert.equal(eur.cash, 1000 - 200 + 50);
      assert.match(await read("portfolio.md"), /\| Available cash \| 850,00 € \|/);
      const { lotsMismatches } = await import("../utils/lots-check.js");
      const { readDecisionHistory } = await import("../vault-io.js");
      assert.deepEqual(lotsMismatches(eur, await readDecisionHistory()), []);
    });

    it("a sale over two lots writes one exit per lot, and the two-month rule sees the loss of the second", async () => {
      await drop(
        "a.yaml",
        batch(BUY_ON("2026-06-15"), `command: buy\nticker: SAP.DE\ndate: 2026-06-22\nunits: 2\nprice: 110 EUR`),
      );
      await drop("b.yaml", batch("command: sale\nticker: SAP.DE\ndate: 2026-08-10\nunits: 3\nprice: 105 EUR"));
      assert.equal((await inbox.ingestInbox()).exitCode, 0);
      const exits = (await log()).filter((l) => l.type === "exit");
      assert.deepEqual(
        exits.map((e) => [e.pnl, e.lot_units_left]),
        [
          [10, 0],
          [-5, 1],
        ],
      );
      const { twoMonthRuleWarning } = await import("../decisions.js");
      const { readDecisionHistory } = await import("../vault-io.js");
      const { parseTicker } = await import("../ticker.js");
      const warning = twoMonthRuleWarning(await readDecisionHistory(), parseTicker("SAP.DE"), "2026-08-20", "real");
      assert.ok(warning?.includes("-5"), String(warning));
    });
  });

  describe("entry ids", () => {
    it("are unique across the whole history, closed lots included: buy, sell all and buy again the same day", async () => {
      await drop("1.yaml", batch(BUY(), STOP, SELL(2)));
      await drop("2.yaml", batch(BUY(), STOP, SELL(2), BUY()));
      await inbox.ingestInbox();
      const lines = await log();
      const ids = lines.map((l) => l.id as string);
      assert.equal(new Set(ids).size, ids.length, `ids repeat: ${ids.join(", ")}`);
      const entries = lines.filter((l) => l.type === "entry");
      assert.equal(entries.length, 3);
      assert.ok(entries.every((e) => /^20260915-sapde-entry-[0-9a-f]{8}$/.test(e.id as string)));
      const [open] = JSON.parse(await storeText()).silos.EUR.lots;
      assert.equal(open.entry_id, entries[2].id);
    });

    it("never repeat an id the history holds, whatever its type", async () => {
      const { newDecisionId, uniqueDecisionIds } = await import("../utils/decision-id.js");
      const taken = new Set([newDecisionId("2026-09-15", "SAP.DE", "entry", "1d3e4b2e")]);
      const next = uniqueDecisionIds(taken, "seed");
      const ids = Array.from({ length: 200 }, () => next("2026-09-15", "SAP.DE", "entry"));
      assert.equal(new Set(ids).size, 200);
      for (const id of ids) assert.ok(taken.has(id));
      assert.equal(
        uniqueDecisionIds(new Set(), "seed")("2026-09-15", "SAP.DE", "entry"),
        uniqueDecisionIds(new Set(), "seed")("2026-09-15", "SAP.DE", "entry"),
        "the same seed over the same history gives the same ids",
      );
    });
  });

  describe("the lots a buy opens and the exits a sale records", () => {
    it("a lot opened by an inbox buy has the rules version filled in, and no_stop until it has a stop", async () => {
      await drop("a.yaml", batch(BUY()));
      await drop(
        "b.yaml",
        batch(
          "command: buy\nticker: KO\ndate: 2026-09-16\nunits: 1\nprice: 50 USD",
          "command: set_stop\nticker: KO\nprice: 45 USD",
        ),
      );
      const result = await inbox.ingestInbox();
      assert.match(result.lines.join("\n"), /warning: SAP\.DE has no stop in the EUR silo/);
      const doc = JSON.parse(await storeText());
      assert.deepEqual(
        [
          doc.silos.EUR.lots[0].rules_version,
          doc.silos.EUR.lots[0].rules_violations,
          doc.silos.EUR.lots[0].initial_stop,
        ],
        ["1.4", ["entry_without_setup", "no_stop"], null],
      );
      assert.deepEqual(
        [
          doc.silos.USD.lots[0].rules_version,
          doc.silos.USD.lots[0].rules_violations,
          doc.silos.USD.lots[0].initial_stop,
        ],
        ["1.4", ["entry_without_setup"], "45"],
      );
      const entries = (await log()).filter((l) => l.type === "entry");
      assert.deepEqual(
        entries.map((e) => [e.rules_version, e.rule_violations ?? []]),
        [
          ["1.4", ["entry_without_setup", "no_stop"]],
          ["1.4", ["entry_without_setup"]],
        ],
      );
    });

    it("a sale takes the entry costs earlier exits already used: the exits of a lot add up to its entry costs", async () => {
      await drop("1.yaml", batch(BUY("costs: 3 EUR"), STOP, SELL(1)));
      await drop("2.yaml", batch(SELL(1)));
      await inbox.ingestInbox();
      const exits = (await log()).filter((l) => l.type === "exit");
      assert.equal(exits.length, 2);
      assert.deepEqual(
        exits.map((e) => e.entry_costs),
        [1.5, 1.5],
      );
      assert.deepEqual(
        exits.map((e) => e.lot_units_left),
        [1, 0],
      );
      assert.equal(exits[0].related_id, exits[1].related_id);
    });

    it("a sale in the same batch as the buy records the lot with the stop the batch ends with", async () => {
      await drop("1.yaml", batch(BUY(), SELL(1), STOP));
      await inbox.ingestInbox();
      const [entry, exit] = await log();
      assert.equal(entry.stop_initial, 90);
      assert.equal(exit.stop_initial, 90, "each exit is a snapshot of its lot as the batch leaves it");
      assert.equal(exit.entry_price, 100);
      assert.equal(exit.pnl, 10);
      assert.equal(exit.amount, 110);
      assert.equal(exit.units, 1);
    });

    /** A store that already holds `lots` of EUR (what a buy cannot make: dust a buy refuses), with 5.00 EUR of cash. */
    async function seedDust(lots: { id: string; units: number; price: number; date: string }[]) {
      const { encodeStore } = await import("../utils/portfolio-json.js");
      const { lot, stateOf } = await import("./fixtures/inbox.js");
      const { EUR, USD } = stateOf(
        { eurCash: 5 },
        {
          EUR: lots.map((l) =>
            lot("EUR", { ticker: "DUST", units: l.units, entryPrice: l.price, entryId: l.id, date: l.date }),
          ),
        },
      );
      // The entries of those lots, as a buy would have logged them: what a closed lot must not leave open in the log.
      const { buildDecision } = await import("../decisions.js");
      const { exactAmount } = await import("../money.js");
      const { parseTicker } = await import("../ticker.js");
      await mkdir(dir("logs"), { recursive: true });
      await writeFile(
        dir("logs", "decisions.jsonl"),
        lots
          .map((l) =>
            JSON.stringify(
              buildDecision({
                id: l.id,
                date: l.date,
                ticker: parseTicker("DUST"),
                currency: "EUR",
                origin: "propietario",
                source: "portfolio-sync",
                type: "entry",
                price: l.price,
                amount: exactAmount(l.units * l.price),
                units: l.units,
                rules_version: "1.0",
              }),
            ),
          )
          .map((line) => `${line}\n`)
          .join(""),
        "utf8",
      );
      await mkdir(dir("state"), { recursive: true });
      await writeFile(
        dir("state", "portfolio.json"),
        encodeStore({ silos: { EUR, USD }, unmoved: [], pendingDecisions: [], resolvedRejections: [] }),
        "utf8",
      );
    }
    const SELL_DUST = (units: string, price: number) =>
      `command: sale\nticker: DUST\ndate: 2026-09-03\nunits: ${units}\nprice: ${price} EUR`;

    it("a 0.00 sale records exit amounts that add up to the exact proceeds, while cash moves by 0.00", async () => {
      await seedDust([
        { id: "d1", units: 0.0001, price: 2, date: "2026-09-01" },
        { id: "d2", units: 0.0001, price: 2, date: "2026-09-02" },
      ]);
      await drop("a.yaml", batch(SELL_DUST("0.0002", 0.04)));
      assert.equal((await inbox.ingestInbox()).exitCode, 0);
      const exits = (await log()).filter((l) => l.type === "exit");
      assert.deepEqual(
        exits.map((e) => e.amount),
        [0.000004, 0.000004],
      );
      assert.equal(
        exits.reduce((sum, e) => sum + (e.amount as number), 0),
        0.000008,
      );
      const doc = JSON.parse(await storeText());
      assert.equal(
        doc.silos.EUR.cash,
        "5.00 EUR",
        "cash moves by 0.00 (ADR-0017): the exit amounts are not checked against it",
      );
      assert.deepEqual(doc.silos.EUR.lots, []);
      assert.deepEqual(
        exits.map((e) => e.lot_units_left),
        [0, 0],
      );
      await assertNoEntryOpen();
    });

    /** The lots check, as `decision:record` and `decisions:evaluate` run it: no entry is open in the log, no lot is left. */
    const assertNoEntryOpen = async () => {
      const { lotsMismatches } = await import("../utils/lots-check.js");
      const { readDecisionHistory } = await import("../vault-io.js");
      assert.deepEqual(lotsMismatches((await store.readPortfolio("EUR")).portfolio, await readDecisionHistory()), []);
    };

    it("a sale whose proceeds are one unit of the last decimal over two lots: the exit of 0 is recorded, so no entry stays open (#152)", async () => {
      // 6e-8 units at 0.2 are 1.2e-8 of proceeds: 1 at 8 decimals, shared over two lots as [0, 1e-8].
      await seedDust([
        { id: "d1", units: 3e-8, price: 0.2, date: "2026-09-01" },
        { id: "d2", units: 3e-8, price: 0.2, date: "2026-09-02" },
      ]);
      await drop("a.yaml", batch(SELL_DUST("0.00000006", 0.2)));
      const result = await inbox.ingestInbox();
      assert.equal(result.exitCode, 0, result.lines.join("\n"));
      const exits = (await log()).filter((l) => l.type === "exit");
      assert.deepEqual(
        exits.map((e) => [e.related_id, e.amount, e.lot_units_left]),
        [
          ["d1", 0, 0],
          ["d2", 1e-8, 0],
        ],
        "one exit per lot the sale closed: the share of 0 is recorded as 0, the one amount of 0 the log accepts",
      );
      const doc = JSON.parse(await storeText());
      assert.deepEqual(doc.silos.EUR.lots, [], "both lots are closed in the state");
      assert.deepEqual(doc.silos.EUR.positions, []);
      assert.equal(doc.silos.EUR.cash, "5.00 EUR");
      await assertNoEntryOpen();
    });

    it("a 0.00 sale of one lot whose proceeds round to nothing at 8 decimals records its exit of 0, and the lot is not left open in the log (#152)", async () => {
      await seedDust([{ id: "d1", units: 0.0001, price: 0.5, date: "2026-09-01" }]);
      // 0.0001 units at 0.00001 are 1e-9 of proceeds: under 5e-9, so 0 at 8 decimals.
      await drop("a.yaml", batch(SELL_DUST("0.0001", 0.00001)));
      const result = await inbox.ingestInbox();
      assert.equal(result.exitCode, 0, result.lines.join("\n"));
      const exits = (await log()).filter((l) => l.type === "exit");
      assert.deepEqual(
        exits.map((e) => [e.related_id, e.amount, e.units, e.lot_units_left]),
        [["d1", 0, 0.0001, 0]],
      );
      assert.deepEqual(JSON.parse(await storeText()).silos.EUR.lots, []);
      await assertNoEntryOpen();
    });

    it("the decision log is read again after a dust sale: decisions:evaluate does not refuse the silo", async () => {
      await seedDust([
        { id: "d1", units: 3e-8, price: 0.2, date: "2026-09-01" },
        { id: "d2", units: 3e-8, price: 0.2, date: "2026-09-02" },
      ]);
      await drop("a.yaml", batch(SELL_DUST("0.00000006", 0.2)));
      assert.equal((await inbox.ingestInbox()).exitCode, 0);
      const { loadEvaluationReport } = await import("../decisions-evaluation-run.js");
      await assert.doesNotReject(loadEvaluationReport("[test]", new Date("2026-09-14T00:00:00Z")));
    });
  });

  describe("the inbox folder is not trusted", () => {
    const outside = () => dir("outside.yaml");

    it("a symlinked batch file is reported by check and ingest, never read, never skipped in silence", async () => {
      await writeFile(outside(), batch("command: deposit\namount: 777 EUR"), "utf8");
      await symlink(outside(), dir("inbox", "link.yaml"));

      const checked = await inbox.checkInbox();
      assert.equal(checked.exitCode, 1);
      assert.doesNotMatch(checked.lines.join("\n"), /Inbox is empty/);
      assert.match(
        checked.lines.join("\n"),
        /inbox\/link\.yaml, line|inbox\/link\.yaml: file: inbox\/link\.yaml is a symbolic link/,
      );

      const ingested = await inbox.ingestInbox();
      assert.equal(ingested.exitCode, 1);
      assert.doesNotMatch(ingested.lines.join("\n"), /Inbox is empty/);
      assert.match(ingested.lines.join("\n"), /1 file\(s\) left in inbox\/ unread/);
      assert.deepEqual(await ls("inbox"), ["link.yaml"], "left where it is");
      await assert.rejects(() => stat(dir("state")), { code: "ENOENT" }, "what the link points to was not applied");
    });

    it("a symlinked batch does not stop the others, and a file after it that depends on it is not checked against it", async () => {
      await writeFile(outside(), batch("command: deposit\namount: 777 EUR"), "utf8");
      await symlink(outside(), dir("inbox", "1-link.yaml"));
      await drop("2-ok.yaml", batch("command: deposit\namount: 1 EUR"));
      await drop("3-depends.yaml", batch("command: withdrawal\namount: 1500 EUR"));
      const result = await inbox.ingestInbox();
      assert.equal(result.exitCode, 1);
      assert.deepEqual(await ls("inbox", "applied"), ["2-ok.yaml"]);
      assert.match(
        await read("inbox", "rejected", "3-depends.yaml.errors.txt"),
        /not checked: depends on inbox\/1-link\.yaml, which was rejected/,
      );
    });

    it("a folder or a named pipe called like a batch is reported as not a regular file, and nothing blocks", async () => {
      await mkdir(dir("inbox", "folder.yaml"));
      execFileSync("mkfifo", [dir("inbox", "pipe.yml")]);
      const checked = await inbox.checkInbox();
      assert.equal(checked.exitCode, 1);
      assert.match(checked.lines.join("\n"), /inbox\/folder\.yaml is not a regular file/);
      assert.match(checked.lines.join("\n"), /inbox\/pipe\.yml is not a regular file/);
    });

    it("a hidden file (macOS ._buy.yaml) is reported unread like a link, and neither stops the others nor crashes a later run", async () => {
      await drop("._buy.yaml", batch("command: deposit\namount: 1 EUR"));
      await drop(".fix.yml", "not even yaml: [");
      await drop("1-ok.yaml", batch("command: deposit\namount: 5 EUR"));

      const first = await inbox.ingestInbox();
      assert.equal(first.exitCode, 1);
      assert.match(first.lines.join("\n"), /inbox\/\._buy\.yaml is a hidden file/);
      assert.match(first.lines.join("\n"), /2 file\(s\) left in inbox\/ unread/);
      assert.deepEqual(await ls("inbox", "applied"), ["1-ok.yaml"]);
      assert.deepEqual(await ls("inbox"), ["._buy.yaml", ".fix.yml", "applied"]);

      const second = await inbox.ingestInbox();
      assert.equal(second.exitCode, 1, "the same report, no throw");
      assert.deepEqual(JSON.parse(await storeText()).unmoved_batches, []);
      assert.equal(JSON.parse(await storeText()).silos.EUR.cash, "1005.00 EUR", "applied once");
    });

    it("a leftover errors file does not abort the ingest: the new errors are kept under the next name", async () => {
      await mkdir(dir("inbox", "rejected"), { recursive: true });
      await writeFile(dir("inbox", "rejected", "bad.yaml.errors.txt"), "an old one\n", "utf8");
      await drop("a-ok.yaml", batch("command: deposit\namount: 5 EUR"));
      await drop("bad.yaml", batch("command: withdrawal\namount: 99999 EUR"));
      await drop("z-ok.yaml", batch("command: deposit\namount: 7 EUR"));

      const result = await inbox.ingestInbox();
      assert.equal(result.exitCode, 1);
      assert.deepEqual(await ls("inbox", "applied"), ["a-ok.yaml", "z-ok.yaml"]);
      assert.equal(await read("inbox", "rejected", "bad.yaml.errors.txt"), "an old one\n", "never overwritten");
      assert.deepEqual(await ls("inbox", "rejected"), ["bad-2.yaml", "bad-2.yaml.errors.txt", "bad.yaml.errors.txt"]);
      assert.match(await read("inbox", "rejected", "bad-2.yaml.errors.txt"), /exceeds the available cash/);
      assert.deepEqual(JSON.parse(await storeText()).unmoved_batches, []);
    });

    it("the errors of a rejected batch whose name has a colon are written whole, without the file prefix", async () => {
      await drop("a:b.yaml", batch("command: withdrawal\namount: 99999 EUR"));
      await inbox.ingestInbox();
      const errors = await read("inbox", "rejected", "a:b.yaml.errors.txt");
      assert.match(errors, /^command 1, line \d+: the withdrawal/);
      assert.doesNotMatch(errors, /inbox\//);
    });

    it("an entry of the waiting list whose file is gone is forgotten, also when nothing else is applied", async () => {
      await drop("1-ok.yaml", batch("command: deposit\namount: 5 EUR"));
      await inbox.ingestInbox();
      const written = (await store.readStoreIfAny())!;
      await store.saveStore({
        ...written,
        unmoved: [{ file: "gone.yaml", sha256: "0".repeat(64), at: "2026-11-01T00:00:00.000Z" }],
      });

      const empty = await inbox.ingestInbox();
      assert.equal(empty.exitCode, 0);
      assert.deepEqual(JSON.parse(await storeText()).unmoved_batches, [], "forgotten with an empty inbox");

      await store.saveStore({
        ...written,
        unmoved: [{ file: "gone.yaml", sha256: "0".repeat(64), at: "2026-11-01T00:00:00.000Z" }],
      });
      await drop("bad.yaml", batch("command: withdrawal\namount: 99999 EUR"));
      await inbox.ingestInbox();
      assert.deepEqual(JSON.parse(await storeText()).unmoved_batches, [], "and with only a rejected batch");
    });

    it("inbox/ itself being a symbolic link is refused", async () => {
      await rm(dir("inbox"), { recursive: true });
      await mkdir(dir("elsewhere"));
      await writeFile(dir("elsewhere", "a.yaml"), batch("command: deposit\namount: 1 EUR"), "utf8");
      await symlink(dir("elsewhere"), dir("inbox"));
      await assert.rejects(inbox.checkInbox(), /inbox\/ is a symbolic link/);
      await assert.rejects(inbox.ingestInbox(), /inbox\/ is a symbolic link/);
      assert.deepEqual(await ls("elsewhere"), ["a.yaml"]);
    });

    it("rejected/ and applied/ are confined to the inbox folder: a link there is refused and nothing is written through it", async () => {
      await mkdir(dir("elsewhere"));
      await symlink(dir("elsewhere"), dir("inbox", "rejected"));
      await drop("bad.yaml", batch("command: withdrawal\namount: 99999 EUR"));
      await assert.rejects(inbox.ingestInbox(), /inbox\/rejected is not a real folder/);
      assert.deepEqual(await ls("elsewhere"), []);
      assert.deepEqual(await ls("inbox"), ["bad.yaml", "rejected"]);
    });

    it("moveBatch takes a plain file name only, never over a file that is there", async () => {
      const { moveBatch } = await import("../inbox-store.js");
      await drop("a.yaml", "x");
      for (const name of ["../a.yaml", "sub/a.yaml", ".hidden.yaml", "..", ""]) {
        await assert.rejects(moveBatch(name, "applied"), /not a plain file name|ENOENT|EISDIR/, name);
      }
      await mkdir(dir("inbox", "applied"));
      await writeFile(dir("inbox", "applied", "a.yaml"), "old", "utf8");
      const target = await moveBatch("a.yaml", "applied");
      assert.equal(target, dir("inbox", "applied", "a-2.yaml"));
      assert.equal(await read("inbox", "applied", "a.yaml"), "old");
    });
  });

  describe("the command `npm run inbox:ingest`", () => {
    const run = (...args: string[]) =>
      spawnSync(process.execPath, ["--import", "tsx/esm", join(import.meta.dirname, "..", "inbox.ts"), ...args], {
        env: { ...process.env, VAULT_PROJECT_DIR: vaultDir },
        encoding: "utf8",
      });

    it("exits 0 and prints on stdout for a clean batch, and moves it", async () => {
      await drop("a.yaml", batch("command: deposit\namount: 5 EUR"));
      const result = run("ingest");
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Applied 1 batch\(es\): inbox\/a\.yaml/);
      assert.deepEqual(await ls("inbox", "applied"), ["a.yaml"]);
    });

    it("exits 1 and lists the errors on stderr for a refused batch", async () => {
      await drop("a.yaml", batch("command: deposit\namount: 5"));
      const result = run("ingest");
      assert.equal(result.status, 1);
      assert.match(result.stderr, /inbox\/a\.yaml: command 1, line 3: "amount" needs its currency/);
    });

    it("exits 1 for a failure that is not a verdict on a batch, and 2 for a command it does not know", async () => {
      await drop("a.yaml", batch("command: deposit\namount: 5 EUR"));
      await rm(dir("strategies", "base.md"));
      assert.equal(run("ingest").status, 1);
      assert.equal(run("nonsense").status, 2);
    });

    it("is wired in package.json", () => {
      const scripts = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf8")).scripts;
      assert.equal(scripts["inbox:ingest"], "tsx src/inbox.ts ingest");
    });
  });

  describe("the sale handler's own rules, in check and ingest", () => {
    it("a sale dated before its buy in the same batch is an error", async () => {
      await drop(
        "a.yaml",
        batch(BUY_ON("2026-09-30"), "command: sale\nticker: SAP.DE\ndate: 2026-09-01\nunits: 1\nprice: 1 EUR"),
      );
      const checked = await inbox.checkInbox();
      assert.equal(checked.exitCode, 1);
      assert.match(
        checked.lines.join("\n"),
        /command 2, line 8: the sale of SAP\.DE is dated 2026-09-01, before lot .* was bought on 2026-09-30/,
      );
      const ingested = await inbox.ingestInbox();
      assert.equal(ingested.exitCode, 1);
      assert.deepEqual(await ls("inbox", "rejected"), ["a.yaml", "a.yaml.errors.txt"]);
    });

    it("the same day is a round trip, not an error", async () => {
      await drop(
        "a.yaml",
        batch(BUY_ON("2026-09-30"), STOP, "command: sale\nticker: SAP.DE\ndate: 2026-09-30\nunits: 1\nprice: 1 EUR"),
      );
      assert.equal((await inbox.checkInbox()).exitCode, 0);
    });

    it("the lot of a sale is validated again: a malformed id is refused for what it is", async () => {
      const { applyCommand } = await import("../utils/inbox-handlers.js");
      const { parseTicker } = await import("../ticker.js");
      const { stateOf } = await import("./fixtures/inbox.js");
      const result = applyCommand(
        stateOf(),
        {
          kind: "sale",
          currency: "EUR",
          ticker: parseTicker("SAP.DE"),
          date: "2026-09-20",
          units: 1,
          price: 1,
          lot: "../../etc|x",
          stopExecuted: false,
        },
        {
          opened: new Map(),
          earlierTickers: new Set(),
          newEntryId: () => "x",
          rulesVersion: "1",
          entryCostsTaken: new Map(),
          awaiting: new Set(),
          entry: entryContext(),
          today: "2026-11-26",
        },
      );
      assert.ok("reason" in result);
      assert.match(result.reason, /the lot "\.\.\/\.\.\/etc\|x" of the sale of SAP\.DE is not an entry id/);
    });
  });
});
