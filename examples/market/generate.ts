// Generates the synthetic daily bars of examples/market/: made-up
// prices, deterministic, shaped so the demo heartbeat has something to show.
//
//   npx tsx examples/market/generate.ts
//
// - EXSA.DE, VOO: steady uptrends (favorable regime in both silos).
// - SAP.DE: rally and pullback to just above the stop in examples/brain
//   (approaching_stop → escalation).
// - AIR.PA, JNJ: uptrend and a tight base at the high (armed breakout).
// - KO: quiet uptrend, far from its stop (nothing to report).
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { detectNewSetups } from "../../src/utils/setups/index.js";
import type { HistoricalBar } from "../../src/providers/types.js";

const LAST_SESSION = "2026-10-09";
const SESSIONS = 260;

/** The `n` weekdays ending on LAST_SESSION, oldest first. */
function weekdays(n: number): string[] {
  const out: string[] = [];
  for (let d = new Date(`${LAST_SESSION}T00:00:00Z`); out.length < n; d.setUTCDate(d.getUTCDate() - 1)) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.unshift(d.toISOString().slice(0, 10));
  }
  return out;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Bars from closes, with a range of `spreadPct` % around each close. */
function toBars(closes: number[], spreadPct: number): HistoricalBar[] {
  const dates = weekdays(closes.length);
  return closes.map((c, i) => {
    const close = round(c);
    const spread = (close * spreadPct) / 100;
    return {
      date: dates[i],
      close,
      high: round(close + spread),
      low: round(close - spread),
      volume: 1_000_000 + (i % 7) * 50_000,
    };
  });
}

/** `n` closes from `from` to `to` in a straight line, with a gentle wave of `amplitude`. */
const trend = (n: number, from: number, to: number, amplitude = 0) =>
  Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1) + amplitude * Math.sin(i / 3));

/** Uptrend then a 15-session base at the high, cut at the first session the breakout is armed. */
function armedBreakout(from: number, to: number): HistoricalBar[] {
  const run = trend(SESSIONS - 15, from, to);
  const base = Array.from({ length: 15 }, (_, i) => to * (1 + (i % 2 ? 0.004 : -0.004)));
  const closes = [...run, ...base];
  for (let cut = SESSIONS - 15; cut <= SESSIONS; cut++) {
    const bars = toBars(closes.slice(0, cut), 0.3);
    if (detectNewSetups(bars).some((s) => s.pattern === "breakout" && s.state === "armed")) return bars;
  }
  throw new Error(`no armed breakout between ${from} and ${to}`);
}

const series: Record<string, HistoricalBar[]> = {
  "EXSA.DE": toBars(trend(SESSIONS, 44, 54, 0.3), 0.8),
  VOO: toBars(trend(SESSIONS, 480, 590, 3), 0.8),
  "SAP.DE": toBars([...trend(SESSIONS - 30, 150, 192, 1.5), ...trend(30, 192, 171.2)], 1.2),
  KO: toBars(trend(SESSIONS, 58, 70, 0.4), 0.7),
  "AIR.PA": armedBreakout(90, 182),
  JNJ: armedBreakout(80, 168),
};

for (const [ticker, bars] of Object.entries(series)) {
  await writeFile(join(import.meta.dirname, `${ticker}.json`), JSON.stringify(bars) + "\n", "utf8");
  console.log(`${ticker}: ${bars.length} sessions, last close ${bars.at(-1)!.close} on ${bars.at(-1)!.date}`);
}
