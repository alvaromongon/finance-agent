/**
 * Integration tests of the engine.
 *
 * They cover what unit tests CANNOT check:
 *   1. Full I/O cycle over real .md files on disk
 *      (readWatchlist, readPortfolio, updatePortfolioPrices, writeDecisionLog)
 *   2. End-to-end heartbeat pipeline with a mocked IMarketDataProvider:
 *      watchlist → precios → evaluateSignals → validateTicket → writeDecisionLog
 *
 * No calls to external APIs: it can run in CI without secrets.
 *
 * Technical note: vault-io and heartbeat import `config`, which reads env vars
 * when the module is first evaluated. For VAULT_PROJECT_DIR to point at the
 * temporary directory created in before(), those modules are imported
 * dynamically (await import()) INSIDE the before() hook, after setting the
 * environment variable. This suite has no static import of application code
 * (only types, erased at runtime by tsx).
 */
// These tests assert the owner's Spanish output; English is covered in i18n.test.ts.
process.env.OUTPUT_LANGUAGE = "es";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Type imports only (erased at runtime — they do not evaluate config.ts)
import type {
  BuyTicket,
  Currency,
  EngineTicket,
  Recommendation,
  PortfolioSnapshot,
  WatchlistEntry,
  Signal,
  TriggerKind,
} from "../types.js";
import type { Ticker } from "../ticker.js";
import type { TicketValidation } from "../risk.js";
import { SPANISH } from "./fixtures/spanish.js";
import { lotId, lotsSection } from "./fixtures/lots.js";
import { parseTicker as tk } from "../ticker.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** portfolio.md with EUR balance, one EUR position and an empty USD balance. */
const PORTFOLIO_MD = `---
schema_version: 2
last_manual_sync: "2026-06-27"
---

## EUR — Cash

| Item | Value |
|---|---|
| Available cash | 1.000,00 € |

## EUR — Positions

| Ticker | Volume | Avg price | Current price | P/L | Stop loss |
|---|---|---|---|---|---|
| TEST.EU | 10 | 45,00 | 45,00 | 0,00 | 42,00 |
| — | — | — | — | — | — |

${lotsSection("EUR", [{ ticker: "TEST.EU", units: 10, price: 45, stop: 42 }])}
## USD — Cash

| Item | Value |
|---|---|
| Available cash | $500.00 |

## USD — Positions

| Ticker | Volume | Avg price | Current price | P/L | Stop loss |
|---|---|---|---|---|---|
| — | — | — | — | — | — |

${lotsSection("USD")}`;

/** watchlist.md with one EUR asset (in buy range) and one USD asset. */
const WATCHLIST_MD = `---
schema_version: 1
---

# Watchlist

\`\`\`yaml
watchlist:
  - ticker: TEST.EU
    name: Test Asset EUR
    market: TEST
    currency: EUR
    horizon: medium
    thesis: "Thesis de integración"
  - ticker: USDTEST
    name: Test Asset USD
    market: NYSE
    currency: USD
    horizon: short
    thesis: "USD thesis"
\`\`\`
`;

const MOCK_REC: Recommendation = {
  ticker: tk("TEST.EU"),
  action: "BUY",
  ticket: { direction: "BUY", currency: "EUR", target: 50 },
  thesis_summary: "Integration test BUY signal.",
  triggers: ["setup"],
};

// ─── Suite principal ──────────────────────────────────────────────────────────

describe("Integration — engine", () => {
  let tempDir: string;

  // References to dynamically imported functions
  let readWatchlist: (currency: Currency) => Promise<WatchlistEntry[]>;
  let readPortfolio: (currency: Currency) => Promise<PortfolioSnapshot>;
  let updatePortfolioPrices: (currency: Currency, prices: Map<Ticker, number>) => Promise<void>;
  let writeDecisionLog: typeof import("../vault-io.js").writeDecisionLog;
  let getLastLogForTicker: (
    ticker: Ticker,
    files?: string[],
  ) => Promise<{ price: number; triggers: TriggerKind[] } | null>;
  let listLogFiles: () => Promise<string[]>;
  let vaultIo: typeof import("../vault-io.js");
  let evaluateSignals: (
    watchlist: WatchlistEntry[],
    portfolio: PortfolioSnapshot,
    prices: Map<string, number>,
    stopProximityPct?: number,
  ) => Signal[];
  let validateTicket: (ticket: EngineTicket, signal: Pick<Signal, "cash" | "position">) => TicketValidation;

  before(async () => {
    // 1. Create a temporary vault with a logs/ subdirectory
    tempDir = await mkdtemp(join(tmpdir(), "finance-agent-integration-"));
    await mkdir(join(tempDir, "logs"));

    // 2. Set env vars BEFORE importing modules that read config.ts
    process.env.VAULT_PROJECT_DIR = tempDir;
    process.env.STOP_PROXIMITY_PCT = "3";

    // 3. Write fixtures to disk
    await writeFile(join(tempDir, "watchlist.md"), WATCHLIST_MD, "utf8");
    await writeFile(join(tempDir, "portfolio.md"), PORTFOLIO_MD, "utf8");

    // 4. Dynamic imports: config.ts is evaluated here for the first time,
    //    when VAULT_PROJECT_DIR is already set.
    vaultIo = await import("../vault-io.js");
    const hb = await import("../heartbeat.js");
    const risk = await import("../risk.js");

    readWatchlist = vaultIo.readWatchlist;
    readPortfolio = vaultIo.readPortfolio;
    updatePortfolioPrices = vaultIo.updatePortfolioPrices;
    writeDecisionLog = vaultIo.writeDecisionLog;
    getLastLogForTicker = vaultIo.getLastLogForTicker;
    listLogFiles = vaultIo.listLogFiles;
    evaluateSignals = hb.evaluateSignals;
    validateTicket = risk.validateTicket;
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ─── vault-io: lectura ──────────────────────────────────────────────────────

  describe("vault-io — readWatchlist", () => {
    it("filters by EUR: returns only EUR entries", async () => {
      const entries = await readWatchlist("EUR");
      assert.equal(entries.length, 1);
      assert.equal(entries[0].ticker, "TEST.EU");
      assert.equal(entries[0].currency, "EUR");
      assert.equal(entries[0].horizon, "medium");
    });

    it("filters by USD: returns only USD entries", async () => {
      const entries = await readWatchlist("USD");
      assert.equal(entries.length, 1);
      assert.equal(entries[0].ticker, "USDTEST");
    });
  });

  describe("vault-io — readPortfolio", () => {
    it("EUR: parses cash and position correctly from disk", async () => {
      const snapshot = await readPortfolio("EUR");
      assert.equal(snapshot.currency, "EUR");
      assert.equal(snapshot.cash, 1000);
      assert.equal(snapshot.positions.length, 1);

      const pos = snapshot.positions[0];
      assert.equal(pos.ticker, "TEST.EU");
      assert.equal(pos.volume, 10);
      assert.equal(pos.avgPrice, 45);
      assert.equal(pos.stopLoss, 42);
    });

    it("syncedAt is always an ISO string, even if the frontmatter has no quotes", async () => {
      // js-yaml returns a Date with `last_manual_sync: 2026-08-27T20:46:00Z`
      // (as in the real portfolio.md) and a string if quoted. Without
      // normalizing, any consumer treating it as a string breaks only in
      // production — which is exactly how it was found.
      const original = await readFile(join(tempDir, "portfolio.md"), "utf8");
      try {
        await writeFile(
          join(tempDir, "portfolio.md"),
          original.replace(/last_manual_sync: .*/, "last_manual_sync: 2026-06-27T20:46:00Z"),
          "utf8",
        );
        const snapshot = await readPortfolio("EUR");
        assert.equal(typeof snapshot.syncedAt, "string");
        assert.equal(snapshot.syncedAt.slice(0, 10), "2026-06-27");
      } finally {
        await writeFile(join(tempDir, "portfolio.md"), original, "utf8");
      }
    });

    it("USD: correct cash and no positions (placeholder rows)", async () => {
      const snapshot = await readPortfolio("USD");
      assert.equal(snapshot.currency, "USD");
      assert.equal(snapshot.cash, 500);
      assert.equal(snapshot.positions.length, 0);
    });
  });

  // ─── vault-io: input format v1 ──────────────────────────────────

  describe("vault-io — input format v1", () => {
    it("readPortfolio rejects a portfolio without schema_version", async () => {
      await writeFile(join(tempDir, "portfolio.md"), PORTFOLIO_MD.replace("schema_version: 2\n", ""), "utf8");
      try {
        await assert.rejects(readPortfolio("EUR"), /portfolio\.md.*schema_version/);
      } finally {
        await writeFile(join(tempDir, "portfolio.md"), PORTFOLIO_MD, "utf8");
      }
    });

    it("readPortfolio rejects a v1 portfolio, naming the file and the version it reads", async () => {
      await writeFile(
        join(tempDir, "portfolio.md"),
        PORTFOLIO_MD.replace("schema_version: 2", "schema_version: 1"),
        "utf8",
      );
      try {
        await assert.rejects(readPortfolio("EUR"), /portfolio\.md.*schema_version 1.*version 2/);
      } finally {
        await writeFile(join(tempDir, "portfolio.md"), PORTFOLIO_MD, "utf8");
      }
    });

    it("readPortfolio rejects a v2 portfolio without the Lots section of the currency", async () => {
      await writeFile(join(tempDir, "portfolio.md"), PORTFOLIO_MD.replace("## USD — Lots", "## USD — Lotes"), "utf8");
      try {
        await assert.rejects(readPortfolio("USD"), /portfolio\.md.*## USD — Lots/);
        // Each currency is checked on its own, as Cash and Positions are.
        assert.equal((await readPortfolio("EUR")).currency, "EUR");
      } finally {
        await writeFile(join(tempDir, "portfolio.md"), PORTFOLIO_MD, "utf8");
      }
    });

    it("readPortfolio returns the open lots of the silo next to its positions", async () => {
      const eur = await readPortfolio("EUR");
      assert.deepEqual(
        eur.lots.map((l) => [l.entryId, l.units, l.entryPrice, l.initialStop]),
        [[lotId("TEST.EU"), 10, 45, 42]],
      );
      assert.deepEqual((await readPortfolio("USD")).lots, []);
    });

    it("every other vault file stays at schema_version 1, including the ones the engine writes", async () => {
      assert.equal((await readWatchlist("EUR")).length, 1, "watchlist.md v1 is read");
    });

    it("readPortfolio rejects a section with the previous heading instead of reading the silo as empty", async () => {
      await writeFile(
        join(tempDir, "portfolio.md"),
        PORTFOLIO_MD.replace("## EUR — Positions", "## EUR — Posiciones"),
        "utf8",
      );
      try {
        await assert.rejects(readPortfolio("EUR"), /## EUR — Positions/);
      } finally {
        await writeFile(join(tempDir, "portfolio.md"), PORTFOLIO_MD, "utf8");
      }
    });

    it("readWatchlist rejects a watchlist without schema_version", async () => {
      await writeFile(join(tempDir, "watchlist.md"), WATCHLIST_MD.replace("schema_version: 1\n", ""), "utf8");
      try {
        await assert.rejects(readWatchlist("EUR"), /watchlist\.md.*schema_version/);
      } finally {
        await writeFile(join(tempDir, "watchlist.md"), WATCHLIST_MD, "utf8");
      }
    });

    it("appendScreeningLogEntries creates the screening-log with version and header, and reads it back", async () => {
      const log = {
        ticker: tk("AAA"),
        name: "Aaa",
        index: "S&P 500",
        date: "2026-10-13",
        result: "not_interesting" as const,
        summary: "Sin catalizador",
        nextReview: "2026-12-13",
      };
      await vaultIo.appendScreeningLogEntries([log]);
      const raw = await readFile(join(tempDir, "screening-log.md"), "utf8");
      assert.match(raw, /^---\nschema_version: 1\n---/);
      assert.deepEqual(await vaultIo.readScreeningLog(), [log]);
    });
  });

  // ─── vault-io: escritura ────────────────────────────────────────────────────

  describe("vault-io — updatePortfolioPrices", () => {
    beforeEach(async () => {
      // Restore the original portfolio.md before each writing test
      await writeFile(join(tempDir, "portfolio.md"), PORTFOLIO_MD, "utf8");
    });

    it("reads the columns by header: with another order it writes to the right column", async () => {
      const reordered = PORTFOLIO_MD.replace(
        /\| Ticker \| Volume \| Avg price \| Current price \| P\/L \| Stop loss \|\n\|---\|---\|---\|---\|---\|---\|\n\| TEST\.EU \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|/,
        "| Stop loss | P/L | Current price | Avg price | Volume | Ticker |\n|---|---|---|---|---|---|\n| $5 | $4 | $3 | $2 | $1 | TEST.EU |",
      );
      assert.notEqual(reordered, PORTFOLIO_MD, "the fixture must end up reordered");
      await writeFile(join(tempDir, "portfolio.md"), reordered, "utf8");
      await updatePortfolioPrices("EUR", new Map([[tk("TEST.EU"), 48.0]]));
      const updated = await readFile(join(tempDir, "portfolio.md"), "utf8");
      assert.match(updated, /\| 42,00 \| 30,00 \| 48,00 \| 45,00 \| 10 \| TEST\.EU \|/);
    });

    it("throws if the table is missing a column, without touching the file", async () => {
      const broken = PORTFOLIO_MD.replace(
        "| Ticker | Volume | Avg price | Current price | P/L | Stop loss |",
        "| Ticker | Volume | Precio medio | Current price | P/L | Stop loss |",
      );
      await writeFile(join(tempDir, "portfolio.md"), broken, "utf8");
      await assert.rejects(updatePortfolioPrices("EUR", new Map([[tk("TEST.EU"), 48.0]])), /Avg price/);
      assert.equal(await readFile(join(tempDir, "portfolio.md"), "utf8"), broken);
    });

    it("keeps rewriting only Current price and P/L: the Lots table is left as it was", async () => {
      await updatePortfolioPrices("EUR", new Map([[tk("TEST.EU"), 48.0]]));
      const updated = await readFile(join(tempDir, "portfolio.md"), "utf8");
      assert.equal(
        updated.slice(updated.indexOf("## EUR — Lots")),
        PORTFOLIO_MD.slice(PORTFOLIO_MD.indexOf("## EUR — Lots")),
      );
      assert.match(updated, /^schema_version: 2$/m);
    });

    it("updates Current price and P/L in portfolio.md", async () => {
      await updatePortfolioPrices("EUR", new Map([[tk("TEST.EU"), 48.0]]));
      const updated = await readFile(join(tempDir, "portfolio.md"), "utf8");

      // P/L = (48 - 45) * 10 = 30 → "30,00" en formato europeo
      assert.ok(updated.includes("48,00"), "current price updated to 48,00");
      assert.ok(updated.includes("30,00"), "P/L recalculado a 30,00");
      // avgPrice (45,00) and stop-loss (42,00) must not change
      assert.ok(updated.includes("45,00"), "average price unchanged");
      assert.ok(updated.includes("42,00"), "stop-loss unchanged");
    });

    it("prices every Positions row of a ticker, the way the Volume check reads them (it sums all of them)", async () => {
      const twice = PORTFOLIO_MD.replace(
        "| TEST.EU | 10 | 45,00 | 45,00 | 0,00 | 42,00 |",
        "| TEST.EU | 4 | 45,00 | 45,00 | 0,00 | 42,00 |\n| TEST.EU | 6 | 40,00 | 40,00 | 0,00 | 42,00 |",
      );
      await writeFile(join(tempDir, "portfolio.md"), twice, "utf8");
      await updatePortfolioPrices("EUR", new Map([[tk("TEST.EU"), 48.0]]));
      const updated = await readFile(join(tempDir, "portfolio.md"), "utf8");
      assert.match(updated, /\| TEST\.EU \| 4 \| 45,00 \| 48,00 \| 12,00 \| 42,00 \|/);
      assert.match(updated, /\| TEST\.EU \| 6 \| 40,00 \| 48,00 \| 48,00 \| 42,00 \|/);
    });

    it("a Positions table split by a blank line is one table: the rows under the split are priced too", async () => {
      const split = PORTFOLIO_MD.replace(
        "| TEST.EU | 10 | 45,00 | 45,00 | 0,00 | 42,00 |",
        "\n| TEST.EU | 10 | 45,00 | 45,00 | 0,00 | 42,00 |",
      );
      await writeFile(join(tempDir, "portfolio.md"), split, "utf8");
      await updatePortfolioPrices("EUR", new Map([[tk("TEST.EU"), 48.0]]));
      const updated = await readFile(join(tempDir, "portfolio.md"), "utf8");
      assert.equal(updated, split.replace("| 45,00 | 45,00 | 0,00 |", "| 45,00 | 48,00 | 30,00 |"));
    });

    it("keeps the line ends of the file: a CRLF file stays CRLF", async () => {
      await writeFile(join(tempDir, "portfolio.md"), PORTFOLIO_MD.replace(/\n/g, "\r\n"), "utf8");
      await updatePortfolioPrices("EUR", new Map([[tk("TEST.EU"), 48.0]]));
      const updated = await readFile(join(tempDir, "portfolio.md"), "utf8");
      assert.ok(!/[^\r]\n/.test(updated), "no bare LF");
      assert.ok(updated.includes("48,00"));
    });

    it("prices a lower-case Positions row by its parsed ticker and writes the upper-case ticker into the row", async () => {
      const lower = PORTFOLIO_MD.replace("| TEST.EU | 10 |", "| test.eu | 10 |");
      assert.notEqual(lower, PORTFOLIO_MD, "the fixture must end up lower case");
      await writeFile(join(tempDir, "portfolio.md"), lower, "utf8");
      await updatePortfolioPrices("EUR", new Map([[tk("TEST.EU"), 48.0]]));
      const updated = await readFile(join(tempDir, "portfolio.md"), "utf8");
      assert.match(updated, /\| TEST\.EU \| 10 \| 45,00 \| 48,00 \| 30,00 \| 42,00 \|/);
    });

    it("leaves a Positions row whose ticker does not parse byte-identical", async () => {
      const bad = PORTFOLIO_MD.replace("| TEST.EU | 10 |", "| TE ST | 10 |");
      assert.notEqual(bad, PORTFOLIO_MD, "the fixture must end up with a bad ticker");
      await writeFile(join(tempDir, "portfolio.md"), bad, "utf8");
      await updatePortfolioPrices("EUR", new Map([[tk("TEST.EU"), 48.0]]));
      assert.equal(await readFile(join(tempDir, "portfolio.md"), "utf8"), bad);
    });

    it("does not modify the file if no ticker has a price", async () => {
      const before = await readFile(join(tempDir, "portfolio.md"), "utf8");
      await updatePortfolioPrices("EUR", new Map<Ticker, number>()); // no prices
      const after = await readFile(join(tempDir, "portfolio.md"), "utf8");
      assert.equal(before, after);
    });

    it("ignores map tickers that are not in the positions section", async () => {
      const before = await readFile(join(tempDir, "portfolio.md"), "utf8");
      await updatePortfolioPrices("EUR", new Map([[tk("UNKNOWN.XX"), 999]]));
      const after = await readFile(join(tempDir, "portfolio.md"), "utf8");
      assert.equal(before, after);
    });
  });

  describe("vault-io — writeDecisionLog and getLastLogForTicker", () => {
    it("creates the log file with the right content and price in the frontmatter", async () => {
      await writeDecisionLog(MOCK_REC, {
        price: 45.2,
        setup: { pattern: "breakout", state: "triggered", date: "2026-09-24", level: 45.2, target: 52.1 },
        conviction: { conviction: "medium", points: ["regime_favorable", "reward_risk"] },
      });

      const today = new Date().toISOString().slice(0, 10);
      const logPath = join(tempDir, "logs", `${today}-test.eu.md`);
      const content = await readFile(logPath, "utf8");

      assert.ok(content.includes("TEST.EU"), "ticker in the log");
      assert.ok(content.includes("BUY"), "action in the log");
      assert.ok(
        content.includes("| Convicción | medium (régimen favorable, R:R ≥ 3) |"),
        "engine conviction in the log",
      );
      assert.ok(content.includes("45"), "reference price in the log");
      assert.ok(content.includes("Integration test BUY signal."), "thesis in the log");
      assert.ok(content.includes("price: 45.2"), "price en frontmatter");
      assert.ok(content.includes("triggers: [setup]"), "triggers en frontmatter");
      assert.ok(content.includes("| Setup | breakout a 45.2, objetivo 52.1 |"), "setup in the log");

      const lastLog = await getLastLogForTicker(tk("TEST.EU"));
      assert.deepEqual(lastLog, { price: 45.2, triggers: ["setup"] });
    });

    it("in English with OUTPUT_LANGUAGE=en", async () => {
      process.env.OUTPUT_LANGUAGE = "en";
      try {
        await writeDecisionLog(
          { ...MOCK_REC, ticker: tk("TEST.US"), thesis_summary: "English thesis.", assumptions: ["Brent holds"] },
          {
            price: 45.2,
            blocked: true,
            reasons: ["regime_adverse"],
            notes: ["Check earnings"],
            setup: { pattern: "breakout", state: "triggered", date: "2026-09-24", level: 45.2, target: 52.1 },
            conviction: { conviction: "medium", points: ["regime_favorable"] },
          },
        );
      } finally {
        process.env.OUTPUT_LANGUAGE = "es";
      }
      const today = new Date().toISOString().slice(0, 10);
      const content = await readFile(join(tempDir, "logs", `${today}-test.us.md`), "utf8");
      assert.match(content, /## Decision\n\n\| Field \| Value \|/);
      assert.match(content, /\| Conviction \| medium \(favorable regime\) \|/);
      assert.match(content, /\| Setup \| breakout at 45\.2, target 52\.1 \|/);
      assert.match(content, /\| Block \| regime_adverse \|/);
      assert.match(
        content,
        /## Assumptions\n\n- Brent holds\n\n## Notices\n\n- Check earnings\n\n## Thesis\n\nEnglish thesis\./,
      );
      assert.doesNotMatch(content, SPANISH);
    });

    it("getLastLogForTicker returns null for a ticker without a log", async () => {
      const lastLog = await getLastLogForTicker(tk("NEVER.ANALYZED"));
      assert.equal(lastLog, null);
    });

    it("listLogFiles + getLastLogForTicker(ticker, files) gives the same result as without files (a single directory read for several tickers)", async () => {
      const files = await listLogFiles();
      assert.ok(files.length > 0, "it must list the files already written in this test");

      const withFiles = await getLastLogForTicker(tk("TEST.EU"), files);
      const withoutFiles = await getLastLogForTicker(tk("TEST.EU"));
      assert.deepEqual(withFiles, withoutFiles);
    });

    it("getLastLogForTicker ignora logs blocked: true", async () => {
      await writeDecisionLog({ ...MOCK_REC, ticker: tk("BLOCKED.EU") }, { price: 99, blocked: true });
      const lastLog = await getLastLogForTicker(tk("BLOCKED.EU"));
      assert.equal(lastLog, null);
    });
  });

  // End-to-end regression (real I/O, not isolated pure functions) of the
  // cooldown.ts bug: a previous log with [support_break, buy_zone] must not block
  // a new big_move just because buy_zone is shared by both.
  describe("re-analysis cooldown through the real pipeline (writeDecisionLog + getLastLogForTicker + shouldSkipReanalysis)", () => {
    let shouldSkipReanalysis: (input: {
      currentTriggers: TriggerKind[];
      currentPrice: number;
      lastLog: { price: number; triggers: TriggerKind[] } | null;
      reanalysisPriceDeltaPct: number;
    }) => boolean;

    before(async () => {
      const cooldown = await import("../utils/cooldown.js");
      shouldSkipReanalysis = cooldown.shouldSkipReanalysis;
    });

    it("same trigger, no relevant price change: there IS a cooldown", async () => {
      await writeDecisionLog(
        { ...MOCK_REC, ticker: tk("COOLDOWN.EU"), triggers: ["setup", "big_move"] },
        { price: 100 },
      );
      const lastLog = await getLastLogForTicker(tk("COOLDOWN.EU"));
      const skip = shouldSkipReanalysis({
        currentTriggers: ["setup"],
        currentPrice: 101, // Δ 1% < REANALYSIS_PRICE_DELTA_PCT (3% by default)
        lastLog,
        reanalysisPriceDeltaPct: 3,
      });
      assert.equal(skip, true);
    });

    it("new trigger (big_move after a setup): there is NO cooldown", async () => {
      await writeDecisionLog({ ...MOCK_REC, ticker: tk("COOLDOWN2.EU"), triggers: ["setup"] }, { price: 100 });
      const lastLog = await getLastLogForTicker(tk("COOLDOWN2.EU"));
      const skip = shouldSkipReanalysis({
        currentTriggers: ["big_move"], // same price, different and never seen trigger
        currentPrice: 100,
        lastLog,
        reanalysisPriceDeltaPct: 3,
      });
      assert.equal(skip, false);
    });
  });

  // ─── Pipeline integrado ─────────────────────────────────────────────────────

  describe("integrated pipeline: watchlist → prices → signals → validation", () => {
    it("a price far from the stop and no big move generates no signals (no API cost)", async () => {
      const watchlist = await readWatchlist("EUR");
      const portfolio = await readPortfolio("EUR");

      // Price 60: stopLoss=42 with pct=3 → margin=43.26 < 60
      const prices = new Map([["TEST.EU", 60.0]]);
      const signals = evaluateSignals(watchlist, portfolio, prices, 3);

      assert.equal(signals.length, 0);
    });

    it("a price near the stop fires approaching_stop", async () => {
      const watchlist = await readWatchlist("EUR");
      const portfolio = await readPortfolio("EUR");

      // Price 43: stopLoss=42 with pct=3 → margin=43.26 ≥ 43 → approaching_stop
      const prices = new Map([["TEST.EU", 43.0]]);
      const signals = evaluateSignals(watchlist, portfolio, prices, 3);

      assert.equal(signals.length, 1);
      assert.deepEqual(signals[0].triggers, ["approaching_stop"]);
    });

    it("an empty watchlist produces no signals", async () => {
      const portfolio = await readPortfolio("EUR");
      const signals = evaluateSignals([], portfolio, new Map([["TEST.EU", 45.0]]), 3);
      assert.equal(signals.length, 0);
    });

    it("the signal carries the silo value at market, the base of risk sizing", async () => {
      const watchlist = await readWatchlist("EUR");
      const portfolio = await readPortfolio("EUR");
      const signals = evaluateSignals(watchlist, portfolio, new Map([["TEST.EU", 35.0]]), 3);
      // €1,000 cash + 10 shares at €35.
      assert.equal(signals[0].siloValue, 1350);
    });

    it("validateTicket fails if the portfolio cash is not enough for the ticket", async () => {
      const watchlist = await readWatchlist("EUR");
      const portfolio = await readPortfolio("EUR");
      const prices = new Map([["TEST.EU", 35.0]]);
      const signals = evaluateSignals(watchlist, portfolio, prices, 3);

      // €40 ticket with only €10 available
      const ticket: BuyTicket = {
        kind: "BUY",
        currency: "EUR",
        entry: 35,
        stop: 30,
        stopAtr: 3,
        units: 1.1428,
        amount: 40,
        costs: 0,
        taxPct: 0,
        risk: 5.71,
        riskBudget: 13.5,
        cappedBy: "risk",
        target: 50,
        rrGross: 3,
        rrNet: 3,
      };
      const validation = validateTicket(ticket, { ...signals[0], cash: 10 });
      assert.equal(validation.valid, false);
      assert.ok(validation.errors.some((e) => e.code === "insufficient_cash"));
    });
  });
});
