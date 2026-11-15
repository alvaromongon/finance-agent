// Lot keeping for `decision:record` (ADR-0015, #42). Pure: no I/O, no config, no text of any file. The
// recorder reads the portfolio and the log, plans with these functions, then writes the log and hands the
// new lots to the portfolio store.
//
// - `lotOfEntry`: the lot an entry opens.
// - `planSale`: which lots a sale consumes (first in, first out) and what each exit carries.
import type { Decision } from "../decisions.js";
import type { Currency, Lot } from "../types.js";
import { printable } from "./printable.js";
import { UNITS_TOLERANCE } from "./units.js";
import type { Ticker } from "../ticker.js";
import {
  addCounted,
  countedInCents,
  shareExactAmount,
  shareMoney,
  subtractCounted,
  sumCounted,
  unitsWorthHalfACent,
  zero,
  type Money,
} from "../money.js";

/** How a refusal names the file the lots are in, unless the caller says where they come from. */
export const LOTS_SOURCE = "portfolio.md";

/**
 * `planSale` refuses a sale in words (no open lot, more units than open, an entry cost that cannot be shared):
 * the owner's data, not a bug. `message` names the lots as `LOTS_SOURCE`; `named` gives it with the words of the
 * caller who knows better where the lots come from (the inbox: some were opened by its own commands).
 */
export class SaleRefusal extends Error {
  readonly named: (lotsFrom: string) => string;

  constructor(message: string | ((lotsFrom: string) => string)) {
    const named = typeof message === "string" ? () => message : message;
    super(named(LOTS_SOURCE));
    this.name = "SaleRefusal";
    this.named = named;
  }
}

/**
 * The one rule "a lot cannot be sold before it was bought" (the same day is a round trip), for the
 * validation of a recorded exit and for the refusal of a sale before it is recorded.
 */
export const entryAfterExit = (entryDate: string, exitDate: string): boolean => entryDate > exitDate;

/**
 * What the exits already written took of each lot's entry costs, by entry id: a sale does not take it twice. The
 * history may hold both silos; an exit adds its costs in its own currency.
 */
export function entryCostsTaken(history: readonly Decision[]): Map<string, Money> {
  const taken = new Map<string, Money>();
  for (const d of history) {
    if (d.type === "exit" && d.related_id && d.entry_costs != null) {
      taken.set(
        d.related_id,
        addCounted(
          taken.get(d.related_id) ?? zero(d.currency),
          d.entry_costs,
          `the entry_costs the exits of entry ${d.related_id} took together`,
        ),
      );
    }
  }
  return taken;
}

/** The lot an entry opens: all the units it bought, with the entry's own data as its snapshot. */
export function lotOfEntry<C extends Currency>(entry: Decision & { currency: C }, units: number): Lot<C> {
  return {
    ticker: entry.ticker!,
    entryId: entry.id,
    date: entry.date,
    units,
    entryUnits: units,
    entryPrice: entry.price!,
    initialStop: entry.stop_initial ?? null,
    entryCosts: (entry.costs as Money<C> | undefined) ?? null,
    origin: entry.origin,
    rulesVersion: entry.rules_version,
    rulesViolations: entry.rule_violations ?? [],
  };
}

// ─── Sale: first in, first out ────────────────────────────────────────────────

export interface SalePlanInput<C extends Currency = Currency> {
  ticker: Ticker;
  /** Currency of the silo the sale is in: the one of its lots and of every amount it shares. */
  currency: C;
  /** Units sold. */
  units: number;
  /**
   * The units were derived from `amount / price` (the owner gave only the amount), so they are known
   * to half a cent of price: a lot that the sale leaves with less than that is used up. Absent when the
   * owner gave the units: they are exact and nothing is snapped.
   */
  unitsFromAmount?: boolean;
  price: number;
  /** Amount of the whole sale, in the silo currency. */
  amount: number;
  /** Costs of the whole sale; absent if none were given. */
  costs?: Money<C>;
  /**
   * Realized result of the whole sale if the owner gave it: each lot keeps its own computed result, net of its
   * share of the entry costs (they stay with their lot, #90), and the rest of the difference to the owner's
   * total is shared by units. Otherwise each lot's own is computed, before entry costs.
   */
  pnl?: Money<C>;
}

/** What one lot gives to a sale: one `exit` line. */
export interface SaleShare<C extends Currency = Currency> {
  lot: Lot<C>;
  unitsSold: number;
  /** The lot's `Units` after the sale; exactly 0 when it is used up. */
  unitsLeft: number;
  /** This exit's share of the sale amount; the shares add up to it. */
  amount: number;
  costs: Money<C> | undefined;
  pnl: Money<C>;
  /** This exit's share of the lot's entry costs; absent if the lot has none. */
  entryCosts: Money<C> | undefined;
}

/**
 * Consumes the ticker's lots first in, first out (oldest entry date first, ties in the order of the
 * table) until `sale.units` are sold. The amount and the costs of the sale are shared across the lots
 * pro rata to the units; each exit's result is its lot's own (from its entry price), plus, when the owner
 * gave the result of the whole sale, its units' share of the difference to the computed sum, which counts each
 * lot's share of its entry costs (below) as part of the lot's own result. The exits add up to the sale
 * (`shareMoney`: never a negative share). A lot's sign is kept before costs and FX; they can change it.
 * The amount is shared exactly (not to the cent: a lot of a few units of a low-priced asset would get
 * 0.00); the costs and the result, which are settled money, go to the cent.
 * A lot's entry costs go pro rata too, and the exit that uses the lot up takes what is left of them
 * (`priorEntryCosts`: what earlier exits of each lot already took), so the exits of one lot add up
 * to its `Entry costs`. Throws if the ticker has no lots or fewer units than the sale.
 */
export function planSale<C extends Currency>(
  lots: readonly Lot<C>[],
  sale: SalePlanInput<C>,
  priorEntryCosts: ReadonlyMap<string, Money<C>>,
): SaleShare<C>[] {
  const ordered = lots
    .map((lot, index) => ({ lot, index }))
    .filter(({ lot }) => lot.ticker === sale.ticker && lot.units > 0)
    .sort((a, b) => a.lot.date.localeCompare(b.lot.date) || a.index - b.index)
    .map(({ lot }) => lot);
  if (ordered.length === 0)
    throw new SaleRefusal(
      (lotsFrom) => `Cannot sell ${printable(sale.ticker)}: no open lots for ${printable(sale.ticker)} in ${lotsFrom}`,
    );
  const open = ordered.reduce((sum, l) => sum + l.units, 0);
  // A sale narrated by amount has its units known to half a cent of price: that much over is the lot,
  // and that much under leaves nothing worth keeping: the lot is used up (a position of dust is not one).
  // Units the owner gave are exact: on a low-priced asset half a cent of price is several units.
  const tolerance = (sale.unitsFromAmount ? unitsWorthHalfACent(sale.price) : 0) + UNITS_TOLERANCE;
  if (sale.units > open + tolerance) {
    throw new SaleRefusal(
      (lotsFrom) =>
        `Cannot sell ${sale.units} units of ${printable(sale.ticker)}: only ${open} are open in ${lotsFrom}`,
    );
  }

  const taken: { lot: Lot<C>; unitsSold: number; unitsLeft: number }[] = [];
  let remaining = sale.units;
  for (const lot of ordered) {
    if (remaining < UNITS_TOLERANCE || (taken.length > 0 && remaining <= tolerance)) break;
    const left = lot.units - Math.min(lot.units, remaining);
    const usedUp = left <= tolerance;
    const unitsSold = usedUp ? lot.units : lot.units - left;
    taken.push({ lot, unitsSold, unitsLeft: usedUp ? 0 : left });
    remaining -= unitsSold;
  }

  // The costs and the result are settled money, shared in whole cents. The amount is the exact share of
  // the sale amount (`shareExactAmount`), so that a lot of a few units of a low-priced asset does not get
  // 0.00 (the 8 decimals only clear float noise, as the file's number format does).
  const weights = taken.map((t) => t.unitsSold);
  const shareOf = (total: Money<C> | undefined): (Money<C> | undefined)[] =>
    total === undefined ? taken.map(() => undefined) : shareMoney(total, weights);
  const amounts = shareExactAmount(sale.amount, weights);
  const costs = shareOf(sale.costs);
  const entryCosts = taken.map((t) =>
    entryCostsShare(t, priorEntryCosts.get(t.lot.entryId) ?? zero(sale.currency), sale.currency),
  );
  // Each exit keeps its lot's own result (from the entry price). A result the owner gave for the whole
  // sale only moves them by the difference to the computed sum (costs, FX), shared by units in whole cents,
  // so a losing lot stays a loss when the sale as a whole is a gain.
  const computed = taken.map((t) =>
    countedInCents(
      (sale.price - t.lot.entryPrice) * t.unitsSold,
      `the result of ${lotName(t.lot)} (its Entry price)`,
      sale.currency,
    ),
  );
  // An owner-given result keeps each lot's entry costs with the lot (#90): the exit is its computed result minus
  // its own share of them, and only what remains of the difference to the owner's total (exit costs, FX) is shared.
  // Without it each exit is its computed result, before entry costs.
  const net =
    sale.pnl === undefined
      ? computed
      : computed.map((c, i) =>
          subtractCounted(
            c,
            entryCosts[i] ?? zero(sale.currency),
            `the result of ${lotName(taken[i].lot)} net of its entry costs`,
          ),
        );
  const difference =
    sale.pnl === undefined
      ? undefined
      : subtractCounted(
          sale.pnl,
          sumCounted(net, `the results of the lots of ${printable(sale.ticker)} sold together`, sale.currency),
          `the difference between the pnl and the results of the lots of ${printable(sale.ticker)}`,
        );
  const adjustments = shareOf(difference);

  return taken.map((t, i) => ({
    ...t,
    amount: amounts[i],
    costs: costs[i],
    pnl: addCounted(net[i], adjustments[i] ?? zero(sale.currency), `the result of ${lotName(t.lot)}`),
    entryCosts: entryCosts[i],
  }));
}

function entryCostsShare<C extends Currency>(
  t: { lot: Lot<C>; unitsSold: number; unitsLeft: number },
  taken: Money<C>,
  currency: C,
): Money<C> | undefined {
  const total = t.lot.entryCosts;
  if (total == null) return undefined;
  const remainder = subtractCounted(total, taken, `the entry costs of ${lotName(t.lot)} left`);
  const left = Math.max(remainder, zero(currency)) as Money<C>;
  if (t.unitsLeft === 0) return left;
  if (!(t.lot.entryUnits > 0)) {
    throw new SaleRefusal(
      `${lotName(t.lot)} has Entry units ${t.lot.entryUnits}: its entry costs cannot be shared over a partial sale (nothing was recorded)`,
    );
  }
  const share = countedInCents(
    (total * t.unitsSold) / t.lot.entryUnits,
    `the entry costs of ${lotName(t.lot)} taken by the sale`,
    currency,
  );
  return Math.min(share, left) as Money<C>;
}

/** How a lot is named in a refusal: its entry id and ticker. */
const lotName = (lot: Lot<Currency>): string => `lot ${printable(lot.entryId)} (${printable(lot.ticker)})`;
