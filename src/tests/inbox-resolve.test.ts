/**
 * Closing a pending escalation is a command (#141, spec #124): a signal the engine escalated and left in
 * `logs/pending/` is open until a `resolve` command closes it, answered (`resolved`) or given up (`discarded`), and it
 * is named in every digest until then. The file stays as the record; the store remembers it was closed.
 * Temporary vault, no network. VAULT_PROJECT_DIR is set before the first import of the engine.
 */
process.env.OUTPUT_LANGUAGE = "en";
import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { portfolioMd, watchlistMd } from "./fixtures/inbox.js";

const batch = (...commands: string[]): string =>
  `schema_version: 1\ncommands:\n${commands.map((c) => `  - ${c.replace(/\n/g, "\n    ")}`).join("\n")}\n`;
const DEPOSIT = "command: deposit\namount: 10 EUR";
const TOO_MUCH = "command: withdrawal\namount: 99999 EUR";
const resolveOf = (id: string, outcome = "resolved", extra = ""): string =>
  `command: resolve\nid: ${id}\noutcome: ${outcome}${extra}`;

const XOM = "2026-11-20-xom";
const KO = "2026-11-21-ko";
const pendingText = (ticker: string, extra = ""): string =>
  `---\nticker: ${ticker}\ncurrency: USD\nprice: 100\ntriggers: [big_move]\n---\n\nSignal ${ticker} ${extra}\n`;

describe("pending escalations are closed by a command (#141)", () => {
  let vaultDir: string;
  let inbox: typeof import("../inbox.js");
  let escalations: typeof import("../inbox-escalations.js");
  let digestMod: typeof import("../utils/heartbeat-digest.js");
  const dir = (...parts: string[]) => join(vaultDir, ...parts);
  const drop = (name: string, text: string) => writeFile(dir("inbox", name), text, "utf8");
  const raise = (id: string, text: string) => writeFile(dir("logs", "pending", `${id}.md`), text, "utf8");
  const storeDoc = async () => JSON.parse(await readFile(dir("state", "portfolio.json"), "utf8"));
  const lines = (r: { lines: string[] }): string => r.lines.join("\n");

  before(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "finance-agent-resolve-"));
    process.env.VAULT_PROJECT_DIR = vaultDir;
    mock.method(console, "warn", () => {});
    mock.method(console, "log", () => {});
    inbox = await import("../inbox.js");
    escalations = await import("../inbox-escalations.js");
    digestMod = await import("../utils/heartbeat-digest.js");
  });
  after(async () => {
    mock.restoreAll();
    await rm(vaultDir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    for (const name of await readdir(vaultDir)) await rm(dir(name), { recursive: true, force: true });
    await mkdir(dir("inbox"), { recursive: true });
    await mkdir(dir("logs", "pending"), { recursive: true });
    await mkdir(dir("strategies"), { recursive: true });
    await writeFile(dir("strategies", "base.md"), `---\nversion: "1.4"\n---\n`, "utf8");
    await writeFile(dir("portfolio.md"), portfolioMd(), "utf8");
    await writeFile(dir("watchlist.md"), watchlistMd([["ABC", "EUR"]]), "utf8");
    await raise(XOM, pendingText("XOM"));
    await raise(KO, pendingText("KO"));
  });

  const digestOf = async () => {
    const pendingEscalations = await escalations.readOpenEscalations();
    return digestMod.renderHeartbeatDigest({
      currency: "USD",
      minAtr: 2,
      breaches: [],
      lotsWarnings: [],
      tickerWarnings: [],
      unreadableCells: [],
      noStop: [],
      rejectedBatches: [],
      pendingEscalations,
      storeProblem: null,
      configurationProblems: [],
      staleness: null,
      snapshot: null,
      tightStops: [],
      armed: [],
      escalated: [],
    });
  };

  it("an escalation stays in every digest until a command closes it: two digests, then the closing batch", async () => {
    const first = (await digestOf())!;
    assert.ok(first.body.includes(`- \`logs/pending/${XOM}.md\``), first.body);
    assert.ok(first.body.includes(`- \`logs/pending/${KO}.md\``));
    assert.match(first.subject, /pending escalation/);

    // An unrelated batch is applied between the two digests: it closes nothing.
    await drop("1-deposit.yaml", batch(DEPOSIT));
    assert.equal((await inbox.ingestInbox()).exitCode, 0);
    const second = (await digestOf())!;
    assert.ok(second.body.includes(`logs/pending/${XOM}.md`));
    assert.ok(second.body.includes(`logs/pending/${KO}.md`));

    // The closing batch closes one of them: the other stays.
    await drop("2-close.yaml", batch(resolveOf(XOM)));
    const result = await inbox.ingestInbox(new Date("2026-11-22T09:00:00Z"));
    assert.equal(result.exitCode, 0, lines(result));
    assert.match(lines(result), /Closed 1 pending escalation\(s\)\./);
    const third = (await digestOf())!;
    assert.ok(!third.body.includes(`logs/pending/${XOM}.md`), "the closed one is gone");
    assert.ok(third.body.includes(`logs/pending/${KO}.md`), "the other one stays");

    await drop("3-close.yaml", batch(resolveOf(KO, "discarded")));
    assert.equal((await inbox.ingestInbox()).exitCode, 0);
    assert.equal(await digestOf(), null, "nothing left to say");
  });

  it("writes the closing to the store with the outcome, the note, the date and the batch, and keeps the file", async () => {
    await drop(
      "close.yaml",
      batch(resolveOf(XOM, "resolved", "\nnote: bought half, rest on the next dip\ndate: 2026-11-21")),
    );
    const result = await inbox.ingestInbox(new Date("2026-11-22T09:00:00Z"));
    assert.equal(result.exitCode, 0, lines(result));
    const [closed] = (await storeDoc()).closed_escalations;
    assert.equal(closed.id, XOM);
    assert.equal(closed.outcome, "resolved");
    assert.equal(closed.note, "bought half, rest on the next dip");
    assert.equal(closed.date, "2026-11-21");
    assert.equal(closed.by, "close.yaml");
    assert.match(closed.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(
      (await readdir(dir("logs", "pending"))).sort(),
      [`${XOM}.md`, `${KO}.md`],
      "the files are the record",
    );
    assert.deepEqual(await readdir(dir("inbox", "applied")), ["close.yaml"]);
  });

  it("the date is the day of the run when the command gives none, and a discard is recorded as discarded", async () => {
    await drop("close.yaml", batch(resolveOf(KO, "discarded")));
    await inbox.ingestInbox(new Date("2026-11-22T09:00:00Z"));
    const [closed] = (await storeDoc()).closed_escalations;
    assert.deepEqual([closed.id, closed.outcome, closed.date, closed.note], [KO, "discarded", "2026-11-22", undefined]);
  });

  it("a batch with only a resolve is applied: it changes no cash, lot or stop", async () => {
    await drop("close.yaml", batch(resolveOf(XOM)));
    assert.equal((await inbox.ingestInbox()).exitCode, 0);
    assert.equal((await storeDoc()).silos.EUR.cash, "1000.00 EUR");
  });

  describe("refuses, naming the command", () => {
    it("an id that does not exist", async () => {
      await drop("close.yaml", batch(resolveOf("2026-11-20-nope")));
      const result = await inbox.checkInbox();
      assert.equal(result.exitCode, 1);
      assert.match(
        lines(result),
        /inbox\/close\.yaml: command 1, line 3: cannot resolve "2026-11-20-nope": no pending escalation of that id is open/,
      );
    });

    it("an escalation that is already closed, by an earlier run, by an earlier file of the run or by the same batch", async () => {
      await drop("1-close.yaml", batch(resolveOf(XOM)));
      await inbox.ingestInbox();
      await drop("2-again.yaml", batch(resolveOf(XOM, "discarded")));
      const later = await inbox.checkInbox();
      assert.equal(later.exitCode, 1);
      assert.match(
        lines(later),
        /inbox\/2-again\.yaml: command 1, line 3: cannot resolve "2026-11-20-xom": no pending escalation/,
      );

      await rm(dir("inbox", "2-again.yaml"));
      await drop("3-a.yaml", batch(resolveOf(KO)));
      await drop("4-b.yaml", batch(resolveOf(KO)));
      const sameRun = await inbox.checkInbox();
      assert.match(lines(sameRun), /inbox\/4-b\.yaml: command 1/);
      assert.doesNotMatch(lines(sameRun), /inbox\/3-a\.yaml: command/);

      await rm(dir("inbox", "3-a.yaml"));
      await rm(dir("inbox", "4-b.yaml"));
      await drop("5-twice.yaml", batch(resolveOf(KO), resolveOf(KO, "discarded")));
      assert.match(
        lines(await inbox.checkInbox()),
        /inbox\/5-twice\.yaml: command 2, line \d+: cannot resolve "2026-11-21-ko"/,
      );
    });

    it("a date in the future, an outcome that is neither, a missing field, an unknown field and a long note", async () => {
      await drop(
        "close.yaml",
        batch(
          resolveOf(XOM, "resolved", "\ndate: 2999-01-01"),
          resolveOf(KO, "maybe"),
          "command: resolve\noutcome: resolved",
          "command: resolve\nid: ../etc/passwd\noutcome: resolved",
          `${resolveOf(KO)}\nnote: ${"x".repeat(501)}`,
          `${resolveOf(KO)}\nticker: KO`,
        ),
      );
      const out = lines(await inbox.checkInbox());
      assert.match(out, /command 1, line \d+: the date 2999-01-01 is in the future/);
      assert.match(out, /command 2, line \d+: "outcome" must be resolved or discarded; got: "maybe"/);
      assert.match(out, /command 3, line \d+: missing field "id"/);
      assert.match(out, /command 4, line \d+: "id" must be the id of a pending escalation/);
      assert.match(out, /command 5, line \d+: "note" must be at most 500 characters/);
      assert.match(out, /command 6, line \d+: unknown field "ticker" for a resolve/);
    });

    it("blocks nothing: the commands after a refused resolve are checked as usual", async () => {
      await drop("close.yaml", batch(resolveOf("2026-11-20-nope"), TOO_MUCH));
      const out = lines(await inbox.checkInbox());
      assert.equal(out.split("\n").filter((l) => /command \d/.test(l)).length, 2, out);
      assert.doesNotMatch(out, /not checked/);
    });

    it("a refused batch closes nothing: it is rejected whole and the escalation stays open", async () => {
      await drop("close.yaml", batch(resolveOf(XOM), TOO_MUCH));
      assert.equal((await inbox.ingestInbox()).exitCode, 1);
      assert.deepEqual(await escalations.readOpenEscalations(), [KO, XOM].sort());
    });
  });

  describe("inbox:check validates it against the list as the commands before it leave it", () => {
    it("a command after a closing of the same id in the same batch is refused", async () => {
      await drop("close.yaml", batch(resolveOf(XOM), resolveOf(XOM)));
      assert.match(lines(await inbox.checkInbox()), /command 2, line \d+: cannot resolve/);
    });

    it("names the escalations left open, and not the ones a clean file closes", async () => {
      await drop("close.yaml", batch(resolveOf(XOM)));
      const out = lines(await inbox.checkInbox());
      assert.match(out, /1 pending escalation\(s\) awaiting a resolve command: logs\/pending\/2026-11-21-ko\.md\./);
      assert.doesNotMatch(out, /2026-11-20-xom/);
    });

    it("names them with an empty inbox too, and changes nothing", async () => {
      const result = await inbox.checkInbox();
      assert.equal(result.exitCode, 0);
      assert.match(lines(result), /Inbox is empty: nothing to check\./);
      assert.match(
        lines(result),
        /2 pending escalation\(s\) awaiting a resolve command: logs\/pending\/2026-11-20-xom\.md, logs\/pending\/2026-11-21-ko\.md\./,
      );
      assert.deepEqual(await readdir(dir("logs", "pending")), [`${XOM}.md`, `${KO}.md`]);
    });
  });

  it("a new escalation written under a closed one's name is open again (the hash of the file tells them apart)", async () => {
    await drop("close.yaml", batch(resolveOf(XOM)));
    await inbox.ingestInbox();
    assert.deepEqual(await escalations.readOpenEscalations(), [KO]);
    await raise(XOM, pendingText("XOM", "a second signal the same day"));
    assert.deepEqual(await escalations.readOpenEscalations(), [KO, XOM].sort());
  });

  it("a file in logs/pending/ that is not a name the engine writes is not an escalation and never stops the run", async () => {
    await writeFile(dir("logs", "pending", "notes.md"), "x", "utf8");
    assert.deepEqual(await escalations.readOpenEscalations(), [KO, XOM].sort());
  });

  it("the escalations to work on leave out the ones a batch waiting in inbox/ already closes", async () => {
    await drop("close.yaml", batch(resolveOf(XOM)));
    assert.deepEqual(await escalations.readEscalationsToDo(), [KO]);
    assert.deepEqual(
      await escalations.readOpenEscalations(),
      [KO, XOM].sort(),
      "the digest still names it until ingest",
    );
  });

  it("a correction replays the batches that closed an escalation without refusing them", async () => {
    await drop("1-deposit.yaml", batch(DEPOSIT));
    await inbox.ingestInbox();
    const history = JSON.parse((await readFile(dir("logs", "decisions.jsonl"), "utf8")).trim().split("\n")[0]);
    await drop("2-close.yaml", batch(resolveOf(XOM)));
    await inbox.ingestInbox();
    await drop("3-fix.yaml", batch(`command: correct\nid: ${history.id}\namount: 25 EUR`));
    const result = await inbox.ingestInbox();
    assert.equal(result.exitCode, 0, lines(result));
    assert.equal((await storeDoc()).silos.EUR.cash, "1025.00 EUR");
    assert.deepEqual(
      (await storeDoc()).closed_escalations.map((c: { id: string }) => c.id),
      [XOM],
    );
  });
});
