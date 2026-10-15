// Market session guard: decides whether the data the provider just returned
// belong to a recent session or the market has been closed since earlier
// (holiday).
//
// Why it is not compared with "today":
//   The previous version aborted the run when the last tick date was not the
//   runner date (`marketDate.toDateString() !== today`). GitHub Actions crons
//   run late under load —seen firing at 00:53, 01:22, 03:13 and 05:31 UTC for
//   17:00 and 21:30 crons— and once past UTC midnight "today" was another day:
//   the run discarded correct prices it already had and ended without
//   evaluating anything. Between 26 and 31 August 2026, 4 of 5 runs died like
//   that and the heartbeat stopped watching the stops without anything going red.
//
// The right criterion is the data age, not the calendar day:
//   - on-time run after the close .....................  1–2 h
//   - cron several hours late (worst case seen) ........ ~9–13 h
//   - single-day weekday holiday ....................... ≥25 h
//   - weekend .......................................... ≥49 h
//   18 h splits the two groups with margin on both sides.

/** Maximum age (hours) of the last tick to consider the session current. */
export const DEFAULT_MAX_SESSION_AGE_HOURS = 18;

export interface MarketSessionCheck {
  /** true if the last tick is so old that the market was already closed. */
  stale: boolean;
  /** Age of the last tick in hours (negative if the local clock is behind). */
  ageHours: number;
}

/**
 * Compares the last tick time with the time of the run.
 * A null `marketDate` (the provider could not give the date) is NOT stale: the
 * absence of the control data must never kill a run that does have prices —
 * same criterion as the rest of the heartbeat's best-effort data.
 */
export function checkMarketSession(
  marketDate: Date | null,
  now: Date = new Date(),
  maxAgeHours: number = DEFAULT_MAX_SESSION_AGE_HOURS,
): MarketSessionCheck {
  if (marketDate == null) return { stale: false, ageHours: 0 };

  const ageHours = (now.getTime() - marketDate.getTime()) / 3_600_000;
  return { stale: ageHours > maxAgeHours, ageHours };
}
