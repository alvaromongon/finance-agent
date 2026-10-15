// Technical computations reused by analyze.ts and weekly-screening.ts.
import type { HistoricalBar } from "../providers/types.js";
import type { TrendBias } from "../types.js";
import { round2 } from "./round.js";

export interface Technicals {
  currentPrice: number;
  w52High: number;
  w52Low: number;
  rangePosition: number; // 0–1: position in the yearly range
  sma50: number | null;
  sma200: number | null;
  atr14: number | null;
  supports: number[];
  /** Clusters of local highs, lowest to highest. */
  resistances: number[];
  bias: TrendBias;
}

export function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function atr14d(bars: HistoricalBar[]): number | null {
  if (bars.length < 14) return null;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const { high, low } = bars[i];
    const prevClose = bars[i - 1].close;
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  const recent = trs.slice(-14);
  return recent.reduce((a, b) => a + b, 0) / 14;
}

export function findSupports(bars: HistoricalBar[], window = 5, gapPct = 0.03): number[] {
  const localLows: number[] = [];
  for (let i = window; i < bars.length - window; i++) {
    const candidate = bars[i].low;
    let isMin = true;
    for (let j = i - window; j <= i + window; j++) {
      if (j !== i && bars[j].low < candidate) {
        isMin = false;
        break;
      }
    }
    if (isMin) localLows.push(candidate);
  }
  return clusterLevels(localLows, gapPct);
}

/**
 * Resistances: the mirror of `findSupports` with local highs. A level the
 * price touched at least twice without breaking it is where a target makes
 * sense.
 */
export function findResistances(bars: HistoricalBar[], window = 5, gapPct = 0.03): number[] {
  const localHighs: number[] = [];
  for (let i = window; i < bars.length - window; i++) {
    const candidate = bars[i].high;
    let isMax = true;
    for (let j = i - window; j <= i + window; j++) {
      if (j !== i && bars[j].high > candidate) {
        isMax = false;
        break;
      }
    }
    if (isMax) localHighs.push(candidate);
  }
  return clusterLevels(localHighs, gapPct);
}

/** Groups local extremes within `gapPct` of each other; each cluster of ≥2 yields its median. */
function clusterLevels(values: number[], gapPct: number): number[] {
  if (values.length === 0) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const clusters: number[][] = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const last = clusters[clusters.length - 1];
    const ref = last[last.length - 1];
    if ((sorted[i] - ref) / ref <= gapPct) {
      last.push(sorted[i]);
    } else {
      clusters.push([sorted[i]]);
    }
  }
  return clusters.filter((c) => c.length >= 2).map((c) => c[Math.floor(c.length / 2)]);
}

/**
 * Levels to anchor a BUY target to: resistances and the 52-week
 * high above the price, lowest to highest. Empty if the asset trades at
 * highs: without a prior level there is no target the engine can check.
 */
export function targetLevels(t: Pick<Technicals, "currentPrice" | "resistances" | "w52High">): number[] {
  const above = [...t.resistances, t.w52High].filter((l) => l > t.currentPrice).map(round2);
  return [...new Set(above)].sort((a, b) => a - b);
}

/** Price position in the 52-week range: 0 at the low, 1 at the high. */
export function rangePosition(price: number, w52Low: number, w52High: number): number {
  return (price - w52Low) / (w52High - w52Low);
}

export function computeTechnicals(bars: HistoricalBar[], currentPrice: number): Technicals {
  const closes = bars.map((b) => b.close);
  const w52High = Math.max(...bars.map((b) => b.high));
  const w52Low = Math.min(...bars.map((b) => b.low));
  const sma50v = sma(closes, 50);
  const sma200v = sma(closes, 200);
  const atr = atr14d(bars);
  const supports = findSupports(bars);
  const resistances = findResistances(bars);

  let bias: Technicals["bias"] = "INSUFICIENTE";
  if (sma50v != null && sma200v != null) {
    if (currentPrice > sma50v && sma50v > sma200v) bias = "ALCISTA";
    else if (currentPrice < sma50v && sma50v < sma200v) bias = "BAJISTA";
    else bias = "MIXTO";
  }

  return {
    currentPrice,
    w52High,
    w52Low,
    rangePosition: rangePosition(currentPrice, w52Low, w52High),
    sma50: sma50v,
    sma200: sma200v,
    atr14: atr,
    supports,
    resistances,
    bias,
  };
}
