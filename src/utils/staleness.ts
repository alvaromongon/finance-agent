// How stale a silo is (#138): measured from the day of its latest snapshot of the broker, the one thing that says the
// engine's state was compared with the broker. A silo with no snapshot is stale, never fresh by default: the engine
// integrates with no broker, so a state nobody ever compared may be wrong. Pure.

export interface Staleness {
  /** The day (or time) the latest snapshot is as of; `null`: none was ever recorded, or it does not read. */
  asOf: string | null;
  /** Days between `asOf` and now, to a tenth; `null` with no snapshot. */
  ageDays: number | null;
  stale: boolean;
}

const DAY_MS = 86_400_000;

/** The staleness of a silo whose latest snapshot is as of `asOf`, judged at `now` against `maxAgeDays`. */
export function stalenessOf(asOf: string | null | undefined, now: Date, maxAgeDays: number): Staleness {
  const time = asOf == null ? Number.NaN : Date.parse(asOf);
  if (asOf == null || Number.isNaN(time)) return { asOf: null, ageDays: null, stale: true };
  const age = (now.getTime() - time) / DAY_MS;
  return { asOf, ageDays: Math.round(age * 10) / 10, stale: age > maxAgeDays };
}
