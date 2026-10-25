// Money, a domain value (ADR-0017): a number in units of the silo currency that is always a whole
// number of cents, made only by `money`, compared at the cent, shared by the largest-remainder method
// and formatted by one function. No other code writes its own cent tolerance or `toFixed(2)`.
//
// Prices, exchange rates, units and percentages are not money and stay plain numbers. The amount of a
// trade is the one exception: an exit's `amount` is its exact share of the sale amount and may have
// sub-cent decimals (owner decision of 2026-10-22 in #27), so it is a plain number kept to
// `EXACT_AMOUNT_DECIMALS` decimals (`exactAmount`, `shareExactAmount`).

declare const moneyBrand: unique symbol;

/** An amount of the silo currency, a whole number of cents. A branded number, so it survives JSON. */
export type Money = number & { readonly [moneyBrand]: "Money" };

const CENTS = 100;

/** The only way to make a `Money`: rounds to whole cents (half away from zero on the positive side, as `Math.round`). Throws on a value that is not finite. */
export function money(n: number): Money {
  if (typeof n !== "number" || !Number.isFinite(n)) throw new RangeError(`money must be a finite number; got: ${n}`);
  const cents = Math.round(n * CENTS);
  return (cents === 0 ? 0 : cents / CENTS) as Money;
}

export const ZERO: Money = money(0);

/** The whole number of cents of an amount, for comparing and sharing without float noise. */
const centsOf = (n: number): number => Math.round(n * CENTS);

export const addMoney = (a: Money, b: Money): Money => money(a + b);
export const subtractMoney = (a: Money, b: Money): Money => money(a - b);
export const sumMoney = (values: Iterable<Money>): Money => {
  let cents = 0;
  for (const value of values) cents += centsOf(value);
  return money(cents / CENTS);
};

/** True if two amounts are the same at the cent: the one comparison of money, whatever the float noise. */
export const sameCents = (a: number, b: number): boolean => centsOf(a) === centsOf(b);

/** True if two amounts differ by at most one cent (a trade's amount and `units × price` must agree to this). */
export const withinACent = (a: number, b: number): boolean => Math.abs(a - b) <= 1 / CENTS + 1e-9;

/** True if `a` is more than a cent above `b`: how far a buy or a sale may overshoot its cash or position and still pass. */
export const overByMoreThanACent = (a: number, b: number): boolean => centsOf(a) - centsOf(b) > 1;

/** Units that a cent is worth at `price`: the precision of units derived from an amount rounded to the cent. */
export const unitsWorthACent = (price: number): number => 1 / CENTS / price;

/** Units that half a cent is worth at `price`: what an amount rounded to the cent leaves unknown. */
export const unitsWorthHalfACent = (price: number): number => 0.5 / CENTS / price;

/** The one way to write money in a report or an email: two decimals. */
export function formatMoney(amount: number): string {
  return amount.toFixed(2);
}

/**
 * Shares `total` over `weights` in whole units of 10^-`decimals`, by the largest-remainder method: each
 * share is its exact part rounded down and the units left over go one each to the largest remainders
 * (the later on a tie). No share is negative (all are <= 0 for a negative total) and the shares add up
 * exactly to `total` rounded to that unit. Done in integers (BigInt), so there is no float noise to clear.
 */
function share(total: number, weights: readonly number[], decimals: number): number[] {
  if (weights.length === 0) return [];
  const unit = 10 ** decimals;
  const scale = 1e8;
  const w = weights.map((x) => BigInt(Math.round(x * scale)));
  const weightSum = w.reduce((a, b) => a + b, 0n);
  if (weightSum <= 0n || w.some((x) => x < 0n))
    throw new RangeError("the weights of a share must be >= 0 and not all 0");
  const sign = total < 0 ? -1 : 1;
  const units = BigInt(Math.round(Math.abs(total) * unit));
  const shares = w.map((x) => (units * x) / weightSum);
  const remainders = w.map((x) => (units * x) % weightSum);
  const left = Number(units - shares.reduce((a, b) => a + b, 0n));
  const byRemainder = remainders
    .map((remainder, i) => ({ i, remainder }))
    .sort((a, b) => (a.remainder === b.remainder ? b.i - a.i : a.remainder > b.remainder ? -1 : 1));
  for (let k = 0; k < left; k++) shares[byRemainder[k].i]++;
  return shares.map((n) => (n === 0n ? 0 : (sign * Number(n)) / unit));
}

/** Shares an amount over weights in whole cents (`share`): the shares add up exactly to the total. */
export function shareMoney(total: Money, weights: readonly number[]): Money[] {
  return share(total, weights, 2) as Money[];
}

// ─── The amount of a trade ────────────────────────────────────────────────────

/** Decimals of the amount of a trade: its exact value, with the float noise cleared. */
export const EXACT_AMOUNT_DECIMALS = 8;

/**
 * The dust limit, the one rule: an amount of a trade is kept to `EXACT_AMOUNT_DECIMALS` decimals, so
 * one that rounds to 0 there (under half of the last decimal, 5e-9 of the silo currency) is dust: its
 * amount is 0 and it cannot be recorded or sold.
 */
export const DUST_LIMIT = 0.5 / 10 ** EXACT_AMOUNT_DECIMALS;

/** The amount of a trade from a value: to the cent, unless that rounds to 0 and the value is not dust, then exact. */
export function exactAmount(value: number): number {
  const cents = money(value);
  if (cents !== 0) return cents;
  const f = 10 ** EXACT_AMOUNT_DECIMALS;
  return Math.round(value * f) / f;
}

/** Shares the amount of a sale over weights to `EXACT_AMOUNT_DECIMALS` decimals (`share`): each exit's exact part. */
export function shareExactAmount(total: number, weights: readonly number[]): number[] {
  return share(total, weights, EXACT_AMOUNT_DECIMALS);
}
