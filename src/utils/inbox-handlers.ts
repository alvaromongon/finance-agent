// The command handlers of the inbox (#131, spec #124, ADR-0018): one independent, pure handler per command,
// `(state, command) -> new state or a reason`. No I/O, no clock, no config: `inbox:check` runs them over a
// batch without writing anything, and `inbox:ingest` (#132) runs the same ones, then applies the batch.
//
// The state is both silos of the portfolio. The currency is enforced by the type only where a silo is
// picked at run time (`state[command.currency]`, #145), so every handler checks it explicitly before it
// touches a silo (`siloOf`).
import { CURRENCIES, type Currency, type Lot, type PortfolioSnapshot, type Position } from "../types.js";
import type { Ticker } from "../ticker.js";
import {
  addCounted,
  formatMoney,
  countedInCents,
  exactAmount,
  isCountedRefusal,
  subtractCounted,
  type Money,
  zero,
} from "../money.js";
import { entryAfterExit, LOTS_SOURCE, planSale, SaleRefusal, type SaleShare } from "./portfolio-lots.js";
import { printable, quoted } from "./printable.js";
import { stopOf } from "./stop.js";
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
 * (`opened`, see `openedKey`, and `lot`, the lot itself): the batch records those, so a `set_stop` knows which
 * lots are the batch's own and `inbox:ingest` has the lot to write down. A sale says the exit of each lot it
 * touched (`exits`), which `inbox:ingest` records and whose entry costs the next sale must not take again.
 */
export type HandlerResult =
  { state: InboxState; opened?: string; lot?: Lot; exits?: readonly SaleShare[] } | { reason: string };

/** The id of the lot a buy opens: from the one source of decision ids, never one the history or the state holds. */
export type NewEntryId = (date: string, ticker: Ticker) => string;

/**
 * What the handlers need besides the state and the command, from whoever runs the batch (`inbox:check`,
 * `inbox:ingest`). No field has a default: a caller that leaves one out does not compile (`opened`, found in #151).
 */
export interface BatchContext {
  /** The lots the commands before this one opened, see `OpenedLots`: the stops and the words of a sale refusal. */
  opened: OpenedLots;
  /** `openedKey(currency, ticker)` of the tickers earlier files opened, even if sold out since, for the same words. */
  earlierTickers: ReadonlySet<string>;
  /** The ids of the lots a buy opens. */
  newEntryId: NewEntryId;
  /** `version` of `strategies/base.md`, written into the lot a buy opens. */
  rulesVersion: string;
  /** What the exits written so far took of each lot's entry costs, by entry id: a sale does not take it twice. */
  entryCostsTaken: ReadonlyMap<string, Money>;
  /** Where a `set_stop` or `clear_stop` writes who changed the stop. */
  record?: StopRecord;
}

/** Identifies a lot across silos: entry ids are only unique within one. */
export const openedKey = (currency: Currency, entryId: string): string => `${currency}/${entryId}`;

/** A lot that a command of the inbox opened, and which command. */
export interface OpenedLot {
  currency: Currency;
  ticker: Ticker;
  /** The 1-based position of the buy in its batch, and its line. */
  command: number;
  line: number;
  /** The inbox file that opened it; absent: the batch under check. */
  file?: string;
}

/**
 * The lots the commands of the inbox opened so far, by `openedKey`: the ones of the batch under check (no
 * `file`: a `set_stop` gives them their initial stop) and the ones of the clean files before it. A lot it
 * does not hold is the portfolio's.
 */
export type OpenedLots = ReadonlyMap<string, OpenedLot>;

/** True for a lot the batch under check opened. */
const ownLot = (opened: OpenedLots, key: string): boolean => {
  const lot = opened.get(key);
  return lot !== undefined && lot.file === undefined;
};

/** Where a lot was opened, in words: the batch under check, or an earlier file. */
export const sourceOf = (lot: OpenedLot): string =>
  lot.file === undefined
    ? `command ${lot.command} of this batch`
    : `command ${lot.command} of inbox/${printable(lot.file)}`;

/** Who set the stop of a position: a `set_stop` of the batch under check (no `file`), or of an earlier file. */
export interface StopSource {
  command: number;
  line: number;
  file?: string;
}

/** The stop of a position (`openedKey(currency, ticker)`) after the commands so far: who set it, or `null` for cleared. */
export type StopSources = ReadonlyMap<string, StopSource | null>;

/**
 * Where the handlers write down who set or cleared a stop as they apply a command (#158), so whoever applies the
 * commands (`inbox:check`, `inbox:ingest`) reads the source of an initial stop from `initialStopBreaches` and does
 * not work it out again. `stops` starts with the sources of the earlier files; a position it does not hold is the portfolio's.
 */
export interface StopRecord {
  /** The command being applied. */
  at: Pick<StopSource, "command" | "line">;
  stops: Map<string, StopSource | null>;
}

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

/** The words for an amount that rounds to zero cents: below half a cent, the way `countedInCents` rounds. */
const belowHalfACent = (command: { units: number; price: number; currency: Currency }): string =>
  `${command.units} units at ${command.price} ${command.currency} is below half a cent`;

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

/** The rule an entry id must follow before it reaches a path or a cell: what `newDecisionId` writes, and the example ids. */
const ENTRY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** The rule violations a lot carries from its stop: `no_stop` while it has none (ADR-0009 §5), nothing otherwise. */
const violationsOf = (initialStop: number | null): string[] => (initialStop === null ? ["no_stop"] : []);

export function buy<C extends Currency>(state: InboxState, command: Buy<C>, context: BatchContext): HandlerResult {
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
    return refused(`the buy of ${printable(ticker)} costs nothing: ${belowHalfACent(command)}`);
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
    entryId: context.newEntryId(command.date, ticker),
    date: command.date,
    units: command.units,
    entryUnits: command.units,
    entryPrice: command.price,
    // A buy never changes the stop: the lot starts with the one the position has (a `set_stop` later in
    // the batch replaces it), or none, and then it carries `no_stop` (`withStop` keeps that true).
    initialStop: held ? stopOf(held) : null,
    entryCosts: command.costs ?? null,
    origin: "propietario",
    rulesVersion: context.rulesVersion,
    rulesViolations: violationsOf(held ? stopOf(held) : null),
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
    lot,
  };
}

/**
 * Where `lots` (the open lots of `ticker` a sale reaches) come from, in words: `portfolio.md`, the commands that
 * opened them, or both. With no lot at all the ticker may have been in the portfolio, or opened and sold by the
 * commands before: name the ones that opened any of it.
 */
function describeSources(
  lots: readonly Lot[],
  currency: Currency,
  ticker: Ticker,
  opened: OpenedLots,
  earlierTickers: ReadonlySet<string>,
): string {
  const labels = new Set<string>();
  let fromPortfolio = lots.length === 0;
  for (const lot of lots) {
    const origin = opened.get(openedKey(currency, lot.entryId));
    if (origin === undefined) fromPortfolio = true;
    else labels.add(sourceOf(origin));
  }
  if (lots.length === 0) {
    const prefix = openedKey(currency, "");
    const before = [...opened].filter(([key, origin]) => key.startsWith(prefix) && origin.ticker === ticker);
    if (before.some(([, origin]) => origin.file === undefined)) labels.add("the earlier commands");
    if (before.some(([, origin]) => origin.file !== undefined) || earlierTickers.has(openedKey(currency, ticker))) {
      labels.add("an earlier file");
    }
  }
  return [...(fromPortfolio ? [LOTS_SOURCE] : []), ...labels].join(" and ");
}

/**
 * The silo with the stop of `ticker` set to `stop` (null: none). The lots the batch opened before the command
 * start with that stop, the older ones keep theirs (their R): the initial stop of a lot is the stop of its
 * position right after the batch that holds the buy.
 */
function withStop<C extends Currency>(
  silo: PortfolioSnapshot<C>,
  ticker: Ticker,
  stop: number | null,
  opened: OpenedLots,
): PortfolioSnapshot<C> {
  return {
    ...silo,
    positions: silo.positions.map((p) => (p.ticker === ticker ? { ...p, stopLoss: stop } : p)),
    lots: silo.lots.map((l) =>
      l.ticker === ticker && ownLot(opened, openedKey(silo.currency, l.entryId))
        ? { ...l, initialStop: stop, rulesViolations: violationsOf(stop) }
        : l,
    ),
  };
}

export function setStop<C extends Currency>(
  state: InboxState,
  command: SetStop<C>,
  { opened, record }: Pick<BatchContext, "opened" | "record">,
): HandlerResult {
  const silo = siloOf(state, command.currency);
  if (isRefusal(silo)) return silo;
  const { currency, ticker } = command;
  // The parser refuses it too, but the handler is also run by whoever builds a command without it (#132): a
  // stop at or below zero is no stop (`stopOf`), so it would leave the position stopless with a command that says otherwise.
  if (!(command.price > 0)) return refused(`the stop of ${printable(ticker)} must be greater than zero`);
  if (!silo.positions.some((p) => p.ticker === ticker)) {
    return refused(`cannot set a stop: there is no open position in ${printable(ticker)} in the ${currency} silo`);
  }
  record?.stops.set(openedKey(currency, ticker), { ...record.at });
  return { state: withSilo(state, withStop(silo, ticker, command.price, opened)) };
}

export function clearStop(
  state: InboxState,
  command: ClearStop,
  { opened, record }: Pick<BatchContext, "opened" | "record">,
): HandlerResult {
  const { ticker } = command;
  // A silo the portfolio does not have holds nothing. One that fails to read may hold the ticker, so its error
  // is what the command reports when no silo that reads settles it: a ticker held in a silo that reads is
  // cleared there, whatever the state of the others.
  const silos: PortfolioSnapshot[] = [];
  let unreadable: { reason: string } | undefined;
  for (const currency of CURRENCIES) {
    if (state[currency] === undefined) continue;
    const silo = siloOf(state, currency);
    if (isRefusal(silo)) unreadable ??= silo;
    else if (silo.positions.some((p) => p.ticker === ticker)) silos.push(silo);
  }
  const stopped = silos.filter((silo) => silo.positions.some((p) => p.ticker === ticker && stopOf(p) !== null));
  if (stopped.length === 0) {
    if (unreadable !== undefined) return unreadable;
    return refused(
      silos.length === 0
        ? `cannot clear a stop: there is no open position in ${printable(ticker)}`
        : `cannot clear a stop: ${printable(ticker)} has no stop to clear`,
    );
  }
  for (const silo of stopped) record?.stops.set(openedKey(silo.currency, ticker), null);
  // The position ends with no stop, so the lots this batch opened start with none (they carry `no_stop`).
  return { state: stopped.reduce((next, silo) => withSilo(next, withStop(silo, ticker, null, opened)), state) };
}

/**
 * The exit of each lot a sale touches. The proceeds are `units x price`, worked out here and not taken from the
 * caller, so what is recorded cannot disagree with the command. The amount shared over the lots is `exactAmount`
 * of them: the proceeds in whole cents (the exits add up to the cents the cash is credited), except proceeds
 * under half a cent that are not dust, which keep their exact value to 8 decimals so that a lot of a few units
 * of a low-priced asset does not get an amount of 0 (ADR-0017). Proceeds that are dust give 0. Each exit's share
 * is kept to 8 decimals. `entryCostsTaken`: what the exits before already took of each lot's entry costs.
 */
export function saleShares<C extends Currency>(
  chosen: readonly Lot<C>[],
  command: Sale<C>,
  entryCostsTaken: ReadonlyMap<string, Money<C>>,
): SaleShare<C>[] {
  return planSale(
    chosen,
    {
      ticker: command.ticker,
      currency: command.currency,
      units: command.units,
      price: command.price,
      amount: exactAmount(command.units * command.price),
      costs: command.costs,
    },
    entryCostsTaken,
  );
}

/** `taken` with the entry costs the `exits` took added: the next sale of the batch starts from it. */
export function takeEntryCosts(taken: Map<string, Money>, exits: readonly SaleShare[], currency: Currency): void {
  for (const exit of exits) {
    if (exit.entryCosts === undefined) continue;
    taken.set(
      exit.lot.entryId,
      addCounted(
        taken.get(exit.lot.entryId) ?? zero(currency),
        exit.entryCosts,
        `the entry costs the exits of lot ${printable(exit.lot.entryId)} took together`,
      ),
    );
  }
}

export function sale<C extends Currency>(
  state: InboxState,
  command: Sale<C>,
  { opened, earlierTickers, entryCostsTaken }: Pick<BatchContext, "opened" | "earlierTickers" | "entryCostsTaken">,
): HandlerResult {
  const silo = siloOf(state, command.currency);
  if (isRefusal(silo)) return silo;
  const { currency, ticker } = command;
  if (command.units < UNITS_TOLERANCE) return refused(tooFewUnits(command.units));
  // The handler is also run by whoever builds a command without the parser (#132): the id is checked again before
  // it is compared with the lots, so a malformed one is refused for what it is and never reaches a path or a cell.
  if (command.lot !== undefined && !ENTRY_ID.test(command.lot)) {
    return refused(`the lot ${quoted(command.lot)} of the sale of ${printable(ticker)} is not an entry id`);
  }
  // Which lots are sold is this handler's to say; how many units they give, and the tolerance, are `planSale`'s.
  const chosen = silo.lots.filter(
    (l) => l.ticker === ticker && (command.lot === undefined || l.entryId === command.lot),
  );
  if (command.lot !== undefined && !chosen.some((l) => l.units > 0)) {
    return refused(
      `cannot sell lot ${quoted(command.lot)}: ${printable(ticker)} has no open lot with that id in the ${currency} silo`,
    );
  }
  // Cents are for the cash credit and the costs check; the exact amount is for the exits `inbox:ingest` records (ADR-0017).
  const amount = countedInCents(
    command.units * command.price,
    `the amount of the sale of ${printable(ticker)}`,
    currency,
  );
  let shares: SaleShare<C>[];
  try {
    shares = saleShares(chosen, command, entryCostsTaken as ReadonlyMap<string, Money<C>>);
  } catch (err) {
    // Only the lot arithmetic's own refusals are reasons; anything else is a bug and must crash. Where the
    // lots come from is worked out here, only for a refusal that names it.
    if (err instanceof SaleRefusal) {
      return refused(
        err.named(
          describeSources(
            chosen.filter((l) => l.units > 0),
            currency,
            ticker,
            opened,
            earlierTickers,
          ),
        ),
      );
    }
    throw err;
  }
  // A lot cannot be sold before it was bought (the same day is a round trip), as `decision:record` refuses it too.
  // It is checked after the lots, so that an unheld ticker or too many units report their real reason.
  const early = shares.find((share) => entryAfterExit(share.lot.date, command.date));
  if (early !== undefined) {
    return refused(
      `the sale of ${printable(ticker)} is dated ${command.date}, before lot ${quoted(early.lot.entryId)} was bought on ${early.lot.date}: a lot cannot be sold before it was bought`,
    );
  }
  // Checked after the lots so that an unheld ticker or too many units report their real reason, not this one.
  // A sale that uses up every lot it touches is the way out for dust lots, so it may credit 0.00 (#149, #162).
  if (amount === 0 && !shares.every((share) => share.unitsLeft === 0)) {
    return refused(`the sale of ${printable(ticker)} yields nothing: ${belowHalfACent(command)}`);
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
  return { state: withSilo(state, { ...credited, lots, positions }), exits: shares };
}

/** A lot the batch opened whose initial stop is not below its entry price, so its R would be zero or negative. */
export interface InitialStopBreach {
  currency: Currency;
  ticker: Ticker;
  entryId: string;
  entryPrice: number;
  /** The stop the position ends the batch with, which is the lot's initial stop. */
  stop: number;
  /** Who set that stop (see `StopRecord`); `null`: nobody in the inbox, `portfolio.md` holds it. */
  setBy: StopSource | null;
}

/**
 * The lots in `opened` (the ones the batch opened, see `openedKey`) that `state` (the one after the whole batch)
 * holds with an initial stop at or above their entry price (#159). R is the entry price minus the initial stop,
 * so it would be zero or negative. Only the stop a lot starts with counts: a position's stop moved above the
 * entry later, in another batch, is a trailing stop. A lot with no initial stop is not a breach (it carries
 * `no_stop`, #132), nor is one the batch sold out.
 */
export function initialStopBreaches(state: InboxState, opened: OpenedLots, stops: StopSources): InitialStopBreach[] {
  return CURRENCIES.flatMap((currency) =>
    (state[currency]?.lots ?? []).flatMap((l) =>
      ownLot(opened, openedKey(currency, l.entryId)) && l.initialStop !== null && l.initialStop >= l.entryPrice
        ? [
            {
              currency,
              ticker: l.ticker,
              entryId: l.entryId,
              entryPrice: l.entryPrice,
              stop: l.initialStop,
              setBy: stops.get(openedKey(currency, l.ticker)) ?? null,
            },
          ]
        : [],
    ),
  );
}

/**
 * Applies one command to the state: the new state, or the reason it is refused. What the handlers need besides
 * them is in `context` (see `BatchContext`, none of it optional but `record`). Never throws for an amount too
 * large to count.
 */
export function applyCommand(state: InboxState, command: Command, context: BatchContext): HandlerResult {
  try {
    switch (command.kind) {
      case "deposit":
        return deposit(state, command);
      case "withdrawal":
        return withdrawal(state, command);
      case "buy":
        return buy(state, command, context);
      case "sale":
        return sale(state, command, context);
      case "set_stop":
        return setStop(state, command, context);
      case "clear_stop":
        return clearStop(state, command, context);
    }
  } catch (err) {
    if (isCountedRefusal(err)) return refused(err.message);
    throw err;
  }
}
