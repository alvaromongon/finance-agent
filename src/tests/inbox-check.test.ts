/**
 * `inbox:check` (#131, spec #124): the batches in `inbox/` against the current portfolio, read through the
 * state port, changing nothing. Temporary vault, no network. VAULT_PROJECT_DIR is set before the first import
 * of the engine.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { portfolioMd } from "./fixtures/inbox.js";

const SAP: { ticker: string; units: number; price: number } = { ticker: "SAP.DE", units: 5, price: 180 };

const batch = (...commands: string[]): string =>
  `schema_version: 1\ncommands:\n${commands.map((c) => `  - ${c.replace(/\n/g, "\n    ")}`).join("\n")}\n`;
const BUY = "command: buy\nticker: TCK\ndate: 2026-09-15\nunits: 2\nprice: 100 USD";
const SELL = "command: sale\nticker: TCK\ndate: 2026-09-20\nunits: 2\nprice: 110 USD";

describe("inbox:check", () => {
  let vaultDir: string;
  let checkInbox: typeof import("../inbox.js").checkInbox;
  const inbox = () => join(vaultDir, "inbox");
  const drop = (name: string, text: string) => writeFile(join(inbox(), name), text, "utf8");

  /** Every file of the vault with its bytes: what "changes nothing" is measured against. */
  async function snapshot(dir = vaultDir): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
      if (entry.isFile()) {
        const path = join(entry.parentPath, entry.name);
        out[relative(dir, path)] = await readFile(path, "utf8");
      }
    }
    return out;
  }

  before(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "finance-agent-inbox-"));
    process.env.VAULT_PROJECT_DIR = vaultDir;
    ({ checkInbox } = await import("../inbox.js"));
  });
  after(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await rm(inbox(), { recursive: true, force: true });
    await mkdir(inbox(), { recursive: true });
    await writeFile(join(vaultDir, "portfolio.md"), portfolioMd({ usd: [SAP] }), "utf8");
  });

  it("says a missing or empty inbox is nothing to check and exits 0", async () => {
    assert.deepEqual(await checkInbox(), { lines: ["Inbox is empty: nothing to check."], exitCode: 0 });
    await rm(inbox(), { recursive: true });
    assert.equal((await checkInbox()).exitCode, 0);
  });

  it("exits 0 for a clean batch, and a buy and its sale in one batch are valid", async () => {
    await drop("2026-09-15.yaml", batch("command: deposit\namount: 100 USD", BUY, SELL));
    const { lines, exitCode } = await checkInbox();
    assert.equal(exitCode, 0, lines.join("\n"));
    assert.match(lines[0], /clean: 1 batch/);
  });

  it("checks each command against the state the previous ones produce", async () => {
    // The state has 500 USD: the second withdrawal fails only because the first one already happened.
    await drop("a.yaml", batch("command: withdrawal\namount: 300 USD", "command: withdrawal\namount: 300 USD"));
    const { lines, exitCode } = await checkInbox();
    assert.equal(exitCode, 1);
    assert.match(
      lines[0],
      /^inbox\/a\.yaml: command 2, line 5: the withdrawal of 300\.00 USD exceeds the available cash of 200\.00 USD$/,
    );
  });

  it("reports every error of the batch, not only the first: command, line and reason", async () => {
    await drop(
      "a.yaml",
      batch(
        "command: withdrawal\namount: 9999 USD", // 1: over the cash
        "command: sale\nticker: SAP.DE\ndate: 2026-09-20\nunits: 9\nprice: 1 USD", // 2: more than held
        "command: deposit\namount: 10 GBP", // 3: unknown currency
        "command: deposit\namount: 10 USD", // 4: fine
        "command: sale\nticker: ZZZ\ndate: 2026-09-20\nunits: 1\nprice: 1 USD", // 5: not held
        "command: buy\nticker: TCK\ndate: 2026-09-15\nunits: 1e2\nprice: 1 USD", // 6: notation
      ),
    );
    const { lines, exitCode } = await checkInbox();
    assert.equal(exitCode, 1);
    assert.deepEqual(
      lines.map((l) => l.replace(/:.*?(command \d+, line \d+).*$/, " $1")),
      [
        "inbox/a.yaml command 1, line 3",
        "inbox/a.yaml command 2, line 5",
        "inbox/a.yaml command 3, line 10",
        "inbox/a.yaml command 5, line 14",
        "inbox/a.yaml command 6, line 19",
        lines[5],
      ],
    );
    assert.match(lines[5], /^5 error\(s\) in 1 of 1 batch/);
  });

  it("checks the currency of the silo: the EUR cash does not cover a USD withdrawal, nor does a USD amount touch EUR", async () => {
    await writeFile(join(vaultDir, "portfolio.md"), portfolioMd({ eurCash: "9000.00", usdCash: "50.00" }), "utf8");
    await drop("a.yaml", batch("command: withdrawal\namount: 100 USD", "command: withdrawal\namount: 100 EUR"));
    const { lines } = await checkInbox();
    assert.equal(lines.filter((l) => /command \d/.test(l)).length, 1);
    assert.match(lines[0], /command 1.*100\.00 USD exceeds the available cash of 50\.00 USD/);
  });

  it("reports a malformed YAML file as one error, not a crash, and still checks the other files", async () => {
    await drop("a.yaml", "schema_version: 1\ncommands: [oops\n");
    await drop("b.yaml", batch("command: deposit\namount: 5 USD"));
    await drop("c.yml", batch("command: deposit\namount: 5 GBP"));
    const { lines, exitCode } = await checkInbox();
    assert.equal(exitCode, 1);
    assert.match(lines[0], /^inbox\/a\.yaml: file, line \d+: not valid YAML/);
    assert.match(lines[1], /^inbox\/c\.yml: command 1, line 3: .*unknown currency/);
    assert.match(lines[2], /^2 error\(s\) in 2 of 3 batch/);
  });

  it("checks the files in name order, each against what the clean ones before it would produce", async () => {
    await drop("1.yaml", batch("command: withdrawal\namount: 400 USD"));
    await drop("2.yaml", batch("command: withdrawal\namount: 400 USD")); // only 100 left after 1.yaml
    await drop("3.yaml", batch("command: deposit\namount: 1 GBP")); // rejected: contributes nothing
    await drop("4.yaml", batch("command: withdrawal\namount: 100 USD")); // 100 are left
    const { lines } = await checkInbox();
    assert.deepEqual(
      lines.filter((l) => l.startsWith("inbox/")).map((l) => l.split(":")[0]),
      ["inbox/2.yaml", "inbox/3.yaml"],
    );
  });

  it("ignores files that are not YAML", async () => {
    await drop("notes.txt", "not a batch");
    assert.equal((await checkInbox()).exitCode, 0);
  });

  it("refuses a portfolio it cannot read whole instead of checking against a partial state", async () => {
    await writeFile(join(vaultDir, "portfolio.md"), "---\nschema_version: 1\n---\n", "utf8");
    await drop("a.yaml", batch("command: deposit\namount: 5 USD"));
    await assert.rejects(checkInbox(), /portfolio\.md/);
  });

  it("writes nothing: the inbox and the state are byte-identical afterwards, clean batch or not", async () => {
    await drop("a.yaml", batch("command: deposit\namount: 100 USD", BUY, SELL));
    await drop("b.yaml", batch("command: withdrawal\namount: 99999 USD", "command: deposit\namount: 5"));
    await drop("c.yaml", "{ not yaml");
    const before = await snapshot();
    await checkInbox();
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual((await readdir(vaultDir)).sort(), ["inbox", "portfolio.md"]);
    assert.deepEqual((await readdir(inbox())).sort(), ["a.yaml", "b.yaml", "c.yaml"]);
  });

  describe("the command `npm run inbox:check`", () => {
    const run = () =>
      spawnSync(process.execPath, ["--import", "tsx/esm", join(import.meta.dirname, "..", "inbox.ts"), "check"], {
        env: { ...process.env, VAULT_PROJECT_DIR: vaultDir },
        encoding: "utf8",
      });

    it("exits 0 and prints on stdout for a clean batch", async () => {
      await drop("a.yaml", batch("command: deposit\namount: 5 USD"));
      const result = run();
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Inbox is clean/);
    });

    it("exits non-zero and lists the errors on stderr for a batch with errors", async () => {
      await drop("a.yaml", batch("command: deposit\namount: 5"));
      const result = run();
      assert.equal(result.status, 1);
      assert.match(result.stderr, /inbox\/a\.yaml: command 1, line 3: "amount" needs its currency/);
    });

    it("is wired in package.json", () => {
      const scripts = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf8")).scripts;
      assert.equal(scripts["inbox:check"], "tsx src/inbox.ts check");
    });
  });

  describe("the inbox is not part of the heartbeat (the stop check does not read it)", () => {
    it("no module of the engine but the inbox's own reads the inbox", () => {
      const SRC = join(import.meta.dirname, "..");
      const inboxModules = new Set([
        "inbox.ts",
        "inbox-store.ts",
        "utils/inbox-check.ts",
        "utils/inbox-parse.ts",
        "utils/inbox-handlers.ts",
      ]);
      const walk = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory()
            ? e.name === "tests"
              ? []
              : walk(join(dir, e.name))
            : e.name.endsWith(".ts")
              ? [relative(SRC, join(dir, e.name))]
              : [],
        );
      const importers = walk(SRC).filter(
        (file) =>
          !inboxModules.has(file) && /from\s+["'][^"']*inbox[^"']*["']/.test(readFileSync(join(SRC, file), "utf8")),
      );
      assert.deepEqual(importers, []);
    });
  });
});
