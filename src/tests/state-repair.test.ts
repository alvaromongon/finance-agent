/**
 * The repair of a corrupt state (#139, spec #124, ADR-0018): `repairStore` rebuilds the store from the decision log and
 * `inbox/applied/`, refuses when they disagree and changes nothing, and writes a `repair` line to the log in every run.
 * Temporary vault, no network.
 */
import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Decision } from "../decisions.js";
import { portfolioMd, watchlistMd } from "./fixtures/inbox.js";

const batch = (...commands: string[]): string =>
  `schema_version: 1\ncommands:\n${commands.map((c) => `  - ${c.replace(/\n/g, "\n    ")}`).join("\n")}\n`;
const DEPOSIT = "command: deposit\namount: 2000 EUR";
const BUY = "command: buy\nticker: SAP.DE\ndate: 2026-11-02\nunits: 10\nprice: 100 EUR\ncosts: 1 EUR";
const STOP = "command: set_stop\nticker: SAP.DE\nprice: 90 EUR";
const SELL = "command: sale\nticker: SAP.DE\ndate: 2026-11-03\nunits: 4\nprice: 110 EUR";

describe("the repair of a corrupt state", () => {
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
  const now = new Date("2026-11-25T09:00:00Z");
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
  const without = (files: Record<string, string>, ...names: string[]) =>
    Object.fromEntries(Object.entries(files).filter(([name]) => !names.includes(name)));

  before(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "finance-agent-repair-"));
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
    await writeFile(dir("portfolio.md"), portfolioMd({ eurCash: "0.00", usdCash: "0.00" }), "utf8");
    await writeFile(dir("watchlist.md"), watchlistMd([["SAP.DE", "EUR"]]), "utf8");
    for (const [name, text] of [
      ["2026-11-01-deposit.yaml", batch(DEPOSIT)],
      ["2026-11-02-buy.yaml", batch(BUY, STOP)],
      ["2026-11-03-sale.yaml", batch(SELL)],
    ] as const) {
      await writeFile(dir("inbox", name), text, "utf8");
      assert.equal((await inbox.ingestInbox(new Date("2026-11-20T09:00:00Z"))).exitCode, 0);
    }
  });

  const storeFile = () => read("state", "portfolio.json");
  const repairLines = async () => (await log()).filter((l) => l.type === "repair");

  it("a store with a deleted lot is rebuilt, and the run is in the log", async () => {
    const good = JSON.parse(await storeFile());
    const broken = structuredClone(good);
    broken.silos.EUR.lots = [];
    await writeFile(dir("state", "portfolio.json"), JSON.stringify(broken), "utf8");

    const outcome = await repair.repairStore(now);
    assert.equal(outcome.exitCode, 0, outcome.lines.join("\n"));
    assert.match(outcome.lines.join("\n"), /Rebuilt state\/portfolio\.json/);
    const rebuilt = JSON.parse(await storeFile());
    assert.equal(rebuilt.silos.EUR.lots.length, 1);
    assert.deepEqual(rebuilt.silos.EUR.lots, good.silos.EUR.lots);
    assert.equal(rebuilt.silos.EUR.cash, good.silos.EUR.cash);

    const [line] = await repairLines();
    assert.ok(line);
    assert.equal(line.result, "rebuilt");
    assert.equal(line.date, "2026-11-25");
    assert.ok(Array.isArray(line.differences) && line.differences.length > 0, "the differences it found");
  });

  it("a store that does not read is rebuilt whole", async () => {
    const good = await storeFile();
    await writeFile(dir("state", "portfolio.json"), '{"silos": {', "utf8");
    const outcome = await repair.repairStore(now);
    assert.equal(outcome.exitCode, 0, outcome.lines.join("\n"));
    assert.deepEqual(JSON.parse(await storeFile()).silos.EUR.lots, JSON.parse(good).silos.EUR.lots);
    assert.equal((await repairLines())[0].result, "rebuilt");
  });

  it("a store that does not read gets its closed escalations back from the resolve commands of the applied batches (#141)", async () => {
    const id = "2026-11-10-xom";
    const text = "---\nticker: XOM\ncurrency: USD\nprice: 100\ntriggers: [big_move]\n---\n";
    await mkdir(dir("logs", "pending"), { recursive: true });
    await writeFile(dir("logs", "pending", `${id}.md`), text, "utf8");
    await writeFile(
      dir("inbox", "2026-11-21-close.yaml"),
      batch(`command: resolve\nid: ${id}\noutcome: discarded\nnote: stale\ndate: 2026-11-20`),
      "utf8",
    );
    assert.equal((await inbox.ingestInbox(new Date("2026-11-21T09:00:00Z"))).exitCode, 0);
    const closed = JSON.parse(await storeFile()).closed_escalations;
    assert.equal(closed.length, 1);

    await writeFile(dir("state", "portfolio.json"), '{"silos": {', "utf8");
    const outcome = await repair.repairStore(now);
    assert.equal(outcome.exitCode, 0, outcome.lines.join("\n"));
    const [rebuilt] = JSON.parse(await storeFile()).closed_escalations;
    assert.deepEqual(
      [rebuilt.id, rebuilt.outcome, rebuilt.note, rebuilt.date, rebuilt.by, rebuilt.sha256],
      [id, "discarded", "stale", "2026-11-20", "2026-11-21-close.yaml", closed[0].sha256],
    );
  });

  it("a store that is what the audit trail gives is left alone, and the run is still logged", async () => {
    const before = await snapshot();
    const outcome = await repair.repairStore(now);
    assert.equal(outcome.exitCode, 0);
    assert.match(outcome.lines.join("\n"), /Nothing to repair/);
    const after = await snapshot();
    assert.deepEqual(
      without(after, "/logs/decisions.jsonl"),
      without(before, "/logs/decisions.jsonl"),
      "only the log changes",
    );
    assert.equal((await repairLines())[0].result, "unchanged");
  });

  it("a log that disagrees with the applied batches refuses, says where, and changes nothing", async () => {
    const lines = (await read("logs", "decisions.jsonl")).split("\n").filter(Boolean);
    const tampered = lines
      .map((l) => JSON.parse(l) as Decision)
      .map((d) => (d.type === "entry" ? { ...d, price: 99 } : d));
    await writeFile(dir("logs", "decisions.jsonl"), tampered.map((d) => JSON.stringify(d)).join("\n") + "\n", "utf8");
    const before = await snapshot();

    const outcome = await repair.repairStore(now);
    assert.equal(outcome.exitCode, 1);
    const said = outcome.lines.join("\n");
    assert.match(said, /Repair refused/);
    assert.match(
      said,
      /price is 99 in logs\/decisions\.jsonl and 100 in inbox\/applied\/2026-11-02-buy\.yaml, command 1/,
    );

    const after = await snapshot();
    assert.deepEqual(
      without(after, "/logs/decisions.jsonl"),
      without(before, "/logs/decisions.jsonl"),
      "the store and the batches are untouched",
    );
    // The log keeps every line it had, and gets the line of the refusal.
    assert.ok(after["/logs/decisions.jsonl"].startsWith(before["/logs/decisions.jsonl"]));
    const [line] = await repairLines();
    assert.equal(line.result, "refused");
    assert.ok((line.differences ?? []).length > 0);
  });

  it("a log that lacks a line the batches write refuses and changes nothing", async () => {
    const kept = (await read("logs", "decisions.jsonl"))
      .split("\n")
      .filter(Boolean)
      .filter((l) => (JSON.parse(l) as { type: string }).type !== "exit");
    await writeFile(dir("logs", "decisions.jsonl"), kept.join("\n") + "\n", "utf8");
    const before = await snapshot();
    const outcome = await repair.repairStore(now);
    assert.equal(outcome.exitCode, 1);
    assert.match(outcome.lines.join("\n"), /but not in logs\/decisions\.jsonl/);
    assert.equal((await snapshot())["/state/portfolio.json"], before["/state/portfolio.json"]);
  });

  it("a repair after a correction rebuilds the corrected state", async () => {
    const id = (await log()).find((l) => l.type === "entry")!.id;
    await writeFile(dir("inbox", "2026-11-21-fix.yaml"), batch(`command: correct\nid: ${id}\nunits: 8`), "utf8");
    assert.equal((await inbox.ingestInbox(new Date("2026-11-21T09:00:00Z"))).exitCode, 0);
    const corrected = JSON.parse(await storeFile());
    const broken = structuredClone(corrected);
    broken.silos.EUR.lots = [];
    await writeFile(dir("state", "portfolio.json"), JSON.stringify(broken), "utf8");
    assert.equal((await repair.repairStore(now)).exitCode, 0);
    assert.deepEqual(JSON.parse(await storeFile()).silos.EUR.lots, corrected.silos.EUR.lots);
  });
});
