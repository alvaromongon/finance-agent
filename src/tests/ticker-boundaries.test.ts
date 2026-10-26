/**
 * Every boundary that reads a ticker parses it (#78, ADR-0016): a value written in lower case reads as its
 * upper-case value, and a value that does not parse is refused by `decision:record` and
 * `decisions:evaluate` only; every other reader skips that row or entry, warns, and the rest keeps working.
 * One test per boundary, so that if a boundary stopped parsing, a test fails. Temporary vault, no network.
 */
import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lotsSection } from "./fixtures/lots.js";

const WATCHLIST_MD = `---
schema_version: 1
---

\`\`\`yaml
watchlist:
  - ticker: aapl
    name: Apple
    market: NASDAQ
    currency: USD
    horizon: medium
    thesis: "t"
  - ticker: "M&M.NS"
    name: Mahindra
    market: NSE
    currency: EUR
    horizon: medium
    thesis: "t"
\`\`\`
`;

const portfolioMd = (positions: string[]) => `---
schema_version: 2
last_manual_sync: 2026-09-10T18:00:00Z
account_env: demo
---

## USD — Cash

| Item | Value |
|---|---|
| Available cash | 1000.00 |

## USD — Positions

| Ticker | Volume | Avg price | Current price | P/L | Stop loss |
|---|---|---|---|---|---|
${positions.join("\n")}

${lotsSection("USD")}`;

const UNIVERSE_MD = `---
schema_version: 1
next_review: 2099-01-01
---

\`\`\`yaml
universe:
  eur:
    - ticker: asml.as
      name: ASML
      market: Euronext
      currency: EUR
    - ticker: "M&M.NS"
      name: Mahindra
      market: NSE
      currency: EUR
  usd:
    - ticker: nvda
      name: NVIDIA
      market: NASDAQ
      currency: USD
  note: just a scalar
  extra:
    - not a pool
\`\`\`
`;

const SCREENING_LOG_MD = `---
schema_version: 1
---

| Ticker | Name | Index | Date | Result | Summary | Next review |
|---|---|---|---|---|---|---|
| aapl | Apple | S&P 500 | 2026-06-28 | not_interesting | High P/E | 2026-08-28 |
| M&M.NS | Mahindra | NSE | 2026-06-21 | not_interesting | old row | 2026-08-21 |
`;

const pendingMd = (ticker: string) => `---
id: x
ticker: ${ticker}
currency: USD
price: 10
triggers: [big_move]
benchmark_ticker: voo
benchmark_price: 600
---

body
`;

const candidateMd = (ticker: string) => `---
ticker: ${ticker}
name: Tick
market: NASDAQ
currency: USD
asset_class: equity
price: 10
benchmark_ticker: voo
benchmark_price: 600
---

body
`;

const decisionLine = (over: Record<string, unknown>) =>
  JSON.stringify({
    id: "d1",
    date: "2026-06-15",
    ticker: "tck",
    currency: "USD",
    origin: "sistema",
    source: "portfolio-sync",
    type: "entry",
    price: 10,
    amount: 20,
    rules_version: "1.0",
    ...over,
  });

describe("tickers at every boundary", () => {
  let vaultDir: string;
  let vaultIo: typeof import("../vault-io.js");
  let weekly: typeof import("../weekly-screening.js");
  const path = (...parts: string[]) => join(vaultDir, ...parts);
  const warnings: string[] = [];

  before(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "finance-agent-ticker-boundaries-"));
    process.env.VAULT_PROJECT_DIR = vaultDir;
    vaultIo = await import("../vault-io.js");
    weekly = await import("../weekly-screening.js");
  });

  after(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await rm(path("logs"), { recursive: true, force: true });
    await mkdir(path("logs", "pending"), { recursive: true });
    await mkdir(path("logs", "pending-screening"), { recursive: true });
    await writeFile(path("watchlist.md"), WATCHLIST_MD, "utf8");
    await writeFile(path("screening-universe.md"), UNIVERSE_MD, "utf8");
    await writeFile(path("screening-log.md"), SCREENING_LOG_MD, "utf8");
    warnings.length = 0;
    mock.method(console, "warn", (m: unknown) => warnings.push(String(m)));
  });

  const quiet = () => mock.restoreAll();

  describe("a value that does not parse: skipped by the readers that carry on, refused by the two that refuse", () => {
    it("the watchlist: skipped with a warning naming the entry; the strict reader throws", async () => {
      const entries = await vaultIo.readWatchlistSkippingBadTickers("EUR");
      assert.deepEqual(entries, []);
      assert.ok(warnings.some((w) => w.includes("watchlist.md: entry 2") && w.includes("skipped")));
      assert.deepEqual(
        (await vaultIo.readWatchlistSkippingBadTickers("USD")).map((e) => e.ticker),
        ["AAPL"],
      );
      assert.deepEqual(await vaultIo.readAllWatchlistTickers(), ["AAPL"]);
      quiet();
      await assert.rejects(() => vaultIo.readWatchlist("USD"), /watchlist\.md: entry 2/);
    });

    it("Positions: the readers that carry on skip the row and keep the others; the strict reader throws", async () => {
      await writeFile(
        path("portfolio.md"),
        portfolioMd(["| aapl | 2 | 10 | 10 | 0 | 8 |", "| M&M.NS | 1 | 5 | 5 | 0 | 4 |"]),
        "utf8",
      );

      const { portfolio, skippedRows } = await vaultIo.readPortfolioTolerantOfLots("USD");
      assert.deepEqual(
        portfolio.positions.map((p) => p.ticker),
        ["AAPL"],
      );
      assert.equal(skippedRows.length, 1);
      assert.match(skippedRows[0], /## USD — Positions: Ticker "M&M\.NS"/);

      const ignoring = await vaultIo.readPortfolioIgnoringLots("USD");
      assert.deepEqual(
        ignoring.positions.map((p) => p.ticker),
        ["AAPL"],
      );
      assert.ok(warnings.some((w) => w.includes("M&M.NS")));
      quiet();
      await assert.rejects(() => vaultIo.readPortfolio("USD"), /## USD — Positions: Ticker "M&M\.NS"/);
    });

    it("the screening universe: the entry is skipped with a warning, the known pools are read, other keys are ignored", async () => {
      const universe = await weekly.readUniverse();
      assert.deepEqual(
        universe.eur.map((t) => t.ticker),
        ["ASML.AS"],
      );
      assert.deepEqual(
        universe.usd.map((t) => t.ticker),
        ["NVDA"],
      );
      assert.deepEqual(universe.commodities, []);
      assert.ok(warnings.some((w) => w.includes("screening-universe.md: eur entry 2")));
      assert.deepEqual(Object.keys(universe).sort(), ["commodities", "eur", "usd"]);
    });

    it("the screening log: a historic row is skipped with a warning, the others are read", async () => {
      const rows = await vaultIo.readScreeningLog();
      assert.deepEqual(
        rows.map((r) => r.ticker),
        ["AAPL"],
      );
      assert.ok(warnings.some((w) => w.includes("screening-log.md") && w.includes("M&M.NS")));
    });

    it("the removal list: a token that is not a ticker is reported, not dropped silently", async () => {
      const { extractRetireList } = await import("../utils/vault-parser.js");
      assert.deepEqual(extractRetireList("## AUTOMATED_ACTIONS\nRETIRE: hal, TCK (thesis broken), sgo.pa, "), [
        "HAL",
        "SGO.PA",
      ]);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /RETIRE: "TCK \(thesis broken\)" is not a ticker and was not retired/);
    });

    it("a pending signal and a screening candidate with a ticker that does not parse are refused", async () => {
      await writeFile(path("logs", "pending", "2026-07-15-bad.md"), pendingMd('"T;K"'), "utf8");
      await writeFile(path("logs", "pending-screening", "2026-07-15-bad.md"), candidateMd('"T;K"'), "utf8");
      await assert.rejects(() => vaultIo.readPendingSignal("2026-07-15-bad.md"), /ticker: a ticker has letters/);
      await assert.rejects(() => vaultIo.readScreeningCandidate("2026-07-15-bad.md"), /ticker: a ticker has letters/);
    });

    it("a decision-log line: a benchmark that does not parse is dropped with a warning, the line stays", async () => {
      await writeFile(
        path("logs", "decisions.jsonl"),
        decisionLine({ benchmark: { ticker: "M&M.NS", price: 10 } }) + "\n",
        "utf8",
      );
      const [decision] = await vaultIo.readDecisions();
      assert.equal(decision.ticker, "TCK");
      assert.equal(decision.benchmark, undefined);
      assert.ok(warnings.some((w) => w.includes("benchmark dropped")));
    });
  });

  describe("a value written in lower case reads as its upper-case value", () => {
    it("the screening universe and the screening log", async () => {
      const universe = await weekly.readUniverse();
      assert.equal(universe.eur[0].ticker, "ASML.AS");
      assert.equal((await vaultIo.readScreeningLog())[0].ticker, "AAPL");
      quiet();
    });

    it("a pending signal and a screening candidate, with their benchmark", async () => {
      await writeFile(path("logs", "pending", "2026-07-15-ok.md"), pendingMd("tck"), "utf8");
      await writeFile(path("logs", "pending-screening", "2026-07-15-ok.md"), candidateMd("tck"), "utf8");
      const { meta: signal } = await vaultIo.readPendingSignal("2026-07-15-ok.md");
      const { meta: candidate } = await vaultIo.readScreeningCandidate("2026-07-15-ok.md");
      assert.equal(signal.ticker, "TCK");
      assert.equal(signal.benchmark?.ticker, "VOO");
      assert.equal(candidate.ticker, "TCK");
      assert.equal(candidate.benchmark?.ticker, "VOO");
      quiet();
    });

    it("the archived decision log", async () => {
      const archive = await mkdtemp(join(tmpdir(), "finance-agent-archive-"));
      try {
        await writeFile(join(archive, "decisions-2026-Q2.jsonl"), decisionLine({ id: "old" }) + "\n", "utf8");
        const history = await vaultIo.readDecisionHistory(archive);
        assert.deepEqual(
          history.map((d) => [d.id, d.ticker]),
          [["old", "TCK"]],
        );
      } finally {
        await rm(archive, { recursive: true, force: true });
      }
      quiet();
    });

    it("REFERENCE_TICKER_*: parsed on use, refused when it is not a ticker", async () => {
      const { config } = await import("../config.js");
      const saved = [process.env.REFERENCE_TICKER_EUR, process.env.REFERENCE_TICKER_USD];
      try {
        process.env.REFERENCE_TICKER_EUR = " exsa.de ";
        process.env.REFERENCE_TICKER_USD = "V;OO";
        assert.equal(config.reference.EUR, "EXSA.DE");
        assert.throws(() => config.reference.USD, /REFERENCE_TICKER_USD: a ticker has letters/);
      } finally {
        if (saved[0] === undefined) delete process.env.REFERENCE_TICKER_EUR;
        else process.env.REFERENCE_TICKER_EUR = saved[0];
        if (saved[1] === undefined) delete process.env.REFERENCE_TICKER_USD;
        else process.env.REFERENCE_TICKER_USD = saved[1];
      }
      quiet();
    });

    it("analyze --ticker", async () => {
      const { parseAnalyzeArgs } = await import("../utils/analyze-args.js");
      assert.deepEqual(parseAnalyzeArgs(["--ticker", " exsa.de ", "--range", "2y"]), {
        ticker: "EXSA.DE",
        range: "2y",
      });
      assert.throws(() => parseAnalyzeArgs(["--ticker", "T;K"]), /--ticker: a ticker has letters/);
      assert.throws(() => parseAnalyzeArgs([]), /Usage/);
      quiet();
    });
  });
});
