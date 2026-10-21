/**
 * The five R tests of spec #27 (measurable exits: partial sales and scale-ins), written
 * against the public flow so they survive the redesign: the owner's trades go in through
 * `decision:record` (`recordOwnerDecision`), `portfolio.md` lives in a temporary vault, and the
 * results come from the evaluation report (`loadEvaluationReport`, the one behind
 * `decisions:evaluate`). No test references a type or a function of the redesign.
 *
 * Tests 1, 2 and the "after" half of 4 pass since #40: the evaluation measures R from the exit
 * alone. Until `decision:record` writes the exit snapshot (#42) they record their exits with
 * `exitFromLot`, which appends an exit line carrying the snapshot of its lot, the way #42 will.
 * The rest describes the behaviour of the redesign (ADR-0015) and is `todo`: the "before" half of
 * 4 until #42, 3 until #42 and #43, 5 until #43. A `todo` test that starts passing fails the file,
 * so its mark gets removed in the same PR.
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
import type { Decision } from "../decisions.js";
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
 * `portfolio.md` in the v2 shape of ADR-0015 (#41): the `Positions` table plus a `## <CCY> — Lots`
 * table per currency, `schema_version: 2`. Lots are read back with the engine's own parser (the
 * helpers below), so this builder is the only place that knows the Lots columns.
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
  "Rules violations",
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
schema_version: 2
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

describe("measurable exits: the five R tests of spec #27", () => {
  let root: string;
  let vaultDir: string;
  let archiveDir: string;
  let record: (raw: unknown) => Promise<Decision>;
  let appendDecisions: (decisions: Decision[]) => Promise<void>;
  let buildDecision: (fields: Omit<Decision, "id">) => Decision;
  /** Names of the `todo` tests whose body passed: their mark has to go. */
  const passingTodos: string[] = [];
  let loadEvaluationReport: (tag: string, now?: Date) => Promise<EvaluationReport>;
  let renderDecisionsEvaluation: (report: EvaluationReport) => string;
  let extractCutBoard: (md: string) => string | null;
  let sectionBody: typeof import("../utils/vault-parser.js").sectionBody;
  let sectionRange: typeof import("../utils/vault-parser.js").sectionRange;
  let parseTableRows: typeof import("../utils/vault-parser.js").parseTableRows;

  /**
   * Rows of the `## USD — <section>` table keyed by column name, read the way the engine reads the
   * vault: en dash and hyphen headings, CRLF, `---` rules and `:---:` separator rows included.
   */
  const usdTable = (md: string, section: "Positions" | "Lots"): Record<string, string>[] => {
    const [header, ...rows] = parseTableRows(sectionBody(md, "USD", section));
    return rows.map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i]])));
  };
  const parseLots = (md: string) => usdTable(md, "Lots");
  /** The USD position row whose Ticker cell is `ticker` (not a row that merely mentions it), as its cells. */
  const positionRow = (md: string, ticker: string): string[] | undefined => {
    const [header, ...rows] = parseTableRows(sectionBody(md, "USD", "Positions"));
    const col = header.indexOf("Ticker");
    return rows.find((cells) => cells[col] === ticker);
  };
  /** `md` with `from` replaced by `to` inside the USD Positions section only; fails if nothing changed. */
  const corruptPositions = (md: string, from: RegExp, to: string): string => {
    const range = sectionRange(md, "USD", "Positions");
    assert.ok(range, "the USD Positions section exists");
    const corrupted =
      md.slice(0, range.start) + md.slice(range.start, range.end).replace(from, to) + md.slice(range.end);
    assert.notEqual(corrupted, md, `the corruption ${from} did not change the portfolio`);
    return corrupted;
  };

  const decisionsPath = () => join(vaultDir, "logs", "decisions.jsonl");
  const readLog = async (): Promise<Record<string, unknown>[]> =>
    (await readFile(decisionsPath(), "utf8").catch(() => ""))
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l));
  const evaluate = () => loadEvaluationReport("[test]", NOW);

  const entry = (price: number, units: number, stop: number, date: string) =>
    record({ type: "entry", ticker: "TCK", currency: "USD", price, units, stop, date, origin: "sistema" });
  /** A sale narrated to `decision:record`, which writes no snapshot until #42. */
  const exit = (price: number, units: number, date: string) =>
    record({ type: "exit", ticker: "TCK", currency: "USD", price, units, date, origin: "sistema" });
  /** An exit line with the snapshot of `lot` (the entry it consumes), as `decision:record` will write it from #42. */
  const exitFromLot = async (lot: Decision, price: number, units: number, date: string) =>
    appendDecisions([
      buildDecision({
        date,
        ticker: lot.ticker,
        currency: lot.currency,
        origin: lot.origin,
        source: "portfolio-sync",
        type: "exit",
        price,
        amount: Math.round(units * price * 100) / 100,
        rules_version: lot.rules_version,
        related_id: lot.id,
        entry_price: lot.price,
        stop_initial: lot.stop_initial,
        entry_units: lot.amount! / lot.price!,
        // This exit's share of the lot's entry costs, pro rata to the units it sold.
        entry_costs: lot.costs == null ? undefined : (lot.costs * units) / (lot.amount! / lot.price!),
        entry_date: lot.date,
        entry_origin: lot.origin,
        entry_rules_version: lot.rules_version,
        rule_violations: lot.rule_violations,
      }),
    ]);

  /** A test of the redesign that cannot pass yet. If it does pass, the file fails: remove the mark. */
  const todoTest = (name: string, todo: string, body: () => Promise<void>): void => {
    void it(name, { todo }, async () => {
      await body();
      passingTodos.push(name);
    });
  };

  /** R of every closed trade, ascending: one value per trade, the way the evaluation reports them. */
  const tradeRs = (report: EvaluationReport): number[] =>
    report.trades
      .map((t) => {
        assert.notEqual(t.rNet, null, `the ${t.ticker} trade closed on ${t.exitDate} has no R`);
        return t.rNet!;
      })
      .sort((a, b) => a - b);
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
    ({ buildDecision } = await import("../decisions.js"));
    ({ appendDecisions } = await import("../vault-io.js"));
    const { FixturesProvider } = await import("../providers/fixtures.js");
    const provider = new FixturesProvider(market);
    record = (raw) => recordOwnerDecision(raw, provider, TODAY);
    ({ loadEvaluationReport } = await import("../decisions-evaluation-run.js"));
    ({ renderDecisionsEvaluation, extractCutBoard } = await import("../utils/decisions-evaluation-render.js"));
    ({ sectionBody, sectionRange, parseTableRows } = await import("../utils/vault-parser.js"));
  });

  after(async () => {
    mock.restoreAll();
    await rm(root, { recursive: true, force: true });
    assert.deepEqual(passingTodos, [], "these `todo` tests pass now: remove their todo mark");
  });

  /** An empty vault: no log, no archive, the rules version, the watchlist and an empty portfolio. */
  const resetVault = async () => {
    await rm(join(vaultDir, "logs"), { recursive: true, force: true });
    await rm(archiveDir, { recursive: true, force: true });
    await mkdir(join(vaultDir, "logs"), { recursive: true });
    await mkdir(join(vaultDir, "strategies"), { recursive: true });
    await mkdir(archiveDir, { recursive: true });
    await writeFile(join(vaultDir, "strategies", "base.md"), `---\nversion: "1.0"\n---\n`, "utf8");
    await writeFile(join(vaultDir, "watchlist.md"), WATCHLIST_MD, "utf8");
    await writeFile(join(vaultDir, "portfolio.md"), portfolioMd(), "utf8");
  };
  beforeEach(resetVault);

  it("R1: one entry and one exit give R = (exit − entry) / (entry − stop), as today", async () => {
    // Buy 10 at 100 with the stop at 90 (1R = 10); sell all 10 at 120: R = (120 − 100) / 10 = +2.
    const lot = await entry(100, 10, 90, "2026-06-15");
    await exitFromLot(lot, 120, 10, "2026-08-10");

    const report = await evaluate();
    assertRs(tradeRs(report), [2]);
    assert.equal(report.board.trades.total, 1);
    assert.equal(report.board.trades.withR, 1);
    assert.ok(Math.abs(report.board.trades.expectancy! - 2) < TOLERANCE);
  });

  it("R2: two partial exits of one entry count as one trade, R = Σ(unitsᵢ / entry_units) × Rᵢ", async () => {
    // Buy 10 at 100, stop 90 (1R = 10). Sell 4 at 120 (R = +2) and the other 6 at 105 (R = +0.5).
    // One trade: R = 4/10 × 2 + 6/10 × 0.5 = 0.8 + 0.3 = +1.1.
    const lot = await entry(100, 10, 90, "2026-06-15");
    await exitFromLot(lot, 120, 4, "2026-08-10");
    await exitFromLot(lot, 105, 6, "2026-08-17");

    const report = await evaluate();
    assertRs(tradeRs(report), [1.1]);
    assert.equal(report.board.trades.total, 1);
    assert.ok(Math.abs(report.board.trades.expectancy! - 1.1) < TOLERANCE);
  });

  it("R2b: a lot that is only partly sold is open, not a closed trade", async () => {
    // The 5 units sold of the 10 are not a trade yet; the other 5 close it.
    const lot = await entry(100, 10, 90, "2026-06-15");
    await exitFromLot(lot, 120, 5, "2026-08-10");
    assert.equal((await evaluate()).trades.length, 0);
    assert.equal((await evaluate()).board.trades.total, 0);

    await exitFromLot(lot, 110, 5, "2026-08-17");
    // 5/10 × 2 + 5/10 × 1 = +1.5
    assertRs(tradeRs(await evaluate()), [1.5]);
  });

  todoTest(
    "R3: two entries and sales that span both lots are matched first in, first out, one R per lot",
    "needs lots and FIFO matching (#42 and #43)",
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

  // R4. The deposit is in 2026-T1, the entry in 2026-T2 and the exit in 2026-T3. The same trade is
  // narrated without archiving, then archiving each quarter either before the exit is recorded
  // (`decision:record` reads only the live log; archiving T2 separates the entry from its exit)
  // or after it (T3 is the exit's own quarter).
  type Quarter = [quarter: "T1" | "T2" | "T3", from: string, to: string];
  const QUARTERS: Quarter[] = [
    ["T1", "2026-01-01", "2026-03-31"],
    ["T2", "2026-04-01", "2026-06-30"],
    ["T3", "2026-07-01", "2026-09-30"],
  ];
  const archiveQuarter = async (quarter: Quarter[0], from: string, to: string) => {
    const archived: string[] = [];
    const live: string[] = [];
    for (const line of (await readFile(decisionsPath(), "utf8")).split("\n").filter((l) => l !== "")) {
      const date = (JSON.parse(line) as { date: string }).date;
      (date >= from && date <= to ? archived : live).push(line);
    }
    await writeFile(join(archiveDir, `decisions-2026-${quarter}.jsonl`), archived.join("\n") + "\n", "utf8");
    await writeFile(decisionsPath(), live.length > 0 ? live.join("\n") + "\n" : "", "utf8");
  };
  /** The evaluation report of the trade, `recordExit` writing its exit and `archive` archiving a quarter around it. */
  const scenario = async (
    recordExit: (lot: Decision) => Promise<unknown>,
    archive?: { quarter: Quarter; when: "before" | "after" },
  ): Promise<string> => {
    await resetVault();
    await record({ type: "deposit", currency: "USD", amount: 5000, date: "2026-02-02" });
    const lot = await entry(100, 10, 90, "2026-06-15");
    if (archive?.when === "before") await archiveQuarter(...archive.quarter);
    await recordExit(lot);
    if (archive?.when === "after") await archiveQuarter(...archive.quarter);
    const report = await evaluate();
    // Equal reports are only a proof if the trade is in them.
    assertRs(tradeRs(report), [2]);
    return renderDecisionsEvaluation(report);
  };
  const assertArchivingChangesNothing = async (
    when: "before" | "after",
    recordExit: (lot: Decision) => Promise<unknown>,
  ) => {
    const unarchived = await scenario(recordExit);
    for (const quarter of QUARTERS) {
      const archived = await scenario(recordExit, { quarter, when });
      const label = `archiving 2026-${quarter[0]} ${when} the exit`;
      // The cut board first, so a failure shows the numbers that moved instead of the whole report.
      assert.equal(extractCutBoard(archived), extractCutBoard(unarchived), label);
      assert.equal(archived, unarchived, label);
    }
  };

  it("R4: archiving any quarter after the exit is recorded leaves the decisions:evaluate output unchanged", async () => {
    await assertArchivingChangesNothing("after", (lot) => exitFromLot(lot, 120, 10, "2026-08-10"));
  });

  todoTest(
    "R4: archiving any quarter, even one that separates an entry from a later exit, leaves the decisions:evaluate output unchanged",
    "decision:record has to write the exit snapshot without the entry in the live log (#42)",
    async () => {
      await assertArchivingChangesNothing("before", () => exit(120, 10, "2026-08-10"));
    },
  );

  describe("R5, read side: Lots that do not match fail on read", () => {
    /** Two entries and a portfolio.md that lists them as lots, the way the redesign leaves it. */
    const holdTwoLots = async () => {
      const first = await entry(100, 10, 90, "2026-06-15");
      const second = await entry(110, 10, 100, "2026-06-22");
      const lotRow = (d: Decision, price: number, stop: number) =>
        `| ${d.id} | ${d.date} | 10 | 10 | ${price} | ${stop} | — | sistema | 1.0 | — |`;
      const md = portfolioMd({
        positions: ["| TCK | 20 | 105.00 | 100.00 | 0.00 | 90.00 |"],
        lots: [lotRow(first, 100, 90), lotRow(second, 110, 100)],
      });
      await writeFile(join(vaultDir, "portfolio.md"), md, "utf8");
      return { first, second, md };
    };

    it("a Volume that is the sum of its lots' units reads, and the lots are the engine's", async () => {
      const { first, second, md } = await holdTwoLots();
      assert.deepEqual(
        parseLots(md).map((l) => [l["Entry id"], l.Units]),
        [
          [first.id, "10"],
          [second.id, "10"],
        ],
      );
      assert.deepEqual(positionRow(md, "TCK")?.slice(0, 3), ["TCK", "20", "105.00"]);
      await evaluate();
      await entry(100, 1, 90, "2026-09-01");
    });

    it("a Volume that is not the sum of its lots' units fails on read, naming the ticker", async () => {
      const { md } = await holdTwoLots();
      await writeFile(join(vaultDir, "portfolio.md"), corruptPositions(md, /\| TCK \| 20 \|/, "| TCK | 7 |"), "utf8");

      await assert.rejects(entry(100, 1, 90, "2026-09-01"), /TCK.*Volume/);
      await assert.rejects(evaluate(), /TCK.*Volume/);
    });

    it("a lot whose entry id is not in the decision log fails on read, naming the id", async () => {
      const { first, md } = await holdTwoLots();
      await writeFile(join(vaultDir, "portfolio.md"), md.replace(first.id, "20260101-tck-entry-ghost"), "utf8");

      await assert.rejects(entry(100, 1, 90, "2026-09-01"), /20260101-tck-entry-ghost/);
      await assert.rejects(evaluate(), /20260101-tck-entry-ghost/);
    });

    it("a v1 portfolio.md (no Lots, schema_version: 1) is refused by both", async () => {
      await holdTwoLots();
      const v1 = portfolioMd().replace("schema_version: 2", "schema_version: 1");
      await writeFile(join(vaultDir, "portfolio.md"), v1, "utf8");

      await assert.rejects(entry(100, 1, 90, "2026-09-01"), /portfolio\.md.*schema_version 1/);
      await assert.rejects(evaluate(), /portfolio\.md.*schema_version 1/);
    });
  });

  todoTest(
    "R5: a sale that spans two lots writes two exit lines and keeps Lots, Volume and Avg price consistent",
    "needs the lots written by decision:record (#42)",
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
    },
  );
});
