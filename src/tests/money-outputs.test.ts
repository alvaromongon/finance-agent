/**
 * Output pin of the money numbers (#79): the serialized numbers of decisions.jsonl and portfolio.md that
 * `decision:record` writes stay the same whatever type carries them. Written BEFORE the refactor and
 * run against it unchanged. Temporary vault, fake provider, no network.
 * Same pattern as pending.test.ts: VAULT_PROJECT_DIR before the first import.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Decision } from "../decisions.js";
import type { HistoricalBar } from "../providers/types.js";
import { lotsSection } from "./fixtures/lots.js";

const TODAY = "2026-09-14";

const WATCHLIST_MD = `---
schema_version: 1
---

# Watchlist

\`\`\`yaml
watchlist:
  - ticker: ADBE
    name: Applied Materials
    market: NASDAQ
    currency: USD
    horizon: medium
    thesis: "Capex de IA."
\`\`\`
`;

/** An empty portfolio in the v2 shape: an entry adds its lot to it, a sale consumes the lots (#42). */
const PORTFOLIO_MD = `---
schema_version: 2
last_manual_sync: 2026-09-10T18:00:00Z
account_env: demo
---

${["EUR", "USD"]
  .map(
    (c) => `## ${c} — Cash

| Item | Value |
|---|---|
| Available cash | 1000.00 |

## ${c} — Positions

| Ticker | Volume | Avg price | Current price | P/L | Stop loss |
|---|---|---|---|---|---|

${lotsSection(c as "EUR" | "USD")}`,
  )
  .join("\n")}`;

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

const EXPECTED: unknown = {
  out: [
    [["entry", 100, 1.07, null, null, 3, null, 33.333]],
    [["entry", 287.7, 2.33, null, null, 7, null, 41.1]],
    [["entry", 100.01, null, null, null, 8.0008, null, 12.5]],
    [
      ["exit", 150, 0.1, 52.81, 1.07, 3, 0, 50],
      ["exit", 350, 0.24, 68.85, 2.33, 7, 0, 50],
      ["exit", 50, 0.03, 38.43, null, 1, 7.0008, 50],
    ],
    [["exit", 160.37, null, 121.06, null, 3.1445098039215686, 3.8562901960784313, 51]],
    [["deposit", 123.45, null, null, null, null, null, null]],
    [["fx_conversion", 100, 0.8, null, null, null, null, null]],
  ],
  logNumbers: [
    ["entry", 100, 1.07, null, null, 3, null, 33.333],
    ["entry", 287.7, 2.33, null, null, 7, null, 41.1],
    ["entry", 100.01, null, null, null, 8.0008, null, 12.5],
    ["exit", 150, 0.1, 52.81, 1.07, 3, 0, 50],
    ["exit", 350, 0.24, 68.85, 2.33, 7, 0, 50],
    ["exit", 50, 0.03, 38.43, null, 1, 7.0008, 50],
    ["exit", 160.37, null, 121.06, null, 3.1445098039215686, 3.8562901960784313, 51],
    ["deposit", 123.45, null, null, null, null, null, null],
    ["fx_conversion", 100, 0.8, null, null, null, null, null],
  ],
  cash: [
    "| Available cash | 1000.00 |",
    "| Available cash | 1000.00 |",
    "| ADBE | 3.8562902 | 12.50 | 33.333 | 0.00 | 30.00 |",
  ],
};

const FIELDS = ["type", "amount", "costs", "pnl", "entry_costs", "units", "lot_units_left", "price"] as const;

describe("money numbers written by decision:record (pinned before #79)", () => {
  let vaultDir: string;
  let recordOwnerDecision: (raw: unknown, provider?: typeof fakeProvider, today?: string) => Promise<Decision[]>;

  const nums = (ds: Decision[]) =>
    ds.map((d) => FIELDS.map((f) => (d as unknown as Record<string, unknown>)[f] ?? null));
  const run = (raw: unknown) => recordOwnerDecision(raw, fakeProvider, TODAY);

  before(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "finance-agent-money-pin-"));
    process.env.VAULT_PROJECT_DIR = vaultDir;
    ({ recordOwnerDecision } = await import("../decision.js"));
    await mkdir(join(vaultDir, "logs"), { recursive: true });
    await mkdir(join(vaultDir, "strategies"), { recursive: true });
    await writeFile(join(vaultDir, "strategies", "base.md"), `---\nversion: "0.2"\n---\n`, "utf8");
    await writeFile(join(vaultDir, "watchlist.md"), WATCHLIST_MD, "utf8");
    await writeFile(join(vaultDir, "logs", "decisions.jsonl"), "", "utf8");
    await writeFile(join(vaultDir, "portfolio.md"), PORTFOLIO_MD, "utf8");
  });

  after(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });

  it("entries with costs, a sale over three lots with an owner pnl and costs, a deposit and a conversion", async () => {
    const out: unknown[] = [];
    out.push(
      nums(
        await run({ type: "entry", ticker: "ADBE", currency: "USD", price: 33.333, units: 3, costs: 1.07, stop: 30 }),
      ),
    );
    out.push(
      nums(await run({ type: "entry", ticker: "ADBE", currency: "USD", price: 41.1, units: 7, costs: 2.33, stop: 35 })),
    );
    out.push(
      nums(await run({ type: "entry", ticker: "ADBE", currency: "USD", price: 12.5, amount: 100.01, stop: 10 })),
    );
    out.push(
      nums(
        await run({ type: "exit", ticker: "ADBE", currency: "USD", price: 50, units: 11, costs: 0.37, pnl: 160.09 }),
      ),
    );
    out.push(nums(await run({ type: "exit", ticker: "ADBE", currency: "USD", price: 51, amount: 160.37 })));
    out.push(nums(await run({ type: "deposit", currency: "EUR", amount: 123.45 })));
    out.push(nums(await run({ type: "fx_conversion", currency: "EUR", amount: 100, fx_rate: 1.17, costs: 0.8 })));
    const log = (await readFile(join(vaultDir, "logs", "decisions.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const portfolio = await readFile(join(vaultDir, "portfolio.md"), "utf8");
    const cash = portfolio
      .split("\n")
      .filter((l) => /Available cash|Total cash|^\| ADBE \| [0-9.]+ \| [0-9.]+ \|/.test(l));
    assert.deepEqual({ out, logNumbers: nums(log), cash }, EXPECTED);
  });
});
