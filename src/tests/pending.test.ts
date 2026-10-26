/**
 * Tests of src/pending.ts: list/show/resolve
 * on a temporary logs/pending/, with no network and no real SMTP. Same pattern
 * as integration.test.ts and handoff-provider.test.ts — VAULT_PROJECT_DIR is
 * set BEFORE the first import of config.js, so the app modules are imported
 * dynamically inside before().
 */
// These tests assert the owner's Spanish output; English is covered in i18n.test.ts.
process.env.OUTPUT_LANGUAGE = "es";
import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { brokenUsdLots, lotsSection } from "./fixtures/lots.js";

const WATCHLIST_MD = `---
schema_version: 1
---

# Watchlist

\`\`\`yaml
watchlist:
  - ticker: XOM
    name: Exxon
    market: NYSE
    currency: USD
    horizon: medium
    thesis: "Tesis de prueba."
\`\`\`
`;

const PORTFOLIO_MD = `---
schema_version: 2
last_manual_sync: "2026-07-10"
---

## USD — Cash

| Item | Value |
|---|---|
| Available cash | $1,000.00 |

## USD — Positions

| Ticker | Volume | Avg price | Current price | P/L | Stop loss |
|---|---|---|---|---|---|
| — | — | — | — | — | — |

${lotsSection("USD")}`;

const STRATEGY_MD = `---
title: Estrategia Base
version: "0.2"
---
`;

const PENDING_FILENAME = "2026-07-15-xom.md";

const PENDING_MD = `---
id: 20260715-xom-pending
title: "Señal pendiente de análisis — XOM — 2026-07-15"
tags: [project-note, log, pending]
status: active
created: 2026-07-15
ticker: XOM
currency: USD
price: 124.5
triggers: [big_move]
use_web_search: true
---

> Resolver con: \`npm run pending:show -- ${PENDING_FILENAME}\`

## System prompt

Instrucciones de razonamiento de prueba.

## User prompt

Activo: XOM (USD)
`;

// Pending file with the technical snapshot the engine needs to compute the ticket
//: ATR 2 → stop at 3 ATR at 118.5; level 140 → R:R 2.58.
// A BUY only comes from a setup (ADR-0013): the pending file carries it, with its target.
const PENDING_BUYABLE_MD = PENDING_MD.replace("triggers: [big_move]", "triggers: [setup]").replace(
  "use_web_search: true",
  "range_position: 0.5\nbias: ALCISTA\natr14: 2.0000\ntarget_levels: [140]\n" +
    "setup_pattern: pullback\nsetup_date: 2026-07-15\nsetup_level: 124.5\nsetup_target: 140\nuse_web_search: true",
);

const validRecommendation = () => ({
  ticker: "XOM",
  action: "BUY",
  ticket: {
    direction: "BUY",
    currency: "USD",
    target: 140,
  },
  thesis_summary: "Tesis de prueba para el test de resolve.",
  triggers: ["big_move"],
  assumptions: ["El Brent se mantiene por encima de 80 $"],
});

describe("pending.ts", () => {
  let vaultDir: string;
  let listPending: () => Promise<void>;
  let showPending: (filename: string) => Promise<void>;
  let resolvePending: (filename: string, recommendationInput: unknown) => Promise<void>;

  before(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "finance-agent-pending-"));
    await mkdir(join(vaultDir, "logs"), { recursive: true });
    await writeFile(join(vaultDir, "watchlist.md"), WATCHLIST_MD, "utf8");
    await writeFile(join(vaultDir, "portfolio.md"), PORTFOLIO_MD, "utf8");
    await mkdir(join(vaultDir, "strategies"), { recursive: true });
    await writeFile(join(vaultDir, "strategies", "base.md"), STRATEGY_MD, "utf8");

    process.env.VAULT_PROJECT_DIR = vaultDir;
    const mod = await import("../pending.js");
    listPending = mod.listPending;
    showPending = mod.showPending;
    resolvePending = mod.resolvePending;
  });

  after(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });

  /** Last line of logs/decisions.jsonl (the log accumulates the whole describe). */
  async function lastDecision(): Promise<Record<string, unknown>> {
    const raw = await readFile(join(vaultDir, "logs", "decisions.jsonl"), "utf8");
    return JSON.parse(raw.trim().split("\n").at(-1)!);
  }

  describe("listPending", () => {
    it('prints "No pending signals." when logs/pending/ does not exist yet', async () => {
      const log = mock.method(console, "log", () => {});
      try {
        await listPending();
        assert.deepEqual(
          log.mock.calls.map((c) => c.arguments[0]),
          ["No pending signals."],
        );
      } finally {
        log.mock.restore();
      }
    });

    it("lists the logs/pending/ files when there are signals", async () => {
      await mkdir(join(vaultDir, "logs", "pending"), { recursive: true });
      await writeFile(join(vaultDir, "logs", "pending", PENDING_FILENAME), PENDING_MD, "utf8");

      const log = mock.method(console, "log", () => {});
      try {
        await listPending();
        assert.deepEqual(
          log.mock.calls.map((c) => c.arguments[0]),
          [PENDING_FILENAME],
        );
      } finally {
        log.mock.restore();
        await rm(join(vaultDir, "logs", "pending"), { recursive: true, force: true });
      }
    });
  });

  describe("showPending / resolvePending", () => {
    beforeEach(async () => {
      await mkdir(join(vaultDir, "logs", "pending"), { recursive: true });
      await writeFile(join(vaultDir, "logs", "pending", PENDING_FILENAME), PENDING_MD, "utf8");
    });

    it("showPending prints the full content (system + user prompt)", async () => {
      const log = mock.method(console, "log", () => {});
      try {
        await showPending(PENDING_FILENAME);
        const printed = log.mock.calls.map((c) => c.arguments[0]).join("\n");
        assert.match(printed, /## System prompt/);
        assert.match(printed, /Instrucciones de razonamiento de prueba\./);
        assert.match(printed, /## User prompt/);
        assert.match(printed, /Activo: XOM \(USD\)/);
      } finally {
        log.mock.restore();
      }
    });

    it("resolvePending with a valid ticket writes the log, sends the alert and deletes the pending file", async () => {
      await writeFile(join(vaultDir, "logs", "pending", PENDING_FILENAME), PENDING_BUYABLE_MD, "utf8");
      const log = mock.method(console, "log", () => {});
      const warn = mock.method(console, "warn", () => {});
      try {
        await resolvePending(PENDING_FILENAME, validRecommendation());
      } finally {
        log.mock.restore();
        warn.mock.restore();
      }

      const today = new Date().toISOString().slice(0, 10);
      const logPath = join(vaultDir, "logs", `${today}-xom.md`);
      const content = await readFile(logPath, "utf8");
      assert.ok(content.includes("XOM"), "ticker in the log");
      assert.ok(content.includes("BUY"), "action in the log");
      assert.ok(!content.includes("blocked: true"), "must not be marked blocked");
      // Engine ticket: stop and size computed, not proposed.
      assert.match(content, /\| Stop-loss \| 118\.5 USD \(3 ATR\) \|/);
      assert.match(content, /\| Objetivo \| 140 USD \|/);
      assert.match(content, /\| Riesgo \| 10\.00 USD de 10\.00/); // 1% of $1,000

      // SMTP not configured in the test environment -> sendAlert dumps to the log
      // instead of throwing; we check it was attempted ("mailer" in the output).
      const warnedNoSmtp = warn.mock.calls.some((c) => String(c.arguments[0]).includes("SMTP_USER/SMTP_PASS"));
      assert.ok(warnedNoSmtp, "sendAlert must be attempted (and dump to the log without SMTP)");

      // The proposal stays in the single decision log with its assumptions.
      const decision = await lastDecision();
      assert.equal(decision.type, "buy_proposal");
      assert.equal(decision.origin, "sistema");
      assert.equal(decision.source, "heartbeat");
      assert.equal(decision.rules_version, "0.2");
      assert.equal(decision.stop_initial, 118.5);
      assert.equal(decision.target, 140);
      assert.ok((decision.amount as number) > 0);
      assert.deepEqual(decision.assumptions, ["El Brent se mantiene por encima de 80 $"]);
      assert.equal(decision.log_link, `logs/${today}-xom.md`);

      // The pending file is deleted whether the ticket is valid or blocked.
      await assert.rejects(() => access(join(vaultDir, "logs", "pending", PENDING_FILENAME)));
    });

    for (const [label, broken] of brokenUsdLots(PORTFOLIO_MD)) {
      it(`resolvePending resolves a signal with ${label}: recorded, alert sent, file deleted`, async () => {
        const portfolioPath = join(vaultDir, "portfolio.md");
        await writeFile(portfolioPath, broken, "utf8");
        await writeFile(join(vaultDir, "logs", "pending", PENDING_FILENAME), PENDING_BUYABLE_MD, "utf8");
        const log = mock.method(console, "log", () => {});
        const warn = mock.method(console, "warn", () => {});
        try {
          await resolvePending(PENDING_FILENAME, validRecommendation());
        } finally {
          log.mock.restore();
          warn.mock.restore();
          await writeFile(portfolioPath, PORTFOLIO_MD, "utf8");
        }

        const decision = await lastDecision();
        assert.equal(decision.type, "buy_proposal");
        const smtpWarned = warn.mock.calls.some((c) => String(c.arguments[0]).includes("SMTP_USER/SMTP_PASS"));
        assert.ok(smtpWarned, "the alert was attempted");
        await assert.rejects(() => access(join(vaultDir, "logs", "pending", PENDING_FILENAME)));
      });
    }

    it("resolvePending with R:R below the minimum records blocked:true and sends no alert", async () => {
      await writeFile(
        join(vaultDir, "logs", "pending", PENDING_FILENAME),
        PENDING_BUYABLE_MD.replace("target_levels: [140]", "target_levels: [130]"),
        "utf8",
      );
      const rec = validRecommendation();
      rec.ticket.target = 130; // (130 − 124,5) / 6 = 0,92 < 2

      const log = mock.method(console, "log", () => {});
      const warn = mock.method(console, "warn", () => {});
      const error = mock.method(console, "error", () => {});
      try {
        await resolvePending(PENDING_FILENAME, rec);
      } finally {
        log.mock.restore();
        warn.mock.restore();
        error.mock.restore();
      }

      const today = new Date().toISOString().slice(0, 10);
      const logPath = join(vaultDir, "logs", `${today}-xom.md`);
      const content = await readFile(logPath, "utf8");
      assert.ok(content.includes("blocked: true"), "must be marked blocked in the frontmatter");
      assert.match(content, /\| Bloqueo \| rr_below_min \|/);

      // Without SMTP configured, sendAlert would have warned with "SMTP_USER/SMTP_PASS" if
      // it had been called; on the blocked path it must not be called at all.
      const smtpWarned = warn.mock.calls.some((c) => String(c.arguments[0]).includes("SMTP_USER/SMTP_PASS"));
      assert.ok(!smtpWarned, "sendAlert must not be called when the ticket is blocked");

      // Not acting is a decision too: it is not hidden.
      const decision = await lastDecision();
      assert.equal(decision.type, "buy_blocked");
      assert.deepEqual(decision.eligibility, { verdict: "blocked", reasons: ["rr_below_min"] });

      await assert.rejects(() => access(join(vaultDir, "logs", "pending", PENDING_FILENAME)));
    });

    // The regime block follows the same path as the rest (log +
    // decision log, no email), and uses the regime of the detection date frozen
    // in the pending file, not today's.
    it("resolvePending with an adverse regime in the pending file records buy_blocked for regime_adverse and sends no alert", async () => {
      await writeFile(
        join(vaultDir, "logs", "pending", PENDING_FILENAME),
        PENDING_BUYABLE_MD.replace(
          "use_web_search: true",
          "benchmark_ticker: VOO\nbenchmark_price: 701.5\nbenchmark_regime: adverso\nuse_web_search: true",
        ),
        "utf8",
      );

      const log = mock.method(console, "log", () => {});
      const warn = mock.method(console, "warn", () => {});
      const error = mock.method(console, "error", () => {});
      try {
        await resolvePending(PENDING_FILENAME, validRecommendation());
      } finally {
        log.mock.restore();
        warn.mock.restore();
        error.mock.restore();
      }

      const today = new Date().toISOString().slice(0, 10);
      const content = await readFile(join(vaultDir, "logs", `${today}-xom.md`), "utf8");
      assert.ok(content.includes("blocked: true"), "must be marked blocked in the frontmatter");
      assert.match(content, /\| Bloqueo \| regime_adverse \|/);

      const smtpWarned = warn.mock.calls.some((c) => String(c.arguments[0]).includes("SMTP_USER/SMTP_PASS"));
      assert.ok(!smtpWarned, "a BUY blocked by regime sends no email");

      const decision = await lastDecision();
      assert.equal(decision.type, "buy_blocked");
      assert.deepEqual(decision.eligibility, { verdict: "blocked", reasons: ["regime_adverse"] });
      assert.equal(decision.regime, "adverso");
    });

    it("resolvePending carries strength, benchmark and its regime from the pending file to the decision log", async () => {
      const withSnapshot = PENDING_MD.replace(
        "use_web_search: true",
        "range_position: 0.742\nbias: ALCISTA\natr14: 4.2500\nbenchmark_ticker: VOO\nbenchmark_price: 701.5\nbenchmark_regime: favorable\nuse_web_search: true",
      );
      await writeFile(join(vaultDir, "logs", "pending", PENDING_FILENAME), withSnapshot, "utf8");

      const log = mock.method(console, "log", () => {});
      const warn = mock.method(console, "warn", () => {});
      try {
        await resolvePending(PENDING_FILENAME, {
          ...validRecommendation(),
          action: "HOLD",
          ticket: { ...validRecommendation().ticket, direction: "HOLD" },
        });
      } finally {
        log.mock.restore();
        warn.mock.restore();
      }

      const decision = await lastDecision();
      assert.equal(decision.type, "hold");
      assert.deepEqual(decision.benchmark, { ticker: "VOO", price: 701.5 });
      assert.equal(decision.regime, "favorable");
      assert.deepEqual(decision.strength, { range_position: 0.742, bias: "ALCISTA" });
      assert.equal(decision.atr14, 4.25);
      assert.equal(decision.price, 124.5);
      // The date is the detection date (the pending file's), not the resolve date.
      assert.equal(decision.date, "2026-07-15");
    });

    it("a setup pending file (ADR-0013) records the setup; a HOLD counts as an eligible buy not made", async () => {
      await writeFile(join(vaultDir, "logs", "pending", PENDING_FILENAME), PENDING_BUYABLE_MD, "utf8");

      const log = mock.method(console, "log", () => {});
      const warn = mock.method(console, "warn", () => {});
      try {
        await resolvePending(PENDING_FILENAME, {
          ...validRecommendation(),
          action: "HOLD",
          triggers: ["setup"],
          ticket: { ...validRecommendation().ticket, direction: "HOLD" },
        });
      } finally {
        log.mock.restore();
        warn.mock.restore();
      }

      const decision = await lastDecision();
      assert.equal(decision.type, "hold");
      assert.deepEqual(decision.setup, { pattern: "pullback", state: "triggered", level: 124.5 });
      assert.deepEqual(decision.eligibility, { verdict: "eligible", reasons: [] });
      const logMd = await readFile(join(vaultDir, "logs", `${new Date().toISOString().slice(0, 10)}-xom.md`), "utf8");
      assert.match(logMd, /\| Setup \| pullback a 124\.5, objetivo 140 \|/);
    });

    it("the decision log conviction is the engine's from the pending file, not the reasoner's", async () => {
      await writeFile(
        join(vaultDir, "logs", "pending", PENDING_FILENAME),
        PENDING_BUYABLE_MD.replace(
          "use_web_search: true",
          "conviction: high\nconviction_points: [top_quintile, regime_favorable, dated_catalyst]\nuse_web_search: true",
        ),
        "utf8",
      );
      const log = mock.method(console, "log", () => {});
      const warn = mock.method(console, "warn", () => {});
      try {
        await resolvePending(PENDING_FILENAME, validRecommendation());
      } finally {
        log.mock.restore();
        warn.mock.restore();
      }
      const decision = await lastDecision();
      assert.equal(decision.conviction, "high");
      assert.deepEqual(decision.conviction_points, ["top_quintile", "regime_favorable", "dated_catalyst"]);
      const logMd = await readFile(join(vaultDir, "logs", `${new Date().toISOString().slice(0, 10)}-xom.md`), "utf8");
      assert.match(logMd, /\| Convicción \| high \(quintil superior, régimen favorable, catalizador fechado\) \|/);
    });

    it("resolvePending rejects a recommendation carrying conviction: the engine computes it", async () => {
      await writeFile(join(vaultDir, "logs", "pending", PENDING_FILENAME), PENDING_BUYABLE_MD, "utf8");
      await assert.rejects(
        () => resolvePending(PENDING_FILENAME, { ...validRecommendation(), conviction: "high" }),
        /conviction .*the engine computes it/,
      );
    });

    it("resolvePending rejects a recommendation for another ticker without writing anything", async () => {
      const decisionsPath = join(vaultDir, "logs", "decisions.jsonl");
      const before = await readFile(decisionsPath, "utf8").catch(() => "");
      await assert.rejects(
        () => resolvePending(PENDING_FILENAME, { ...validRecommendation(), ticker: "CVX" }),
        /recommendation is for CVX \(USD\) and the signal for XOM \(USD\)/,
      );
      assert.equal(await readFile(decisionsPath, "utf8").catch(() => ""), before);
      // The pending file is still there to retry.
      await access(join(vaultDir, "logs", "pending", PENDING_FILENAME));
    });

    it("resolvePending writes nothing if strategies/base.md has no version", async () => {
      await writeFile(join(vaultDir, "strategies", "base.md"), "---\ntitle: sin versión\n---\n", "utf8");
      try {
        await assert.rejects(() => resolvePending(PENDING_FILENAME, validRecommendation()), /version/);
      } finally {
        await writeFile(join(vaultDir, "strategies", "base.md"), STRATEGY_MD, "utf8");
      }
      // The pending file is still there to retry.
      await access(join(vaultDir, "logs", "pending", PENDING_FILENAME));
    });

    // ADR-0006: strength is a snapshot of the DETECTION date, so it has to travel
    // in the pending file's frontmatter — when the Routine resolves, buildSignal
    // rebuilds the rest of the Signal from the current vault and could no longer
    // recompute it for that day.
    it("resolvePending carries range_position/bias from the pending file to the decision log", async () => {
      const filename = "2026-07-15-xom.md";
      const withStrength = PENDING_MD.replace(
        "use_web_search: true",
        "range_position: 0.742\nbias: ALCISTA\nuse_web_search: true",
      );
      await writeFile(join(vaultDir, "logs", "pending", filename), withStrength, "utf8");

      const log = mock.method(console, "log", () => {});
      const warn = mock.method(console, "warn", () => {});
      try {
        await resolvePending(filename, validRecommendation());
      } finally {
        log.mock.restore();
        warn.mock.restore();
      }

      const today = new Date().toISOString().slice(0, 10);
      const content = await readFile(join(vaultDir, "logs", `${today}-xom.md`), "utf8");
      assert.match(content, /\| Posición en rango \| 0\.742 \|/);
      assert.match(content, /\| Sesgo \| ALCISTA \|/);
    });

    // The detection-date ATR travels like the rest of the strength —
    // it is the unit the proposed stop was sized in.
    it("resolvePending carries atr14 from the pending file to the decision log", async () => {
      const filename = "2026-07-15-xom.md";
      const withAtr = PENDING_MD.replace(
        "use_web_search: true",
        "range_position: 0.742\nbias: ALCISTA\natr14: 4.2500\nuse_web_search: true",
      );
      await writeFile(join(vaultDir, "logs", "pending", filename), withAtr, "utf8");

      const log = mock.method(console, "log", () => {});
      const warn = mock.method(console, "warn", () => {});
      try {
        await resolvePending(filename, validRecommendation());
      } finally {
        log.mock.restore();
        warn.mock.restore();
      }

      const today = new Date().toISOString().slice(0, 10);
      const content = await readFile(join(vaultDir, "logs", `${today}-xom.md`), "utf8");
      assert.match(content, /\| ATR14 \| 4\.25 \|/);
    });

    it("a pending file without atr14 keeps the rest of the strength", async () => {
      const filename = "2026-07-15-xom.md";
      const withoutAtr = PENDING_MD.replace(
        "use_web_search: true",
        "range_position: 0.742\nbias: ALCISTA\nuse_web_search: true",
      );
      await writeFile(join(vaultDir, "logs", "pending", filename), withoutAtr, "utf8");

      const log = mock.method(console, "log", () => {});
      const warn = mock.method(console, "warn", () => {});
      try {
        await resolvePending(filename, validRecommendation());
      } finally {
        log.mock.restore();
        warn.mock.restore();
      }

      const today = new Date().toISOString().slice(0, 10);
      const content = await readFile(join(vaultDir, "logs", `${today}-xom.md`), "utf8");
      assert.match(content, /\| Sesgo \| ALCISTA \|/);
      assert.ok(!content.includes("| ATR14 |"), "without atr14 the row must not be written");
    });

    it("resolvePending works with a pending file without strength: it skips the rows, does not fail", async () => {
      const log = mock.method(console, "log", () => {});
      const warn = mock.method(console, "warn", () => {});
      try {
        await resolvePending(PENDING_FILENAME, validRecommendation());
      } finally {
        log.mock.restore();
        warn.mock.restore();
      }

      const today = new Date().toISOString().slice(0, 10);
      const content = await readFile(join(vaultDir, "logs", `${today}-xom.md`), "utf8");
      assert.ok(!content.includes("Posición en rango"), "without strength the row must not be written");
      assert.ok(!content.includes("| Sesgo |"), "without strength the row must not be written");
    });

    it("resolvePending ignores corrupt strength in the pending file instead of breaking", async () => {
      const filename = "2026-07-15-xom.md";
      const corrupt = PENDING_MD.replace(
        "use_web_search: true",
        "range_position: no-es-un-numero\nbias: LATERAL\nuse_web_search: true",
      );
      await writeFile(join(vaultDir, "logs", "pending", filename), corrupt, "utf8");

      const log = mock.method(console, "log", () => {});
      const warn = mock.method(console, "warn", () => {});
      try {
        await resolvePending(filename, validRecommendation());
      } finally {
        log.mock.restore();
        warn.mock.restore();
      }

      const today = new Date().toISOString().slice(0, 10);
      const content = await readFile(join(vaultDir, "logs", `${today}-xom.md`), "utf8");
      assert.ok(!content.includes("Posición en rango"), "invalid strength is discarded");
    });

    it("resolvePending throws if the pending file ticker is in neither watchlist.md nor portfolio.md", async () => {
      const filename = "2026-07-15-unknown.md";
      const content = PENDING_MD.replace(/ticker: XOM/, "ticker: UNKNOWN").replace(/XOM/g, "UNKNOWN");
      await writeFile(join(vaultDir, "logs", "pending", filename), content, "utf8");

      const rec = validRecommendation();
      rec.ticker = "UNKNOWN";

      await assert.rejects(
        () => resolvePending(filename, rec),
        /UNKNOWN is in neither watchlist\.md nor portfolio\.md/,
      );
    });

    // ADR-0007: A position without a watchlist.md entry can be resolved
    // too — buildSignal no longer requires finding the ticker in the watchlist if
    // it has a real position in portfolio.md.
    it("resolvePending resolves a signal for a ticker without a watchlist entry but with a position in portfolio.md", async () => {
      const filename = "2026-07-15-orphan.md";
      const content = PENDING_MD.replace(/ticker: XOM/, "ticker: ORPHAN").replace(/XOM/g, "ORPHAN");
      await writeFile(join(vaultDir, "logs", "pending", filename), content, "utf8");

      const orphanPortfolio = PORTFOLIO_MD.replace(
        "| — | — | — | — | — | — |",
        "| ORPHAN | 4 | 100.00 | 105.00 | 20.00 | 95.00 |",
      );
      await writeFile(
        join(vaultDir, "portfolio.md"),
        orphanPortfolio.replace(
          lotsSection("USD"),
          lotsSection("USD", [{ ticker: "ORPHAN", units: 4, price: 100, stop: 95 }]),
        ),
        "utf8",
      );

      const rec = { ...validRecommendation(), ticker: "ORPHAN", action: "HOLD" };

      const log = mock.method(console, "log", () => {});
      const warn = mock.method(console, "warn", () => {});
      try {
        await resolvePending(filename, rec);
      } finally {
        log.mock.restore();
        warn.mock.restore();
        // Leave portfolio.md as it was for the rest of the describe's tests.
        await writeFile(join(vaultDir, "portfolio.md"), PORTFOLIO_MD, "utf8");
      }

      const today = new Date().toISOString().slice(0, 10);
      const content2 = await readFile(join(vaultDir, "logs", `${today}-orphan.md`), "utf8");
      assert.ok(content2.includes("ORPHAN"), "ticker in the log");
      assert.ok(!content2.includes("blocked: true"), "must not be marked blocked");
    });
  });
});
