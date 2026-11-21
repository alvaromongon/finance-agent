/**
 * A rejected batch is never forgotten (#152, spec #124): it stays in `inbox/rejected/` as the audit trail, is never
 * retried, and is awaiting an answer until a later batch replaces it (`replaces:`) or discards it (`discard`).
 * Temporary vault, no network. VAULT_PROJECT_DIR is set before the first import of the engine.
 */
import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { portfolioMd, watchlistMd } from "./fixtures/inbox.js";

const batch = (...commands: string[]): string =>
  `schema_version: 1\ncommands:\n${commands.map((c) => `  - ${c.replace(/\n/g, "\n    ")}`).join("\n")}\n`;
const replacing = (file: string, ...commands: string[]): string => `replaces: ${file}\n${batch(...commands)}`;
const TOO_MUCH = "command: withdrawal\namount: 99999 EUR";
const DEPOSIT = "command: deposit\namount: 10 EUR";

describe("rejected batches (#152)", () => {
  let vaultDir: string;
  let inbox: typeof import("../inbox.js");
  let rejected: typeof import("../inbox-rejected.js");
  const dir = (...parts: string[]) => join(vaultDir, ...parts);
  const drop = (name: string, text: string) => writeFile(dir("inbox", name), text, "utf8");
  const ls = (...parts: string[]) =>
    readdir(dir(...parts)).then(
      (names) => names.sort(),
      () => [] as string[],
    );
  const storeDoc = async () => JSON.parse(await readFile(dir("state", "portfolio.json"), "utf8"));

  before(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "finance-agent-rejected-"));
    process.env.VAULT_PROJECT_DIR = vaultDir;
    mock.method(console, "warn", () => {});
    mock.method(console, "log", () => {});
    inbox = await import("../inbox.js");
    rejected = await import("../inbox-rejected.js");
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
    await writeFile(dir("portfolio.md"), portfolioMd(), "utf8");
    await writeFile(dir("watchlist.md"), watchlistMd([["ABC", "EUR"]]), "utf8");
  });

  describe("until it is replaced or discarded", () => {
    beforeEach(async () => {
      await drop("bad.yaml", batch(TOO_MUCH));
      assert.equal((await inbox.ingestInbox()).exitCode, 1);
    });

    it("stays in rejected/ as the audit trail, with its errors, and awaits an answer", async () => {
      assert.deepEqual(await ls("inbox", "rejected"), ["bad.yaml", "bad.yaml.errors.txt"]);
      assert.deepEqual(await rejected.readAwaitingRejected(), ["bad.yaml"]);
    });

    it("is never retried: later runs leave the file as it is, and it is still awaiting", async () => {
      const text = await readFile(dir("inbox", "rejected", "bad.yaml"), "utf8");
      await drop("later.yaml", batch(DEPOSIT));
      assert.equal((await inbox.ingestInbox()).exitCode, 0);
      assert.equal((await inbox.ingestInbox()).lines[0], "Inbox is empty: nothing to apply.");
      assert.equal(await readFile(dir("inbox", "rejected", "bad.yaml"), "utf8"), text);
      assert.deepEqual(await rejected.readAwaitingRejected(), ["bad.yaml"]);
      assert.equal((await storeDoc()).silos.EUR.cash, "1010.00 EUR", "only the later batch was applied");
    });

    it("is named by inbox:check, which changes nothing", async () => {
      await drop("later.yaml", batch(DEPOSIT));
      const result = await inbox.checkInbox();
      assert.equal(result.exitCode, 0);
      assert.match(
        result.lines.join("\n"),
        /1 rejected batch\(es\) awaiting a replacement or a discard: inbox\/rejected\/bad\.yaml/,
      );
    });

    it("makes a later batch that depends on it fail its own validation", async () => {
      await drop("0-bad-buy.yaml", batch("command: buy\nticker: ABC\ndate: 2026-09-15\nunits: 1000\nprice: 100 EUR"));
      assert.equal((await inbox.ingestInbox()).exitCode, 1);
      await drop("1-sell.yaml", batch("command: sale\nticker: ABC\ndate: 2026-09-20\nunits: 1\nprice: 110 EUR"));
      const result = await inbox.ingestInbox();
      assert.equal(result.exitCode, 1);
      assert.match(result.lines.join("\n"), /1-sell\.yaml: command 1, line 3: Cannot sell ABC: no open lots/);
    });
  });

  describe("inbox:check names the waiting batches in every case", () => {
    beforeEach(async () => {
      await drop("bad.yaml", batch(TOO_MUCH));
      await inbox.ingestInbox();
    });

    it("also with an empty inbox: nothing to check, and the batch that awaits an answer", async () => {
      const result = await inbox.checkInbox();
      assert.equal(result.exitCode, 0);
      assert.deepEqual(result.lines, [
        "Inbox is empty: nothing to check.",
        "1 rejected batch(es) awaiting a replacement or a discard: inbox/rejected/bad.yaml.",
      ]);
    });

    it("does not list a batch a clean file of the same inbox replaces or discards", async () => {
      await drop("fix.yaml", replacing("bad.yaml", DEPOSIT));
      const result = await inbox.checkInbox();
      assert.equal(result.exitCode, 0);
      assert.doesNotMatch(result.lines.join("\n"), /awaiting a replacement/);
    });

    it("still lists it when the file that would settle it is refused", async () => {
      await drop("fix.yaml", replacing("bad.yaml", TOO_MUCH));
      assert.match(
        (await inbox.checkInbox()).lines.join("\n"),
        /awaiting a replacement or a discard: inbox\/rejected\/bad\.yaml/,
      );
    });

    it("a rejected/ that cannot be read is said and stops neither check nor ingest", async () => {
      await rm(dir("inbox", "rejected"), { recursive: true });
      await mkdir(dir("elsewhere"));
      await symlink(dir("elsewhere"), dir("inbox", "rejected"));
      await drop("later.yaml", batch(DEPOSIT));
      const checked = await inbox.checkInbox();
      assert.equal(checked.exitCode, 0);
      assert.match(checked.lines.join("\n"), /inbox\/rejected could not be read: inbox\/rejected is not a real folder/);
      const ingested = await inbox.ingestInbox();
      assert.equal(ingested.exitCode, 0, ingested.lines.join("\n"));
      assert.match(ingested.lines.join("\n"), /inbox\/rejected could not be read/);
      assert.equal((await storeDoc()).silos.EUR.cash, "1010.00 EUR");
    });

    it("a link or a hidden file in rejected/ is named, never read, and the batches next to it are", async () => {
      await writeFile(dir("elsewhere.yaml"), batch(DEPOSIT), "utf8");
      await symlink(dir("elsewhere.yaml"), dir("inbox", "rejected", "linked.yaml"));
      await writeFile(dir("inbox", "rejected", "._hidden.yaml"), "x", "utf8");
      const result = await inbox.checkInbox();
      const text = result.lines.join("\n");
      assert.match(text, /inbox\/rejected\/\._hidden\.yaml is a hidden file/);
      assert.match(text, /inbox\/rejected\/linked\.yaml is a symbolic link/);
      assert.match(text, /awaiting a replacement or a discard: inbox\/rejected\/bad\.yaml\./);
      assert.deepEqual(await rejected.readAwaitingRejected(), ["bad.yaml"]);
    });
  });

  describe("replaces:", () => {
    beforeEach(async () => {
      await drop("bad.yaml", batch(TOO_MUCH));
      await inbox.ingestInbox();
    });

    it("a clean batch that replaces it applies, and the rejected file stays but no longer awaits", async () => {
      await drop("fix.yaml", replacing("bad.yaml", "command: withdrawal\namount: 100 EUR"));
      const result = await inbox.ingestInbox(new Date("2026-11-13T09:00:00Z"));
      assert.equal(result.exitCode, 0, result.lines.join("\n"));
      assert.deepEqual(await rejected.readAwaitingRejected(), []);
      assert.deepEqual(await ls("inbox", "rejected"), ["bad.yaml", "bad.yaml.errors.txt"]);
      const doc = await storeDoc();
      assert.equal(doc.silos.EUR.cash, "900.00 EUR");
      assert.deepEqual(
        doc.resolved_rejections.map((r: Record<string, string>) => [r.file, r.how, r.by, r.at]),
        [["bad.yaml", "replaced", "fix.yaml", "2026-11-13T09:00:00.000Z"]],
      );
    });

    it("a replacement that is itself refused settles nothing: the original still awaits", async () => {
      await drop("fix.yaml", replacing("bad.yaml", TOO_MUCH));
      assert.equal((await inbox.ingestInbox()).exitCode, 1);
      assert.deepEqual(await rejected.readAwaitingRejected(), ["bad.yaml", "fix.yaml"]);
    });

    it("naming a file that is not awaiting is an error of the file, at the replaces line", async () => {
      await drop("fix.yaml", replacing("other.yaml", DEPOSIT));
      const result = await inbox.checkInbox();
      assert.equal(result.exitCode, 1);
      assert.match(
        result.lines.join("\n"),
        /inbox\/fix\.yaml: file, line 1: cannot replace "other\.yaml": no rejected batch of that name is awaiting/,
      );
    });

    it("a file that was replaced cannot be replaced again, nor discarded", async () => {
      await drop("1-fix.yaml", replacing("bad.yaml", DEPOSIT));
      await drop("2-again.yaml", replacing("bad.yaml", DEPOSIT));
      await drop("3-discard.yaml", batch("command: discard\nfile: bad.yaml"));
      const result = await inbox.ingestInbox();
      assert.equal(result.exitCode, 1);
      assert.match(result.lines.join("\n"), /2-again\.yaml: file, line 1: cannot replace "bad\.yaml"/);
      assert.match(result.lines.join("\n"), /3-discard\.yaml: command 1, line 3: cannot discard "bad\.yaml"/);
      assert.equal((await storeDoc()).silos.EUR.cash, "1010.00 EUR", "only the first replacement was applied");
    });

    it("a batch cannot replace one file and discard it too", async () => {
      await drop("fix.yaml", replacing("bad.yaml", DEPOSIT, "command: discard\nfile: bad.yaml"));
      const result = await inbox.checkInbox();
      assert.equal(result.exitCode, 1);
      assert.match(result.lines.join("\n"), /fix\.yaml: command 2, line 6: cannot discard "bad\.yaml"/);
    });

    it("check says what ingest does, and writes nothing", async () => {
      await drop("fix.yaml", replacing("bad.yaml", DEPOSIT));
      assert.equal((await inbox.checkInbox()).exitCode, 0);
      assert.deepEqual(await rejected.readAwaitingRejected(), ["bad.yaml"]);
      assert.deepEqual(await ls("inbox"), ["fix.yaml", "rejected"]);
    });
  });

  describe("the discard command", () => {
    beforeEach(async () => {
      await drop("bad.yaml", batch(TOO_MUCH));
      await inbox.ingestInbox();
    });

    it("gives the rejected batch up, beside other commands, and the file stays as the audit trail", async () => {
      await drop("d.yaml", batch(DEPOSIT, "command: discard\nfile: bad.yaml"));
      const result = await inbox.ingestInbox(new Date("2026-11-13T09:00:00Z"));
      assert.equal(result.exitCode, 0, result.lines.join("\n"));
      assert.deepEqual(await rejected.readAwaitingRejected(), []);
      assert.deepEqual(await ls("inbox", "rejected"), ["bad.yaml", "bad.yaml.errors.txt"]);
      const doc = await storeDoc();
      assert.deepEqual(
        doc.resolved_rejections.map((r: Record<string, string>) => [r.file, r.how, r.by]),
        [["bad.yaml", "discarded", "d.yaml"]],
      );
      assert.equal(doc.silos.EUR.cash, "1010.00 EUR");
    });

    it("a batch with only a discard is applied: it changes no cash, lot or stop", async () => {
      await drop("d.yaml", batch("command: discard\nfile: bad.yaml"));
      assert.equal((await inbox.ingestInbox()).exitCode, 0);
      assert.equal((await storeDoc()).silos.EUR.cash, "1000.00 EUR");
    });

    it("refuses a name that is not awaiting, naming the command", async () => {
      await drop("d.yaml", batch("command: discard\nfile: nothing.yaml"));
      const result = await inbox.checkInbox();
      assert.equal(result.exitCode, 1);
      assert.match(
        result.lines.join("\n"),
        /inbox\/d\.yaml: command 1, line 3: cannot discard "nothing\.yaml": no rejected batch of that name is awaiting/,
      );
    });

    it("a refused discard blocks nothing: the commands after it are checked as usual", async () => {
      await drop("d.yaml", batch("command: discard\nfile: nothing.yaml", TOO_MUCH));
      const result = await inbox.checkInbox();
      assert.equal(result.lines.filter((l) => /command \d/.test(l)).length, 2, result.lines.join("\n"));
      assert.doesNotMatch(result.lines.join("\n"), /not checked/);
    });

    it("an unreadable discard blocks nothing either", async () => {
      await drop("d.yaml", batch("command: discard\nfile: ../x.yaml", TOO_MUCH));
      const result = await inbox.checkInbox();
      assert.doesNotMatch(result.lines.join("\n"), /not checked/);
      assert.match(result.lines.join("\n"), /"file" must be the name of a rejected batch/);
    });

    it("a rejected batch is awaiting again when a file of the same name but another text takes its place", () => {
      const resolved = [
        { file: "a.yaml", sha256: rejected.sha256("old"), how: "replaced" as const, by: "b.yaml", at: "x" },
      ];
      assert.deepEqual(rejected.awaitingOf([{ name: "a.yaml", text: "old" }], resolved), []);
      assert.deepEqual(rejected.awaitingOf([{ name: "a.yaml", text: "new" }], resolved), ["a.yaml"]);
    });
  });
});
