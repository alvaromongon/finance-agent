/**
 * Test of HandoffAnalystProvider.escalate(): writes the file in logs/pending/
 * without calling the network. Same pattern as integration.test.ts
 * — VAULT_PROJECT_DIR is set BEFORE the first import of config.js, so the
 * app modules are imported dynamically inside before().
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { Signal, WatchlistEntry } from "../types.js";
import type { HandoffAnalystProvider as HandoffAnalystProviderType } from "../analyst/handoff-provider.js";
import { parseTicker as tk } from "../ticker.js";

const baseEntry = (): WatchlistEntry => ({
  ticker: tk("XOM"),
  name: "Exxon",
  market: "NYSE",
  currency: "USD",
  horizon: "medium",
  thesis: "Tesis de prueba.",
});

const baseSignal = (overrides: Partial<Signal> = {}): Signal => ({
  ticker: tk("XOM"),
  currency: "USD",
  triggers: ["big_move"],
  price: 124.5,
  entry: baseEntry(),
  position: undefined,
  cash: 1000,
  siloValue: 1000,
  ...overrides,
});

describe("HandoffAnalystProvider.escalate", () => {
  let vaultDir: string;
  let HandoffAnalystProvider: typeof HandoffAnalystProviderType;

  before(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "finance-agent-handoff-"));
    await mkdir(join(vaultDir, "routines"), { recursive: true });
    await mkdir(join(vaultDir, "strategies"), { recursive: true });
    await writeFile(
      join(vaultDir, "routines", "execution-analysis.md"),
      "Instrucciones de razonamiento de prueba.",
      "utf8",
    );
    await writeFile(join(vaultDir, "strategies", "base.md"), "Definición de estrategia base de prueba.", "utf8");

    process.env.VAULT_PROJECT_DIR = vaultDir;
    const mod = await import("../analyst/handoff-provider.js");
    HandoffAnalystProvider = mod.HandoffAnalystProvider;
  });

  after(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });

  it("writes a file in logs/pending/ with ticker, triggers and both prompts, without network", async () => {
    const provider = new HandoffAnalystProvider();
    const result = await provider.escalate(baseSignal(), ["XOM anuncia resultados"]);

    assert.equal(result.status, "deferred");
    const today = new Date().toISOString().slice(0, 10);
    assert.ok(result.status === "deferred" && result.pendingPath === join("logs", "pending", `${today}-xom.md`));

    const pendingPath = result.status === "deferred" ? result.pendingPath : "";
    const content = await readFile(join(vaultDir, pendingPath), "utf8");

    assert.match(content, /ticker: XOM/);
    assert.match(content, /triggers: \[big_move\]/);
    assert.match(content, /Instrucciones de razonamiento de prueba\./); // system prompt
    assert.match(content, /Definición de estrategia base de prueba\./); // system prompt (strategy)
    assert.match(content, /Asset: XOM \(USD\)/); // user prompt
    assert.match(content, /```\nXOM anuncia resultados\n```/); // user prompt (delimited headlines)
  });

  it("a setup signal (ADR-0013) carries the setup into the pending file's frontmatter", async () => {
    const provider = new HandoffAnalystProvider();
    const result = await provider.escalate(
      baseSignal({
        triggers: ["setup"],
        setup: { pattern: "breakout", state: "triggered", date: "2026-09-24", level: 137.2, target: 151.4 },
      }),
      [],
    );
    const content = await readFile(join(vaultDir, result.status === "deferred" ? result.pendingPath : ""), "utf8");
    assert.match(content, /setup_pattern: breakout\nsetup_date: 2026-09-24\nsetup_level: 137.2\nsetup_target: 151.4/);
    assert.match(content, /Pattern target: 151\.4/);
  });

  it("the engine conviction travels in the pending file's frontmatter", async () => {
    const provider = new HandoffAnalystProvider();
    const result = await provider.escalate(
      baseSignal({
        triggers: ["setup"],
        setup: { pattern: "pullback", state: "triggered", date: "2026-09-24", level: 137.2, target: 151.4 },
        conviction: { conviction: "medium", points: ["regime_favorable", "reward_risk"] },
      }),
      [],
    );
    const content = await readFile(join(vaultDir, result.status === "deferred" ? result.pendingPath : ""), "utf8");
    assert.match(content, /conviction: medium\nconviction_points: \[regime_favorable, reward_risk\]/);
  });

  // ADR-0006: without serializing the strength in the pending file, the handoff
  // path (the one running in production) would lose the data the decision log keeps.
  it("serializes the signal strength into the pending file's frontmatter", async () => {
    const provider = new HandoffAnalystProvider();
    const result = await provider.escalate(baseSignal({ strength: { rangePosition: 0.4212, bias: "MIXTO" } }), []);

    const pendingPath = result.status === "deferred" ? result.pendingPath : "";
    const content = await readFile(join(vaultDir, pendingPath), "utf8");

    assert.match(content, /range_position: 0\.421/);
    assert.match(content, /bias: MIXTO/);
  });

  it("a signal without strength does not write range_position/bias in the pending file", async () => {
    const provider = new HandoffAnalystProvider();
    const result = await provider.escalate(baseSignal(), []);

    const pendingPath = result.status === "deferred" ? result.pendingPath : "";
    const content = await readFile(join(vaultDir, pendingPath), "utf8");

    assert.ok(!content.includes("range_position:"));
    assert.ok(!content.includes("bias:"));
  });

  // ADR-0007: A position without a watchlist entry arrives with
  // signal.entry undefined and must escalate anyway.
  it("with signal.entry undefined (position without a watchlist entry) does not throw", async () => {
    const provider = new HandoffAnalystProvider();
    const result = await provider.escalate(
      baseSignal({
        entry: undefined,
        triggers: ["approaching_stop"],
        position: {
          ticker: tk("XOM"),
          currency: "USD",
          volume: 5,
          avgPrice: 130,
          currentPrice: 138,
          pl: 40,
          stopLoss: 120,
        },
      }),
      [],
    );

    assert.equal(result.status, "deferred");
    const pendingPath = result.status === "deferred" ? result.pendingPath : "";
    const content = await readFile(join(vaultDir, pendingPath), "utf8");

    assert.match(content, /ticker: XOM/);
    assert.match(content, /Definición de estrategia base de prueba\./); // strategies/base.md
  });
});
