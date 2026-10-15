// Detector of a breakout from a consolidation near highs (ADR-0013).
//
// Two states. `armed`: the base is formed and has not broken yet; its top is
// the level of a short-expiry Buy Stop order at the broker, which is the
// lesson learned (have the order in place before the event) without keeping a
// playbook by hand. `triggered`: the last session closes above the top with volume.
import { round2 } from "../round.js";
import { atr14d } from "../technicals.js";
import type { HistoricalBar } from "../../providers/types.js";
import type { Setup } from "../../types.js";

export interface BreakoutParams {
  /** Base sessions. */
  baseSessions: number;
  /** Maximum base range (high − low), in ATR14. */
  maxBaseAtr: number;
  /** The top of the base, at most this % below the 52-week high. */
  nearHighPct: number;
  /** Breakout session volume against the `volumeSessions` average. */
  volumeMultiple: number;
  volumeSessions: number;
  /** Sessions before the base in which to measure the pole. */
  poleSessions: number;
}

/** Sessions in a trading year: the 52-week high window. */
const YEAR_SESSIONS = 252;

interface Base {
  high: number;
  /** Base top plus the pole: the classic flag projection. */
  target: number;
}

/**
 * Base of `baseSessions` sessions ending at `end`, or `null` if it is not one:
 * range ≤ `maxBaseAtr` ATR14 and top within `nearHighPct` of the 52-week high.
 * The ATR is that of the session before the base, the security's normal
 * volatility: with the base's own, a wide, choppy base would inflate its ATR
 * and pass the filter. The pole is the rise from the low of the previous
 * `poleSessions` sessions up to the top.
 */
function baseEndingAt(bars: readonly HistoricalBar[], end: number, p: BreakoutParams): Base | null {
  const start = end - p.baseSessions + 1;
  if (start - p.poleSessions < 0) return null;

  const base = bars.slice(start, end + 1);
  const high = Math.max(...base.map((b) => b.high));
  const low = Math.min(...base.map((b) => b.low));
  const atr = atr14d(bars.slice(0, start));
  if (atr == null || !(atr > 0) || high - low > p.maxBaseAtr * atr) return null;

  const yearHigh = Math.max(...bars.slice(Math.max(0, end - YEAR_SESSIONS + 1), end + 1).map((b) => b.high));
  if (high < yearHigh * (1 - p.nearHighPct / 100)) return null;

  const poleLow = Math.min(...bars.slice(start - p.poleSessions, start).map((b) => b.low));
  if (!(high > poleLow)) return null;
  return { high, target: high + (high - poleLow) };
}

/** Average volume of the `sessions` sessions before `index`; `null` if any data is missing. */
function averageVolume(bars: readonly HistoricalBar[], index: number, sessions: number): number | null {
  if (index - sessions < 0) return null;
  const volumes = bars.slice(index - sessions, index).map((b) => b.volume);
  if (volumes.some((v) => v == null || !(v > 0))) return null;
  return (volumes as number[]).reduce((a, b) => a + b, 0) / sessions;
}

/**
 * Breakout state on the last session of `bars`, or `null`:
 *
 * - `triggered`: the base ends on the previous session and the last one
 *   closes above its top with volume ≥ `volumeMultiple` × the average. Without
 *   volume data no breakout is confirmed.
 * - `armed`: the base ends on the last session, with no confirmed breakout.
 *
 * Like the pullback, it describes today's state; `detectNewSetups` decides whether it is new.
 */
export function detectBreakout(bars: readonly HistoricalBar[], params: BreakoutParams): Setup | null {
  const today = bars.length - 1;
  if (today < 1) return null;
  const date = bars[today].date;

  const prior = baseEndingAt(bars, today - 1, params);
  if (prior && bars[today].close > prior.high) {
    const avgVolume = averageVolume(bars, today, params.volumeSessions);
    const volume = bars[today].volume;
    if (avgVolume != null && volume != null && volume >= params.volumeMultiple * avgVolume) {
      return {
        pattern: "breakout",
        state: "triggered",
        date,
        level: round2(bars[today].close),
        target: round2(prior.target),
      };
    }
  }

  const current = baseEndingAt(bars, today, params);
  if (current) {
    return { pattern: "breakout", state: "armed", date, level: round2(current.high), target: round2(current.target) };
  }
  return null;
}
