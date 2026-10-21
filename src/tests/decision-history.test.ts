/**
 * Tests of readDecisionHistory: the full log joins the archived
 * quarters with the live file, in chronological order (ADR-0006, "Retention").
 * Temporary vault with the same structure as the repo, no network. VAULT_PROJECT_DIR
 * is set before the first import of config.js.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
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
});
