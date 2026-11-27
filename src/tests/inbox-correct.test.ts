/**
 * The `correct` command (#139, spec #124, ADR-0018): a mistaken buy, sale or deposit is corrected by the id the engine
 * gave it. The batches already applied are replayed with the corrected record, a `correction` line points at the
 * original, which stays in the log, and a correction that would leave a later sale without lots or the cash below
 * zero is refused. Temporary vault, no network.
 */
import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Decision } from "../decisions.js";
import { portfolioMd, watchlistMd } from "./fixtures/inbox.js";

/** The part of `state/portfolio.json` these tests read. */
interface StoreDoc {
  silos: Record<string, { cash: string; lots: Record<string, unknown>[] }>;
}

const batch = (...commands: string[]): string =>
  `schema_version: 1\ncommands:\n${commands.map((c) => `  - ${c.replace(/\n/g, "\n    ")}`).join("\n")}\n`;
const DEPOSIT = (amount = "2000 EUR") => `command: deposit\namount: ${amount}`;
const BUY = (units = 10, price = "100 EUR", over = "") =>
  `command: buy\nticker: SAP.DE\ndate: 2026-11-02\nunits: ${units}\nprice: ${price}${over ? `\n${over}` : ""}`;
const STOP = "command: set_stop\nticker: SAP.DE\nprice: 90 EUR";
const SELL = (units = 4, price = "110 EUR") =>
  `command: sale\nticker: SAP.DE\ndate: 2026-11-03\nunits: ${units}\nprice: ${price}`;
const FIX = (id: string, ...fields: string[]) => [`command: correct`, `id: ${id}`, ...fields].join("\n");

describe("the correct command", () => {
  let vaultDir: string;
  let inbox: typeof import("../inbox.js");
  const dir = (...parts: string[]) => join(vaultDir, ...parts);
  const read = (...parts: string[]) => readFile(dir(...parts), "utf8");
  const ls = (...parts: string[]) =>
    readdir(dir(...parts)).then(
      (names) => names.sort(),
      () => [] as string[],
    );
  const log = async () =>
    (await read("logs", "decisions.jsonl").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Decision);
  const storeDoc = async () => JSON.parse(await read("state", "portfolio.json")) as StoreDoc;
  /** Drops a batch and applies it on its own, as a run of the owner's would. */
  async function apply(name: string, text: string, now = new Date("2026-11-20T09:00:00Z")) {
    await writeFile(dir("inbox", name), text, "utf8");
    return inbox.ingestInbox(now);
  }
  /** Every file of the vault with its bytes: what "changes nothing" is measured against. */
  async function snapshot(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const entry of await readdir(vaultDir, { withFileTypes: true, recursive: true })) {
      if (entry.isFile()) {
        const path = join(entry.parentPath, entry.name);
        out[path.slice(vaultDir.length)] = await readFile(path, "utf8");
      }
    }
    return out;
  }

  before(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "finance-agent-correct-"));
    process.env.VAULT_PROJECT_DIR = vaultDir;
    mock.method(console, "warn", () => {});
    mock.method(console, "log", () => {});
    inbox = await import("../inbox.js");
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
    // The store starts empty: everything it holds came through a batch, which is what a replay gives back.
    await writeFile(dir("portfolio.md"), portfolioMd({ eurCash: "0.00", usdCash: "0.00" }), "utf8");
    await writeFile(dir("watchlist.md"), watchlistMd([["SAP.DE", "EUR"]]), "utf8");
  });

  /** A deposit, a buy of 10 and a sale of 4 of the lot, each applied on its own. Returns the ids of the lines. */
  async function history() {
    await apply("2026-11-01-deposit.yaml", batch(DEPOSIT()));
    await apply("2026-11-02-buy.yaml", batch(BUY(10, "100 EUR", "costs: 1 EUR"), STOP));
    await apply("2026-11-03-sale.yaml", batch(SELL()));
    const lines = await log();
    const id = (type: string) => lines.find((l) => l.type === type)!.id;
    return { deposit: id("deposit"), entry: id("entry"), exit: id("exit") };
  }

  /** Corrects with a batch of its own and applies it. */
  const correct = (name: string, ...commands: string[]) =>
    apply(name, batch(...commands), new Date("2026-11-21T09:00:00Z"));
  const lotsOf = async () => {
    const doc = await storeDoc();
    return doc.silos.EUR.lots;
  };
  const cashOf = async () => Number((await storeDoc()).silos.EUR.cash.split(" ")[0]);

  it("corrects a buy: a correction line points at the original, which stays, and the lots, cash and positions are rebuilt", async () => {
    const ids = await history();
    const before = await log();
    const result = await correct("2026-11-21-fix.yaml", FIX(ids.entry, "units: 8", "price: 105 EUR", "costs: 2 EUR"));
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    const after = await log();
    // The original is still in the file, untouched, and the correction is a new line after it.
    assert.deepEqual(after.slice(0, before.length), before);
    const fixes = after.filter((l) => l.type === "correction");
    const own = fixes.filter((l) => l.corrects === ids.entry);
    assert.equal(own.length, 1);
    assert.deepEqual(own[0].patch, { units: 8, price: 105, amount: 840, costs: 2 });
    // The sale's line moves with the lot it drew from (its result): it is corrected too, and never replaced.
    assert.ok(fixes.every((l) => l.corrects === ids.entry || l.corrects === ids.exit));
    // The lot, the cash and the position are what the corrected buy gives: 8 bought, 4 sold, cash 2000 - 8*105 - 2 + 4*110.
    const lots = await lotsOf();
    assert.equal(lots.length, 1);
    assert.equal(Number(lots[0].units), 4);
    assert.equal(await cashOf(), 2000 - 8 * 105 - 2 + 4 * 110 - 0);
    // The batch of corrections is applied, and the original batches are kept.
    assert.deepEqual(await ls("inbox", "applied"), [
      "2026-11-01-deposit.yaml",
      "2026-11-02-buy.yaml",
      "2026-11-03-sale.yaml",
      "2026-11-21-fix.yaml",
    ]);
  });

  it("corrects a deposit and a sale", async () => {
    const ids = await history();
    assert.equal(
      (await correct("2026-11-21-fix.yaml", FIX(ids.deposit, "amount: 3000 EUR"), FIX(ids.exit, "price: 120 EUR")))
        .exitCode,
      0,
    );
    assert.equal(await cashOf(), 3000 - 1001 + 4 * 120);
    const fixes = (await log()).filter((l) => l.type === "correction");
    assert.ok(fixes.some((f) => f.corrects === ids.deposit));
    assert.ok(fixes.some((f) => f.corrects === ids.exit));
  });

  describe("refuses with a reason and changes nothing", () => {
    const refuses = async (reason: RegExp, build: (ids: Awaited<ReturnType<typeof history>>) => string[]) => {
      const ids = await history();
      const before = await snapshot();
      const commands = build(ids);
      await writeFile(dir("inbox", "2026-11-21-fix.yaml"), batch(...commands), "utf8");
      const checked = await inbox.checkInbox(new Date("2026-11-21T09:00:00Z"));
      assert.equal(checked.exitCode, 1);
      assert.match(checked.lines.join("\n"), reason);
      const ingested = await inbox.ingestInbox(new Date("2026-11-21T09:00:00Z"));
      assert.equal(ingested.exitCode, 1);
      // The batch moves to rejected/; the state and the log are what they were.
      const after = await snapshot();
      for (const file of ["/state/portfolio.json", "/logs/decisions.jsonl"])
        assert.equal(after[file], before[file], file);
      assert.ok(await ls("inbox", "rejected").then((names) => names.includes("2026-11-21-fix.yaml")));
    };

    it("an id that does not exist", () =>
      refuses(/no applied record has the id "nope"/, () => [FIX("nope", "units: 8")]));
    it("a correction that leaves a later sale without lots", () =>
      refuses(/only 3 are open/, (ids) => [FIX(ids.entry, "units: 3")]));
    it("a correction that leaves the cash negative", () =>
      refuses(/more than the available cash/, (ids) => [FIX(ids.deposit, "amount: 500 EUR")]));
    it("a value that does not apply to the record", () =>
      refuses(/a deposit has only an "amount"/, (ids) => [FIX(ids.deposit, "units: 3")]));
    it("an amount in another currency", () => refuses(/does not move it/, (ids) => [FIX(ids.entry, "price: 12 USD")]));
    it("a correction that does not change anything", () =>
      refuses(/at least one corrected value/, (ids) => [FIX(ids.entry)]));
  });

  it("is all or nothing: one bad correction in the batch applies none", async () => {
    const ids = await history();
    const before = await snapshot();
    await writeFile(
      dir("inbox", "2026-11-21-fix.yaml"),
      batch(FIX(ids.deposit, "amount: 3000 EUR"), FIX("nope", "units: 1")),
      "utf8",
    );
    const result = await inbox.ingestInbox(new Date("2026-11-21T09:00:00Z"));
    assert.equal(result.exitCode, 1);
    const after = await snapshot();
    assert.equal(after["/state/portfolio.json"], before["/state/portfolio.json"]);
    assert.equal(after["/logs/decisions.jsonl"], before["/logs/decisions.jsonl"]);
  });

  it("a correction goes through the validation of the original: a stop above the price still refuses", async () => {
    const ids = await history();
    const before = await snapshot();
    await writeFile(dir("inbox", "2026-11-21-fix.yaml"), batch(FIX(ids.entry, "price: 80 EUR")), "utf8");
    const result = await inbox.ingestInbox(new Date("2026-11-21T09:00:00Z"));
    assert.equal(result.exitCode, 1);
    assert.equal((await snapshot())["/state/portfolio.json"], before["/state/portfolio.json"]);
  });

  it("a correction is not mixed with other commands", async () => {
    const ids = await history();
    await writeFile(dir("inbox", "2026-11-21-fix.yaml"), batch(FIX(ids.entry, "units: 8"), BUY()), "utf8");
    const result = await inbox.checkInbox(new Date("2026-11-21T09:00:00Z"));
    assert.equal(result.exitCode, 1);
    assert.match(result.lines.join("\n"), /goes in a batch of corrections only/);
  });
});
