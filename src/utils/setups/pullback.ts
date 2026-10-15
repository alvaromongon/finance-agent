// Detector of a pullback within a trend (ADR-0013).
//
// It is the bottom confirmation ADR-0010 left pending: the static zone could
// not tell a falling price from one that pulls back and bounces. Here the
// bounce is required: the price touches a moving average, closes back above it
// and with a higher low than the touch's.
import { round2 } from "../round.js";
import { sma } from "../technicals.js";
import type { HistoricalBar } from "../../providers/types.js";
import type { Setup } from "../../types.js";

export interface PullbackParams {
  /** Moving averages the pullback can touch, in order of preference. */
  smaPeriods: readonly number[];
  /** Sessions before the last one in which to look for the touch. */
  touchSessions: number;
  /** Sessions before the last one in which to look for the high that is the target. */
  swingSessions: number;
}

/** Average of `period` closes ending on session `index`. */
function smaAt(closes: readonly number[], period: number, index: number): number | null {
  return sma(closes.slice(0, index + 1), period);
}

/**
 * Pullback confirmed on the last session of `bars`, or `null`:
 *
 * 1. Trend: close > SMA200. It implies a non-bearish bias (bearish is close <
 *    SMA50 < SMA200), so it need not be checked separately.
 * 2. Touch: in one of the previous `touchSessions` sessions, the low reached
 *    that day's SMA20 or SMA50.
 * 3. Confirmation: the last session closes above that average and its low is
 *    higher than the lowest since the touch.
 * 4. Swing: the high of the previous `swingSessions` sessions is above the
 *    close. Without it there is no pullback, just a security at highs.
 *
 * The target is the measured move: the high it pulled back from plus the size
 * of the pullback (high − touch low). Going back only to the high never
 * reaches the 2:1 R:R with the framework's 3 ATR stop: it was measured
 * on 310 pullbacks of the last year and none got there (ADR-0013).
 *
 * The detector describes today's state: a confirmed pullback stays confirmed
 * for several days. `detectNewSetups` decides which detections are new.
 */
export function detectPullback(bars: readonly HistoricalBar[], params: PullbackParams): Setup | null {
  const today = bars.length - 1;
  const from = today - params.touchSessions;
  if (from < params.swingSessions || today < 200) return null;

  const closes = bars.map((b) => b.close);
  const close = closes[today];
  const sma200 = smaAt(closes, 200, today);
  if (sma200 == null || !(close > sma200)) return null;

  const swingHigh = Math.max(...bars.slice(today - params.swingSessions, today).map((b) => b.high));
  if (!(swingHigh > close)) return null;

  for (const period of params.smaPeriods) {
    const smaToday = smaAt(closes, period, today);
    if (smaToday == null || !(close > smaToday)) continue;

    let touch = -1;
    for (let i = from; i < today; i++) {
      const smaThen = smaAt(closes, period, i);
      if (smaThen != null && bars[i].low <= smaThen) {
        touch = i;
        break;
      }
    }
    if (touch < 0) continue;

    const touchLow = Math.min(...bars.slice(touch, today).map((b) => b.low));
    if (!(bars[today].low > touchLow)) continue;

    const target = swingHigh + (swingHigh - touchLow);
    return {
      pattern: "pullback",
      state: "triggered",
      date: bars[today].date,
      level: round2(close),
      target: round2(target),
    };
  }
  return null;
}
