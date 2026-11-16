/**
 * A ticker is one parsed value (#78): wherever the engine reads one, it parses it, so a ticker written in
 * another case reads as its upper-case value and is compared with `===`. Temporary vault, fake provider,
 * no network. VAULT_PROJECT_DIR is set before the first import of the engine.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { entryLines, lotsSection, type HeldLot } from "./fixtures/lots.js";

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

/** A batch of commands. */
const batch = (...commands: string[]): string =>
  `schema_version: 1\ncommands:\n${commands.map((c) => `  - ${c.replace(/\n/g, "\n    ")}`).join("\n")}\n`;

describe("a ticker written in another case is the same ticker", () => {
  let vaultDir: string;
  let ingestInbox: typeof import("../inbox.js").ingestInbox;
  let vaultIo: typeof import("../vault-io.js");
  let store: typeof import("../portfolio-store.js");
  let lotsMismatches: typeof import("../utils/lots-check.js").lotsMismatches;

  const path = (...parts: string[]) => join(vaultDir, ...parts);
  const read = (...parts: string[]) => readFile(path(...parts), "utf8");
  /** Applies a batch the way the owner does: a file in `inbox/`, then `inbox:ingest`. */
  const ingest = async (text: string) => {
    await mkdir(path("inbox"), { recursive: true });
    await writeFile(path("inbox", `${Math.random().toString(36).slice(2)}.yaml`), text, "utf8");
    return ingestInbox(new Date("2026-09-14T09:00:00Z"));
  };
  const TCK_LOT: HeldLot = { ticker: "TCK", units: 2, price: 100, stop: 80 };
  const TCK_ROW = "| TCK | 2 | 100 | 100 | 0 | 80 |";

  const setUp = async (positions: string[], held: HeldLot[]) => {
    await writeFile(path("portfolio.md"), portfolioMd(positions, held), "utf8");
    await writeFile(path("logs", "decisions.jsonl"), entryLines("USD", held), "utf8");
  };

  before(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "finance-agent-ticker-flow-"));
    process.env.VAULT_PROJECT_DIR = vaultDir;
    ({ ingestInbox } = await import("../inbox.js"));
    vaultIo = await import("../vault-io.js");
    store = await import("../portfolio-store.js");
    ({ lotsMismatches } = await import("../utils/lots-check.js"));
  });

  after(async () => {
    await rm(vaultDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await rm(path("logs"), { recursive: true, force: true });
    await rm(path("state"), { recursive: true, force: true });
    await rm(path("inbox"), { recursive: true, force: true });
    await mkdir(path("logs"), { recursive: true });
    await mkdir(path("strategies"), { recursive: true });
    await writeFile(path("strategies", "base.md"), `---\nversion: "0.2"\n---\n`, "utf8");
    await writeFile(path("watchlist.md"), WATCHLIST_MD, "utf8");
  });

  const BUY_TCK = (ticker: string) => `command: buy\nticker: ${ticker}\ndate: 2026-09-14\nunits: 1\nprice: 110 USD`;

  it("a buy of `tck` adds its lot to the existing TCK row, and the next sale of `Tck` is accepted", async () => {
    await setUp([TCK_ROW], [TCK_LOT]);

    const bought = await ingest(batch(BUY_TCK("tck")));
    assert.equal(bought.exitCode, 0, bought.lines.join("\n"));
    const entry = (await vaultIo.readDecisions()).find((d) => d.date === "2026-09-14" && d.type === "entry");
    assert.equal(entry?.ticker, "TCK");

    const portfolio = store.requireReadable(await store.readPortfolio("USD"));
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

    const sold = await ingest(batch("command: sale\nticker: Tck\ndate: 2026-09-15\nunits: 3\nprice: 120 USD"));
    assert.equal(sold.exitCode, 0, sold.lines.join("\n"));
    const exits = (await vaultIo.readDecisions()).filter((d) => d.type === "exit");
    assert.deepEqual(
      exits.map((d) => d.ticker),
      ["TCK", "TCK"],
    );
  });

  it("the Positions row written in lower case is found, and the view carries the canonical ticker", async () => {
    await setUp(["| tck | 2 | 100 | 100 | 0 | 80 |"], [TCK_LOT]);

    assert.equal((await ingest(batch(BUY_TCK("TCK")))).exitCode, 0);

    const text = await read("portfolio.md");
    assert.match(text, /^\| TCK \| 3 \|/m);
    assert.doesNotMatch(text, /^\| tck \|/m);
  });

  it("an invalid ticker rejects the batch before anything is applied", async () => {
    await setUp([TCK_ROW], [TCK_LOT]);
    const before = [await read("portfolio.md"), await read("logs", "decisions.jsonl")];
    for (const ticker of ["TC|K", "TCK ; rm", "-", "^.-", "A..B", ".A"]) {
      const result = await ingest(batch(BUY_TCK(JSON.stringify(ticker))));
      assert.equal(result.exitCode, 1, ticker);
      assert.match(result.lines.join("\n"), /a ticker (has letters|must not)/, ticker);
    }
    assert.deepEqual([await read("portfolio.md"), await read("logs", "decisions.jsonl")], before);
    await assert.rejects(read("state", "portfolio.json"), /ENOENT/, "no store was written");
  });

  it("a hand-written lot on `tck` matches the TCK entry of the decision log, with no message", async () => {
    const text = portfolioMd(["| tck | 2 | 100 | 100 | 0 | 80 |"], [{ ...TCK_LOT, ticker: "tck" }]);
    await writeFile(path("portfolio.md"), text, "utf8");
    await writeFile(path("logs", "decisions.jsonl"), entryLines("USD", [TCK_LOT]), "utf8");

    const portfolio = store.requireReadable(await store.readPortfolio("USD"));
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
    await assert.rejects(
      () => store.readPortfolio("USD").then(store.requireReadable),
      /## USD — Positions: Ticker "TC;K"/,
    );
  });

  it("a Positions row with two dots in a row or a leading dot is refused like any other non-ticker", async () => {
    for (const bad of ["A..B", ".A"]) {
      await writeFile(path("portfolio.md"), portfolioMd([`| ${bad} | 2 | 100 | 100 | 0 | 80 |`], []), "utf8");
      await assert.rejects(
        () => store.readPortfolio("USD").then(store.requireReadable),
        (error: Error) => {
          assert.ok(error.message.includes(`## USD — Positions: Ticker "${bad}"`), error.message);
          assert.match(error.message, /two dots in a row|start with a dot/);
          return true;
        },
      );
    }
  });

  it("decisions:evaluate reads Positions strictly: a row that is not a ticker is refused", async () => {
    await setUp([TCK_ROW, "| M&M.NS | 1 | 5 | 5 | 0 | 4 |"], [TCK_LOT]);
    const { loadEvaluationReport } = await import("../decisions-evaluation-run.js");
    await assert.rejects(() => loadEvaluationReport("[test]"), /## USD — Positions: Ticker "M&M\.NS"/);
  });

  it("a Lots row that is not a ticker is skipped with its reason", async () => {
    await writeFile(path("portfolio.md"), portfolioMd([], [{ ticker: "TC;K", units: 1, price: 10 }]), "utf8");
    const portfolio = store.requireReadable(await store.readPortfolio("USD"));
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
