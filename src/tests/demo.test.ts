/**
 * The demo: a heartbeat per silo against examples/brain with the
 * fixtures provider, without Claude, SMTP or network, in a temporary copy so
 * the example stays clean. It also checks that every example file parses with
 * the input format (portfolio.md v2, every other file v1).
 */
import { describe, it, after, mock } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

describe("demo against examples/brain", () => {
  const dirs: string[] = [];

  after(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  const demo = async (currency: "EUR" | "USD") => {
    mock.method(console, "log", () => {});
    mock.method(console, "warn", () => {});
    const { runDemo } = await import("../demo.js");
    const result = await runDemo(currency);
    mock.restoreAll();
    dirs.push(result.dir);
    return result;
  };

  it("EUR: escalates the position near its stop and reports the armed breakout in one email", async () => {
    const { dir, emails, pending } = await demo("EUR");
    assert.deepEqual(
      pending.map((f) => f.replace(/^\d{4}-\d{2}-\d{2}-/, "")),
      ["sap.de.md"],
    );
    assert.equal(emails.length, 1);
    assert.match(emails[0], /AIR\.PA/);
    assert.match(await readFile(join(dir, "portfolio.md"), "utf8"), /\| SAP\.DE \| 2 \| 180,00 \| 171,2/);
  });

  it("USD: the armed breakout goes out and nothing is escalated", async () => {
    const { emails, pending } = await demo("USD");
    assert.deepEqual(pending, []);
    assert.equal(emails.length, 1);
    assert.match(emails[0], /JNJ/);
  });

  it("leaves examples/brain untouched", async () => {
    const brain = join(import.meta.dirname, "..", "..", "examples", "brain");
    // The example ships the decision log its lots refer to; a demo run must leave nothing next to it
    // (no outbox, no pending files, no decision logs).
    assert.deepEqual(await readdir(join(brain, "logs")), ["decisions.jsonl"]);
  });

  it("every example file parses with the input format, and its lots match the decision log", async () => {
    // Read the example itself, not a copy a demo run already changed.
    process.env.VAULT_PROJECT_DIR = join(import.meta.dirname, "..", "..", "examples", "brain");
    const io = await import("../vault-io.js");
    for (const currency of ["EUR", "USD"] as const) {
      const portfolio = await io.readPortfolio(currency);
      assert.equal(portfolio.positions.length, 1);
      assert.equal(portfolio.lots.length, 1);
      assert.equal((await io.readWatchlist(currency)).length, 1);
    }
    const { assertLotsMatch } = await import("../utils/lots-check.js");
    const decisions = await io.readDecisionHistory();
    for (const currency of ["EUR", "USD"] as const) {
      assertLotsMatch(await io.readPortfolio(currency), decisions);
    }
    assert.equal((await io.readScreeningLog()).length, 2);
    const { readUniverse } = await import("../weekly-screening.js");
    const universe = await readUniverse();
    assert.deepEqual([universe.eur.length, universe.usd.length], [2, 2]);
    assert.equal(await io.readRulesVersion(), "1.0");
    const added = await io.readWatchlistAddedOn(await io.readWatchlist("USD"));
    assert.equal(added.get("JNJ"), "2026-09-01");
    const { assertSchemaVersion } = await import("../utils/vault-parser.js");
    for (const slug of ["airpa", "jnj"]) {
      const file = `tesis/tesis-${slug}.md`;
      const raw = await readFile(join(process.env.VAULT_PROJECT_DIR, file), "utf8");
      assertSchemaVersion(raw, file);
      assert.match(raw, /^status: active$/m);
    }
  });
});
