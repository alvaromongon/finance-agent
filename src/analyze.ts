// Technical analysis CLI tool: computes an asset's key levels from its 1y
// historical series (Yahoo Finance `chart`).
//
// Usage: npm run analyze -- --ticker SAP.DE [--range 1y]
//
// Output: text report with levels, ATR stop and the current entry setups
// (ADR-0013), to review an asset by hand.
//
// Method (see also strategies/analysis-methodology.md):
//   1. 52w high/low  — yearly range extremes
//   2. SMA 50 / SMA 200 — medium and long trend
//   3. Key support — cluster of local lows in the 15-30 percentile
//   4. ATR 14d — normalized volatility; used to size zones
//   5. Bullish/bearish bias from price vs SMAs
//   6. ATR stop-loss, target levels and current setups

import "dotenv/config";
import { YahooFinanceProvider } from "./providers/yahoo-finance.js";
import type { HistoricalBar } from "./providers/types.js";
import { sma, atr14d, findSupports, computeTechnicals, targetLevels, rangePosition } from "./utils/technicals.js";
import { MIN_STOP_ATR, STOP_ATR_BY_HORIZON, suggestStop } from "./utils/atr-stop.js";
import { detectSetups } from "./utils/setups/index.js";
import { checkTicker, type Ticker } from "./ticker.js";

// ── CLI arguments ───────────────────────────────────────────────────────────

function parseArgs(): { ticker: Ticker; range: string } {
  const args = process.argv.slice(2);
  const tickerIdx = args.indexOf("--ticker");
  const rangeIdx = args.indexOf("--range");

  if (tickerIdx === -1 || !args[tickerIdx + 1]) {
    console.error("Usage: npm run analyze -- --ticker <TICKER> [--range 1y|2y]");
    process.exit(1);
  }

  const checked = checkTicker(args[tickerIdx + 1]);
  if ("problem" in checked) {
    console.error(`--ticker: ${checked.problem}`);
    process.exit(1);
  }

  return {
    ticker: checked.ticker,
    range: rangeIdx !== -1 && args[rangeIdx + 1] ? args[rangeIdx + 1] : "1y",
  };
}

// ── Report ──────────────────────────────────────────────────────────────────

function fmt(n: number, decimals = 2): string {
  return n.toFixed(decimals);
}

function pct(a: number, b: number): string {
  return ((a / b - 1) * 100).toFixed(1) + "%";
}

function printReport(ticker: Ticker, bars: HistoricalBar[], currentPrice: number): void {
  const closes = bars.map((b) => b.close);

  const w52High = Math.max(...bars.map((b) => b.high));
  const w52Low = Math.min(...bars.map((b) => b.low));
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const atrVal = atr14d(bars);
  const supports = findSupports(bars);

  const bias =
    sma50 != null && sma200 != null
      ? currentPrice > sma50 && sma50 > sma200
        ? "BULLISH (price > SMA50 > SMA200)"
        : currentPrice < sma50 && sma50 < sma200
          ? "BEARISH (price < SMA50 < SMA200)"
          : "MIXED"
      : "not enough data";

  console.log(`\n${"═".repeat(56)}`);
  console.log(`  TECHNICAL ANALYSIS — ${ticker}`);
  console.log("═".repeat(56));
  console.log(`  Current price   : ${fmt(currentPrice)}`);
  console.log(`  Bars analyzed   : ${bars.length} sessions`);
  console.log(`  Last session    : ${bars[bars.length - 1].date}`);
  console.log(`\n  ── Yearly range ───────────────────────────────`);
  console.log(`  52w High        : ${fmt(w52High)}   (vs current: ${pct(currentPrice, w52High)})`);
  console.log(`  52w Low         : ${fmt(w52Low)}   (vs current: ${pct(currentPrice, w52Low)})`);
  console.log(
    `  Range position  : ${(rangePosition(currentPrice, w52Low, w52High) * 100).toFixed(1)}% of the yearly range`,
  );

  console.log(`\n  ── Moving averages ────────────────────────────`);
  if (sma50 != null) console.log(`  SMA 50d         : ${fmt(sma50)}   (vs current: ${pct(currentPrice, sma50)})`);
  else console.log(`  SMA 50d         : not enough data (< 50 bars)`);
  if (sma200 != null) console.log(`  SMA 200d        : ${fmt(sma200)}   (vs current: ${pct(currentPrice, sma200)})`);
  else console.log(`  SMA 200d        : not enough data (< 200 bars; use --range 2y)`);
  console.log(`  Trend bias      : ${bias}`);

  console.log(`\n  ── Volatility ─────────────────────────────────`);
  if (atrVal != null) {
    const atrPct = ((atrVal / currentPrice) * 100).toFixed(2);
    console.log(`  ATR 14d         : ${fmt(atrVal)}   (${atrPct}% of the price)`);
    console.log(`  ±1 ATR zone     : [${fmt(currentPrice - atrVal)}, ${fmt(currentPrice + atrVal)}]`);
  } else {
    console.log(`  ATR 14d         : not enough data`);
  }

  console.log(`\n  ── Key supports ───────────────────────────────`);
  if (supports.length > 0) {
    supports.forEach((s, i) => {
      const dist = ((currentPrice / s - 1) * 100).toFixed(1);
      console.log(`  Support ${i + 1}       : ${fmt(s)}   (current price ${dist}% above)`);
    });
  } else {
    console.log(`  No support clusters found (few repeated lows)`);
  }

  // ── Levels ──────────────────────────────────────────────────────────────
  console.log(`\n  ── Levels ─────────────────────────────────────`);

  const t = computeTechnicals(bars, currentPrice);
  // Setups current today (ADR-0013): the system's only way in.
  const setups = detectSetups(bars);
  console.log(
    `  Setups today    : ${setups.length > 0 ? setups.map((s) => `${s.pattern} ${s.state} at ${fmt(s.level)} → ${fmt(s.target)}`).join("; ") : "none"}`,
  );
  // Volatility-sized stop, not a fixed %. It is also shown in ATR
  // units so it can be applied to the real entry: the stop is measured from
  // the buy price, not from today's.
  if (t.atr14 != null) {
    console.log(
      `  stop-loss       : ${fmt(suggestStop(currentPrice, t.atr14, "medium"))}` +
        `   (${STOP_ATR_BY_HORIZON.medium} ATR below the price — medium horizon)`,
    );
    console.log(
      `                    ${fmt(suggestStop(currentPrice, t.atr14, "short"))}` +
        `   (${STOP_ATR_BY_HORIZON.short} ATR — short horizon)`,
    );
    console.log(
      `  Minimum accepted: ${fmt(currentPrice - MIN_STOP_ATR * t.atr14)}` +
        `   (${MIN_STOP_ATR} ATR; closer, noise hits it)`,
    );
    console.log(`  1 ATR           : ${fmt(t.atr14)} — measure the stop from YOUR entry price, not today's`);
  } else {
    console.log(`  stop-loss       : not enough ATR to size it`);
  }
  // Levels the system anchors a BUY target to.
  const levels = targetLevels(t);
  console.log(
    `  Target levels   : ${levels.length > 0 ? levels.map((l) => fmt(l)).join(", ") : "none above (trading at highs)"}`,
  );

  console.log(`\n  NOTE: review these values with macro/fundamental context.`);
  console.log(`        See strategies/analysis-methodology.md for the full checklist.`);
  console.log(`${"═".repeat(56)}\n`);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { ticker, range } = parseArgs();
  const provider = new YahooFinanceProvider();

  console.log(`\nDownloading ${ticker} history (range=${range})...`);

  const [bars, priceMap] = await Promise.all([provider.getHistorical(ticker, range), provider.getPrices([ticker])]);

  if (bars.length === 0) {
    console.error(`No historical data for ${ticker}. Check the ticker.`);
    process.exit(1);
  }

  const currentPrice = priceMap.get(ticker) ?? bars[bars.length - 1].close;
  printReport(ticker, bars, currentPrice);
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
