/**
 * Heartbeat flow tests: a single summary email per run, without
 * repeating in the next one what did not change. Temporary vault, no network
 * or real SMTP: MAIL_TRANSPORT=outbox leaves each email as a file in
 * logs/outbox/, so counting files is counting emails. Same pattern as
 * monday-briefing-flow.test.ts: VAULT_PROJECT_DIR is set before the first
 * import of config.js.
 */
// These tests assert the owner's Spanish output; English is covered in i18n.test.ts.
process.env.OUTPUT_LANGUAGE = "es";
import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bar, extend, uptrend } from "./fixtures/setup-bars.js";
import type { IMarketDataProvider, HistoricalBar } from "../providers/types.js";
import type { IAnalystProvider } from "../analyst/types.js";
import type { Currency, Signal } from "../types.js";
import { entryLines, lotsSection, type HeldLot } from "./fixtures/lots.js";

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
    thesis: "Sin setup; se mueve un 12% en la sesión."
  - ticker: BO
    name: Breakout
    market: NYSE
    currency: USD
    horizon: medium
    thesis: "Base pegada al máximo."
\`\`\`
`;

const portfolioMd = (positions: string, held: HeldLot[]) => `---
schema_version: 2
last_manual_sync: "2026-10-01"
---

## USD — Cash

| Item | Value |
|---|---|
| Available cash | $1000.00 |

## USD — Positions

| Ticker | Volume | Avg price | Current price | P/L | Stop loss |
|---|---|---|---|---|---|
${positions}

${lotsSection("USD", held)}`;

// MSFT with the stop 0.1 ATR from the price: tight stop and approaching_stop (deferred escalation).
const MSFT_ROW = "| MSFT | 1 | 492.01 | 501.02 | +9.01 | 500.00 |";
const MSFT_LOT: HeldLot = { ticker: "MSFT", units: 1, price: 492.01 };
// CAT already trades below its stop.
const CAT_ROW = "| CAT | 1 | 218.00 | 216.90 | -1.10 | 213.00 |";
const CAT_LOT: HeldLot = { ticker: "CAT", units: 1, price: 218 };

// A fifteen-session base right at the high; before() cuts it where it is
// armed for the first time (see setups-scan.test.ts). The detector is imported
// there: loading it here would load config.js before setting VAULT_PROJECT_DIR.
const run = uptrend(150);
const high = run[run.length - 1].close;
const base = extend(
  run,
  Array.from({ length: 15 }, (_, i) => high + (i % 2 ? 0.5 : -0.5)),
);

const flat = (close: number, spread: number): HistoricalBar[] =>
  Array.from({ length: 30 }, (_, i) => bar(i, close, { spread }));

const PRICES: Record<string, number> = { MSFT: 501.02, CAT: 210.77, XOM: 112.4, VOO: 800 };
const HISTORY: Record<string, HistoricalBar[]> = {
  MSFT: flat(501.02, 5),
  CAT: flat(216, 2),
  XOM: uptrend(250),
  VOO: uptrend(250, 600),
};

const provider: IMarketDataProvider = {
  getPrices: async (tickers) => new Map(tickers.filter((t) => t in PRICES).map((t) => [t, PRICES[t]])),
  getPreviousCloses: async (tickers) =>
    new Map(tickers.filter((t) => t in PRICES).map((t) => [t, t === "XOM" ? 100 : PRICES[t]])),
  getHistorical: async (ticker) => HISTORY[ticker] ?? [],
};

describe("runHeartbeat", () => {
  let vaultDir: string;
  let runHeartbeat: (
    currency: Currency,
    deps: {
      provider: IMarketDataProvider;
      analyst: IAnalystProvider;
      headlines?: (ticker: string) => Promise<string[]>;
      lastMarketDate?: (ticker: string) => Promise<Date | null>;
    },
  ) => Promise<void>;
  const escalated: Signal[] = [];
  const analyst: IAnalystProvider = {
    escalate: async (signal) => {
      escalated.push(signal);
      return { status: "deferred", pendingPath: `logs/pending/2026-10-13-${signal.ticker.toLowerCase()}.md` };
    },
  };

  before(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "finance-agent-heartbeat-"));
    process.env.VAULT_PROJECT_DIR = vaultDir;
    ({ runHeartbeat } = await import("../heartbeat-run.js"));
    const { detectNewSetups } = await import("../utils/setups/index.js");
    HISTORY.BO = Array.from({ length: 16 }, (_, i) => base.slice(0, run.length + i)).find((bars) =>
      detectNewSetups(bars).some((s) => s.state === "armed"),
    )!;
    PRICES.BO = HISTORY.BO.at(-1)!.close;
  });

  after(async () => {
    delete process.env.MAIL_TRANSPORT;
    await rm(vaultDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    process.env.MAIL_TRANSPORT = "outbox";
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    escalated.length = 0;
    await rm(join(vaultDir, "logs"), { recursive: true, force: true });
    await mkdir(join(vaultDir, "logs"), { recursive: true });
    await mkdir(join(vaultDir, "strategies"), { recursive: true });
    await writeFile(join(vaultDir, "strategies", "base.md"), `---\nversion: "1.0"\n---\n`, "utf8");
    await writeFile(join(vaultDir, "watchlist.md"), WATCHLIST_MD, "utf8");
    await setPortfolio(MSFT_ROW, [MSFT_LOT]);
  });

  /** portfolio.md with these position rows and, consistent with them, their lots and the entries in the log. */
  const setPortfolio = async (rows: string, held: HeldLot[]) => {
    await writeFile(join(vaultDir, "portfolio.md"), portfolioMd(rows, held), "utf8");
    await writeFile(join(vaultDir, "logs", "decisions.jsonl"), entryLines("USD", held), "utf8");
  };

  const heartbeat = async (over: Partial<Parameters<typeof runHeartbeat>[1]> = {}) => {
    const log = mock.method(console, "log", () => {});
    const warn = mock.method(console, "warn", () => {});
    const error = mock.method(console, "error", () => {});
    try {
      await runHeartbeat("USD", { provider, analyst, headlines: async () => [], ...over });
      return warn.mock.calls.map((c) => String(c.arguments[0]));
    } finally {
      log.mock.restore();
      warn.mock.restore();
      error.mock.restore();
    }
  };

  async function outbox(): Promise<{ subject: string; body: string }[]> {
    const dir = join(vaultDir, "logs", "outbox");
    const files = (await readdir(dir).catch(() => [] as string[])).sort();
    return Promise.all(files.map(async (f) => JSON.parse(await readFile(join(dir, f), "utf8"))));
  }

  it("tight stop + armed breakout + deferred signal produce exactly one email", async () => {
    await heartbeat();

    const emails = await outbox();
    assert.equal(emails.length, 1);
    assert.match(emails[0].subject, /stop ceñido: MSFT · ruptura armada: BO · a análisis: /);
    assert.deepEqual(escalated.map((s) => s.ticker).sort(), ["MSFT", "XOM"], "both escalated as before");
    assert.doesNotMatch(emails[0].subject, /pendiente de análisis/);
  });

  describe("Lots that do not match (ADR-0015): it keeps watching and warns loudly", () => {
    it("Volume that is not the sum of the units of its lots: the crossed stop still goes out, with the warning", async () => {
      // CAT trades below its stop; its row says 1 unit and its lot 3.
      await setPortfolio(`${MSFT_ROW}\n${CAT_ROW}`, [MSFT_LOT, { ...CAT_LOT, units: 3 }]);
      const warnings = await heartbeat();

      assert.ok(
        warnings.some((w) => w.includes("Lots do not match") && /CAT.*Volume 1/.test(w)),
        `warnings: ${JSON.stringify(warnings)}`,
      );
      const [email] = await outbox();
      assert.match(email.subject, /stop cruzado: CAT/, "the position is still watched for risk");
      assert.match(email.subject, /lotes que no cuadran/);
      assert.match(email.body, /CAT.*Volume 1/);
    });

    it("the alerting path does not read the decision log: Volume is checked from portfolio.md alone (#52)", async () => {
      // A lot whose entry is not in the log, and a log that cannot be parsed at all: neither reaches the
      // heartbeat. The checks that need the log run where the log is read (decision:record, the evaluation).
      await setPortfolio(MSFT_ROW, [{ ...MSFT_LOT, id: "ghost-entry" }]);
      await writeFile(join(vaultDir, "logs", "decisions.jsonl"), "not json at all\n", "utf8");
      const warnings = await heartbeat();

      assert.deepEqual(
        warnings.filter((w) => w.includes("Lots")),
        [],
      );
      const [email] = await outbox();
      assert.match(email.subject, /stop ceñido: MSFT/);
      assert.doesNotMatch(email.subject, /lotes que no cuadran/);
    });

    it("a Volume that does not match is found by the lots' own Ticker column", async () => {
      // The row says MSFT 1, the lots say MSFT 1 and CAT 3 with no CAT row.
      await setPortfolio(MSFT_ROW, [MSFT_LOT, { ...CAT_LOT, units: 3 }]);
      const warnings = await heartbeat();
      assert.ok(
        warnings.some((w) => /CAT.*Volume 0.*3/.test(w)),
        `warnings: ${JSON.stringify(warnings)}`,
      );
    });

    it("the warning is not deduplicated: a second run the same day with the same mismatch repeats it", async () => {
      await setPortfolio(MSFT_ROW, [{ ...MSFT_LOT, units: 2 }]);
      await heartbeat();
      await heartbeat();

      const emails = await outbox();
      assert.equal(emails.length, 2, "a lots warning alone still produces a digest, every run");
      for (const email of emails) {
        assert.match(email.subject, /lotes que no cuadran/);
        assert.match(email.body, /MSFT.*Volume 1/);
      }
      assert.doesNotMatch(emails[1].subject, /stop ceñido/, "what is deduplicated still is");
    });

    describe("a Lots table that does not read", () => {
      const brokenHeader = async () => {
        await setPortfolio(`${MSFT_ROW}\n${CAT_ROW}`, [MSFT_LOT, CAT_LOT]);
        const path = join(vaultDir, "portfolio.md");
        const text = await readFile(path, "utf8");
        await writeFile(path, text.replace("| Entry units |", "| Entry unitz |"), "utf8");
      };

      it("does not stop the heartbeat: the crossed stop goes out with the lots warning naming file and section", async () => {
        await brokenHeader();
        const warnings = await heartbeat();

        assert.ok(
          warnings.some(
            (w) => w.includes("Lots do not match") && w.includes("portfolio.md") && w.includes("USD — Lots"),
          ),
          `warnings: ${JSON.stringify(warnings)}`,
        );
        const [email] = await outbox();
        assert.match(email.subject, /stop cruzado: CAT/);
        assert.match(email.subject, /lotes que no cuadran/);
        assert.match(email.body, /portfolio\.md: ## USD — Lots: columns Entry units missing/);
      });

      it("two consecutive runs with the same mismatch both include the warning", async () => {
        await brokenHeader();
        await heartbeat();
        await heartbeat();

        const emails = await outbox();
        assert.equal(emails.length, 2);
        for (const email of emails) assert.match(email.body, /Entry units missing/);
      });

      it("a Positions table that does not read still stops the run", async () => {
        await brokenHeader();
        const path = join(vaultDir, "portfolio.md");
        await writeFile(path, (await readFile(path, "utf8")).replace("| Volume |", "| Volumez |"), "utf8");
        await assert.rejects(heartbeat(), /Positions: columns Volume missing/);
      });
    });

    it("a consistent portfolio raises no warning and no lots section", async () => {
      const warnings = await heartbeat();
      assert.deepEqual(
        warnings.filter((w) => w.includes("Lots")),
        [],
      );
      assert.doesNotMatch((await outbox())[0].subject, /lotes/);
    });
  });

  it("a second run with the same state sends nothing (no crossed stops)", async () => {
    await heartbeat();
    await heartbeat();

    assert.equal((await outbox()).length, 1);
  });

  it("a crossed stop is repeated on every run, with only what is new", async () => {
    await setPortfolio(`${MSFT_ROW}\n${CAT_ROW}`, [MSFT_LOT, CAT_LOT]);
    await heartbeat();
    await heartbeat();

    const [, second] = await outbox();
    assert.ok(second, "the second run sends");
    assert.equal(second.subject, "[Finance Agent] Heartbeat USD — stop cruzado: CAT");
  });

  it("on a holiday only the crossed stop goes out: there is no new price to review", async () => {
    await setPortfolio(`${MSFT_ROW}\n${CAT_ROW}`, [MSFT_LOT, CAT_LOT]);
    await heartbeat({ lastMarketDate: async () => new Date(Date.now() - 72 * 3_600_000) });

    const emails = await outbox();
    assert.equal(emails.length, 1);
    assert.equal(emails[0].subject, "[Finance Agent] Heartbeat USD — stop cruzado: CAT");
    assert.deepEqual(escalated, [], "no escalation on a holiday");
  });

  it("if the run fails halfway, the crossed stop goes out anyway and the run ends in error", async () => {
    await setPortfolio(`${MSFT_ROW}\n${CAT_ROW}`, [MSFT_LOT, CAT_LOT]);
    const failing: IAnalystProvider = {
      escalate: async () => {
        throw new Error("reasoner down");
      },
    };

    await assert.rejects(heartbeat({ analyst: failing }), /reasoner down/);
    const emails = await outbox();
    assert.equal(emails.length, 1);
    assert.match(emails[0].subject, /stop cruzado: CAT/);
  });

  it("what was sent another day does not silence today's alerts, and does not accumulate", async () => {
    await writeFile(
      join(vaultDir, "logs", "heartbeat-sent-usd.json"),
      JSON.stringify({ date: "2026-01-02", keys: ["tight_stop|MSFT|500", "viejo"] }),
      "utf8",
    );
    await heartbeat();

    assert.equal((await outbox()).length, 1);
    const state = JSON.parse(await readFile(join(vaultDir, "logs", "heartbeat-sent-usd.json"), "utf8"));
    assert.equal(state.date, new Date().toISOString().slice(0, 10));
    assert.ok(!state.keys.includes("viejo"));
  });

  it("if the email does not go out, it is not marked as sent", async () => {
    process.env.MAIL_TRANSPORT = "smtp"; // no credentials: "logs only" mode, sendSummaryEmail returns false
    await heartbeat();

    await assert.rejects(readFile(join(vaultDir, "logs", "heartbeat-sent-usd.json"), "utf8"), { code: "ENOENT" });
  });
});
