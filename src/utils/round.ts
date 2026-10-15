// Shared rounding: cents for amounts and prices, and arbitrary decimals where
// the data needs them (exchange rates).

/** Rounds to `decimals` decimals. */
export function round(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

/** Rounds to cents. Single-argument, so it can be passed to `map`. */
export function round2(n: number): number {
  return round(n, 2);
}
