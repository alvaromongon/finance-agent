/**
 * Tolerance to CRLF line endings (Windows checkouts).
 *
 * The vault is edited from Windows, Android and Linux. Without `.gitattributes`, a
 * Windows checkout with `core.autocrlf=true` materializes the .md files with CRLF
 * and the parsers — which anchor blocks with a literal `\n` (```yaml\n, ^---\n) —
 * failed locally while still working on GitHub Actions (Linux).
 * Worse: `extractYamlBlock` threw, but `applyRetireWatchlistEntry` silently
 * returned the Markdown untouched.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeEol } from "../utils/parse.js";
import {
  extractYamlBlock,
  extractFrontmatter,
  sectionBody,
  parseCash,
  parsePositions,
  parseTableRows,
  extractRetireList,
  extractPlanSummary,
  applyRetireWatchlistEntry,
} from "../utils/vault-parser.js";

const PORTFOLIO_LF = `---
schema_version: 1
last_manual_sync: 2026-09-12T12:05:00Z
---

## EUR — Cash

| Item | Value |
|---|---|
| Available cash | 28,11 € |

## EUR — Positions

| Ticker | Volume | Avg price | Current price | P/L | Stop loss |
|---|---|---|---|---|---|
| — | — | — | — | — | — |

## USD — Cash

| Item | Value |
|---|---|
| Available cash | $545.61 |

## USD — Positions

| Ticker | Volume | Avg price | Current price | P/L | Stop loss |
|---|---|---|---|---|---|
| HAL | 10 | 37.00 | 35,80 | -12,00 | 34.00 |
`;

const WATCHLIST_LF = `---
title: "Watchlist"
---

## Activos

\`\`\`yaml
watchlist:
  - ticker: HAL
    currency: USD
  - ticker: SGO.PA
    currency: EUR
\`\`\`
`;

const REVIEW_LF = `## AUTOMATED_ACTIONS
RETIRE: HAL, SGO.PA
PLAN_SUMMARY: Semana defensiva, sin compras nuevas.
`;

/** Converts to CRLF: what git materializes on Windows with autocrlf. */
const crlf = (md: string): string => md.replace(/\n/g, "\r\n");

describe("normalizeEol", () => {
  it("converts CRLF to LF", () => {
    assert.equal(normalizeEol("a\r\nb"), "a\nb");
  });
  it("converts a lone CR (classic Mac) to LF", () => {
    assert.equal(normalizeEol("a\rb"), "a\nb");
  });
  it("leaves LF untouched", () => {
    assert.equal(normalizeEol("a\nb"), "a\nb");
  });
  it("does not touch text without line breaks", () => {
    assert.equal(normalizeEol("abc"), "abc");
  });
});

describe("vault parsers with CRLF", () => {
  it("extractYamlBlock finds the yaml block", () => {
    const block = extractYamlBlock(crlf(WATCHLIST_LF));
    assert.match(block, /ticker: HAL/);
    assert.match(block, /ticker: SGO\.PA/);
  });

  it("extractFrontmatter reads the frontmatter", () => {
    const fm = extractFrontmatter(crlf(PORTFOLIO_LF));
    assert.equal(fm?.last_manual_sync instanceof Date, true);
  });

  it("sectionBody bounds the currency section", () => {
    const body = sectionBody(crlf(PORTFOLIO_LF), "USD", "Positions");
    assert.match(body, /HAL/);
    assert.doesNotMatch(body, /Available cash/);
  });

  it("parseTableRows splits the cells without dragging the \\r", () => {
    const rows = parseTableRows(crlf("| A | B |\n|---|---|\n| 1 | 2 |\n"));
    assert.deepEqual(rows, [
      ["A", "B"],
      ["1", "2"],
    ]);
  });

  it("parseCash reads each currency's balance", () => {
    assert.equal(parseCash(crlf(PORTFOLIO_LF), "EUR"), 28.11);
    assert.equal(parseCash(crlf(PORTFOLIO_LF), "USD"), 545.61);
  });

  it("parsePositions reads the positions and skips the placeholder", () => {
    assert.deepEqual(parsePositions(crlf(PORTFOLIO_LF), "EUR"), []);
    const [hal] = parsePositions(crlf(PORTFOLIO_LF), "USD");
    assert.equal(hal.ticker, "HAL");
    assert.equal(hal.volume, 10);
    assert.equal(hal.avgPrice, 37);
    assert.equal(hal.stopLoss, 34);
  });

  it("extractRetireList reads the removal list", () => {
    assert.deepEqual(extractRetireList(crlf(REVIEW_LF)), ["HAL", "SGO.PA"]);
  });

  it("extractPlanSummary reads the plan summary", () => {
    assert.equal(extractPlanSummary(crlf(REVIEW_LF)), "Semana defensiva, sin compras nuevas.");
  });

  it("applyRetireWatchlistEntry does remove the entry (it used to fail silently)", () => {
    const updated = applyRetireWatchlistEntry(crlf(WATCHLIST_LF), "HAL");
    assert.doesNotMatch(updated, /ticker: HAL/);
    assert.match(updated, /ticker: SGO\.PA/);
  });
});
