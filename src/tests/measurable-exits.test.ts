/**
 * The five R tests of spec #27 (measurable exits: partial sales and scale-ins), written
 * against the public flow so they survive the redesign: the owner's trades go in through
 * `decision:record` (`recordOwnerDecision`), `portfolio.md` lives in a temporary vault, and the
 * results come from the evaluation report (`loadEvaluationReport`, the one behind
 * `decisions:evaluate`). No test references a type or a function of the redesign.
 *
 * Test 1 is today's behaviour and passes. Tests 2-5 describe the behaviour of the redesign
 * (ADR-0015) and are `todo` until it lands: #40 and #42 turn 2-4 green, #43 turns 5 green.
 *
 * Common scenario: ticker TCK in USD, every entry and exit narrated with origin `sistema` and
 * rules version 1.0, so the trades count for the cutoff (C v1). One R of a lot is
 * `(exit price − entry price) / (entry price − initial stop)`; there are no costs.
 */
import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { EvaluationReport } from "../utils/decisions-evaluation.js";

/** The clock of every scenario: the Monday after the last bar. */
const NOW = new Date("2026-10-19T12:00:00Z");
const TODAY = "2026-10-19";
const TOLERANCE = 1e-9;

const WATCHLIST_MD = `---
schema_version: 1
---

# Watchlist

\`\`\`yaml
watchlist:
  - ticker: TCK
    name: Test company
    market: NASDAQ
    currency: USD
    horizon: medium
    thesis: "Test thesis."
\`\`\`
`;

/**
 * `portfolio.md` in the v2 shape of ADR-0015: the `Positions` table of today plus a
 * `## <CCY> — Lots` table per currency. The Lots column names are a proposal that #41 adopts or
 * changes (and #41 decides whether the frontmatter schema_version changes); only this builder and
 * `parseLots` know them.
 */
const LOTS_HEADER = [
  "Entry id",
  "Date",
  "Units",
  "Entry units",
  "Entry price",
  "Initial stop",
  "Entry costs",
  "Origin",
  "Rules version",
];

function portfolioMd(opts: { positions?: string[]; lots?: string[] } = {}): string {
  const table = (header: string[], rows: string[]) =>
    [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`, ...rows].join("\n");
  const section = (currency: string, positions: string[], lots: string[]) => `
## ${currency} — Cash

| Item | Value |
|---|---|
| Available cash | ${currency === "USD" ? "$" : ""}10000.00 |

## ${currency} — Positions

${table(["Ticker", "Volume", "Avg price", "Current price", "P/L", "Stop loss"], positions)}

## ${currency} — Lots

${table(LOTS_HEADER, lots)}
`;
  return `---
schema_version: 1
last_manual_sync: 2026-10-16T18:00:00Z
account_env: demo
---

# Portfolio (test)
${section("EUR", [], [])}${section("USD", opts.positions ?? [], opts.lots ?? [])}`;
}

/** Flat series: close 100, daily range 98-102, one bar per working day. */
function bars(from: string, to: string, close: number): object[] {
  const out: object[] = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += 86_400_000) {
    const day = new Date(t).getUTCDay();
    if (day === 0 || day === 6) continue;
    out.push({
      date: new Date(t).toISOString().slice(0, 10),
      close,
      high: close + 2,
      low: close - 2,
      volume: 1_000_000,
    });
  }
  return out;
}

/** Rows of the `## USD — Lots` table, keyed by its column names. */
function parseLots(md: string): Record<string, string>[] {
  const section = md.split(/^## USD — Lots$/m)[1]?.split(/^## /m)[0] ?? "";
  const rows = section
    .split("\n")
    .filter((l) => l.trim().startsWith("|"))
    .map((l) =>
      l
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => c.trim()),
    )
    .filter((cells) => !cells.every((c) => /^-+$/.test(c)));
  const [header, ...data] = rows;
  return data.map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i]])));
}

function positionRow(md: string, ticker: string): string[] | undefined {
  const section = md.split(/^## USD — Positions$/m)[1]?.split(/^## /m)[0] ?? "";
  return section
    .split("\n")
    .filter((l) => l.trim().startsWith("|") && l.includes(ticker))
    .map((l) =>
      l
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => c.trim()),
    )[0];
}

describe("measurable exits: the five R tests of spec #27", () => {
  let root: string;
  let vaultDir: string;
  let archiveDir: string;
  let record: (raw: unknown) => Promise<{ id: string; type: string; related_id?: string }>;
  let loadEvaluationReport: (tag: string, now?: Date) => Promise<EvaluationReport>;
  let renderDecisionsEvaluation: (report: EvaluationReport) => string;
  let extractCutBoard: (md: string) => string | null;

  const decisionsPath = () => join(vaultDir, "logs", "decisions.jsonl");
  const readLog = async (): Promise<Record<string, unknown>[]> =>
    (await readFile(decisionsPath(), "utf8").catch(() => ""))
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l));
  const evaluate = () => loadEvaluationReport("[test]", NOW);

  const entry = (price: number, units: number, stop: number, date: string) =>
    record({ type: "entry", ticker: "TCK", currency: "USD", price, units, stop, date, origin: "sistema" });
  const exit = (price: number, units: number, date: string) =>
    record({ type: "exit", ticker: "TCK", currency: "USD", price, units, date, origin: "sistema" });

  /** R of every closed trade, ascending: one value per trade, the way the evaluation reports them. */
  const tradeRs = (report: EvaluationReport): number[] => report.trades.map((t) => t.rNet!).sort((a, b) => a - b);
  const assertRs = (actual: number[], expected: number[]) => {
    assert.equal(actual.length, expected.length, `expected ${expected.length} trade(s), got ${JSON.stringify(actual)}`);
    expected.forEach((r, i) => assert.ok(Math.abs(actual[i] - r) < TOLERANCE, `R ${actual[i]} !== ${r}`));
  };

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "finance-agent-measurable-exits-"));
    vaultDir = join(root, "brain");
    archiveDir = join(root, "archive");
    const market = join(root, "market");
    await mkdir(market, { recursive: true });
    for (const [ticker, close] of [
      ["TCK", 100],
      ["VOO", 400],
      ["EXSA.DE", 50],
    ] as const) {
      await writeFile(join(market, `${ticker}.json`), JSON.stringify(bars("2025-12-01", "2026-10-16", close)), "utf8");
    }
    Object.assign(process.env, {
      VAULT_PROJECT_DIR: vaultDir,
      DECISIONS_ARCHIVE_DIR: archiveDir,
      MARKET_DATA_PROVIDER: "fixtures",
      MARKET_FIXTURES_DIR: market,
    });
    mock.method(console, "log", () => {});
    mock.method(console, "warn", () => {});

    const { recordOwnerDecision } = await import("../decision.js");
    const { FixturesProvider } = await import("../providers/fixtures.js");
    const provider = new FixturesProvider(market);
    record = (raw) => recordOwnerDecision(raw, provider, TODAY);
    ({ loadEvaluationReport } = await import("../decisions-evaluation-run.js"));
    ({ renderDecisionsEvaluation, extractCutBoard } = await import("../utils/decisions-evaluation-render.js"));
  });

  after(async () => {
    mock.restoreAll();
    await rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await rm(join(vaultDir, "logs"), { recursive: true, force: true });
    await rm(archiveDir, { recursive: true, force: true });
    await mkdir(join(vaultDir, "logs"), { recursive: true });
    await mkdir(join(vaultDir, "strategies"), { recursive: true });
    await mkdir(archiveDir, { recursive: true });
    await writeFile(join(vaultDir, "strategies", "base.md"), `---\nversion: "1.0"\n---\n`, "utf8");
    await writeFile(join(vaultDir, "watchlist.md"), WATCHLIST_MD, "utf8");
    await writeFile(join(vaultDir, "portfolio.md"), portfolioMd(), "utf8");
  });

  it("R1: one entry and one exit give R = (exit − entry) / (entry − stop), as today", async () => {
    // Buy 10 at 100 with the stop at 90 (1R = 10); sell all 10 at 120: R = (120 − 100) / 10 = +2.
    await entry(100, 10, 90, "2026-06-15");
    await exit(120, 10, "2026-08-10");

    const report = await evaluate();
    assertRs(tradeRs(report), [2]);
    assert.equal(report.board.trades.total, 1);
    assert.equal(report.board.trades.withR, 1);
    assert.ok(Math.abs(report.board.trades.expectancy! - 2) < TOLERANCE);
  });

  it(
    "R2: two partial exits of one entry count as one trade, R = Σ(unitsᵢ / entry_units) × Rᵢ",
    { todo: "needs the exit snapshot of ADR-0015 (#40 and #42)" },
    async () => {
      // Buy 10 at 100, stop 90 (1R = 10). Sell 4 at 120 (R = +2) and the other 6 at 105 (R = +0.5).
      // One trade: R = 4/10 × 2 + 6/10 × 0.5 = 0.8 + 0.3 = +1.1.
      await entry(100, 10, 90, "2026-06-15");
      await exit(120, 4, "2026-08-10");
      await exit(105, 6, "2026-08-17");

      const report = await evaluate();
      assertRs(tradeRs(report), [1.1]);
      assert.equal(report.board.trades.total, 1);
      assert.ok(Math.abs(report.board.trades.expectancy! - 1.1) < TOLERANCE);
    },
  );

  it(
    "R3: two entries and sales that span both lots are matched first in, first out, one R per lot",
    { todo: "needs lots and FIFO matching (#40, #42 and #43)" },
    async () => {
      // Lot A: buy 10 at 100, stop 90 (1R = 10). Lot B: buy 10 at 110, stop 100 (1R = 10).
      // Sale 1: 15 at 130 takes all of A (R = (130 − 100) / 10 = +3) and 5 of B (R = (130 − 110) / 10 = +2).
      // Sale 2: the last 5 of B at 120 (R = (120 − 110) / 10 = +1).
      // Trade A: R = +3. Trade B: R = 5/10 × 2 + 5/10 × 1 = +1.5. (Last in, first out would give 2 and 2.5.)
      await entry(100, 10, 90, "2026-06-15");
      await entry(110, 10, 100, "2026-06-22");
      await exit(130, 15, "2026-08-10");
      await exit(120, 5, "2026-08-17");

      const report = await evaluate();
      assertRs(tradeRs(report), [1.5, 3]);
      assert.equal(report.board.trades.total, 2);
      assert.ok(Math.abs(report.board.trades.expectancy! - 2.25) < TOLERANCE);
    },
  );

  it(
    "R4: archiving any quarter, even one that separates an entry from a later exit, leaves the decisions:evaluate output unchanged",
    { todo: "needs self-contained exits (#40 and #42)" },
    async () => {
      // The deposit is in 2026-T1, the entry in 2026-T2 and the exit in 2026-T3. The same trade is
      // narrated without archiving and then archiving one quarter before the exit is recorded
      // (`decision:record` reads only the live log). Archiving T2 separates the entry from its exit.
      const archiveBeforeExit = async (quarter: "T1" | "T2", from: string, to: string) => {
        const archived: string[] = [];
        const live: string[] = [];
        for (const line of (await readFile(decisionsPath(), "utf8")).split("\n").filter((l) => l !== "")) {
          const date = (JSON.parse(line) as { date: string }).date;
          (date >= from && date <= to ? archived : live).push(line);
        }
        await writeFile(join(archiveDir, `decisions-2026-${quarter}.jsonl`), archived.join("\n") + "\n", "utf8");
        await writeFile(decisionsPath(), live.length > 0 ? live.join("\n") + "\n" : "", "utf8");
      };
      const scenario = async (archive?: [quarter: "T1" | "T2", from: string, to: string]): Promise<string> => {
        await rm(join(vaultDir, "logs"), { recursive: true, force: true });
        await rm(archiveDir, { recursive: true, force: true });
        await mkdir(join(vaultDir, "logs"), { recursive: true });
        await mkdir(archiveDir, { recursive: true });
        await writeFile(join(vaultDir, "portfolio.md"), portfolioMd(), "utf8");

        await record({ type: "deposit", currency: "USD", amount: 5000, date: "2026-02-02" });
        await entry(100, 10, 90, "2026-06-15");
        if (archive) await archiveBeforeExit(...archive);
        await exit(120, 10, "2026-08-10");
        return renderDecisionsEvaluation(await evaluate());
      };

      const unarchived = await scenario();
      for (const quarter of [
        ["T1", "2026-01-01", "2026-03-31"],
        ["T2", "2026-04-01", "2026-06-30"],
      ] as const) {
        const archived = await scenario([...quarter]);
        // The cut board first, so a failure shows the numbers that moved instead of the whole report.
        assert.equal(extractCutBoard(archived), extractCutBoard(unarchived), `archiving 2026-${quarter[0]}`);
        assert.equal(archived, unarchived, `archiving 2026-${quarter[0]}`);
      }
    },
  );

  it(
    "R5: a sale that spans two lots writes two exit lines and keeps Lots, Volume and Avg price consistent",
    { todo: "needs the lots written by decision:record (#43)" },
    async () => {
      // Two entries add two lots: 10 at 100 and 10 at 110 (Volume 20, Avg price 105).
      const first = await entry(100, 10, 90, "2026-06-15");
      const second = await entry(110, 10, 100, "2026-06-22");
      let md = await readFile(join(vaultDir, "portfolio.md"), "utf8");
      assert.deepEqual(
        parseLots(md).map((l) => [l["Entry id"], l.Units]),
        [
          [first.id, "10"],
          [second.id, "10"],
        ],
      );
      assert.deepEqual(positionRow(md, "TCK")?.slice(0, 3), ["TCK", "20", "105.00"]);

      // One sale of 15 consumes lot 1 (10 units) and 5 units of lot 2.
      await exit(130, 15, "2026-08-10");

      const exits = (await readLog()).filter((d) => d.type === "exit");
      assert.equal(exits.length, 2, "one exit line per lot consumed");
      md = await readFile(join(vaultDir, "portfolio.md"), "utf8");
      // Lot 1 is gone, lot 2 keeps 5 of its 10 units: Volume 5, Avg price 110.
      assert.deepEqual(
        parseLots(md).map((l) => [l["Entry id"], l.Units, l["Entry units"]]),
        [[second.id, "5", "10"]],
      );
      assert.deepEqual(positionRow(md, "TCK")?.slice(0, 3), ["TCK", "5", "110.00"]);
      assertRs(tradeRs(await evaluate()), [3]);
      // Test 5's other half: a Volume that is not the sum of the lots' units fails on read.
      await writeFile(join(vaultDir, "portfolio.md"), md.replace(/\| TCK \| 5 \|/, "| TCK | 7 |"), "utf8");
      await assert.rejects(entry(100, 1, 90, "2026-09-01"), /Volume/);
      await assert.rejects(evaluate(), /Volume/);
    },
  );
});
