/**
 * The watchlist as engine state (#140, spec #124, ADR-0018): `inbox:ingest` applies `watch` and `stop_watching` to the
 * store, `watchlist.md` is generated from it, every reader reads the store, and a correction and the repair replay the
 * commands over the list the store began with. Temporary vault, no network.
 */
import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Decision } from "../decisions.js";
import { portfolioMd, watchlistMd } from "./fixtures/inbox.js";

interface StoreDoc {
  silos: Record<string, { cash: string }>;
  watchlist?: { ticker: string; currency: string; thesis: string; date?: string }[];
  starting_watchlist?: { ticker: string }[];
}

const batch = (...commands: string[]): string =>
  `schema_version: 1\ncommands:\n${commands.map((c) => `  - ${c.replace(/\n/g, "\n    ")}`).join("\n")}\n`;
const WATCH = (ticker: string, currency = "USD", extra = "") =>
  `command: watch\ncurrency: ${currency}\nticker: ${ticker}${extra ? `\n${extra}` : ""}`;
const STOP_WATCHING = (ticker: string) => `command: stop_watching\nticker: ${ticker}`;
const DEPOSIT = "command: deposit\namount: 2000 EUR";
const BUY = "command: buy\nticker: SAP.DE\ndate: 2026-11-02\nunits: 10\nprice: 100 EUR";
const STOP = "command: set_stop\nticker: SAP.DE\nprice: 90 EUR";

describe("the watchlist is engine state", () => {
  let vaultDir: string;
  let inbox: typeof import("../inbox.js");
  let repair: typeof import("../state-repair.js");
  let vaultIo: typeof import("../vault-io.js");
  const dir = (...parts: string[]) => join(vaultDir, ...parts);
  const read = (...parts: string[]) => readFile(dir(...parts), "utf8");
  const ls = (...parts: string[]) =>
    readdir(dir(...parts)).then(
      (names) => names.sort(),
      () => [] as string[],
    );
  const storeDoc = async () => JSON.parse(await read("state", "portfolio.json")) as StoreDoc;
  const tickers = async () => (await storeDoc()).watchlist?.map((e) => e.ticker);
  const log = async () =>
    (await read("logs", "decisions.jsonl").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Decision);
  /** Drops a batch and applies it on its own. */
  async function apply(name: string, text: string, now = new Date("2026-11-20T09:00:00Z")) {
    await writeFile(dir("inbox", name), text, "utf8");
    return inbox.ingestInbox(now);
  }

  before(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "finance-agent-watchlist-"));
    process.env.VAULT_PROJECT_DIR = vaultDir;
    mock.method(console, "warn", () => {});
    mock.method(console, "log", () => {});
    inbox = await import("../inbox.js");
    repair = await import("../state-repair.js");
    vaultIo = await import("../vault-io.js");
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
    await writeFile(dir("portfolio.md"), portfolioMd({ eurCash: "0.00", usdCash: "0.00" }), "utf8");
    // The old file the first ingest seeds the watchlist of the store from.
    await writeFile(
      dir("watchlist.md"),
      watchlistMd([
        ["SAP.DE", "EUR"],
        ["KO", "USD"],
      ]),
      "utf8",
    );
  });

  describe("watch and stop_watching", () => {
    it("the first ingest seeds the store from watchlist.md, and watch adds a ticker with the day it joined", async () => {
      const result = await apply("a.yaml", batch(WATCH("AMD", "USD", "note: Data-center share gains\nhorizon: short")));
      assert.equal(result.exitCode, 0, result.lines.join("\n"));
      const doc = await storeDoc();
      assert.deepEqual(
        doc.watchlist?.map((e) => [e.ticker, e.currency, e.thesis, e.date]),
        [
          ["SAP.DE", "EUR", "test", undefined],
          ["KO", "USD", "test", undefined],
          ["AMD", "USD", "Data-center share gains", "2026-11-20"],
        ],
      );
      assert.deepEqual(
        doc.starting_watchlist?.map((e) => e.ticker),
        ["SAP.DE", "KO"],
        "the list the store began with is kept apart, for a correction and the repair",
      );
      assert.deepEqual(await ls("inbox", "applied"), ["a.yaml"]);
    });

    it("stop_watching takes a ticker off, and a ticker that is not on the list rejects its batch with the reason", async () => {
      assert.equal((await apply("a.yaml", batch(STOP_WATCHING("KO")))).exitCode, 0);
      assert.deepEqual(await tickers(), ["SAP.DE"]);

      const before = await read("state", "portfolio.json");
      const refused = await apply("b.yaml", batch(DEPOSIT, STOP_WATCHING("KO")));
      assert.equal(refused.exitCode, 1);
      assert.match(refused.lines.join("\n"), /inbox\/b\.yaml: command 2, line \d+: KO is not on the watchlist/);
      assert.equal(
        await read("state", "portfolio.json"),
        before,
        "a batch with a refusal changes nothing, the deposit too",
      );
      assert.deepEqual(await ls("inbox", "rejected"), ["b.yaml", "b.yaml.errors.txt"]);
    });

    it("watch of a ticker that is on the list is refused, and a ticker that does not parse never gets in", async () => {
      const dup = await apply("a.yaml", batch(WATCH("KO")));
      assert.equal(dup.exitCode, 1);
      assert.match(dup.lines.join("\n"), /KO is already on the watchlist \(USD silo\)/);
      const bad = await apply("b.yaml", batch(WATCH("TC|K")));
      assert.equal(bad.exitCode, 1);
      assert.match(bad.lines.join("\n"), /TC\|K/);
      assert.deepEqual(await ls("state"), [], "nothing was applied, so no store was written");
    });

    it("a watch and its buy in one batch are valid: the lot is not flagged as outside the watchlist", async () => {
      await apply("a.yaml", batch(DEPOSIT));
      const result = await apply(
        "b.yaml",
        batch(WATCH("TCK", "EUR"), `${BUY.replace("SAP.DE", "TCK")}`, STOP.replace("SAP.DE", "TCK")),
      );
      assert.equal(result.exitCode, 0, result.lines.join("\n"));
      const entry = (await log()).find((d) => d.type === "entry" && d.ticker === "TCK")!;
      assert.ok(!entry.rule_violations?.includes("not_in_watchlist"), String(entry.rule_violations));
      const later = await apply("c.yaml", batch(BUY.replace("SAP.DE", "ZZZ")));
      assert.equal(later.exitCode, 0, later.lines.join("\n"));
      assert.ok((await log()).find((d) => d.ticker === "ZZZ")!.rule_violations?.includes("not_in_watchlist"));
    });

    it("an inbox:check reports a watch exactly as the ingest applies it, and changes nothing", async () => {
      await writeFile(dir("inbox", "a.yaml"), batch(WATCH("AMD")), "utf8");
      const before = await ls();
      const checked = await inbox.checkInbox();
      assert.equal(checked.exitCode, 0, checked.lines.join("\n"));
      assert.deepEqual(await ls(), before);
      await writeFile(dir("inbox", "a.yaml"), batch(WATCH("KO")), "utf8");
      assert.equal((await inbox.checkInbox()).exitCode, 1);
    });
  });

  describe("watchlist.md is a generated view and the readers read the store", () => {
    beforeEach(async () => {
      assert.equal((await apply("a.yaml", batch(WATCH("AMD", "USD", "note: Share gains")))).exitCode, 0);
    });

    it("is generated from the store with a note, and holds the entries of the store", async () => {
      const view = await read("watchlist.md");
      assert.match(view, /Generated by the engine from `state\/portfolio\.json`: do not edit it/);
      assert.match(view, /ticker: AMD/);
      assert.match(view, /thesis: Share gains/);
      assert.match(view, /ticker: SAP\.DE/);
    });

    it("every reader reads the store: a hand edit of the view changes nothing, and the next change overwrites it", async () => {
      await writeFile(dir("watchlist.md"), watchlistMd([["EDITED", "USD"]]), "utf8");
      assert.deepEqual(
        (await vaultIo.readWatchlistSkippingBadTickers("USD")).map((e) => e.ticker),
        ["KO", "AMD"],
      );
      assert.deepEqual(
        (await vaultIo.readWatchlist("EUR")).map((e) => e.ticker),
        ["SAP.DE"],
      );
      assert.deepEqual(await vaultIo.readAllWatchlistTickers(), ["SAP.DE", "KO", "AMD"]);
      assert.equal((await apply("b.yaml", batch(STOP_WATCHING("AMD")))).exitCode, 0);
      assert.doesNotMatch(await read("watchlist.md"), /EDITED/);
      assert.doesNotMatch(await read("watchlist.md"), /AMD/);
    });

    it("the heartbeat still reads the list when the store does not read, from its last readable copy", async () => {
      await writeFile(dir("watchlist.md"), watchlistMd([["EDITED", "USD"]]), "utf8");
      await writeFile(dir("state", "portfolio.json"), '{"silos": {', "utf8");
      assert.deepEqual(
        (await vaultIo.readWatchlistSkippingBadTickers("USD")).map((e) => e.ticker),
        ["KO", "AMD"],
      );
    });

    it("the date an entry joined is the one of its watch command", async () => {
      const entries = await vaultIo.readWatchlistSkippingBadTickers("USD");
      assert.deepEqual([...(await vaultIo.readWatchlistAddedOn(entries))], [["AMD", "2026-11-20"]]);
    });
  });

  describe("a store written before the watchlist was state", () => {
    it("reads the watchlist from watchlist.md until an ingest seeds it, and nothing of it is lost", async () => {
      assert.equal((await apply("a.yaml", batch(DEPOSIT))).exitCode, 0);
      const doc = JSON.parse(await read("state", "portfolio.json"));
      delete doc.watchlist;
      delete doc.starting_watchlist;
      await writeFile(dir("state", "portfolio.json"), JSON.stringify(doc), "utf8");
      await writeFile(dir("watchlist.md"), watchlistMd([["SAP.DE", "EUR"]]), "utf8");

      assert.deepEqual(
        await vaultIo.readAllWatchlistTickers(),
        ["SAP.DE"],
        "no list in the store: the file is the state",
      );
      assert.equal((await apply("b.yaml", batch(WATCH("AMD")))).exitCode, 0);
      assert.deepEqual(await tickers(), ["SAP.DE", "AMD"]);
    });
  });

  describe("a correction replays the watchlist commands with the batches", () => {
    it("keeps the list: a retired seeded entry stays retired, and a watched ticker stays watched", async () => {
      await apply("1-deposit.yaml", batch(DEPOSIT));
      await apply("2-buy.yaml", batch(WATCH("AMD"), STOP_WATCHING("KO"), BUY, STOP));
      const before = await tickers();
      assert.deepEqual(before, ["SAP.DE", "AMD"]);
      const id = (await log()).find((l) => l.type === "entry")!.id;
      const fixed = await apply("3-fix.yaml", batch(`command: correct\nid: ${id}\nunits: 8`));
      assert.equal(fixed.exitCode, 0, fixed.lines.join("\n"));
      assert.deepEqual(await tickers(), before, "a correction never touches the watchlist");
    });
  });

  describe("the repair", () => {
    beforeEach(async () => {
      await apply("1-deposit.yaml", batch(DEPOSIT));
      await apply("2-watch.yaml", batch(WATCH("AMD"), STOP_WATCHING("KO")));
    });
    const now = new Date("2026-11-25T09:00:00Z");

    it("a store that lost an entry gets it back: the watchlist is rebuilt from the list it began with and the batches", async () => {
      const good = await storeDoc();
      const broken = structuredClone(good);
      broken.watchlist = broken.watchlist!.filter((e) => e.ticker !== "AMD");
      await writeFile(dir("state", "portfolio.json"), JSON.stringify(broken), "utf8");

      const outcome = await repair.repairStore(now);
      assert.equal(outcome.exitCode, 0, outcome.lines.join("\n"));
      assert.match(
        outcome.lines.join("\n"),
        /the watchlist AMD: not on it in the store, on it \(USD\) in the rebuilt state/,
      );
      assert.deepEqual(await tickers(), ["SAP.DE", "AMD"]);
      assert.deepEqual((await storeDoc()).starting_watchlist, good.starting_watchlist);
    });

    it("a store that does not read is rebuilt with its watchlist, from the last readable copy and the batches", async () => {
      await writeFile(dir("state", "portfolio.json"), '{"silos": {', "utf8");
      const outcome = await repair.repairStore(now);
      assert.equal(outcome.exitCode, 0, outcome.lines.join("\n"));
      assert.deepEqual(await tickers(), ["SAP.DE", "AMD"], "never an empty list");
      assert.deepEqual(
        (await storeDoc()).starting_watchlist?.map((e) => e.ticker),
        ["SAP.DE", "KO"],
      );
    });

    it("refuses, changing nothing, when the batches changed the watchlist and nothing tells the list the store began with", async () => {
      await writeFile(dir("state", "portfolio.json"), '{"silos": {', "utf8");
      await rm(dir("state", "portfolio.last-readable.json"));
      const before = await read("state", "portfolio.json");
      const outcome = await repair.repairStore(now);
      assert.equal(outcome.exitCode, 1);
      assert.match(
        outcome.lines.join("\n"),
        /inbox\/applied\/2-watch\.yaml changes the watchlist, but neither the store nor its last readable copy tells the watchlist it began with/,
      );
      assert.equal(await read("state", "portfolio.json"), before);
      assert.equal((await log()).filter((l) => l.type === "repair" && l.result === "refused").length > 0, true);
    });

    it("a store that is what the audit trail gives, watchlist included, is left alone", async () => {
      const before = await read("state", "portfolio.json");
      const outcome = await repair.repairStore(now);
      assert.equal(outcome.exitCode, 0);
      assert.match(outcome.lines.join("\n"), /Nothing to repair/);
      assert.equal(await read("state", "portfolio.json"), before);
    });
  });
});
