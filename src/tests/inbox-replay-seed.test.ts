/**
 * What a replay starts from and the order it goes in (#139): a store seeded from `portfolio.md` keeps its seed through a
 * correction and a repair, the applied batches are replayed in the order they were applied, two batches with one text
 * (a monthly deposit) are two records, and a correction that changes nothing is refused. Temporary vault, no network.
 */
import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Decision } from "../decisions.js";
import { ledgerOrder } from "../utils/inbox-replay.js";
import { portfolioMd, watchlistMd } from "./fixtures/inbox.js";

const batch = (...commands: string[]): string =>
  `schema_version: 1\ncommands:\n${commands.map((c) => `  - ${c.replace(/\n/g, "\n    ")}`).join("\n")}\n`;
const DEPOSIT = "command: deposit\namount: 1000 EUR";
const BUY = "command: buy\nticker: SAP.DE\ndate: 2026-11-02\nunits: 10\nprice: 80 EUR";
const STOP = "command: set_stop\nticker: SAP.DE\nprice: 70 EUR";
const FIX = (id: string, ...fields: string[]) => [`command: correct`, `id: ${id}`, ...fields].join("\n");

describe("the order the applied batches are replayed in", () => {
  const names = (files: string[]) => ledgerOrder(files.map((name) => ({ name }))).map((f) => f.name);
  it("reads a trailing number as a counter only when the file without it is there", () => {
    assert.deepEqual(names(["2026-11-20-buy.yaml", "2026-11-05.yaml", "2026-11-12.yaml"]), [
      "2026-11-05.yaml",
      "2026-11-12.yaml",
      "2026-11-20-buy.yaml",
    ]);
    assert.deepEqual(names(["a-2.yaml", "a.yaml", "b.yaml", "a-10.yaml"]), [
      "a.yaml",
      "a-2.yaml",
      "a-10.yaml",
      "b.yaml",
    ]);
  });
});

describe("a replay over a store that began with something, and over repeated batches", () => {
  let vaultDir: string;
  let inbox: typeof import("../inbox.js");
  let repair: typeof import("../state-repair.js");
  const dir = (...parts: string[]) => join(vaultDir, ...parts);
  const read = (...parts: string[]) => readFile(dir(...parts), "utf8");
  const log = async () =>
    (await read("logs", "decisions.jsonl").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Decision);
  const cashOf = async () => Number(JSON.parse(await read("state", "portfolio.json")).silos.EUR.cash.split(" ")[0]);
  async function apply(name: string, text: string, now: string) {
    await writeFile(dir("inbox", name), text, "utf8");
    return inbox.ingestInbox(new Date(`${now}T09:00:00Z`));
  }

  before(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "finance-agent-seed-"));
    process.env.VAULT_PROJECT_DIR = vaultDir;
    mock.method(console, "warn", () => {});
    mock.method(console, "log", () => {});
    inbox = await import("../inbox.js");
    repair = await import("../state-repair.js");
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
    await writeFile(dir("portfolio.md"), portfolioMd({ eurCash: "5000.00", usdCash: "0.00" }), "utf8");
    await writeFile(dir("watchlist.md"), watchlistMd([["SAP.DE", "EUR"]]), "utf8");
  });

  async function seededHistory() {
    assert.equal((await apply("2026-11-12.yaml", batch(DEPOSIT), "2026-11-12")).exitCode, 0);
    assert.equal((await apply("2026-11-20-buy.yaml", batch(BUY, STOP), "2026-11-20")).exitCode, 0);
    return (await log()).find((l) => l.type === "entry")!.id;
  }

  it("a correction works on a store seeded with cash, and keeps the seed", async () => {
    const entry = await seededHistory();
    assert.equal(await cashOf(), 5000 + 1000 - 800);
    const result = await apply("2026-11-21-fix.yaml", batch(FIX(entry, "units: 5")), "2026-11-21");
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.equal(await cashOf(), 5000 + 1000 - 400);
  });

  it("a repair keeps the seed, and a store that is as the batches give is left alone", async () => {
    await seededHistory();
    const first = await repair.repairStore(new Date("2026-11-25T09:00:00Z"));
    assert.equal(first.exitCode, 0, first.lines.join("\n"));
    assert.match(first.lines.join("\n"), /Nothing to repair/);

    const doc = JSON.parse(await read("state", "portfolio.json"));
    doc.silos.EUR.lots = [];
    doc.silos.EUR.positions = [];
    await writeFile(dir("state", "portfolio.json"), JSON.stringify(doc), "utf8");
    const second = await repair.repairStore(new Date("2026-11-26T09:00:00Z"));
    assert.equal(second.exitCode, 0, second.lines.join("\n"));
    assert.equal(await cashOf(), 5000 + 1000 - 800);
    assert.equal(JSON.parse(await read("state", "portfolio.json")).silos.EUR.lots.length, 1);
  });

  it("a repair of a store that does not read keeps the seed, from the last readable copy", async () => {
    await seededHistory();
    await writeFile(dir("state", "portfolio.json"), "{ not json", "utf8");
    const outcome = await repair.repairStore(new Date("2026-11-25T09:00:00Z"));
    assert.equal(outcome.exitCode, 0, outcome.lines.join("\n"));
    assert.equal(await cashOf(), 5000 + 1000 - 800);
  });

  it("two batches with one text on two days are two records: a repair accepts them and a correction names the right one", async () => {
    assert.equal((await apply("a.yaml", batch(DEPOSIT), "2026-11-01")).exitCode, 0);
    assert.equal((await apply("b.yaml", batch(DEPOSIT), "2026-12-01")).exitCode, 0);
    const [march, april] = (await log()).filter((l) => l.type === "deposit");
    assert.notEqual(march.id, april.id);

    const outcome = await repair.repairStore(new Date("2026-12-05T09:00:00Z"));
    assert.equal(outcome.exitCode, 0, outcome.lines.join("\n"));
    assert.match(outcome.lines.join("\n"), /Nothing to repair/);

    const result = await apply("fix.yaml", batch(FIX(april.id, "amount: 1500 EUR")), "2026-12-06");
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.equal(await cashOf(), 5000 + 1000 + 1500);
    const fixes = (await log()).filter((l) => l.type === "correction");
    assert.deepEqual(
      fixes.map((f) => f.corrects),
      [april.id],
    );
  });

  it("refuses a correction that changes nothing", async () => {
    const entry = await seededHistory();
    const before = await read("logs", "decisions.jsonl");
    const result = await apply("fix.yaml", batch(FIX(entry, "units: 10")), "2026-11-21");
    assert.notEqual(result.exitCode, 0);
    assert.equal(await read("logs", "decisions.jsonl"), before);
    assert.ok(await readdir(dir("inbox", "rejected")).then((n) => n.some((f) => f.includes("fix"))));
  });
});
