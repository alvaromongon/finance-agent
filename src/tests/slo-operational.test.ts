/**
 * Operational SLO (ADR-0014): with every provider stubbed, a heartbeat over a
 * representative watchlist calls Claude at most once per escalated signal and
 * never on a quiet run (the re-analysis cooldown has its own tests), and its requests to the market data provider stay
 * bounded by the watchlist size, not by anything else.
 */
import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bar, uptrend } from "./fixtures/setup-bars.js";
import type { IMarketDataProvider, HistoricalBar } from "../providers/types.js";
import type { IAnalystProvider } from "../analyst/types.js";
import type { HeartbeatDeps } from "../heartbeat-run.js";
import { lotsSection } from "./fixtures/lots.js";

/** Watchlist size of the SLO, as stated in the README. */
const WATCHLIST_SIZE = 40;
const MOVERS = 3;
const BENCHMARK = "VOO";

const tickers = Array.from({ length: WATCHLIST_SIZE }, (_, i) => `T${String(i).padStart(2, "0")}`);
const movers = new Set(tickers.slice(0, MOVERS));

const watchlistMd = `---
schema_version: 1
---

# Watchlist

\`\`\`yaml
watchlist:
${tickers
  .map(
    (t) => `  - ticker: ${t}
    name: ${t}
    market: NYSE
    currency: USD
    horizon: medium
    thesis: "Synthetic."`,
  )
  .join("\n")}
\`\`\`
`;

const portfolioMd = `---
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

${lotsSection("USD")}`;

const flat: HistoricalBar[] = Array.from({ length: 250 }, (_, i) => bar(i, 100, { spread: 1 }));

function stubProvider(withMoves: boolean) {
  const calls = { getPrices: 0, getPreviousCloses: 0, getHistorical: 0 };
  const price = (t: string) => (t === BENCHMARK ? 800 : withMoves && movers.has(t) ? 112 : 100);
  const provider: IMarketDataProvider = {
    getPrices: async (ts) => {
      calls.getPrices++;
      return new Map(ts.map((t) => [t, price(t)]));
    },
    getPreviousCloses: async (ts) => {
      calls.getPreviousCloses++;
      return new Map(ts.map((t) => [t, t === BENCHMARK ? 800 : 100]));
    },
    getHistorical: async (t) => {
      calls.getHistorical++;
      return t === BENCHMARK ? uptrend(250, 600) : flat;
    },
  };
  return { provider, calls };
}

describe("operational SLO — Claude calls and provider requests per heartbeat", () => {
  let vaultDir: string;
  let runHeartbeat: (currency: "USD", deps: HeartbeatDeps) => Promise<void>;
  let claudeCalls: string[];
  const analyst: IAnalystProvider = {
    escalate: async (signal) => {
      claudeCalls.push(signal.ticker);
      return { status: "deferred", pendingPath: `logs/pending/${signal.ticker}.md` };
    },
  };

  before(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "finance-agent-slo-"));
    process.env.VAULT_PROJECT_DIR = vaultDir;
    ({ runHeartbeat } = await import("../heartbeat-run.js"));
  });

  after(async () => {
    delete process.env.MAIL_TRANSPORT;
    await rm(vaultDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    process.env.MAIL_TRANSPORT = "outbox";
    claudeCalls = [];
    await rm(join(vaultDir, "logs"), { recursive: true, force: true });
    await mkdir(join(vaultDir, "logs"), { recursive: true });
    await mkdir(join(vaultDir, "strategies"), { recursive: true });
    await writeFile(join(vaultDir, "strategies", "base.md"), `---\nversion: "1.0"\n---\n`, "utf8");
    await writeFile(join(vaultDir, "watchlist.md"), watchlistMd, "utf8");
    await writeFile(join(vaultDir, "portfolio.md"), portfolioMd, "utf8");
  });

  const heartbeat = async (provider: IMarketDataProvider) => {
    const silenced = (["log", "warn", "error"] as const).map((m) => mock.method(console, m, () => {}));
    try {
      await runHeartbeat("USD", { provider, analyst, headlines: async () => [] });
    } finally {
      silenced.forEach((s) => s.mock.restore());
    }
  };

  it(`a quiet run over ${WATCHLIST_SIZE} tickers makes no Claude call`, async () => {
    await heartbeat(stubProvider(false).provider);
    assert.deepEqual(claudeCalls, []);
  });

  it(`${MOVERS} signals among ${WATCHLIST_SIZE} tickers make exactly one Claude call each`, async () => {
    await heartbeat(stubProvider(true).provider);
    assert.deepEqual([...claudeCalls].sort(), [...movers].sort());
  });

  it("provider requests are bounded by the watchlist size", async () => {
    const { provider, calls } = stubProvider(true);
    await heartbeat(provider);
    assert.ok(calls.getPrices <= 2, `getPrices called ${calls.getPrices} times`);
    assert.ok(calls.getPreviousCloses <= 2, `getPreviousCloses called ${calls.getPreviousCloses} times`);
    // One year of history per candidate (setups), the silo benchmark, and the
    // technical strength of each escalated signal.
    assert.ok(
      calls.getHistorical <= WATCHLIST_SIZE + 1 + MOVERS,
      `getHistorical called ${calls.getHistorical} times for ${WATCHLIST_SIZE} tickers`,
    );
  });
});
