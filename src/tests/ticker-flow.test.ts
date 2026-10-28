/**
 * A ticker is one parsed value (#78): wherever the engine reads one, it parses it, so a ticker written in
 * another case reads as its upper-case value and is compared with `===`. Temporary vault, fake provider,
 * no network. VAULT_PROJECT_DIR is set before the first import of the engine.
 */
import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Decision } from "../decisions.js";
import type { HistoricalBar } from "../providers/types.js";
import { entryLines, lotsSection, type HeldLot } from "./fixtures/lots.js";

const TODAY = "2026-09-14";

const WATCHLIST_MD = `---
schema_version: 1
---

# Watchlist

\`\`\`yaml
watchlist:
  - ticker: tck
    name: Tick
    market: NASDAQ
    currency: USD
    horizon: medium
    thesis: "Lower case on purpose."
\`\`\`
`;

/** A portfolio whose USD silo holds `TCK` (or whatever `positions` says) with the given lots. */
function portfolioMd(positions: string[], held: HeldLot[]): string {
  return `---
schema_version: 2
last_manual_sync: 2026-09-10T18:00:00Z
account_env: demo
---

## EUR — Cash

| Item | Value |
|---|---|
| Available cash | 1000.00 |

## EUR — Positions

| Ticker | Volume | Avg price | Current price | P/L | Stop loss |
|---|---|---|---|---|---|

${lotsSection("EUR")}
## USD — Cash

| Item | Value |
|---|---|
| Available cash | 1000.00 |

## USD — Positions

| Ticker | Volume | Avg price | Current price | P/L | Stop loss |
|---|---|---|---|---|---|
${positions.join("\n")}

${lotsSection("USD", held)}`;
}

/** 30 sessions up to 12-Sep with a daily range of 20: ATR14 = 20. */
function bars(): HistoricalBar[] {
  return Array.from({ length: 30 }, (_, i) => {
    const date = new Date(Date.UTC(2026, 7, 14 + i)).toISOString().slice(0, 10);
    return { date, close: 100 + i, high: 100 + i + 10, low: 100 + i - 10 };
  });
}

const fakeProvider = {
  getPrices: async (tickers: string[]) => new Map(tickers.map((t) => [t, 700])),
  getHistorical: async () => bars(),
};

describe("a ticker written in another case is the same ticker", () => {
  let vaultDir: string;
  let recordOwnerDecision: (raw: unknown, provider?: typeof fakeProvider, today?: string) => Promise<Decision[]>;
  let vaultIo: typeof import("../vault-io.js");
  let lotsMismatches: typeof import("../utils/lots-check.js").lotsMismatches;

  const path = (...parts: string[]) => join(vaultDir, ...parts);
  const read = (...parts: string[]) => readFile(path(...parts), "utf8");
  const record = (raw: unknown) => recordOwnerDecision(raw, fakeProvider, TODAY);
  const TCK_LOT: HeldLot = { ticker: "TCK", units: 2, price: 100, stop: 80 };
  const TCK_ROW = "| TCK | 2 | 100 | 100 | 0 | 80 |";

  const setUp = async (positions: string[], held: HeldLot[]) => {
    await writeFile(path("portfolio.md"), portfolioMd(positions, held), "utf8");
    await writeFile(path("logs", "decisions.jsonl"), entryLines("USD", held), "utf8");
  };

  before(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "finance-agent-ticker-flow-"));
    process.env.VAULT_PROJECT_DIR = vaultDir;
    ({ recordOwnerDecision } = await import("../decision.js"));
    vaultIo = await import("../vault-io.js");
    ({ lotsMismatches } = await import("../utils/lots-check.js"));
  });

  after(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await rm(path("logs"), { recursive: true, force: true });
    await mkdir(path("logs"), { recursive: true });
    await mkdir(path("strategies"), { recursive: true });
    await writeFile(path("strategies", "base.md"), `---\nversion: "0.2"\n---\n`, "utf8");
    await writeFile(path("watchlist.md"), WATCHLIST_MD, "utf8");
  });

  it("an entry on `tck` adds its lot to the existing TCK row, and the next decision:record is accepted", async () => {
    await setUp([TCK_ROW], [TCK_LOT]);

    const [entry] = await record({ type: "entry", ticker: "tck", currency: "USD", price: 110, units: 1, stop: 90 });
    assert.equal(entry.ticker, "TCK");

    const portfolio = await vaultIo.readPortfolio("USD");
    assert.deepEqual(
      portfolio.positions.map((p) => [p.ticker, p.volume]),
      [["TCK", 3]],
    );
    assert.deepEqual(
      portfolio.lots.map((l) => [l.ticker, l.units]),
      [
        ["TCK", 2],
        ["TCK", 1],
      ],
    );
    assert.equal((await read("portfolio.md")).match(/^\| TCK \|/gm)?.length, 1 + 2, "one Positions row, two lots");

    const [exit] = await record({ type: "exit", ticker: "Tck", currency: "USD", price: 120, units: 3 });
    assert.equal(exit.ticker, "TCK");
  });

  it("the Positions row written in lower case is found, and carries the canonical ticker once the engine edits it", async () => {
    await setUp(["| tck | 2 | 100 | 100 | 0 | 80 |"], [TCK_LOT]);

    await record({ type: "entry", ticker: "TCK", currency: "USD", price: 110, units: 1, stop: 90 });

    const text = await read("portfolio.md");
    assert.match(text, /^\| TCK \| 3 \|/m);
    assert.doesNotMatch(text, /^\| tck \|/m);
  });

  it("a Positions row the entry does not touch stays as the owner wrote it", async () => {
    await setUp([TCK_ROW, "| aapl | 5 | 10 | 10 | 0 | — |"], [TCK_LOT, { ticker: "AAPL", units: 5, price: 10 }]);

    await record({ type: "entry", ticker: "tck", currency: "USD", price: 110, units: 1, stop: 90 });

    assert.match(await read("portfolio.md"), /^\| aapl \| 5 \| 10 \| 10 \| 0 \| — \|$/m);
  });

  it("an invalid ticker is refused before anything is written", async () => {
    await setUp([TCK_ROW], [TCK_LOT]);
    const before = [await read("portfolio.md"), await read("logs", "decisions.jsonl")];
    const warn = mock.method(console, "warn", () => {});
    try {
      for (const ticker of ["TC|K", "TCK ; rm", "-", "^.-", ""]) {
        await assert.rejects(
          () => record({ type: "entry", ticker, currency: "USD", price: 110, units: 1, stop: 90 }),
          /ticker: a ticker/,
        );
      }
    } finally {
      warn.mock.restore();
    }
    assert.deepEqual([await read("portfolio.md"), await read("logs", "decisions.jsonl")], before);
  });

  it("a hand-written lot on `tck` matches the TCK entry of the decision log, with no message", async () => {
    const text = portfolioMd(["| tck | 2 | 100 | 100 | 0 | 80 |"], [{ ...TCK_LOT, ticker: "tck" }]);
    await writeFile(path("portfolio.md"), text, "utf8");
    await writeFile(path("logs", "decisions.jsonl"), entryLines("USD", [TCK_LOT]), "utf8");

    const portfolio = await vaultIo.readPortfolio("USD");
    const history = await vaultIo.readDecisionHistory();

    assert.equal(portfolio.lots[0].ticker, "TCK");
    assert.deepEqual(lotsMismatches(portfolio, history), []);
  });

  it("a decision-log line written in lower case reads as its upper-case value, and the file is left as it is", async () => {
    const line = entryLines("USD", [{ ...TCK_LOT, ticker: "tck", id: "lot-tck" }]);
    await writeFile(path("logs", "decisions.jsonl"), line, "utf8");

    const [decision] = await vaultIo.readDecisions();

    assert.equal(decision.ticker, "TCK");
    assert.equal(await read("logs", "decisions.jsonl"), line);
  });

  it("a watchlist entry written in lower case reads as its upper-case value", async () => {
    const [entry] = await vaultIo.readWatchlist("USD");
    assert.equal(entry.ticker, "TCK");
  });

  it("a watchlist entry that is not a ticker is refused, naming the file", async () => {
    await writeFile(path("watchlist.md"), WATCHLIST_MD.replace("ticker: tck", 'ticker: "TC|K"'), "utf8");
    await assert.rejects(() => vaultIo.readWatchlist("USD"), /watchlist\.md: entry 1: a ticker has letters/);
  });

  it("a Positions row that is not a ticker is refused, naming the section", async () => {
    await writeFile(path("portfolio.md"), portfolioMd(["| TC;K | 2 | 100 | 100 | 0 | 80 |"], []), "utf8");
    await assert.rejects(() => vaultIo.readPortfolio("USD"), /## USD — Positions: Ticker "TC;K"/);
  });

  it("a Positions row with two dots in a row or a leading dot is refused like any other non-ticker", async () => {
    for (const bad of ["A..B", ".A"]) {
      await writeFile(path("portfolio.md"), portfolioMd([`| ${bad} | 2 | 100 | 100 | 0 | 80 |`], []), "utf8");
      await assert.rejects(
        () => vaultIo.readPortfolio("USD"),
        (error: Error) => {
          assert.ok(error.message.includes(`## USD — Positions: Ticker "${bad}"`), error.message);
          assert.match(error.message, /two dots in a row|start with a dot/);
          return true;
        },
      );
    }
  });

  it("decision:record refuses a Positions row or a watchlist entry that is not a ticker, writing nothing", async () => {
    await setUp([TCK_ROW, "| M&M.NS | 1 | 5 | 5 | 0 | 4 |"], [TCK_LOT]);
    const entry = { type: "entry", ticker: "tck", currency: "USD", price: 110, units: 1, stop: 90 };
    await assert.rejects(() => record(entry), /## USD — Positions: Ticker "M&M\.NS"/);

    await setUp([TCK_ROW], [TCK_LOT]);
    await writeFile(path("watchlist.md"), WATCHLIST_MD.replace("ticker: tck", 'ticker: "M&M.NS"'), "utf8");
    await assert.rejects(() => record(entry), /watchlist\.md: entry 1/);
    assert.equal((await read("portfolio.md")).includes("| TCK | 3 |"), false, "nothing was recorded");
  });

  it("decisions:evaluate reads Positions strictly: a row that is not a ticker is refused", async () => {
    await setUp([TCK_ROW, "| M&M.NS | 1 | 5 | 5 | 0 | 4 |"], [TCK_LOT]);
    const { loadEvaluationReport } = await import("../decisions-evaluation-run.js");
    await assert.rejects(() => loadEvaluationReport("[test]"), /## USD — Positions: Ticker "M&M\.NS"/);
  });

  it("a Lots row that is not a ticker is skipped with its reason", async () => {
    await writeFile(path("portfolio.md"), portfolioMd([], [{ ticker: "TC;K", units: 1, price: 10 }]), "utf8");
    const portfolio = await vaultIo.readPortfolio("USD");
    assert.deepEqual(portfolio.lots, []);
    assert.match(portfolio.skippedLotRows?.[0]?.message ?? "", /Ticker "TC;K" does not read/);
  });

  it("the analyst's recommendation and the briefing's proposals read their tickers parsed", async () => {
    const { validateRecommendation } = await import("../claude-analyst.js");
    const { validateProposals } = await import("../utils/briefing-decisions.js");

    const hold = {
      ticker: " tck ",
      action: "HOLD",
      ticket: { direction: "HOLD", currency: "USD" },
      thesis_summary: "t",
      triggers: ["big_move"],
    };
    assert.equal(validateRecommendation(hold).ticker, "TCK");
    assert.throws(() => validateRecommendation({ ...hold, ticker: "T;K" }), /ticker: a ticker has letters/);

    const [proposal] = validateProposals([{ ticker: "tck", action: "SELL", conviction: "low" }]);
    assert.equal(proposal.ticker, "TCK");
    assert.throws(
      () =>
        validateProposals([
          { ticker: "tck", action: "SELL", conviction: "low" },
          { ticker: "TCK", action: "ADJUST_STOP", conviction: "low" },
        ]),
      /TCK appears twice/,
    );
  });

  it("the removal list of the briefing keeps the tickers and drops what is not one", async () => {
    const { extractRetireList } = await import("../utils/vault-parser.js");
    assert.deepEqual(extractRetireList("## AUTOMATED_ACTIONS\nRETIRE: hal, SGO.PA, T;K, "), ["HAL", "SGO.PA"]);
  });

  it("the files the engine writes are named as before, with and without dots, from a ticker in any case", async () => {
    const rec = {
      ticker: (await import("../ticker.js")).parseTicker("exsa.de"),
      action: "HOLD" as const,
      ticket: { direction: "HOLD" as const, currency: "EUR" as const },
      thesis_summary: "t",
      triggers: [],
    };
    await vaultIo.writeDecisionLog(rec, { price: 1 });
    const { readdir } = await import("node:fs/promises");
    const files = (await readdir(path("logs"))).filter((f) => f.endsWith(".md"));
    assert.equal(files.length, 1);
    assert.match(files[0], /^\d{4}-\d{2}-\d{2}-exsa\.de\.md$/);
  });
});
