// The command handlers of the inbox (#131, spec #124, ADR-0018): one independent, pure handler per command,
// `(state, command) -> new state or a reason`. No I/O, no clock, no config: `inbox:check` runs them over a
// batch without writing anything, and `inbox:ingest` (#132) will run the same ones before it applies the batch.
//
// The state is both silos of the portfolio. The currency is enforced by the type only where a silo is
// picked at run time (`state[command.currency]`, #145), so every handler checks it explicitly before it
// touches a silo (`siloOf`).
import { CURRENCIES, type Currency, type Lot, type PortfolioSnapshot, type Position } from "../types.js";
import { tickerIdPart, type Ticker } from "../ticker.js";
import {
  addCounted,
  formatMoney,
  countedInCents,
  isCountedRefusal,
  subtractCounted,
  type Money,
  zero,
} from "../money.js";
import { planSale, SaleRefusal } from "./portfolio-lots.js";
import { printable } from "./printable.js";
import { UNITS_TOLERANCE } from "./units.js";

// ─── Commands ─────────────────────────────────────────────────────────────────

/** Cash into a silo. */
export interface Deposit<C extends Currency = Currency> {
  kind: "deposit";
  currency: C;
  amount: Money<C>;
}

/** Cash out of a silo. */
export interface Withdrawal<C extends Currency = Currency> {
  kind: "withdrawal";
  currency: C;
  amount: Money<C>;
}

/** Units bought; a buy of a ticker already held is a scale-in (it opens one more lot). */
export interface Buy<C extends Currency = Currency> {
  kind: "buy";
  currency: C;
  ticker: Ticker;
  /** YYYY-MM-DD. */
  date: string;
  units: number;
  price: number;
  costs?: Money<C>;
}

/**
 * Sets or moves the one stop of a position, a price. It is also the initial stop (the base of R) of the lots
 * the same batch opened before it. A buy carries no stop: buying and setting a stop are two commands.
 */
export interface SetStop<C extends Currency = Currency> {
  kind: "set_stop";
  currency: C;
  ticker: Ticker;
  /** YYYY-MM-DD, when given. */
  date?: string;
  price: number;
}

/**
 * Removes the stop of a position. It has no amount, so no currency: the silo is the one that holds the ticker.
 */
export interface ClearStop {
  kind: "clear_stop";
  ticker: Ticker;
  /** YYYY-MM-DD, when given. */
  date?: string;
}

/** Units sold, oldest lot first or from one named lot; an executed stop is a sale the broker made at the stop. */
export interface Sale<C extends Currency = Currency> {
  kind: "sale";
  currency: C;
  ticker: Ticker;
  /** YYYY-MM-DD. */
  date: string;
  units: number;
  price: number;
  costs?: Money<C>;
  /** Entry id of the lot sold; absent: first in, first out over the ticker's lots. */
  lot?: string;
  stopExecuted: boolean;
}

export type Command<C extends Currency = Currency> =
  Deposit<C> | Withdrawal<C> | Buy<C> | Sale<C> | SetStop<C> | ClearStop;

// ─── State and result ─────────────────────────────────────────────────────────

/** What the handlers work on: each silo's portfolio, in its own currency; a silo the portfolio does not have is absent. */
export type InboxState = { readonly [C in Currency]?: PortfolioSnapshot<C> };

/**
 * What a handler returns: the new state, or why the command is refused. A buy also says which lot it opened
 * (`opened`, see `openedKey`): the batch passes those to the handlers after it, so a `set_stop` knows which
 * lots are the batch's own.
 */
export type HandlerResult = { state: InboxState; opened?: string } | { reason: string };

/** The lots the commands before the current one, in the same batch, opened; see `openedKey`. */
export type OpenedLots = ReadonlySet<string>;

/** Identifies a lot across silos: entry ids are only unique within one. */
export const openedKey = (currency: Currency, entryId: string): string => `${currency}/${entryId}`;

/**
 * Which command opened a lot, for the lots the batch under check has opened: the `openedKey` of the lot to the
 * words a refusal uses for it ("command 2 of this batch"). A lot it does not name is the portfolio's.
 */
export type LotSources = ReadonlyMap<string, string>;

const refused = (reason: string): { reason: string } => ({ reason });

/** The silo of `currency`, or why the command cannot be applied to it. */
function siloOf<C extends Currency>(state: InboxState, currency: C): PortfolioSnapshot<C> | { reason: string } {
  const silo = state[currency];
  if (silo?.currency !== currency) {
    return refused(`there is no ${currency} silo in the portfolio`);
  }
  return silo;
}

const isRefusal = (value: object): value is { reason: string } => "reason" in value;

/** The state with `silo` in place of its currency's. */
function withSilo<C extends Currency>(state: InboxState, silo: PortfolioSnapshot<C>): InboxState {
  return { ...state, [silo.currency]: silo };
}

/** `cash` and `totalCash` (when the portfolio tells it) moved by `delta`: both are cash of the silo. */
function movedCash<C extends Currency>(
  silo: PortfolioSnapshot<C>,
  delta: Money<C>,
  what: string,
): PortfolioSnapshot<C> {
  const cash = addCounted(silo.cash, delta, `the ${silo.currency} cash after ${what}`);
  return {
    ...silo,
    cash,
    ...(silo.totalCash !== undefined
      ? { totalCash: addCounted(silo.totalCash, delta, `the ${silo.currency} total cash after ${what}`) }
      : {}),
  };
}

/** The reason for units no lot could be closed with: `planSale` takes less than this as nothing left to sell. */
const tooFewUnits = (units: number): string =>
  `${units} units is below the units tolerance (${UNITS_TOLERANCE}): a lot of that size could never be sold`;

const show = (amount: number, currency: Currency): string => `${formatMoney(amount)} ${currency}`;

// ─── Handlers ─────────────────────────────────────────────────────────────────

export function deposit<C extends Currency>(state: InboxState, command: Deposit<C>): HandlerResult {
  const silo = siloOf(state, command.currency);
  if (isRefusal(silo)) return silo;
  return { state: withSilo(state, movedCash(silo, command.amount, "the deposit")) };
}

export function withdrawal<C extends Currency>(state: InboxState, command: Withdrawal<C>): HandlerResult {
  const silo = siloOf(state, command.currency);
  if (isRefusal(silo)) return silo;
  if (command.amount > silo.cash) {
    return refused(
      `the withdrawal of ${show(command.amount, command.currency)} exceeds the available cash of ${show(silo.cash, command.currency)}`,
    );
  }
  return {
    state: withSilo(
      state,
      movedCash(silo, subtractCounted(zero(command.currency), command.amount, "the withdrawal"), "the withdrawal"),
    ),
  };
}

/** The id of the lot a buy opens: its date and ticker, with a counter when one is already taken. */
function newEntryId(date: string, ticker: Ticker, taken: ReadonlySet<string>): string {
  const base = `${date.replace(/-/g, "")}-${tickerIdPart(ticker)}-entry`;
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

export function buy<C extends Currency>(state: InboxState, command: Buy<C>): HandlerResult {
  const silo = siloOf(state, command.currency);
  if (isRefusal(silo)) return silo;
  const { currency, ticker } = command;
  if (command.units < UNITS_TOLERANCE) return refused(tooFewUnits(command.units));
  const amount = countedInCents(
    command.units * command.price,
    `the amount of the buy of ${printable(ticker)}`,
    currency,
  );
  if (amount === 0) {
    return refused(
      `the buy of ${printable(ticker)} costs nothing: ${command.units} units at ${command.price} is below one cent`,
    );
  }
  const cost = addCounted(amount, command.costs ?? zero(currency), `the cost of the buy of ${printable(ticker)}`);
  if (cost > silo.cash) {
    return refused(
      `the buy of ${printable(ticker)} costs ${show(cost, currency)}, more than the available cash of ${show(silo.cash, currency)}`,
    );
  }
  const held = silo.positions.find((p) => p.ticker === ticker);
  const lot: Lot<C> = {
    ticker,
    entryId: newEntryId(command.date, ticker, new Set(silo.lots.map((l) => l.entryId))),
    date: command.date,
    units: command.units,
    entryUnits: command.units,
    entryPrice: command.price,
    // A buy never changes the stop: the lot starts with the one the position has (a `set_stop` later in
    // the batch replaces it), or none, and then it carries `no_stop` when the batch is applied (#132).
    initialStop: held?.stopLoss ?? null,
    entryCosts: command.costs ?? null,
    origin: "propietario",
    // The rules version is filled when the batch is applied (#132); the check does not need it.
    rulesVersion: "",
    rulesViolations: [],
  };
  const position: Position<C> = held
    ? {
        ...held,
        volume: held.volume + command.units,
        avgPrice: (held.volume * held.avgPrice + command.units * command.price) / (held.volume + command.units),
      }
    : {
        ticker,
        currency,
        volume: command.units,
        avgPrice: command.price,
        currentPrice: command.price,
        pl: zero(currency),
        stopLoss: null,
      };
  const paid = movedCash(
    silo,
    subtractCounted(zero(currency), cost, `the buy of ${printable(ticker)}`),
    `the buy of ${printable(ticker)}`,
  );
  return {
    state: withSilo(state, {
      ...paid,
      lots: [...silo.lots, lot],
      positions: held ? silo.positions.map((p) => (p === held ? position : p)) : [...silo.positions, position],
    }),
    opened: openedKey(currency, lot.entryId),
  };
}

/** Where `lots` come from, in words: `portfolio.md`, the commands that opened them, or both. */
function describeSources(lots: readonly Lot[], currency: Currency, sources: LotSources): string {
  const labels = new Set<string>();
  let fromPortfolio = lots.length === 0;
  for (const lot of lots) {
    const label = sources.get(openedKey(currency, lot.entryId));
    if (label === undefined) fromPortfolio = true;
    else labels.add(label);
  }
  // No lot at all: they may have been in the portfolio or opened (and sold) by the batch, so name both when it opened any.
  if (lots.length === 0 && [...sources.keys()].some((key) => key.startsWith(`${currency}/`))) {
    labels.add("the earlier commands");
  }
  return [...(fromPortfolio ? ["portfolio.md"] : []), ...labels].join(" and ");
}

export function setStop<C extends Currency>(
  state: InboxState,
  command: SetStop<C>,
  opened: OpenedLots = new Set(),
): HandlerResult {
  const silo = siloOf(state, command.currency);
  if (isRefusal(silo)) return silo;
  const { currency, ticker, price } = command;
  if (!(price > 0)) return refused(`the stop of ${ticker}: the price must be greater than zero`);
  const held = silo.positions.find((p) => p.ticker === ticker);
  if (held === undefined)
    return refused(`cannot set a stop: there is no open position in ${ticker} in the ${currency} silo`);
  return {
    state: withSilo(state, {
      ...silo,
      positions: silo.positions.map((p) => (p === held ? { ...p, stopLoss: price } : p)),
      // The lots this batch opened before the command start with this stop; the older ones keep theirs (their R).
      lots: silo.lots.map((l) =>
        opened.has(openedKey(currency, l.entryId)) && l.ticker === ticker ? { ...l, initialStop: price } : l,
      ),
    }),
  };
}

export function clearStop(state: InboxState, command: ClearStop, opened: OpenedLots = new Set()): HandlerResult {
  const { ticker } = command;
  const silos = CURRENCIES.flatMap((c) => {
    const silo = siloOf(state, c);
    return !isRefusal(silo) && silo.positions.some((p) => p.ticker === ticker) ? [silo] : [];
  });
  if (silos.length === 0) return refused(`cannot clear a stop: there is no open position in ${ticker}`);
  const stopped = silos.filter((silo) => silo.positions.some((p) => p.ticker === ticker && p.stopLoss !== null));
  if (stopped.length === 0) return refused(`cannot clear a stop: ${ticker} has no stop to clear`);
  let next = state;
  for (const silo of stopped) {
    next = withSilo(next, {
      ...silo,
      positions: silo.positions.map((p) => (p.ticker === ticker ? { ...p, stopLoss: null } : p)),
      // The position ends with no stop, so the lots this batch opened start with none (they carry `no_stop`).
      lots: silo.lots.map((l) =>
        opened.has(openedKey(silo.currency, l.entryId)) && l.ticker === ticker ? { ...l, initialStop: null } : l,
      ),
    });
  }
  return { state: next };
}

export function sale<C extends Currency>(
  state: InboxState,
  command: Sale<C>,
  sources: LotSources = new Map(),
): HandlerResult {
  const silo = siloOf(state, command.currency);
  if (isRefusal(silo)) return silo;
  const { currency, ticker } = command;
  if (command.units < UNITS_TOLERANCE) return refused(tooFewUnits(command.units));
  // Which lots are sold is this handler's to say; how many units they give, and the tolerance, are `planSale`'s.
  const chosen = silo.lots.filter(
    (l) => l.ticker === ticker && (command.lot === undefined || l.entryId === command.lot),
  );
  if (command.lot !== undefined && !chosen.some((l) => l.units > 0)) {
    return refused(
      `cannot sell lot ${JSON.stringify(command.lot)}: ${printable(ticker)} has no open lot with that id in the ${currency} silo`,
    );
  }
  const amount = countedInCents(
    command.units * command.price,
    `the amount of the sale of ${printable(ticker)}`,
    currency,
  );
  let shares: ReturnType<typeof planSale<C>>;
  try {
    shares = planSale(
      chosen,
      {
        ticker,
        currency,
        units: command.units,
        price: command.price,
        amount,
        costs: command.costs,
        lotsFrom: describeSources(
          chosen.filter((l) => l.units > 0),
          currency,
          sources,
        ),
      },
      new Map(),
    );
  } catch (err) {
    // Only the lot arithmetic's own refusals are reasons; anything else is a bug and must crash.
    if (err instanceof SaleRefusal) return refused(err.message);
    throw err;
  }
  // Checked after the lots so that an unheld ticker or too many units report their real reason, not this one.
  if (amount === 0) {
    return refused(
      `the sale of ${ticker} yields nothing: ${command.units} units at ${command.price} is below one cent`,
    );
  }
  const costs = command.costs ?? zero(currency);
  if (costs > amount) {
    return refused(
      `the costs of ${show(costs, currency)} exceed the proceeds of ${show(amount, currency)} of the sale of ${printable(ticker)}`,
    );
  }
  const received = subtractCounted(amount, costs, `the proceeds of the sale of ${printable(ticker)}`);
  const credited = movedCash(silo, received, `the sale of ${printable(ticker)}`);
  // The costs are at most the proceeds, so a sale never lowers the cash: there is no cash-below-zero refusal for it.
  const left = new Map(shares.map((share) => [share.lot.entryId, share.unitsLeft]));
  const lots = silo.lots
    .map((lot) => ({ ...lot, units: left.get(lot.entryId) ?? lot.units }))
    .filter((lot) => lot.units > 0);
  // The position is what the lots left say it is: their units and their average entry price.
  const remaining = lots.filter((l) => l.ticker === ticker);
  const volume = remaining.reduce((sum, l) => sum + l.units, 0);
  const avgPrice = remaining.reduce((sum, l) => sum + l.units * l.entryPrice, 0) / volume;
  const positions = silo.positions.flatMap((p) =>
    p.ticker !== ticker ? [p] : volume > UNITS_TOLERANCE ? [{ ...p, volume, avgPrice }] : [],
  );
  return { state: withSilo(state, { ...credited, lots, positions }) };
}

/**
 * Applies one command to the state: the new state, or the reason it is refused. `opened`: the lots the batch
 * opened before it, for the stops; `sources`: who opened them, for the words of a sale refusal. Never throws for
 * an amount too large to count.
 */
export function applyCommand(
  state: InboxState,
  command: Command,
  opened: OpenedLots = new Set(),
  sources: LotSources = new Map(),
): HandlerResult {
  try {
    switch (command.kind) {
      case "deposit":
        return deposit(state, command);
      case "withdrawal":
        return withdrawal(state, command);
      case "buy":
        return buy(state, command);
      case "sale":
        return sale(state, command, sources);
      case "set_stop":
        return setStop(state, command, opened);
      case "clear_stop":
        return clearStop(state, command, opened);
    }
  } catch (err) {
    if (isCountedRefusal(err)) return refused(err.message);
    throw err;
  }
}
