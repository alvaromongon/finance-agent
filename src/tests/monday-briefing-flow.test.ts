/**
 * Tests of the monday-briefing.ts prepare/finalize flow on a
 * temporary vault, with no network, no API and no real SMTP. Same pattern as
 * pending.test.ts: VAULT_PROJECT_DIR is set BEFORE the first import of
 * config.js, so the app modules are imported dynamically in
 * before().
 */
// These tests assert the owner's Spanish output; English is covered in i18n.test.ts.
process.env.OUTPUT_LANGUAGE = "es";
import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TechnicalsProvider } from "../utils/monday-briefing-helpers.js";
import type { HistoricalBar } from "../providers/types.js";

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
    thesis: "Tesis de prueba sin posición."
  - ticker: MSFT
    name: Microsoft
    market: NASDAQ
    currency: USD
    horizon: long
    thesis: "Tesis de prueba con posición abierta."
\`\`\`
`;

const PORTFOLIO_MD = `---
schema_version: 1
last_manual_sync: "2026-07-10"
---

## EUR — Cash

| Item | Value |
|---|---|
| Available cash | 150,00 € |

## EUR — Positions

| Ticker | Volume | Avg price | Current price | P/L | Stop loss |
|---|---|---|---|---|---|
| — | — | — | — | — | — |

## USD — Cash

| Item | Value |
|---|---|
| Available cash | $32.50 |

## USD — Positions

| Ticker | Volume | Avg price | Current price | P/L | Stop loss |
|---|---|---|---|---|---|
| MSFT | 0.5 | 420.00 | 440.00 | +10.00 | 400.00 |
`;

const SYSTEM_PROMPT_MD = `# Rutina — Monday Briefing (stub de test)

Instrucciones de razonamiento de prueba.
`;

// Report with every section validateBriefingReport requires. It proposes
// removing XOM (no position → must be removed) and MSFT (open position → the
// guardrail must block it).
const VALID_REPORT = `## 0. Resumen ejecutivo

- Acumular cash; retirar XOM de watchlist.

## 1. Plan de la semana

Acumular cash. Para el cash en EUR: acumular en EUR.

## 2. Salud de posiciones

| Ticker | P/L actual | Stop actual | Veredicto | Notas |
|---|---|---|---|---|
| MSFT | +10.00 | 400.00 | MANTENER | — |

## 3. Watchlist — Revisión

| Ticker | Precio ref. | Setup vigente | Veredicto | Nota |
|---|---|---|---|---|
| XOM | 100 | ninguno | RETIRE | tesis inválida |

## 4. Contexto macro y sectorial

- Sin novedades relevantes (conocimiento entrenado, la búsqueda no aportó nada nuevo).

## 5. Próximos eventos a vigilar

| Fecha | Activo | Evento | Impacto esperado |
|---|---|---|---|
| 2026-08-01 | MSFT | Earnings | Alto |

## AUTOMATED_ACTIONS
RETIRE: XOM,MSFT
PLAN_SUMMARY: Acumular cash esta semana
PROPOSALS: []
`;

function bars(closes: number[]): HistoricalBar[] {
  return closes.map((close, i) => ({
    date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
    close,
    high: close * 1.01,
    low: close * 0.99,
  }));
}

const fakeProvider: TechnicalsProvider = {
  getHistorical: async () => bars(Array.from({ length: 60 }, (_, i) => 100 + i)),
  getPrices: async (tickers) => new Map(tickers.map((t) => [t, t === "EURUSD=X" ? 1.1 : 159])),
};

// Benchmarks with a flat year at 200 and trading at 159: below their SMA200.
const adverseProvider: TechnicalsProvider = {
  ...fakeProvider,
  getHistorical: async (ticker) =>
    ["VOO", "EXSA.DE"].includes(ticker) ? bars(Array(250).fill(200)) : fakeProvider.getHistorical(ticker),
};

// XOM rises from 100 to 150 and consolidates 20 sessions right at the high: an
// armed breakout (ADR-0013) with the Buy Stop at the top of the base.
const armedBars = bars([
  ...Array.from({ length: 100 }, (_, i) => 100 + i * 0.5),
  ...Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 149.5 : 150)),
]);
const armedProvider = (base: TechnicalsProvider): TechnicalsProvider => ({
  ...base,
  getHistorical: async (ticker) => (ticker === "XOM" ? armedBars : base.getHistorical(ticker)),
});

describe("monday-briefing prepare/finalize", () => {
  let vaultDir: string;
  let prepareBriefing: (
    provider?: TechnicalsProvider,
  ) => Promise<{ today: string; systemPrompt: string; userPrompt: string }>;
  let finalizeBriefing: (fullText: string, provider?: TechnicalsProvider) => Promise<void>;

  before(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "finance-agent-briefing-"));
    process.env.VAULT_PROJECT_DIR = vaultDir;
    // Makes sendSummaryEmail dump to the log instead of really sending,
    // even if the local development .env has SMTP credentials.
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;

    const mod = await import("../monday-briefing.js");
    prepareBriefing = mod.prepareBriefing;
    finalizeBriefing = mod.finalizeBriefing;
  });

  after(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // logs/ is recreated from scratch: the briefing log carries today's date and
    // would pollute the next test if it survived between cases.
    await rm(join(vaultDir, "logs"), { recursive: true, force: true });
    await mkdir(join(vaultDir, "logs"), { recursive: true });
    await mkdir(join(vaultDir, "routines"), { recursive: true });
    await writeFile(join(vaultDir, "portfolio.md"), PORTFOLIO_MD, "utf8");
    await writeFile(join(vaultDir, "watchlist.md"), WATCHLIST_MD, "utf8");
    await writeFile(join(vaultDir, "routines", "monday-briefing.md"), SYSTEM_PROMPT_MD, "utf8");
    await mkdir(join(vaultDir, "strategies"), { recursive: true });
    await writeFile(join(vaultDir, "strategies", "base.md"), `---\nversion: "0.2"\n---\n`, "utf8");
  });

  async function readDecisionLines(): Promise<Record<string, unknown>[]> {
    const raw = await readFile(join(vaultDir, "logs", "decisions.jsonl"), "utf8");
    return raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  }

  async function quietly(fn: () => Promise<void>): Promise<void> {
    const log = mock.method(console, "log", () => {});
    const warn = mock.method(console, "warn", () => {});
    try {
      await fn();
    } finally {
      log.mock.restore();
      warn.mock.restore();
    }
  }

  describe("prepareBriefing", () => {
    it("refreshes Current price and P/L in portfolio.md before building the prompt", async () => {
      const error = mock.method(console, "error", () => {});
      try {
        const { userPrompt } = await prepareBriefing(fakeProvider);

        // The fake returns 159 for MSFT; the table came from an earlier sync
        // with 440,00 and P/L +10,00 on 0.5 shares at an average of 420,00.
        const portfolioMd = await readFile(join(vaultDir, "portfolio.md"), "utf8");
        assert.match(portfolioMd, /\| MSFT \| 0.5 \| 420.00 \| 159,00 \| -130,50 \|/);
        assert.doesNotMatch(portfolioMd, /440\.00/, "the old price must not survive");

        // And the prompt must already carry the refreshed table, not the previous one:
        // that is what keeps the report from contradicting its own technicals.
        assert.match(userPrompt, /159,00/);
        assert.doesNotMatch(userPrompt.split("## watchlist.md")[0], /440\.00/);
      } finally {
        error.mock.restore();
      }
    });

    it("builds the user prompt with context from both silos, technicals and FX", async () => {
      const error = mock.method(console, "error", () => {});
      try {
        const { systemPrompt, userPrompt } = await prepareBriefing(fakeProvider);

        assert.equal(systemPrompt, SYSTEM_PROMPT_MD);
        assert.match(userPrompt, /## Available funds/);
        // The context is in English and asks for the report in the output language.
        assert.match(userPrompt, /\nWrite every free-text field of your answer in Spanish\. /);
        assert.match(userPrompt, /EUR: 150\.00 €/);
        assert.match(userPrompt, /USD: 32\.50 \$/);
        assert.match(userPrompt, /Current EUR\/USD rate: 1\.1000/);
        // USD buffer (ADR-0009 §6): $32.50 cash + 0.5 MSFT at 159 → silo $112, cap $28.
        assert.match(userPrompt, /USD cushion: covered/);
        assert.doesNotMatch(userPrompt, /## Current EUR\/USD rate/, "without the technical FX section");
        assert.match(userPrompt, /## Current technicals/);
        assert.match(userPrompt, /### XOM/);
        assert.match(userPrompt, /### MSFT/);
        assert.match(userPrompt, /## watchlist\.md/);
        assert.match(userPrompt, /## Weights by asset class/);
      } finally {
        error.mock.restore();
      }
    });

    it("gives each candidate's current setups with their ticket, and the engine stop of each position (ADR-0013)", async () => {
      const error = mock.method(console, "error", () => {});
      try {
        const { userPrompt: none } = await prepareBriefing(fakeProvider);
        assert.match(none, /### XOM[\s\S]*Setups: none in force\./);

        const { userPrompt } = await prepareBriefing(armedProvider(fakeProvider));
        assert.match(
          userPrompt,
          /Setup: XOM: breakout ARMED — Buy Stop at 151\.5 USD, target \d+.*stop .*net R:R .* — ELIGIBLE/,
        );
        assert.match(userPrompt, /### MSFT[\s\S]*Engine stop/);
        assert.doesNotMatch(userPrompt, /Entrada: /, "no zone verdict");
      } finally {
        error.mock.restore();
      }
    });

    it("shows each silo's regime and blocks the setups in adverso", async () => {
      const error = mock.method(console, "error", () => {});
      try {
        const { userPrompt } = await prepareBriefing(armedProvider(adverseProvider));
        assert.match(userPrompt, /## Market regime/);
        assert.match(userPrompt, /Regime USD \(VOO\): ADVERSE/);
        assert.match(userPrompt, /Setup: XOM: breakout ARMED.* — BLOCKED \(regime_adverse\)/);
      } finally {
        error.mock.restore();
      }
    });

    it("includes only the cutoff table of decisions-evaluation.md, or warns if missing", async () => {
      const error = mock.method(console, "error", () => {});
      try {
        const { userPrompt: withoutReport } = await prepareBriefing(fakeProvider);
        assert.match(withoutReport, /## Cut criterion board\n\(not available/);

        await writeFile(
          join(vaultDir, "logs", "decisions-evaluation.md"),
          "---\nid: decisions-evaluation\n---\n\n## Cut criterion board\n\n| Esperanza, R neta | +0.40R en 12 |\n\n## Detalle por decisión\n\n| AAA | fila |\n",
          "utf8",
        );
        const { userPrompt } = await prepareBriefing(fakeProvider);
        assert.match(userPrompt, /## Cut criterion board\n\| Esperanza, R neta \| \+0\.40R en 12 \|/);
        assert.doesNotMatch(userPrompt, /Detalle por decisión/);
      } finally {
        error.mock.restore();
      }
    });

    it("throws if routines/monday-briefing.md is missing (system prompt required)", async () => {
      await rm(join(vaultDir, "routines", "monday-briefing.md"));
      const error = mock.method(console, "error", () => {});
      try {
        await assert.rejects(() => prepareBriefing(fakeProvider), /system prompt required/);
      } finally {
        error.mock.restore();
      }
    });
  });

  describe("finalizeBriefing", () => {
    const today = new Date().toISOString().slice(0, 10);

    it("saves the log with cash in the frontmatter, removes only tickers without a position and sends the email", async () => {
      const log = mock.method(console, "log", () => {});
      const warn = mock.method(console, "warn", () => {});
      try {
        await finalizeBriefing(VALID_REPORT, fakeProvider);

        const logContent = await readFile(join(vaultDir, "logs", `${today}-monday-briefing.md`), "utf8");
        assert.match(logContent, /id: \d+-monday-briefing/);
        assert.match(logContent, /## AUTOMATED_ACTIONS/);

        // XOM removed; MSFT blocked by the guardrail (open position).
        const watchlist = await readFile(join(vaultDir, "watchlist.md"), "utf8");
        assert.ok(!watchlist.includes("XOM"), "XOM must leave watchlist.md");
        assert.ok(watchlist.includes("MSFT"), "MSFT must stay in watchlist.md");
        const blockedWarned = warn.mock.calls.some((c) => String(c.arguments[0]).includes("MSFT"));
        assert.ok(blockedWarned, "the blocked MSFT removal must be warned about");

        // Without SMTP configured, sendSummaryEmail dumps the email to the log with
        // the subject (which includes PLAN_SUMMARY) — we check it was attempted.
        const emailDumped = log.mock.calls.some((c) => String(c.arguments[0]).includes("Acumular cash esta semana"));
        assert.ok(emailDumped, "the summary email must be attempted (dumped to the log without SMTP)");
      } finally {
        log.mock.restore();
        warn.mock.restore();
      }
    });

    // What is not proposed is recorded too. Only
    // positions: buys come from the heartbeat setups.
    it("without proposals records a hold for each position and nothing for the candidates", async () => {
      await quietly(() => finalizeBriefing(VALID_REPORT, armedProvider(fakeProvider)));

      const decisions = await readDecisionLines();
      const byTicker = new Map(decisions.map((d) => [d.ticker, d]));
      assert.equal(decisions.length, 1);

      const msft = byTicker.get("MSFT")!;
      assert.equal(msft.type, "hold");
      assert.equal(msft.source, "monday-briefing");
      assert.equal(msft.price, 159);
      assert.deepEqual(msft.benchmark, { ticker: "VOO", price: 159 });
      assert.equal(msft.log_link, `logs/${today}-monday-briefing.md`);
    });

    it("each decision carries its silo's regime", async () => {
      await quietly(() => finalizeBriefing(VALID_REPORT, adverseProvider));

      const msft = (await readDecisionLines()).find((d) => d.ticker === "MSFT")!;
      assert.equal(msft.regime, "adverso");
      assert.deepEqual(msft.benchmark, { ticker: "VOO", price: 159 });
    });

    it("rerunning finalize the same day does not duplicate the decisions", async () => {
      const report = VALID_REPORT.replace("RETIRE: XOM,MSFT", "RETIRE:");
      await quietly(() => finalizeBriefing(report, fakeProvider));
      await quietly(() => finalizeBriefing(report, fakeProvider));

      assert.equal((await readDecisionLines()).length, 1);
    });

    it("records a SELL with the engine ticket and the position value", async () => {
      const report = VALID_REPORT.replace(
        "PROPOSALS: []",
        'PROPOSALS: [{"ticker":"MSFT","action":"SELL","conviction":"high"}]',
      ).replace("RETIRE: XOM,MSFT", "RETIRE:");
      await quietly(() => finalizeBriefing(report, fakeProvider));

      const msft = (await readDecisionLines()).find((d) => d.ticker === "MSFT")!;
      assert.equal(msft.type, "sell");
      assert.equal(msft.amount, 79.5); // 0.5 shares × 159

      // The tickets section goes to the log (and the email) with the report.
      const logContent = await readFile(join(vaultDir, "logs", `${today}-monday-briefing.md`), "utf8");
      assert.match(logContent, /## Tickets del motor/);
      assert.match(logContent, /### SELL MSFT — PROPUESTA/);
    });

    it("rejects a BUY: the only way in is the heartbeat setups", async () => {
      const report = VALID_REPORT.replace(
        "PROPOSALS: []",
        'PROPOSALS: [{"ticker":"XOM","action":"BUY","conviction":"medium","target":170,"assumptions":["x"]}]',
      );
      await assert.rejects(() => finalizeBriefing(report, fakeProvider), /heartbeat setups/);
      await assert.rejects(() => access(join(vaultDir, "logs", `${today}-monday-briefing.md`)));
    });

    it("rejects a report with a missing or invalid PROPOSALS without writing anything", async () => {
      await assert.rejects(
        () => finalizeBriefing(VALID_REPORT.replace("PROPOSALS: []\n", ""), fakeProvider),
        /missing PROPOSALS: line/,
      );
      await assert.rejects(
        () =>
          finalizeBriefing(
            VALID_REPORT.replace("PROPOSALS: []", 'PROPOSALS: [{"ticker":"MSFT","action":"SELL","conviction":"alta"}]'),
            fakeProvider,
          ),
        /conviction/,
      );
      await assert.rejects(() => access(join(vaultDir, "logs", `${today}-monday-briefing.md`)));
      await assert.rejects(() => access(join(vaultDir, "logs", "decisions.jsonl")));
    });

    it("rejects a truncated report without writing the log or touching the watchlist", async () => {
      const truncated = VALID_REPORT.slice(0, VALID_REPORT.indexOf("## AUTOMATED_ACTIONS"));

      await assert.rejects(() => finalizeBriefing(truncated, fakeProvider), /Incomplete report/);

      await assert.rejects(() => access(join(vaultDir, "logs", `${today}-monday-briefing.md`)));
      const watchlist = await readFile(join(vaultDir, "watchlist.md"), "utf8");
      assert.ok(watchlist.includes("XOM"), "the watchlist must not change with an invalid report");
    });

    it("rejects an empty report", async () => {
      await assert.rejects(() => finalizeBriefing("\n"), /empty/);
    });
  });
});
