// Synthetic series for the setup detectors (ADR-0013). Outside the
// *.test.ts glob: node --test does not run it as a suite.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HistoricalBar } from "../../providers/types.js";

/** Bar with a ±`spread` range around the close (or with an explicit high and low). */
export function bar(
  i: number,
  close: number,
  opts: { high?: number; low?: number; spread?: number; volume?: number } = {},
): HistoricalBar {
  const spread = opts.spread ?? 0.3;
  const d = new Date(Date.UTC(2025, 0, 1) + i * 86_400_000);
  return {
    date: d.toISOString().slice(0, 10),
    close,
    high: opts.high ?? close + spread,
    low: opts.low ?? close - spread,
    volume: opts.volume ?? 1000,
  };
}

/** Linear rise of `n` sessions from `from`, `step` per session. */
export function uptrend(n: number, from = 100, step = 0.5): HistoricalBar[] {
  return Array.from({ length: n }, (_, i) => bar(i, from + i * step));
}

/** Appends bars with the given closes and consecutive indices. */
export function extend(
  bars: HistoricalBar[],
  closes: (number | [number, { high?: number; low?: number; volume?: number }])[],
): HistoricalBar[] {
  const out = [...bars];
  for (const c of closes) {
    const [close, opts] = Array.isArray(c) ? c : [c, {}];
    out.push(bar(out.length, close, opts));
  }
  return out;
}

/** Real Yahoo history saved in fixtures/ (date, close, high, low, volume). */
export function realBars(file: string): HistoricalBar[] {
  const rows = JSON.parse(readFileSync(join(import.meta.dirname, file), "utf8")) as [
    string,
    number,
    number,
    number,
    number,
  ][];
  return rows.map(([date, close, high, low, volume]) => ({ date, close, high, low, volume }));
}
