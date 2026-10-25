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
  if (!Number.isFinite(cents)) throw new RangeError(`money is too large to count in cents; got: ${n}`);
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

/** The tolerance of a ticket against its cash or position, and the smallest balance that counts: one cent, unrounded. */
const A_CENT = 1 / CENTS;

/** True if `a` is more than a cent above `b`, compared exactly (not at the cent): how far a buy or a sale may overshoot its cash or position (ADR-0011). */
export const overByMoreThanACent = (a: number, b: number): boolean => a > b + A_CENT;

/** True if a balance (cash, capital, a previous value) is worth more than a cent: below that it is rounding dust, not money. */
export const isMoreThanACent = (balance: number): boolean => balance > A_CENT;

/** Units that a cent is worth at `price`: the precision of units derived from an amount rounded to the cent. */
export const unitsWorthACent = (price: number): number => 1 / CENTS / price;

/** Units that half a cent is worth at `price`: what an amount rounded to the cent leaves unknown. */
export const unitsWorthHalfACent = (price: number): number => 0.5 / CENTS / price;

/** The one way to write money in a report or an email: two decimals. */
export function formatMoney(amount: number): string {
  return amount.toFixed(2);
}

/**
 * Each finite non-negative double as an integer of a common power of two, so the weights keep every bit
 * they have: the shares come from the exact weights, as the float sharing of `allocateByWeight` did.
 */
function exactWeights(weights: readonly number[]): bigint[] {
  const parts = weights.map((x) => {
    if (!Number.isFinite(x) || x < 0) throw new RangeError("the weights of a share must be >= 0 and not all 0");
    if (x === 0) return { mantissa: 0n, exponent: 0 };
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, x);
    const bits = view.getBigUint64(0);
    const biased = Number((bits >> 52n) & 0x7ffn);
    const fraction = bits & 0xfffffffffffffn;
    return biased === 0
      ? { mantissa: fraction, exponent: -1074 }
      : { mantissa: fraction | (1n << 52n), exponent: biased - 1075 };
  });
  const lowest = Math.min(...parts.map((p) => p.exponent));
  return parts.map((p) => p.mantissa << BigInt(p.exponent - lowest));
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
  const w = exactWeights(weights);
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

/** True if a value is dust (`DUST_LIMIT`): too small to be kept at `EXACT_AMOUNT_DECIMALS` decimals. */
export const isDust = (value: number): boolean => Math.abs(value) < DUST_LIMIT;

/** The amount of a trade from a value: to the cent, unless that rounds to 0 and the value is not dust, then exact. */
export function exactAmount(value: number): number {
  const cents = money(value);
  if (cents !== 0 || isDust(value)) return cents;
  const f = 10 ** EXACT_AMOUNT_DECIMALS;
  return Math.round(value * f) / f;
}

/** Shares the amount of a sale over weights to `EXACT_AMOUNT_DECIMALS` decimals (`share`): each exit's exact part. */
export function shareExactAmount(total: number, weights: readonly number[]): number[] {
  return share(total, weights, EXACT_AMOUNT_DECIMALS);
}
