/**
 * Tests of `decision:record`: what the owner narrates (a stop adjustment) reaches the decision log with origin,
 * related proposal and silo benchmark computed by the engine. A buy, a sale, a deposit, a withdrawal, a conversion, a
 * split and a reconciliation are not told here but through the inbox (#152, #197).
 * Temporary vault, fake provider, no network.
 * Same pattern as pending.test.ts: VAULT_PROJECT_DIR before the first import.
 */
import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Decision } from "../decisions.js";
import type { HistoricalBar } from "../providers/types.js";
import { lotsSection } from "./fixtures/lots.js";
import { parseTicker as tk } from "../ticker.js";

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

/** An empty portfolio in the v2 shape, with 1000.00 of cash in each silo. */
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

describe("decision:record (recordOwnerDecision)", () => {
  let vaultDir: string;
  let recordOwnerDecision: (raw: unknown, provider?: typeof fakeProvider, today?: string) => Promise<Decision[]>;
  let proposal: Decision;

  const decisionsPath = () => join(vaultDir, "logs", "decisions.jsonl");
  const readLines = async (): Promise<Decision[]> =>
    (await readFile(decisionsPath(), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  const recordAll = (raw: unknown) => recordOwnerDecision(raw, fakeProvider, TODAY);
  /** The decision a trade records; a sale that spans several lots records one per lot (`recordAll`). */
  const record = async (raw: unknown) => (await recordAll(raw))[0];

  before(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "finance-agent-decision-record-"));
    process.env.VAULT_PROJECT_DIR = vaultDir;
    ({ recordOwnerDecision } = await import("../decision.js"));
    const { buildDecision } = await import("../decisions.js");
    proposal = buildDecision({
      date: "2026-09-10",
      ticker: tk("ADBE"),
      currency: "USD",
      origin: "sistema",
      source: "heartbeat",
      type: "buy_proposal",
      price: 505,
      setup: { pattern: "pullback", state: "triggered", level: 505 },
      assumptions: ["El capex de IA se mantiene"],
      rules_version: "0.2",
    });
  });

  after(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await rm(join(vaultDir, "logs"), { recursive: true, force: true });
    await rm(join(vaultDir, "state"), { recursive: true, force: true });
    await mkdir(join(vaultDir, "logs"), { recursive: true });
    await mkdir(join(vaultDir, "strategies"), { recursive: true });
    await writeFile(join(vaultDir, "strategies", "base.md"), `---\nversion: "0.2"\n---\n`, "utf8");
    await writeFile(join(vaultDir, "watchlist.md"), WATCHLIST_MD, "utf8");
    await writeFile(decisionsPath(), JSON.stringify(proposal) + "\n", "utf8");
    await writeFile(join(vaultDir, "portfolio.md"), PORTFOLIO_MD, "utf8");
  });

  const adjustment = async (date = "2026-09-11") => {
    const { buildDecision } = await import("../decisions.js");
    const adjust = buildDecision({
      date,
      ticker: tk("ADBE"),
      currency: "USD",
      origin: "sistema",
      source: "heartbeat",
      type: "adjust_stop",
      stop: 470,
      rules_version: "0.2",
    });
    await writeFile(decisionsPath(), JSON.stringify(adjust) + "\n", "utf8");
    return adjust;
  };

  describe("what moves the portfolio is told through the inbox, no longer here (#152, #197)", () => {
    for (const [type, command] of [
      ["entry", "buy"],
      ["exit", "sale"],
      ["deposit", "deposit"],
      ["withdrawal", "withdrawal"],
    ] as const) {
      it(`a ${type} is refused, naming the ${command} command, and nothing is written`, async () => {
        const log = await readFile(decisionsPath(), "utf8");
        const portfolio = await readFile(join(vaultDir, "portfolio.md"), "utf8");
        await assert.rejects(
          recordAll({ type, ticker: "ADBE", currency: "USD", price: 500, units: 1, stop: 440 }),
          new RegExp(
            `a ${type === "entry" || type === "exit" ? command : type} is told to the engine with a ${command} command in inbox/`,
          ),
        );
        assert.equal(await readFile(decisionsPath(), "utf8"), log);
        assert.equal(await readFile(join(vaultDir, "portfolio.md"), "utf8"), portfolio);
      });
    }
  });

  it("a stop adjustment after a system proposal is the system's and cites it", async () => {
    const adjust = await adjustment();

    const d = await record({ type: "adjust_stop", ticker: "ADBE", currency: "USD", stop: 470 });
    assert.equal(d.type, "adjust_stop");
    assert.equal(d.stop, 470);
    assert.equal(d.origin, "sistema");
    assert.equal(d.related_id, adjust.id);
  });

  it("a stop adjustment without a proposal is the owner's and cites nothing", async () => {
    const d = await record({ type: "adjust_stop", ticker: "ADBE", currency: "USD", stop: 470, price: 520 });
    assert.equal(d.origin, "propietario");
    assert.equal(d.related_id, undefined);
    assert.equal(d.price, 520);
    assert.equal(d.source, "portfolio-sync");
    assert.equal(d.rules_version, "0.2");
    assert.deepEqual(d.benchmark, { ticker: "VOO", price: 700 });
    assert.equal((await readLines()).length, 2);
  });

  it("an adjustment can name the decision it follows with related_id", async () => {
    const d = await record({
      type: "adjust_stop",
      ticker: "ADBE",
      currency: "USD",
      stop: 470,
      related_id: proposal.id,
    });
    assert.equal(d.related_id, proposal.id);
  });

  it("a corrupt log line is ignored with a warning and does not prevent attributing or recording", async () => {
    const adjust = await adjustment();
    await writeFile(
      decisionsPath(),
      `{"id":"roto"\n${JSON.stringify(adjust)}\n{"id":"x","type":"desconocido"}\n`,
      "utf8",
    );
    const warn = mock.method(console, "warn", () => {});
    try {
      const d = await record({ type: "adjust_stop", ticker: "ADBE", currency: "USD", stop: 470 });
      assert.equal(d.related_id, adjust.id);
      assert.equal(warn.mock.calls.filter((c) => /line \d+ ignored/.test(String(c.arguments[0]))).length, 2);
    } finally {
      warn.mock.restore();
    }
    const raw = await readFile(decisionsPath(), "utf8");
    assert.ok(raw.startsWith(`{"id":"roto"\n`), "the log is not rewritten");
    assert.equal(raw.trim().split("\n").length, 4);
  });

  it("an invalid input or one with a nonexistent related_id does not touch the log", async () => {
    const warn = mock.method(console, "warn", () => {});
    try {
      await assert.rejects(() => record({ type: "adjust_stop", ticker: "ADBE", currency: "USD" }), /stop is required/);
      await assert.rejects(
        () => record({ type: "adjust_stop", ticker: "ADBE", currency: "USD", stop: 470, related_id: "no-existe" }),
        /related_id no-existe does not exist/,
      );
    } finally {
      warn.mock.restore();
    }
    assert.equal((await readLines()).length, 1);
  });

  it("a deposit with its amount is refused with the same message, and a cash flow leaves the store and the log as they were", async () => {
    const log = await readFile(decisionsPath(), "utf8");
    await assert.rejects(
      recordAll({ type: "deposit", currency: "EUR", amount: 50 }),
      /a deposit is told to the engine with a deposit command in inbox\//,
    );
    await assert.rejects(
      recordAll({ type: "adjust_stop", ticker: "ADBE", currency: "USD", stop: 470, amount: 50 }),
      /amount does not apply/,
    );
    assert.equal(await readFile(decisionsPath(), "utf8"), log);
  });

  it("a currency conversion is refused, naming the convert command, with nothing recorded (#135)", async () => {
    await assert.rejects(
      recordAll({ type: "fx_conversion", currency: "EUR", amount: 100, received: 116, costs: 1 }),
      /a currency conversion is told to the engine with a convert command in inbox\//,
    );
    assert.equal((await readLines()).length, 1, "only the proposal of the seed");
  });
});
