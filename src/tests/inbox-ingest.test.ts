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
import { portfolioMd } from "./fixtures/inbox.js";

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
        ["SAP.DE", "2", "100", "90", "1.50 EUR", "propietario", "1.4", []],
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

    it("leaves the rest of the lot's decision-log lines: the entry of the lot, as decision:record would write it", async () => {
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

  describe("decision:record keeps working beside the inbox until #152 removes its trade part", () => {
    it("records a sale of a lot the inbox opened: the store and the view change, the lots check stays clean", async () => {
      await writeFile(
        dir("watchlist.md"),
        `---\nschema_version: 1\n---\n\n\`\`\`yaml\nwatchlist: []\n\`\`\`\n`,
        "utf8",
      );
      await drop("a.yaml", batch(BUY(), STOP));
      await inbox.ingestInbox();
      const { recordOwnerDecision } = await import("../decision.js");
      const provider = { getPrices: async () => new Map(), getHistorical: async () => [] };
      await recordOwnerDecision(
        { type: "exit", ticker: "SAP.DE", currency: "EUR", price: 110, units: 1, date: "2026-09-20" },
        provider,
        "2026-09-21",
      );
      const eur = (await store.readPortfolio("EUR")).portfolio;
      assert.deepEqual(
        eur.lots.map((l) => l.units),
        [1],
      );
      assert.equal(eur.positions[0].volume, 1);
      assert.match(await read("portfolio.md"), /\| SAP\.DE \| 1 \| 100,00 \|/);
      const { lotsMismatches } = await import("../utils/lots-check.js");
      const { readDecisionHistory } = await import("../vault-io.js");
      assert.deepEqual(lotsMismatches(eur, await readDecisionHistory()), []);
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
        ["1.4", ["no_stop"], null],
      );
      assert.deepEqual(
        [
          doc.silos.USD.lots[0].rules_version,
          doc.silos.USD.lots[0].rules_violations,
          doc.silos.USD.lots[0].initial_stop,
        ],
        ["1.4", [], "45"],
      );
      const entries = (await log()).filter((l) => l.type === "entry");
      assert.deepEqual(
        entries.map((e) => [e.rules_version, e.rule_violations ?? []]),
        [
          ["1.4", ["no_stop"]],
          ["1.4", []],
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
      await mkdir(dir("state"), { recursive: true });
      await writeFile(
        dir("state", "portfolio.json"),
        encodeStore({ silos: { EUR, USD }, unmoved: [], pendingDecisions: [] }),
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
    });

    it("a sale whose proceeds are one unit of the last decimal over two lots: the exit of 0 is not recorded as an exit", async () => {
      // 6e-8 units at 0.2 are 1.2e-8 of proceeds: 1 at 8 decimals, shared over two lots as [0, 1e-8].
      await seedDust([
        { id: "d1", units: 3e-8, price: 0.2, date: "2026-09-01" },
        { id: "d2", units: 3e-8, price: 0.2, date: "2026-09-02" },
      ]);
      await drop("a.yaml", batch(SELL_DUST("0.00000006", 0.2)));
      const result = await inbox.ingestInbox();
      assert.equal(result.exitCode, 0, result.lines.join("\n"));
      const exits = (await log()).filter((l) => l.type === "exit");
      assert.equal(exits.length, 1, "a decision needs an amount above zero");
      assert.equal(exits[0].amount, 1e-8);
      const doc = JSON.parse(await storeText());
      assert.deepEqual(doc.silos.EUR.lots, [], "both lots are closed in the state all the same");
      assert.deepEqual(doc.silos.EUR.positions, []);
      assert.equal(doc.silos.EUR.cash, "5.00 EUR");
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
        },
      );
      assert.ok("reason" in result);
      assert.match(result.reason, /the lot "\.\.\/\.\.\/etc\|x" of the sale of SAP\.DE is not an entry id/);
    });
  });
});
