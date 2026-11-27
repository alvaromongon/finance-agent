// The command handlers of the inbox (#131, spec #124, ADR-0018): one independent, pure handler per command,
// `(state, command) -> new state or a reason`. No I/O, no clock, no config: `inbox:check` runs them over a
// batch without writing anything, and `inbox:ingest` (#132) runs the same ones, then applies the batch.
//
// The state is both silos of the portfolio. The currency is enforced by the type only where a silo is
// picked at run time (`state[command.currency]`, #145), so every handler checks it explicitly before it
// touches a silo (`siloOf`).
import {
  CURRENCIES,
  type AssetClass,
  type Currency,
  type Difference,
  type Horizon,
  type Lot,
  type PortfolioSnapshot,
  type Position,
  type WatchlistEntry,
} from "../types.js";
import {
  entryRuleViolations,
  findRelatedProposal,
  originOf,
  STOP_RULES,
  stopRuleViolations,
  type Decision,
  type DecisionOrigin,
} from "../decisions.js";
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

/**
 * Cash moved from one silo to the other at a rate the owner got (#135): `amount` leaves `from` and what arrived (`received`,
 * or `(amount - costs) x rate`: exactly one of the two is given) reaches `to`, in one step. `costs` are the fee, in `from`,
 * already inside `amount`. The two silos are always different: a conversion into the same currency is refused.
 */
export interface Conversion<F extends Currency = Currency, T extends Currency = Currency> {
  kind: "convert";
  from: F;
  to: T;
  /** Taken out of `from`, costs included. */
  amount: Money<F>;
  /** What arrived in `to`. */
  received?: Money<T>;
  /** `to` per unit of `from`, before the fee. */
  rate?: number;
  costs?: Money<F>;
  /** YYYY-MM-DD, when given. */
  date?: string;
}

/** A split ratio: `new` units after the split for each `old` units before it (4 for 1; 1 for 10 is a reverse split). */
export interface SplitRatio {
  new: number;
  old: number;
}

/**
 * A split (or reverse split) of a ticker (#137): the units of every open lot of it are multiplied by `ratio.new / ratio.old`
 * and its entry price and stop divided by it, in every silo that holds it. It changes no cash, so it has no amount and
 * no currency (as a `clear_stop`, the silo is the one that holds the ticker). A corporate action other than a split is
 * a different command (the glossary's *Corporate action*).
 */
export interface Split {
  kind: "split";
  ticker: Ticker;
  /** YYYY-MM-DD: the day the split took effect. */
  date: string;
  ratio: SplitRatio;
}

/** A position as the broker lists it in a snapshot: a ticker and the units held. */
export interface BrokerPosition {
  ticker: Ticker;
  units: number;
}

/**
 * What the broker shows of one silo on a date (#138): its cash and the units of each position it holds. It is the
 * owner's way to say "this is what the broker has": the handler compares it with the engine's state, tells each
 * difference and changes no cash, lot or stop; the owner corrects a difference with a command. It records the day it is
 * as of, which is what the silo's staleness is measured from.
 */
export interface Snapshot<C extends Currency = Currency> {
  kind: "snapshot";
  currency: C;
  /** YYYY-MM-DD: the day the broker's figures are as of; not in the future. */
  date: string;
  /** The broker's available cash. */
  cash: number;
  /** Every position the broker holds; a ticker that is not listed is one the broker does not hold. */
  positions: readonly BrokerPosition[];
}

/**
 * Gives up a rejected batch for good (#152): it stays in `inbox/rejected/` as the audit trail and is not named in the
 * digest any more. It changes no cash, lot or stop, so it has no currency.
 */
export interface Discard {
  kind: "discard";
  /** The file name in `inbox/rejected/`. */
  file: string;
}

/**
 * Corrects a mistaken record (#139): the buy, the sale, the deposit or the withdrawal that the engine gave `id`, with the
 * values it should have had. What is left out stays as it was told. The engine does not edit the state: it applies the
 * batches that were applied again with the corrected record, so every later command is judged against it, and it
 * writes a `correction` line that points at the original, which stays in the log. It is run by the inbox over the applied
 * batches (`inbox-replay.ts`), on its own in a batch, and not by a handler of the state: `applyCommand` refuses it.
 */
export interface Correct {
  kind: "correct";
  /** The id of the record in the decision log: the entry of a buy, the exit of a sale, the line of a deposit or a withdrawal. */
  id: string;
  /** The currency the amounts of the command are in: the silo of the record, which a correction does not move. */
  currency?: Currency;
  ticker?: Ticker;
  /** YYYY-MM-DD. */
  date?: string;
  units?: number;
  price?: number;
  /** A buy or a sale's costs; zero takes the costs away. */
  costs?: Money;
  /** A deposit or a withdrawal's amount. */
  amount?: Money;
}

/**
 * Puts a ticker on the watchlist (#140): the engine's own list, which the heartbeat scans for setups and which the trade
 * checks read (`not_in_watchlist`). A ticker is on it once, in one silo.
 */
export interface Watch {
  kind: "watch";
  currency: Currency;
  ticker: Ticker;
  /** Why it is watched; kept as the entry's thesis. */
  note?: string;
  /** The day it joins the list, YYYY-MM-DD; the day of the run when left out. */
  date?: string;
  /** `medium` when left out. */
  horizon?: Horizon;
  /** `equity` when left out. */
  assetClass?: AssetClass;
}

/** Takes a ticker off the watchlist (#140). It changes no cash, lot or stop: a position it holds stays under risk watch. */
export interface StopWatching {
  kind: "stop_watching";
  ticker: Ticker;
  /** Why it is retired; the engine does not keep it (the batch in `inbox/applied/` does). */
  reason?: string;
}

export type Command<C extends Currency = Currency> =
  | Deposit<C>
  | Withdrawal<C>
  | Conversion
  | Buy<C>
  | Sale<C>
  | SetStop<C>
  | ClearStop
  | Split
  | Snapshot<C>
  | Discard
  | Watch
  | StopWatching
  | Correct;

// ─── State and result ─────────────────────────────────────────────────────────

/** The silos of a state: each silo's portfolio, in its own currency; a silo the portfolio does not have is absent. */
export type Silos = { readonly [C in Currency]?: PortfolioSnapshot<C> };

/**
 * What the handlers work on: the silos, and the watchlist (#140), which the `watch` and `stop_watching` commands change and
 * the rules of an entry read. A state with no `watchlist` is one with nothing on it.
 */
export type InboxState = Silos & { readonly watchlist?: readonly WatchlistEntry[] };

/** The silos of a state, in the order of `CURRENCIES`. */
export const silosOf = (state: InboxState): PortfolioSnapshot[] => CURRENCIES.flatMap((c) => state[c] ?? []);

/**
 * What a handler returns: the new state, or why the command is refused. A buy also says which lot it opened
 * (`opened`, see `openedKey`, and `lot`, the lot itself): the batch records those, so a `set_stop` knows which
 * lots are the batch's own and `inbox:ingest` has the lot to write down. A sale says the exit of each lot it
 * touched (`exits`), which `inbox:ingest` records and whose entry costs the next sale must not take again. A split says
 * which silos it changed and which lots it scaled (`split`). A discard says which rejected batch it gave up (`discarded`).
 */
export type HandlerResult =
  | {
      state: InboxState;
      opened?: string;
      lot?: Lot;
      /** A buy: the id of the system proposal it follows (`related_id` of its entry), when it follows one. */
      proposal?: string;
      exits?: readonly SaleShare[];
      /** A sale: `sistema` when it follows a sell proposal of the system, `propietario` otherwise (ADR-0009 §8). */
      origin?: DecisionOrigin;
      discarded?: string;
      /** A split: the silos it changed and the lots it scaled (`openedKey`), so the batch can follow the lots it opened. */
      split?: { silos: readonly Currency[]; lots: readonly string[] };
      /** A snapshot: the silo, the day it is as of and each difference found (none when the broker and the engine agree). */
      snapshot?: { currency: Currency; date: string; differences: readonly Difference[] };
    }
  | { reason: string };

/** The id of the lot a buy opens: from the one source of decision ids, never one the history or the state holds. */
export type NewEntryId = (date: string, ticker: Ticker) => string;

/**
 * What the rules of an entry (ADR-0013 §4, ADR-0009 §5 and §8) read, from whoever runs the batch: the decision history
 * (where the system proposal a trade follows is found), the proposals earlier trades of the run already cited, and the ATR
 * of the tickers bought. Everything is read before the run, so the handlers stay pure. The watchlist is not here: it is
 * part of the state (`InboxState`), so a `watch` earlier in the batch counts.
 */
export interface EntryContext {
  history: readonly Decision[];
  /** Ids of the proposals the buys before this command (earlier files included) cited: one proposal, one trade. */
  cited: ReadonlySet<string>;
  /** ATR14 by ticker, best-effort: a ticker with none has no stop distance checked. */
  atr: ReadonlyMap<Ticker, number>;
  /** `strategy.stopMinAtr`: the least a stop may sit from the entry price, in ATRs. */
  minStopAtr: number;
}

/** The decisions of the system an entry can follow: its own proposal, a block it overrides, an armed breakout. */
const ENTRY_PROPOSALS = ["buy_proposal", "buy_blocked", "setup_armed"] as const;

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
  /** The rejected batches (names in `inbox/rejected/`) still awaiting a replacement or a discard: what a `discard` can name. */
  awaiting: ReadonlySet<string>;
  /** What the rules of an entry read, see `EntryContext`. */
  entry: EntryContext;
  /** Where a `set_stop` or `clear_stop` writes who changed the stop. */
  record?: StopRecord;
  /** The day of the run, YYYY-MM-DD: a snapshot is not of a day that has not come (the one clock the handlers read). */
  today: string;
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
  const silo = (state as Silos)[currency];
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

/**
 * Moves cash from the `from` silo to the `to` silo: both change or neither (a refusal returns no state). Every silo is
 * looked up by its own currency (#145) and the two must differ.
 */
export function convert(state: InboxState, command: Conversion): HandlerResult {
  const { from, to, amount } = command;
  if (from === to) {
    return refused(
      `a conversion needs two currencies: it takes ${from} out of the ${from} silo and gives ${to} back to it`,
    );
  }
  const source = siloOf(state, from);
  if (isRefusal(source)) return source;
  const target = siloOf(state, to);
  if (isRefusal(target)) return target;
  if (!(amount > 0)) return refused(`the conversion must take out an amount greater than zero of ${from}`);
  const costs = command.costs ?? zero(from);
  if (!(costs < amount)) {
    return refused(
      `the costs of ${show(costs, from)} are not below the amount of ${show(amount, from)} converted: nothing would reach the ${to} silo`,
    );
  }
  if (amount > source.cash) {
    return refused(`the conversion of ${show(amount, from)} exceeds the available cash of ${show(source.cash, from)}`);
  }
  if ((command.received === undefined) === (command.rate === undefined)) {
    return refused('a conversion says what arrived with "received" or with "rate", one of the two');
  }
  let received: Money;
  if (command.received !== undefined) received = command.received;
  else {
    if (!(command.rate! > 0)) return refused("the rate of a conversion must be greater than zero");
    received = countedInCents((amount - costs) * command.rate!, "the amount the conversion delivers", to);
  }
  if (!(received > 0)) {
    return refused(
      `the conversion of ${show(amount, from)} delivers nothing: ${show(received, to)} would reach the ${to} silo`,
    );
  }
  const taken = movedCash(source, subtractCounted(zero(from), amount, "the conversion"), "the conversion");
  const given = movedCash(target, received as Money<typeof to>, "the conversion");
  return { state: withSilo(withSilo(state, taken), given) };
}

/** The rule an entry id must follow before it reaches a path or a cell: what `newDecisionId` writes, and the example ids. */
export const ENTRY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * The rule violations of a lot once its initial stop is `stop`: the ones it was opened with that do not depend on the
 * stop stay, the ones about the stop (`no_stop`, `stop_below_min_atr`) are judged again.
 */
const withStopRules = (lot: Lot, stop: number | null, { atr, minStopAtr }: EntryContext): string[] => [
  ...lot.rulesViolations.filter((v) => !STOP_RULES.includes(v)),
  ...stopRuleViolations({ price: lot.entryPrice, stop, atr: atr.get(lot.ticker), minStopAtr }),
];

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
  // The system proposal this buy follows (ADR-0009 §8): it decides the origin, so that a buy of what the engine
  // proposed stays in the system's expectancy. Its own block, if it skips one, is a violation (`overrode_block`).
  const { entry } = context;
  const proposal = findRelatedProposal(
    entry.history,
    { ticker, date: command.date, types: ENTRY_PROPOSALS },
    entry.cited,
  );
  const origin = originOf(proposal);
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
    origin,
    rulesVersion: context.rulesVersion,
    rulesViolations: [
      ...entryRuleViolations({
        price: command.price,
        stop: held ? stopOf(held) : null,
        entry: state.watchlist?.find((e) => e.currency === currency && e.ticker === ticker),
        proposal,
        atr: entry.atr.get(ticker),
        minStopAtr: entry.minStopAtr,
      }),
      ...(origin === "propietario" && proposal?.origin === "sistema" ? ["overrode_block"] : []),
    ],
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
    ...(proposal !== undefined ? { proposal: proposal.id } : {}),
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
  entry: EntryContext,
): PortfolioSnapshot<C> {
  return {
    ...silo,
    positions: silo.positions.map((p) => (p.ticker === ticker ? { ...p, stopLoss: stop } : p)),
    lots: silo.lots.map((l) =>
      l.ticker === ticker && ownLot(opened, openedKey(silo.currency, l.entryId))
        ? { ...l, initialStop: stop, rulesViolations: withStopRules(l, stop, entry) }
        : l,
    ),
  };
}

export function setStop<C extends Currency>(
  state: InboxState,
  command: SetStop<C>,
  { opened, record, entry }: Pick<BatchContext, "opened" | "record" | "entry">,
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
  return { state: withSilo(state, withStop(silo, ticker, command.price, opened, entry)) };
}

export function clearStop(
  state: InboxState,
  command: ClearStop,
  { opened, record, entry }: Pick<BatchContext, "opened" | "record" | "entry">,
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
  return { state: stopped.reduce((next, silo) => withSilo(next, withStop(silo, ticker, null, opened, entry)), state) };
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
  {
    opened,
    earlierTickers,
    entryCostsTaken,
    entry,
  }: Pick<BatchContext, "opened" | "earlierTickers" | "entryCostsTaken" | "entry">,
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
  // A lot cannot be sold before it was bought (the same day is a round trip), as the decision log refuses an exit dated before its entry.
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
  // A sale that follows a sell proposal of the system is the system's (ADR-0009 §8); it is not a line `related_id`
  // cites, so a proposal can be followed by more than one sale.
  const followed = findRelatedProposal(entry.history, { ticker, date: command.date, types: ["sell"] });
  return {
    state: withSilo(state, { ...credited, lots, positions }),
    exits: shares,
    origin: originOf(followed),
  };
}

/** True for a whole number of units, within the units tolerance. */
const isWhole = (units: number): boolean => Math.abs(units - Math.round(units)) <= UNITS_TOLERANCE;

/**
 * `lot` after a split of `new` units for `old`: the units open and bought are multiplied by it, the entry price and the
 * initial stop divided, so what was invested (units x price) and R in cents (units x (price - stop)) are the same. The
 * entry costs are money paid and do not change. Multiplies first and divides last, so a ratio that divides the units
 * evenly gives them exactly (30 units, 1 for 10: 3, not 3.0000000000000004).
 */
export function splitLot<C extends Currency>(lot: Lot<C>, ratio: SplitRatio): Lot<C> {
  return {
    ...lot,
    units: (lot.units * ratio.new) / ratio.old,
    entryUnits: (lot.entryUnits * ratio.new) / ratio.old,
    entryPrice: (lot.entryPrice * ratio.old) / ratio.new,
    initialStop: lot.initialStop === null ? null : (lot.initialStop * ratio.old) / ratio.new,
  };
}

/**
 * Applies a split to every silo that holds the ticker, all or none: a refusal in one silo returns no state. A lot is
 * scaled whole (open and bought units); a position follows its lots (volume, average price, current price and stop),
 * its P/L is an amount and stays. Only units that are whole and would stop being so are refused (a reverse split):
 * the owner settles the cash in lieu of the fraction with a sale (#137).
 */
export function split(state: InboxState, command: Split): HandlerResult {
  const { ticker, date, ratio } = command;
  // The parser refuses these too, but the handler is also run by whoever builds a command without it (#132).
  if (!(ratio.new > 0 && ratio.old > 0 && Number.isFinite(ratio.new) && Number.isFinite(ratio.old))) {
    return refused(`the split ratio must be greater than zero; got: ${ratio.new} for ${ratio.old}`);
  }
  if (ratio.new === ratio.old) {
    return refused(`a ratio of 1 changes nothing: ${ratio.new} for ${ratio.old} is not a split`);
  }
  // A silo the portfolio does not have holds nothing. One that fails to read may hold the ticker, so its error is
  // what the command reports when no silo that reads has the ticker (as `clear_stop` does).
  const holding: PortfolioSnapshot[] = [];
  let unreadable: { reason: string } | undefined;
  for (const currency of CURRENCIES) {
    if (state[currency] === undefined) continue;
    const silo = siloOf(state, currency);
    if (isRefusal(silo)) unreadable ??= silo;
    else if (silo.lots.some((l) => l.ticker === ticker && l.units > 0)) holding.push(silo);
  }
  if (holding.length === 0) {
    return unreadable ?? refused(`cannot split ${printable(ticker)}: there is no open lot of it in the portfolio`);
  }
  const lots = holding.flatMap((silo) => silo.lots.filter((l) => l.ticker === ticker));
  const oldest = lots.reduce((min, l) => (l.date < min ? l.date : min), lots[0].date);
  if (date < oldest) {
    return refused(
      `cannot split ${printable(ticker)}: its date ${date} is before the day the oldest open lot was bought (${oldest})`,
    );
  }
  const after = lots.find((l) => l.date > date);
  if (after !== undefined) {
    return refused(
      `cannot split ${printable(ticker)}: lot ${quoted(after.entryId)} was bought on ${after.date}, after the split's date ${date}: it is already at the prices after the split`,
    );
  }
  for (const l of lots) {
    const scaled = splitLot(l, ratio).units;
    if (isWhole(l.units) && !isWhole(scaled)) {
      return refused(
        `cannot split ${printable(ticker)} ${ratio.new} for ${ratio.old}: lot ${quoted(l.entryId)} would be left with ${scaled} units, not a whole number: sell the fraction first (the cash in lieu is settled with a sale)`,
      );
    }
  }
  let next = state;
  for (const silo of holding) {
    const position = (p: Position): Position =>
      p.ticker !== ticker
        ? p
        : {
            ...p,
            volume: (p.volume * ratio.new) / ratio.old,
            avgPrice: (p.avgPrice * ratio.old) / ratio.new,
            currentPrice: (p.currentPrice * ratio.old) / ratio.new,
            // A position with no stop (`stopOf`) keeps whatever it holds in its cell.
            stopLoss: stopOf(p) === null ? p.stopLoss : (p.stopLoss! * ratio.old) / ratio.new,
          };
    next = withSilo(next, {
      ...silo,
      lots: silo.lots.map((l) => (l.ticker === ticker ? splitLot(l, ratio) : l)),
      positions: silo.positions.map(position),
    });
  }
  return {
    state: next,
    split: {
      silos: holding.map((silo) => silo.currency),
      lots: holding.flatMap((silo) =>
        silo.lots.filter((l) => l.ticker === ticker).map((l) => openedKey(silo.currency, l.entryId)),
      ),
    },
  };
}

/** The units the silo holds of `ticker`, the sum of its positions. */
const heldUnits = (silo: PortfolioSnapshot, ticker: Ticker): number =>
  silo.positions.filter((p) => p.ticker === ticker).reduce((sum, p) => sum + p.volume, 0);

/**
 * Compares what the broker shows of a silo with the engine's state (#138) and records the day and the differences on
 * the silo. It changes no cash, position or lot: the broker is the owner's fact, but applying it silently would hide a
 * missed or wrongly entered trade, so the owner corrects a difference with a command. The differences are the cash
 * (to the cent) and each ticker either side holds whose units differ by more than the units tolerance.
 */
export function snapshot<C extends Currency>(
  state: InboxState,
  command: Snapshot<C>,
  { today }: Pick<BatchContext, "today">,
): HandlerResult {
  const silo = siloOf(state, command.currency);
  if (isRefusal(silo)) return silo;
  if (command.date > today) {
    return refused(`the snapshot's date ${command.date} is in the future (today is ${today})`);
  }
  // The parser refuses a repeated ticker too, but the handler is also run by whoever builds a command without it (#132).
  const listed = new Set<Ticker>();
  for (const { ticker } of command.positions) {
    if (listed.has(ticker))
      return refused(`${quoted(ticker)} is listed twice in the snapshot: a ticker is one position`);
    listed.add(ticker);
  }
  const differences: Difference<C>[] = [];
  const broker = countedInCents(command.cash, `the ${command.currency} cash of the snapshot`, command.currency);
  if (broker !== silo.cash) differences.push({ kind: "cash", broker, engine: silo.cash });
  const tickers = [...listed, ...silo.positions.map((p) => p.ticker).filter((t) => !listed.has(t))];
  for (const ticker of new Set(tickers)) {
    const units = command.positions.find((p) => p.ticker === ticker)?.units ?? 0;
    const engine = heldUnits(silo, ticker);
    if (Math.abs(units - engine) > UNITS_TOLERANCE)
      differences.push({ kind: "position", ticker, broker: units, engine });
  }
  return {
    state: withSilo(state, { ...silo, reconciled: { date: command.date, recordedOn: today, differences } }),
    snapshot: { currency: command.currency, date: command.date, differences },
  };
}

export function discard(
  command: Discard,
  { awaiting }: Pick<BatchContext, "awaiting">,
  state: InboxState,
): HandlerResult {
  if (!awaiting.has(command.file)) {
    return refused(
      `cannot discard ${quoted(command.file)}: no rejected batch of that name is awaiting a replacement or a discard in inbox/rejected/`,
    );
  }
  return { state, discarded: command.file };
}

/** `watch`: puts the ticker on the watchlist. Refused when it is on it already, in either silo. */
export function watch(state: InboxState, command: Watch, { today }: Pick<BatchContext, "today">): HandlerResult {
  const list = state.watchlist ?? [];
  const on = list.find((e) => e.ticker === command.ticker);
  if (on !== undefined) {
    return refused(
      `${printable(command.ticker)} is already on the watchlist (${on.currency} silo): a ticker is watched once`,
    );
  }
  const entry: WatchlistEntry = {
    ticker: command.ticker,
    currency: command.currency,
    horizon: command.horizon ?? "medium",
    ...(command.assetClass !== undefined ? { asset_class: command.assetClass } : {}),
    thesis: command.note ?? "",
    date: command.date ?? today,
  };
  return { state: { ...state, watchlist: [...list, entry] } };
}

/** `stop_watching`: takes the ticker off the watchlist. Refused when it is not on it. */
export function stopWatching(state: InboxState, command: StopWatching): HandlerResult {
  const list = state.watchlist ?? [];
  if (!list.some((e) => e.ticker === command.ticker)) {
    return refused(`${printable(command.ticker)} is not on the watchlist: there is nothing to stop watching`);
  }
  return { state: { ...state, watchlist: list.filter((e) => e.ticker !== command.ticker) } };
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
      case "convert":
        return convert(state, command);
      case "buy":
        return buy(state, command, context);
      case "sale":
        return sale(state, command, context);
      case "set_stop":
        return setStop(state, command, context);
      case "clear_stop":
        return clearStop(state, command, context);
      case "split":
        return split(state, command);
      case "snapshot":
        return snapshot(state, command, context);
      case "discard":
        return discard(command, context, state);
      case "watch":
        return watch(state, command, context);
      case "stop_watching":
        return stopWatching(state, command);
      case "correct":
        // The runner of the inbox applies it over the applied batches (`checkCorrections`); there is no state to hand it.
        return refused("a correct command is run on its own in a batch, over the batches already applied");
    }
  } catch (err) {
    if (isCountedRefusal(err)) return refused(err.message);
    throw err;
  }
}
