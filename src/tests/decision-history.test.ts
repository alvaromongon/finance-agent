/**
 * Tests of readDecisionHistory: the full log joins the archived
 * quarters with the live file, in chronological order (ADR-0006, "Retention").
 * Temporary vault with the same structure as the repo, no network. VAULT_PROJECT_DIR
 * is set before the first import of config.js.
 */
import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Decision } from "../decisions.js";

describe("readDecisionHistory", () => {
  let root: string;
  let vaultDir: string;
  let archiveDir: string;
  let readDecisionHistory: (archiveDir?: string) => Promise<Decision[]>;
  let buildDecision: (typeof import("../decisions.js"))["buildDecision"];

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "finance-agent-decision-history-"));
    vaultDir = join(root, "brain");
    archiveDir = join(root, "archive");
    await mkdir(join(vaultDir, "logs"), { recursive: true });
    await mkdir(archiveDir, { recursive: true });
    process.env.VAULT_PROJECT_DIR = vaultDir;
    process.env.DECISIONS_ARCHIVE_DIR = archiveDir;
    ({ readDecisionHistory } = await import("../vault-io.js"));
    ({ buildDecision } = await import("../decisions.js"));
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const deposit = (date: string) =>
    buildDecision({
      date,
      ticker: null,
      currency: "EUR",
      origin: "propietario",
      source: "portfolio-sync",
      type: "deposit",
      amount: 50,
      rules_version: "0.4",
    });
  const line = (d: Decision) => JSON.stringify(d) + "\n";

  it("reads the archived quarters in order and then the live file, without repeating ids", async () => {
    const q2 = deposit("2026-05-04");
    const q3 = deposit("2026-08-03");
    const live = deposit("2026-09-14");
    await writeFile(join(archiveDir, "decisions-2026-T3.jsonl"), line(q3), "utf8");
    await writeFile(join(archiveDir, "decisions-2026-T2.jsonl"), line(q2), "utf8");
    await writeFile(join(archiveDir, "outcomes.md"), "not a decision log\n", "utf8");
    // A line left in both places (a half-done archive) counts once.
    await writeFile(join(vaultDir, "logs", "decisions.jsonl"), line(q3) + line(live), "utf8");

    const history = await readDecisionHistory();
    assert.deepEqual(
      history.map((d) => d.date),
      ["2026-05-04", "2026-08-03", "2026-09-14"],
    );
  });

  it("is chronological whichever quarter was archived: a later quarter in the archive does not jump ahead", async () => {
    const q2 = deposit("2026-05-04");
    const q3 = deposit("2026-08-03");
    const live = deposit("2026-09-14");
    // The middle quarter stays live and the last one is archived: write order is q2, q3, live.
    await writeFile(join(archiveDir, "decisions-2026-T3.jsonl"), line(q3), "utf8");
    await rm(join(archiveDir, "decisions-2026-T2.jsonl"), { force: true });
    await writeFile(join(vaultDir, "logs", "decisions.jsonl"), line(q2) + line(live), "utf8");

    const history = await readDecisionHistory();
    assert.deepEqual(
      history.map((d) => d.date),
      ["2026-05-04", "2026-08-03", "2026-09-14"],
    );
  });

  it("ties on a date keep a stated order: archive files in order, then the live file, each in write order", async () => {
    const day = "2026-08-03";
    // The amount tells them apart; the ids are unique from buildDecision.
    const [a1, a2, b1, l1, l2] = [1, 2, 3, 4, 5].map((amount) => ({ ...deposit(day), amount }));
    // File names sort T2 before T3 whatever the order they are written in.
    await writeFile(join(archiveDir, "decisions-2026-T3.jsonl"), line(b1), "utf8");
    await writeFile(join(archiveDir, "decisions-2026-T2.jsonl"), line(a1) + line(a2), "utf8");
    await writeFile(join(vaultDir, "logs", "decisions.jsonl"), line(l1) + line(l2), "utf8");

    const history = await readDecisionHistory();
    assert.deepEqual(
      history.map((d) => d.amount),
      [1, 2, 3, 4, 5],
    );
  });

  it("without archives, it is the live log", async () => {
    await writeFile(
      join(vaultDir, "logs", "decisions.jsonl"),
      line(deposit("2026-08-03")) + line(deposit("2026-09-14")),
      "utf8",
    );
    const history = await readDecisionHistory(join(root, "no-existe"));
    assert.deepEqual(
      history.map((d) => d.date),
      ["2026-08-03", "2026-09-14"],
    );
  });

  describe("a DECISIONS_ARCHIVE_DIR that cannot give the archive is said on stderr, and nothing else changes", () => {
    let resetArchiveDirNotes: () => void;
    let warn: ReturnType<typeof mock.method>;
    const warned = () => warn.mock.calls.map((c) => String(c.arguments[0]));

    before(async () => {
      ({ resetArchiveDirNotes } = await import("../vault-io.js"));
    });
    beforeEach(async () => {
      resetArchiveDirNotes();
      process.env.DECISIONS_ARCHIVE_DIR = archiveDir;
      await rm(join(archiveDir), { recursive: true, force: true });
      await mkdir(archiveDir, { recursive: true });
      await writeFile(join(vaultDir, "logs", "decisions.jsonl"), line(deposit("2026-09-14")), "utf8");
      warn?.mock.restore();
      warn = mock.method(console, "warn", () => {});
    });
    after(() => {
      warn?.mock.restore();
      process.env.DECISIONS_ARCHIVE_DIR = archiveDir;
    });

    it("says nothing for an absolute directory that exists", async () => {
      await readDecisionHistory();
      assert.deepEqual(warned(), []);
    });

    it("notes once per run that the variable is unset, however many times the history is read", async () => {
      delete process.env.DECISIONS_ARCHIVE_DIR;
      const first = await readDecisionHistory();
      await readDecisionHistory();
      process.env.DECISIONS_ARCHIVE_DIR = "";
      await readDecisionHistory();
      assert.equal(warned().length, 1);
      assert.match(warned()[0], /^\[vault-io\] NOTE: DECISIONS_ARCHIVE_DIR is not set/);
      assert.match(warned()[0], /only logs\/decisions\.jsonl is read/);
      assert.match(warned()[0], /docs\/log-retention\.md/);
      assert.equal(first.length, 1, "the live log is still returned");
    });

    it("warns when the directory does not exist, and still returns the live log", async () => {
      const missing = join(root, "missing-archive");
      process.env.DECISIONS_ARCHIVE_DIR = missing;
      const history = await readDecisionHistory();
      assert.equal(warned().length, 1);
      assert.match(warned()[0], /^\[vault-io\] WARNING: DECISIONS_ARCHIVE_DIR /);
      assert.ok(warned()[0].includes(missing));
      assert.match(warned()[0], /does not exist/);
      assert.equal(history.length, 1);
    });

    it("warns when it is a file, not a directory", async () => {
      const file = join(root, "archive-file");
      await writeFile(file, "x", "utf8");
      process.env.DECISIONS_ARCHIVE_DIR = file;
      await readDecisionHistory();
      assert.equal(warned().length, 1);
      assert.match(warned()[0], /is not a directory/);
    });

    it("warns when the path is relative, naming the working directory it would be resolved against", async () => {
      process.env.DECISIONS_ARCHIVE_DIR = "src";
      await readDecisionHistory();
      assert.equal(warned().length, 1);
      assert.match(warned()[0], /is not an absolute path/);
      assert.ok(warned()[0].includes(process.cwd()));
    });

    it("warns for an explicit directory argument too, and writes nothing", async () => {
      const live = join(vaultDir, "logs", "decisions.jsonl");
      const before = await readFile(live, "utf8");
      await readDecisionHistory(join(root, "no-existe"));
      assert.match(warned()[0], /does not exist/);
      assert.equal(await readFile(live, "utf8"), before);
    });
  });
});
