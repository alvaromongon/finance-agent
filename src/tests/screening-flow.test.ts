/**
 * Tests of the weekly-screening.ts prepare/resolve/summarize flow
 * on a temporary vault, with no network, no API and no real SMTP. Same pattern
 * as monday-briefing-flow.test.ts: VAULT_PROJECT_DIR is set BEFORE the first
 * import of config.js, so the app modules are imported dynamically in before().
 */
// These tests assert the owner's Spanish output; English is covered in i18n.test.ts.
process.env.OUTPUT_LANGUAGE = "es";
import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { HistoricalBar } from "../providers/types.js";
import { extend, uptrend } from "./fixtures/setup-bars.js";
import { brokenUsdLots, lotsSection } from "./fixtures/lots.js";
import { parseTicker as tk } from "../ticker.js";

const UNIVERSE_MD = `---
schema_version: 1
title: Universo de screening
next_review: 2099-01-01
---

\`\`\`yaml
universe:
  eur:
    - ticker: ASML.AS
      name: ASML Holding
      market: Euronext Amsterdam
      currency: EUR
    - ticker: SAP.DE
      name: SAP
      market: XETRA
      currency: EUR
  usd:
    - ticker: NVDA
      name: NVIDIA
      market: NASDAQ
      currency: USD
    - ticker: AAPL
      name: Apple
      market: NASDAQ
      currency: USD
    - ticker: MSFT
      name: Microsoft
      market: NASDAQ
      currency: USD
  commodities: []
\`\`\`
`;

const WATCHLIST_MD = `---
schema_version: 1
---

# Watchlist

\`\`\`yaml
watchlist:
  - ticker: MSFT
    name: Microsoft
    market: NASDAQ
    currency: USD
    horizon: long
    thesis: "Ya en watchlist — el screening debe excluirlo."
\`\`\`
`;

const PORTFOLIO_MD = `---
schema_version: 2
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

${lotsSection("EUR")}
## USD — Cash

| Item | Value |
|---|---|
| Available cash | $32.50 |

## USD — Positions

| Ticker | Volume | Avg price | Current price | P/L | Stop loss |
|---|---|---|---|---|---|
| — | — | — | — | — | — |

${lotsSection("USD")}`;

// AAPL recently analyzed as `not_interesting` with a future nextReview → excluded.
const SCREENING_LOG_MD = `---
schema_version: 1
title: Screening Log
---

## Historial

| Ticker | Name | Index | Date | Result | Summary | Next review |
|---|---|---|---|---|---|---|
| AAPL | Apple | S&P 500 | 2026-06-28 | not_interesting | High P/E | 2099-01-01 |
`;

const SYSTEM_PROMPT_MD = `# Rutina — Weekly Screening (stub de test)

Instrucciones de evaluación de prueba.
`;

const VALID_INTERESTING = {
  interesting: true,
  reason: "Zona técnica atractiva con driver de IA identificable.",
  thesis: "Demanda de aceleradores IA sostiene el crecimiento.",
  horizon: "medium",
  next_catalyst: "Earnings Q2 ~agosto 2026",
  invalidation: ["Los ingresos de centro de datos dejan de crecer", "Recorte del capex de IA de los hiperescalares"],
};

const VALID_NOT_INTERESTING = {
  interesting: false,
  reason: "En máximos de 52 semanas sin catalizador claro.",
};

/** A year of weekday sessions ending today, with plenty of volume for the liquidity filter. */
function yearOfBars(closeAt: (i: number) => number): HistoricalBar[] {
  const d = new Date();
  const out: HistoricalBar[] = [];
  while (out.length < 252) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) {
      const close = closeAt(251 - out.length);
      out.unshift({
        date: d.toISOString().slice(0, 10),
        close,
        high: close * 1.01,
        low: close * 0.99,
        volume: 1_000_000,
      });
    }
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}

const rising = yearOfBars((i) => 100 + i * 0.25);
// SAP.DE falls all year: price below the SMA200, it does not pass filter 0 (ADR-0012).
const falling = yearOfBars((i) => 200 - i * 0.25);

const fakeProvider = {
  getHistorical: async (ticker: string) => (ticker === "SAP.DE" ? falling : rising),
  getPrices: async (tickers: string[]) => new Map(tickers.map((t) => [t, 159])),
};

/** Without the USD benchmark there is no relative strength: the ranking is not reliable and a draw is made. */
const providerWithoutReference = {
  ...fakeProvider,
  getHistorical: async (ticker: string) => (ticker === "VOO" ? [] : fakeProvider.getHistorical(ticker)),
};
/** Sets weekday session dates ending today and plenty of volume: it passes filter 0. */
function endingToday(bars: HistoricalBar[]): HistoricalBar[] {
  const d = new Date();
  const out: HistoricalBar[] = [];
  for (let i = bars.length - 1; i >= 0;) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) {
      out.unshift({ ...bars[i], date: d.toISOString().slice(0, 10), volume: 1_000_000 });
      i--;
    }
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}

// A year-long rise, a pullback touching the SMA20 and a bounce: pullback confirmed today (ADR-0013).
const up = uptrend(260);
const top = up[up.length - 1].close;
const pullbackToday = endingToday(extend(up, [top - 1.5, top - 3, top - 4.5, [top - 5, { low: top - 6 }], top - 2]));

const fakeHeadlines = async (ticker: string) => [`Titular de prueba sobre ${ticker}`];

/** Same +2 months computation as addMonths in weekly-screening.ts. */
function expectedNextReview(): string {
  const d = new Date(new Date().toISOString().slice(0, 10));
  d.setMonth(d.getMonth() + 2);
  return d.toISOString().slice(0, 10);
}

describe("weekly-screening prepare/resolve/summarize", () => {
  const today = new Date().toISOString().slice(0, 10);
  let vaultDir: string;
  let runPrepare: (provider?: typeof fakeProvider, headlinesFetcher?: typeof fakeHeadlines) => Promise<string[]>;
  const runtimeProvider = { current: fakeProvider };
  let resolveScreeningCandidate: (filename: string, input: unknown) => Promise<void>;
  let summarizeScreening: () => Promise<void>;
  let validateScreeningEvaluation: (raw: unknown) => unknown;
  let writeScreeningCandidate: typeof import("../vault-io.js").writeScreeningCandidate;

  before(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "finance-agent-screening-"));
    process.env.VAULT_PROJECT_DIR = vaultDir;
    // Makes sendSummaryEmail dump to the log instead of really sending.
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;

    const mod = await import("../weekly-screening.js");
    runPrepare = mod.runPrepare;
    resolveScreeningCandidate = mod.resolveScreeningCandidate;
    summarizeScreening = mod.summarizeScreening;
    ({ validateScreeningEvaluation } = await import("../utils/screening-helpers.js"));
    ({ writeScreeningCandidate } = await import("../vault-io.js"));
  });

  after(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    runtimeProvider.current = fakeProvider;
    await rm(join(vaultDir, "logs"), { recursive: true, force: true });
    await mkdir(join(vaultDir, "logs"), { recursive: true });
    await mkdir(join(vaultDir, "routines"), { recursive: true });
    await mkdir(join(vaultDir, "tesis"), { recursive: true });
    await writeFile(join(vaultDir, "screening-universe.md"), UNIVERSE_MD, "utf8");
    await writeFile(join(vaultDir, "watchlist.md"), WATCHLIST_MD, "utf8");
    await writeFile(join(vaultDir, "portfolio.md"), PORTFOLIO_MD, "utf8");
    await writeFile(join(vaultDir, "screening-log.md"), SCREENING_LOG_MD, "utf8");
    await writeFile(join(vaultDir, "routines", "weekly-screening.md"), SYSTEM_PROMPT_MD, "utf8");
    await mkdir(join(vaultDir, "strategies"), { recursive: true });
    await writeFile(join(vaultDir, "strategies", "base.md"), `---\nversion: "0.2"\n---\n`, "utf8");
    // Clean up theses from previous tests
    for (const f of await readdir(join(vaultDir, "tesis"))) {
      if (f.startsWith("tesis-")) await rm(join(vaultDir, "tesis", f));
    }
  });

  async function readDecisionLines(): Promise<Record<string, unknown>[]> {
    const raw = await readFile(join(vaultDir, "logs", "decisions.jsonl"), "utf8");
    return raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  }

  async function prepare(): Promise<string[]> {
    const error = mock.method(console, "error", () => {});
    const warn = mock.method(console, "warn", () => {});
    try {
      return await runPrepare(runtimeProvider.current, fakeHeadlines);
    } finally {
      error.mock.restore();
      warn.mock.restore();
    }
  }

  describe("screening:prepare", () => {
    for (const [label, broken] of brokenUsdLots(PORTFOLIO_MD)) {
      it(`builds the candidates' files with ${label}`, async () => {
        await writeFile(join(vaultDir, "portfolio.md"), broken, "utf8");
        const files = await prepare();
        assert.deepEqual(files.sort(), [`${today}-asml.as.md`, `${today}-nvda.md`]);
      });
    }

    it("writes one file per candidate, excluding the watchlist and recent not-interesting ones", async () => {
      const files = await prepare();

      // MSFT excluded (watchlist), AAPL excluded (not_interesting with a future nextReview).
      assert.deepEqual(files.sort(), [`${today}-asml.as.md`, `${today}-nvda.md`]);

      const content = await readFile(join(vaultDir, "logs", "pending-screening", `${today}-nvda.md`), "utf8");
      assert.match(content, /ticker: NVDA/);
      assert.match(content, /currency: USD/);
      assert.match(content, /asset_class: equity/);
      assert.doesNotMatch(content, /suggested_buy_lo: /);
      assert.match(content, /## Technicals/);
      assert.match(content, /## User prompt[\s\S]*\nWrite every free-text field of your answer in Spanish\. /);
      assert.match(content, /## System prompt/);
      assert.match(content, /Instrucciones de evaluación de prueba/);
      assert.match(content, /## User prompt/);
      assert.match(content, /Titular de prueba sobre NVDA/);
      assert.match(content, /el screening debe excluirlo/, "the user prompt carries the current watchlist");
      // Snapshot of the prepare date for the decision log.
      assert.match(content, /range_position: /);
      assert.match(content, /benchmark_ticker: VOO/);
      assert.match(content, /benchmark_price: 159/);
      // Silo regime: the benchmark rises all year and trades above its SMA200.
      assert.match(content, /benchmark_regime: favorable/);
      // Ranking (ADR-0012): AAPL and MSFT count for the place even though they are excluded.
      assert.match(content, /rank: 3\n/);
      // Rubric: with 3 eligibles in the silo, only the 1st is top quintile.
      assert.match(content, /top_quintile: false\n/);
      assert.match(content, /score: 0\.5\n/);
      assert.doesNotMatch(content, /exploration/);
      assert.match(content, /6m relative strength vs VOO: \+0\.0%/);
      assert.doesNotMatch(
        content.split("## User prompt")[1],
        /rank|score|exploration/i,
        "the user prompt does not carry the place",
      );
    });

    it("lists the candidate's current setups with the engine ticket and its best R:R", async () => {
      runtimeProvider.current = {
        ...fakeProvider,
        getHistorical: async (ticker: string) =>
          ticker === "NVDA" ? pullbackToday : fakeProvider.getHistorical(ticker),
      };
      await prepare();
      const content = await readFile(join(vaultDir, "logs", "pending-screening", `${today}-nvda.md`), "utf8");
      assert.match(
        content,
        /setups:\n {2}- "NVDA: retroceso en tendencia confirmado a [\d.]+ USD, objetivo [\d.]+ · stop /,
      );
      assert.match(content, /reward_risk: [\d.]+\n/);

      const log = mock.method(console, "log", () => {});
      const warn = mock.method(console, "warn", () => {});
      try {
        await resolveScreeningCandidate(`${today}-nvda.md`, VALID_INTERESTING);
        await summarizeScreening();
        const dumped = log.mock.calls.map((c) => String(c.arguments.join(" "))).join("\n");
        assert.match(dumped, /── CON SETUP ACTIVO O ARMADO[─ ]*\n\nNVDA — NVIDIA/);
        assert.match(dumped, /Setup: NVDA: retroceso en tendencia confirmado/);
      } finally {
        log.mock.restore();
        warn.mock.restore();
      }
    });

    it("removes from the watchlist what breaks filter 0, archives its thesis and reports it in the email", async () => {
      runtimeProvider.current = {
        ...fakeProvider,
        getHistorical: async (ticker: string) => (ticker === "MSFT" ? falling : fakeProvider.getHistorical(ticker)),
      };
      await writeFile(
        join(vaultDir, "tesis", "tesis-msft.md"),
        "---\nschema_version: 1\nstatus: active\ncreated: 2026-08-17\n---\n\n## Tesis de inversión\n",
        "utf8",
      );
      await prepare();

      assert.doesNotMatch(await readFile(join(vaultDir, "watchlist.md"), "utf8"), /MSFT/);
      const thesis = await readFile(join(vaultDir, "tesis", "tesis-msft.md"), "utf8");
      assert.match(thesis, /status: archived/);
      assert.match(thesis, /archive_reason: "Salida mecánica .*: below_sma200"/);

      const log = mock.method(console, "log", () => {});
      const warn = mock.method(console, "warn", () => {});
      try {
        await resolveScreeningCandidate(`${today}-nvda.md`, VALID_NOT_INTERESTING);
        await summarizeScreening();
        const dumped = log.mock.calls.map((c) => String(c.arguments.join(" "))).join("\n");
        assert.match(dumped, /── RETIRADOS DE LA WATCHLIST[─ ]*\n {2}MSFT +rompe el filtro 0: below_sma200/);
      } finally {
        log.mock.restore();
        warn.mock.restore();
      }
    });

    it("without a reliable ranking it removes nothing from the watchlist", async () => {
      runtimeProvider.current = providerWithoutReference;
      await prepare();
      assert.match(await readFile(join(vaultDir, "watchlist.md"), "utf8"), /MSFT/);
    });

    it("without a reliable ranking it draws as before and applies filter 0 to each drawn one", async () => {
      runtimeProvider.current = providerWithoutReference;
      const files = await prepare();

      // Same candidates as the ranking; SAP.DE drops out of the draw because of filter 0.
      assert.deepEqual(files.sort(), [`${today}-asml.as.md`, `${today}-nvda.md`]);
      const content = await readFile(join(vaultDir, "logs", "pending-screening", `${today}-nvda.md`), "utf8");
      assert.doesNotMatch(content, /^rank:/m);
      assert.doesNotMatch(content, /relative strength/);
    });
  });

  describe("screening:resolve", () => {
    it("with an interesting evaluation: log, thesis, watchlist, results.jsonl and file deletion", async () => {
      await prepare();
      const log = mock.method(console, "log", () => {});
      try {
        await resolveScreeningCandidate(`${today}-nvda.md`, VALID_INTERESTING);
      } finally {
        log.mock.restore();
      }

      const screeningLog = await readFile(join(vaultDir, "screening-log.md"), "utf8");
      assert.match(screeningLog, /\| NVDA \| NVIDIA \| S&P 500 \| .+ \| interesting \| .+ \| — \|/);

      const watchlist = await readFile(join(vaultDir, "watchlist.md"), "utf8");
      assert.ok(watchlist.includes("NVDA"), "NVDA must enter watchlist.md");
      // No entry thresholds: the setups decide the entry.
      assert.ok(!/target_buy_range|alert_thresholds|strategy:/.test(watchlist));

      const thesis = await readFile(join(vaultDir, "tesis", "tesis-nvda.md"), "utf8");
      assert.match(thesis, /Demanda de aceleradores IA/);
      assert.match(thesis, /Earnings Q2/);
      assert.match(thesis, /Solo con un setup del heartbeat/);
      assert.doesNotMatch(thesis, /Notas de mercado/);
      // Invalidation criteria written when the thesis is created, not the placeholder.
      assert.match(
        thesis,
        /## Cuándo dejaría de ser válida\n\n- Los ingresos de centro de datos dejan de crecer\n- Recorte del capex/,
      );
      assert.ok(!thesis.includes("pendiente de definir"));
      assert.match(thesis, /^schema_version: 1$/m, "the created thesis carries the format version");
      assert.doesNotMatch(thesis, /^exit_criteria:/m);

      const results = await readFile(join(vaultDir, "logs", "pending-screening", "results.jsonl"), "utf8");
      assert.equal(results.trim().split("\n").length, 1);
      assert.match(results, /"interesting":true/);

      await assert.rejects(() => access(join(vaultDir, "logs", "pending-screening", `${today}-nvda.md`)));

      const [decision] = await readDecisionLines();
      assert.equal(decision.type, "screen_interesting");
      assert.equal(decision.source, "screening");
      // Engine rubric: favorable regime + catalyst; NVDA is 3rd of 3 in the silo, not the top quintile.
      assert.equal(decision.conviction, "medium");
      // The points go to the decision log: the heartbeat inherits quintile and catalyst from here.
      assert.deepEqual(decision.conviction_points, ["regime_favorable", "dated_catalyst"]);
      assert.equal(decision.horizon, "medium");
      assert.equal(decision.price, 159);
      assert.deepEqual(decision.benchmark, { ticker: "VOO", price: 159 });
      assert.equal(decision.regime, "favorable");
      assert.ok(decision.strength, "it carries the prepare technical snapshot");
      assert.equal(decision.log_link, "tesis/tesis-nvda.md");
      assert.equal(decision.rank, 3);
      assert.equal(decision.score, 0.5);
      assert.ok(!("exploration" in decision));
    });

    it("an exploration candidate keeps the file's mark through to the decision log and the email", async () => {
      await writeScreeningCandidate(
        {
          ticker: tk("NVDA"),
          name: "NVIDIA",
          market: "NASDAQ",
          currency: "USD",
          asset_class: "equity",
          price: 159,
          rank: 7,
          score: 0.25,
          exploration: true,
          topQuintile: false,
          setups: [],
        },
        { systemPrompt: SYSTEM_PROMPT_MD, userPrompt: "Datos de prueba", technicalsText: "Current price: 159" },
      );
      const log = mock.method(console, "log", () => {});
      const warn = mock.method(console, "warn", () => {});
      try {
        await resolveScreeningCandidate(`${today}-nvda.md`, VALID_NOT_INTERESTING);
        await summarizeScreening();
        const dumped = log.mock.calls.map((c) => String(c.arguments.join(" "))).join("\n");
        assert.match(dumped, /NVDA\s+\[exploración\] En máximos de 52 semanas/);
      } finally {
        log.mock.restore();
        warn.mock.restore();
      }

      const [decision] = await readDecisionLines();
      assert.deepEqual([decision.rank, decision.score, decision.exploration], [7, 0.25, true]);
    });

    it("with a not-interesting evaluation: log with nextReview +2 months and the watchlist untouched", async () => {
      await prepare();
      const log = mock.method(console, "log", () => {});
      try {
        await resolveScreeningCandidate(`${today}-asml.as.md`, VALID_NOT_INTERESTING);
      } finally {
        log.mock.restore();
      }

      const screeningLog = await readFile(join(vaultDir, "screening-log.md"), "utf8");
      assert.ok(
        screeningLog.includes(
          `| not_interesting | En máximos de 52 semanas sin catalizador claro. | ${expectedNextReview()} |`,
        ),
        `screening-log must carry nextReview=${expectedNextReview()}:\n${screeningLog}`,
      );

      const watchlist = await readFile(join(vaultDir, "watchlist.md"), "utf8");
      assert.ok(!watchlist.includes("ASML"), "ASML must not enter watchlist.md");
      await assert.rejects(() => access(join(vaultDir, "tesis", "tesis-asmlas.md")));

      // The rejection is recorded too, with its silo benchmark and without the
      // validator's default conviction.
      const [decision] = await readDecisionLines();
      assert.equal(decision.type, "screen_rejected");
      assert.equal(decision.currency, "EUR");
      assert.deepEqual(decision.benchmark, { ticker: "EXSA.DE", price: 159 });
      assert.ok(!("conviction" in decision));
      assert.equal(decision.log_link, "screening-log.md");
    });

    it("with malformed JSON: rejects without corrupting the log or the watchlist nor deleting the candidate", async () => {
      await prepare();
      const before = {
        screeningLog: await readFile(join(vaultDir, "screening-log.md"), "utf8"),
        watchlist: await readFile(join(vaultDir, "watchlist.md"), "utf8"),
      };

      await assert.rejects(
        () => resolveScreeningCandidate(`${today}-nvda.md`, { interesting: "yes", reason: 42 }),
        /Invalid screening evaluation/,
      );
      // interesting=true without thesis/conviction is invalid too
      await assert.rejects(
        () => resolveScreeningCandidate(`${today}-nvda.md`, { interesting: true, reason: "ok" }),
        /thesis .* interesting=true/s,
      );

      assert.equal(await readFile(join(vaultDir, "screening-log.md"), "utf8"), before.screeningLog);
      assert.equal(await readFile(join(vaultDir, "watchlist.md"), "utf8"), before.watchlist);
      await access(join(vaultDir, "logs", "pending-screening", `${today}-nvda.md`));
      await assert.rejects(() => access(join(vaultDir, "logs", "pending-screening", "results.jsonl")));
      await assert.rejects(() => access(join(vaultDir, "logs", "decisions.jsonl")));
    });
  });

  describe("screening:summarize", () => {
    it("composes the aggregated email and, if it could not go out (no SMTP), keeps results.jsonl", async () => {
      await prepare();
      const log = mock.method(console, "log", () => {});
      const warn = mock.method(console, "warn", () => {});
      try {
        await resolveScreeningCandidate(`${today}-nvda.md`, VALID_INTERESTING);
        await resolveScreeningCandidate(`${today}-asml.as.md`, VALID_NOT_INTERESTING);
        await summarizeScreening();

        const dumped = log.mock.calls.map((c) => String(c.arguments.join(" "))).join("\n");
        assert.match(dumped, /1 nuevo\(s\) en watchlist/);
        assert.match(dumped, /Analizados: 2 \| Añadidos a watchlist: 1 \| Descartados: 1/);
        assert.match(
          dumped,
          /NVDA — NVIDIA {2}\[convicción: medium \(régimen favorable, catalizador fechado\) · ranking #3\]/,
        );
        assert.match(dumped, /ASML\.AS\s+\[ranking #1\] En máximos de 52 semanas/);
        assert.doesNotMatch(dumped, /SIN RANKING/);
        assert.match(dumped, /Régimen EUR \(EXSA\.DE\): FAVORABLE/);
        assert.match(dumped, /Régimen USD \(VOO\): FAVORABLE/);

        // Without SMTP credentials the email did not go out: results.jsonl must
        // be kept for the Actions relay to process.
        const warned = warn.mock.calls.map((c) => String(c.arguments.join(" "))).join("\n");
        assert.match(warned, /results\.jsonl kept for the relay/);
      } finally {
        log.mock.restore();
        warn.mock.restore();
      }

      await access(join(vaultDir, "logs", "pending-screening", "results.jsonl"));
      await access(join(vaultDir, "logs", "pending-screening", "run.json"));
    });

    it("with MAIL_TRANSPORT=outbox queues the email in logs/outbox/ and deletes results.jsonl", async () => {
      await prepare();
      const log = mock.method(console, "log", () => {});
      process.env.MAIL_TRANSPORT = "outbox";
      try {
        await resolveScreeningCandidate(`${today}-nvda.md`, VALID_INTERESTING);
        await summarizeScreening();
      } finally {
        delete process.env.MAIL_TRANSPORT;
        log.mock.restore();
      }

      const outboxFiles = await readdir(join(vaultDir, "logs", "outbox"));
      assert.equal(outboxFiles.length, 1);
      const msg = JSON.parse(await readFile(join(vaultDir, "logs", "outbox", outboxFiles[0]), "utf8"));
      assert.match(msg.subject, /Screening — 1 nuevo\(s\) en watchlist/);
      assert.match(msg.body, /NVDA — NVIDIA/);

      // Queued counts as delivered: the content is persisted and the relay will
      // send it — results.jsonl can now be deleted.
      await assert.rejects(() => access(join(vaultDir, "logs", "pending-screening", "results.jsonl")));
      await assert.rejects(() => access(join(vaultDir, "logs", "pending-screening", "run.json")));
    });

    it("warns in the email if the candidates were drawn without a ranking", async () => {
      runtimeProvider.current = providerWithoutReference;
      await prepare();
      const log = mock.method(console, "log", () => {});
      try {
        await resolveScreeningCandidate(`${today}-nvda.md`, VALID_NOT_INTERESTING);
        await summarizeScreening();
        const dumped = log.mock.calls.map((c) => String(c.arguments.join(" "))).join("\n");
        assert.match(dumped, /SIN RANKING: sin histórico reciente de la referencia VOO\./);
        assert.match(dumped, /Régimen USD \(VOO\): sin datos, no bloquea/);
        assert.match(dumped, /NVDA\s+En máximos de 52 semanas/);
      } finally {
        log.mock.restore();
      }

      const [decision] = await readDecisionLines();
      assert.ok(!("rank" in decision) && !("score" in decision), "a drawn candidate carries no place");
    });

    it("warns in the email if a silo is left without candidates", async () => {
      // NVDA falls all year; AAPL (recently rejected) and MSFT (watchlist) are eligible but not analyzed.
      runtimeProvider.current = {
        ...fakeProvider,
        getHistorical: async (ticker: string) => (ticker === "NVDA" ? falling : fakeProvider.getHistorical(ticker)),
      };
      assert.deepEqual(await prepare(), [`${today}-asml.as.md`]);
      const log = mock.method(console, "log", () => {});
      try {
        await resolveScreeningCandidate(`${today}-asml.as.md`, VALID_NOT_INTERESTING);
        await summarizeScreening();
        const dumped = log.mock.calls.map((c) => String(c.arguments.join(" "))).join("\n");
        assert.match(
          dumped,
          /SILO USD SIN CANDIDATOS: los 2 elegibles del ranking están en watchlist o descartados hace poco\./,
        );
        assert.doesNotMatch(dumped, /SILO EUR|SIN RANKING/);
      } finally {
        log.mock.restore();
      }
    });

    it("warns in the email about the candidates left unresolved", async () => {
      await prepare();
      const log = mock.method(console, "log", () => {});
      try {
        await resolveScreeningCandidate(`${today}-nvda.md`, VALID_NOT_INTERESTING);
        await summarizeScreening();

        const dumped = log.mock.calls.map((c) => String(c.arguments.join(" "))).join("\n");
        assert.match(dumped, /1 candidato\(s\) quedaron sin resolver/);
        assert.match(dumped, new RegExp(`${today}-asml\\.as\\.md`));
      } finally {
        log.mock.restore();
      }
    });

    it("without accumulated results it sends nothing", async () => {
      const log = mock.method(console, "log", () => {});
      try {
        await summarizeScreening();
        const dumped = log.mock.calls.map((c) => String(c.arguments.join(" "))).join("\n");
        assert.match(dumped, /nothing to summarize/);
        assert.ok(!dumped.includes("Weekly Screening ("), "no email must be composed");
      } finally {
        log.mock.restore();
      }
    });
  });

  describe("readWatchlistAddedOn", () => {
    it("takes the date added from the linked thesis created, quoted or not", async () => {
      const { readWatchlistAddedOn } = await import("../vault-io.js");
      await writeFile(
        join(vaultDir, "tesis", "tesis-msft.md"),
        "---\nschema_version: 1\ncreated: 2026-08-17\n---\n",
        "utf8",
      );
      await writeFile(
        join(vaultDir, "tesis", "tesis-aapl.md"),
        '---\nschema_version: 1\ncreated: "2026-09-19"\n---\n',
        "utf8",
      );
      const entry = (ticker: string, thesis_link?: string) => ({
        ticker: tk(ticker),
        name: ticker,
        market: "NASDAQ",
        currency: "USD" as const,
        horizon: "medium" as const,
        thesis: "t",
        thesis_link,
      });
      const addedOn = await readWatchlistAddedOn([
        entry("MSFT", "[[tesis-msft]]"),
        entry("AAPL", "[[tesis-aapl|Apple]]"),
        entry("NVDA", "[[tesis-nvda]]"),
        entry("UNH"),
      ]);
      assert.deepEqual(
        [...addedOn],
        [
          ["MSFT", "2026-08-17"],
          ["AAPL", "2026-09-19"],
        ],
      );
    });
  });

  describe("validateScreeningEvaluation", () => {
    it("normalizes a minimal not-interesting evaluation", () => {
      const v = validateScreeningEvaluation(VALID_NOT_INTERESTING) as Record<string, unknown>;
      assert.equal(v.interesting, false);
      assert.ok(!("conviction" in v), "the reasoner no longer gives the conviction");
      assert.equal(v.thesis, null);
      assert.equal(v.next_catalyst, null);
      assert.deepEqual(v.invalidation, []);
    });

    it("requires invalidation criteria when interesting=true", () => {
      const { invalidation: _omit, ...sinCriterios } = VALID_INTERESTING;
      assert.throws(() => validateScreeningEvaluation(sinCriterios), /invalidation/);
      assert.throws(() => validateScreeningEvaluation({ ...VALID_INTERESTING, invalidation: [] }), /invalidation/);
      assert.throws(
        () => validateScreeningEvaluation({ ...VALID_INTERESTING, invalidation: ["ok", " "] }),
        /invalidation/,
      );
    });

    it("normalizes the invalidation criteria", () => {
      const v = validateScreeningEvaluation({ ...VALID_INTERESTING, invalidation: ["  Rebaja de guía  "] }) as Record<
        string,
        unknown
      >;
      assert.deepEqual(v.invalidation, ["Rebaja de guía"]);
    });

    it("collects all the errors", () => {
      assert.throws(
        () => validateScreeningEvaluation({ interesting: true, reason: "", thesis: "t" }),
        (err: Error) => err.message.includes("reason") && err.message.includes("invalidation"),
      );
    });

    it("rejects conviction and market notes: they are no longer part of the contract", () => {
      assert.throws(
        () => validateScreeningEvaluation({ ...VALID_INTERESTING, conviction: "high", market_notes: "x" }),
        (err: Error) => /conviction .*the engine computes it/.test(err.message) && err.message.includes("market_notes"),
      );
    });

    it("ignores the zone thresholds of a reasoner using the previous contract", () => {
      const v = validateScreeningEvaluation({
        ...VALID_INTERESTING,
        suggested_buy_range: [150, 160],
        suggested_support_break: 140,
      });
      assert.equal("suggested_buy_range" in (v as object), false);
    });
  });
});
