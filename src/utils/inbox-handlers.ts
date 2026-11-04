// The command handlers of the inbox (#131, spec #124, ADR-0018): one independent, pure handler per command,
// `(state, command) -> new state or a reason`. No I/O, no clock, no config: `inbox:check` runs them over a
// batch without writing anything, and `inbox:ingest` (#132) will run the same ones before it applies the batch.
//
// The state is both silos of the portfolio. The currency is enforced by the type only where a silo is
// picked at run time (`state[command.currency]`, #145), so every handler checks it explicitly before it
// touches a silo (`siloOf`).
import type { Currency, Lot, PortfolioSnapshot, Position } from "../types.js";
import { tickerIdPart, type Ticker } from "../ticker.js";
import { addCounted, countedInCents, isCountedRefusal, subtractCounted, type Money, zero } from "../money.js";
import { planSale } from "./portfolio-lots.js";
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
  /** Initial stop, a price. */
  stop?: number;
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

export type Command<C extends Currency = Currency> = Deposit<C> | Withdrawal<C> | Buy<C> | Sale<C>;

// ─── State and result ─────────────────────────────────────────────────────────

/** What the handlers work on: each silo's portfolio, in its own currency. */
export type InboxState = { readonly [C in Currency]: PortfolioSnapshot<C> };

export type HandlerResult = { state: InboxState } | { reason: string };

const refused = (reason: string): { reason: string } => ({ reason });

/** The silo of `currency`, or why the command cannot be applied to it. */
function siloOf<C extends Currency>(state: InboxState, currency: C): PortfolioSnapshot<C> | { reason: string } {
  const silo = state[currency] as PortfolioSnapshot<C> | undefined;
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

const show = (amount: number, currency: Currency): string => `${amount.toFixed(2)} ${currency}`;

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
  const amount = countedInCents(command.units * command.price, `the amount of the buy of ${ticker}`, currency);
  const cost = addCounted(amount, command.costs ?? zero(currency), `the cost of the buy of ${ticker}`);
  if (cost > silo.cash) {
    return refused(
      `the buy of ${ticker} costs ${show(cost, currency)}, more than the available cash of ${show(silo.cash, currency)}`,
    );
  }
  const lot: Lot<C> = {
    ticker,
    entryId: newEntryId(command.date, ticker, new Set(silo.lots.map((l) => l.entryId))),
    date: command.date,
    units: command.units,
    entryUnits: command.units,
    entryPrice: command.price,
    initialStop: command.stop ?? null,
    entryCosts: command.costs ?? null,
    origin: "propietario",
    // The rules version is filled when the batch is applied (#132); the check does not need it.
    rulesVersion: "",
    rulesViolations: [],
  };
  const held = silo.positions.find((p) => p.ticker === ticker);
  const position: Position<C> = held
    ? {
        ...held,
        volume: held.volume + command.units,
        avgPrice: (held.volume * held.avgPrice + command.units * command.price) / (held.volume + command.units),
        stopLoss: command.stop ?? held.stopLoss,
      }
    : {
        ticker,
        currency,
        volume: command.units,
        avgPrice: command.price,
        currentPrice: command.price,
        pl: zero(currency),
        stopLoss: command.stop ?? null,
      };
  const paid = movedCash(silo, subtractCounted(zero(currency), cost, `the buy of ${ticker}`), `the buy of ${ticker}`);
  return {
    state: withSilo(state, {
      ...paid,
      lots: [...silo.lots, lot],
      positions: held ? silo.positions.map((p) => (p === held ? position : p)) : [...silo.positions, position],
    }),
  };
}

export function sale<C extends Currency>(state: InboxState, command: Sale<C>): HandlerResult {
  const silo = siloOf(state, command.currency);
  if (isRefusal(silo)) return silo;
  const { currency, ticker } = command;
  const ofTicker = silo.lots.filter((l) => l.ticker === ticker && l.units > 0);
  if (ofTicker.length === 0) return refused(`cannot sell ${ticker}: no open lot of ${ticker} in the ${currency} silo`);
  const chosen = command.lot === undefined ? ofTicker : ofTicker.filter((l) => l.entryId === command.lot);
  if (chosen.length === 0) return refused(`cannot sell lot ${command.lot}: ${ticker} has no open lot with that id`);
  const open = chosen.reduce((sum, l) => sum + l.units, 0);
  if (command.units > open + UNITS_TOLERANCE) {
    return refused(
      `cannot sell ${command.units} units of ${ticker}: only ${open} are open${command.lot === undefined ? "" : ` in lot ${command.lot}`}`,
    );
  }
  const amount = countedInCents(command.units * command.price, `the amount of the sale of ${ticker}`, currency);
  let shares: ReturnType<typeof planSale<C>>;
  try {
    shares = planSale(
      chosen,
      { ticker, currency, units: command.units, price: command.price, amount, costs: command.costs },
      new Map(),
    );
  } catch (err) {
    // The lot arithmetic refuses in words (an entry cost that cannot be shared): a reason, not a crash.
    if (err instanceof Error) return refused(err.message);
    throw err;
  }
  const left = new Map(shares.map((share) => [share.lot.entryId, share.unitsLeft]));
  const lots = silo.lots
    .map((lot) => ({ ...lot, units: left.get(lot.entryId) ?? lot.units }))
    .filter((lot) => lot.units > 0);
  const volume = lots.filter((l) => l.ticker === ticker).reduce((sum, l) => sum + l.units, 0);
  const positions = silo.positions.flatMap((p) =>
    p.ticker !== ticker ? [p] : volume > UNITS_TOLERANCE ? [{ ...p, volume }] : [],
  );
  const received = subtractCounted(amount, command.costs ?? zero(currency), `the proceeds of the sale of ${ticker}`);
  const credited = movedCash(silo, received, `the sale of ${ticker}`);
  return { state: withSilo(state, { ...credited, lots, positions }) };
}

/** Applies one command to the state: the new state, or the reason it is refused. Never throws for an amount too large to count. */
export function applyCommand(state: InboxState, command: Command): HandlerResult {
  try {
    switch (command.kind) {
      case "deposit":
        return deposit(state, command);
      case "withdrawal":
        return withdrawal(state, command);
      case "buy":
        return buy(state, command);
      case "sale":
        return sale(state, command);
    }
  } catch (err) {
    if (isCountedRefusal(err)) return refused(err.message);
    throw err;
  }
}
