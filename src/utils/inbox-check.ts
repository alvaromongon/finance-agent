// The shared runner of the inbox (#131, #132): a batch (the text of one inbox file) against a state, and the files
// of the inbox in order. Pure; `inbox.ts` reads the files and the portfolio, and `inbox:check` prints what this
// returns while `inbox:ingest` writes the state it ends with: one code path, `check` being `ingest` without the write.
import { createHash } from "node:crypto";
import { CURRENCIES, type Currency, type Difference, type Lot } from "../types.js";
import type { Ticker } from "../ticker.js";
import { formatMoney, zero, type Money } from "../money.js";
import { round } from "./round.js";
import { isDeepStrictEqual } from "node:util";
import { uniqueDecisionIds } from "./decision-id.js";
import type { SaleShare } from "./portfolio-lots.js";
import {
  applyCommand,
  initialStopBreaches,
  openedKey,
  splitLot,
  takeEntryCosts,
  type BatchContext,
  type Command,
  type EntryContext,
  type InboxState,
  type InitialStopBreach,
  type OpenedLot,
  type OpenedLots,
  type SplitRatio,
  type StopSource,
  type StopSources,
} from "./inbox-handlers.js";
import { parseBatch, type CommandKind, type InboxIssue, type ParsedBatch, type ParsedCommand } from "./inbox-parse.js";
import {
  pinKey,
  type ReplayResult,
  isCorrection,
  isReplayFailure,
  emptyState,
  patchesOf,
  replay,
  restoreMetadata,
  stateDifferences,
  withTelemetry,
  type Correction,
  type LedgerFile,
} from "./inbox-replay.js";
import { entryCostsTaken as costsTakenBy } from "./portfolio-lots.js";
import type { Decision, DecisionOrigin } from "../decisions.js";
import { printable, quoted } from "./printable.js";
import { stopOf } from "./stop.js";

export type { StopSource, StopSources };

/**
 * What a command would have changed, as far as other commands can depend on it: the silos, the kind of command
 * (`null`: a command that did not read that far, which could have been any), and the ticker whose lots and
 * stop it changes (`undefined`: none, a cash command; `null`: any, a command that did not read).
 */
interface Footprint {
  currencies: readonly Currency[];
  kind: CommandKind | null;
  ticker: Ticker | null | undefined;
}

/** A file that was rejected: the later files are checked without it, and what they depend on from it is unknown. */
export interface RejectedFile {
  file: string;
  footprint: readonly Footprint[];
}

/**
 * What a batch is run with besides the state, from whoever runs it (`check` and `ingest` give the same): the
 * `version` of the rules, the ids of the whole decision history (closed lots included, so no lot opened gets one of
 * them) and what the exits of the history already took of each lot's entry costs.
 */
export interface RunContext {
  /** The rejected batches (names in `inbox/rejected/`) awaiting a replacement or a discard when the run starts. */
  awaiting: ReadonlySet<string>;
  rulesVersion: string;
  takenIds: ReadonlySet<string>;
  entryCostsTaken: ReadonlyMap<string, Money>;
  /** What the rules of an entry read (see `EntryContext`) but the trades of the run itself: they add to `cited`. */
  entry: Omit<EntryContext, "cited">;
  /** The day of the run, YYYY-MM-DD: a snapshot is not of a day to come. */
  today: string;
  /**
   * The batches already applied, in the order they were (`inbox/applied/` and the ones applied and not yet moved): what a
   * `correct` command replays. Absent, a correction cannot be checked and is refused for that.
   */
  ledger?: readonly LedgerFile[];
  /** The silos before the first batch, from `portfolio.md` (the store's `starting`): what the ledger is replayed over. Absent: empty ones. */
  starting?: InboxState;
  /** A replay's own: the commands it runs in place of the ones a file holds (by file name, then command position). */
  overrides?: ReadonlyMap<string, ReadonlyMap<number, Command>>;
  /** A replay's own: the id the log holds for each id this run gives, by `idKey`. */
  pins?: ReadonlyMap<string, string>;
}

/** What the files before the batch under check left behind. */
export interface Earlier {
  /** The lots the clean files opened and that are still open. */
  lots: OpenedLots;
  stops: StopSources;
  rejected: readonly RejectedFile[];
  /** `openedKey(currency, ticker)` of every ticker the clean files opened, also when all of it was sold since. */
  tickers: ReadonlySet<string>;
  /** The rejected batches still awaiting a replacement or a discard, as the clean files before this one left them. */
  awaiting: ReadonlySet<string>;
  /** The ids taken so far: the history's, and those the clean files gave to their lots. */
  takenIds: ReadonlySet<string>;
  /** The entry costs taken so far: the history's, and those the exits of the clean files took. */
  entryCostsTaken: ReadonlyMap<string, Money>;
  rulesVersion: string;
  /** The ids of the system proposals the buys of the clean files before this one cited. */
  cited: ReadonlySet<string>;
  entry: Omit<EntryContext, "cited">;
  today: string;
  /** The batches applied before the run and the clean files of the run so far, in order; see `RunContext.ledger`. */
  ledger?: readonly LedgerFile[];
  starting?: InboxState;
  /** The file under check: a replay's pins are of one file. */
  name?: string;
  /** How many clean batches of the run have applied something before this one: a correction needs them applied first. */
  appliedInRun?: number;
  /** The commands of this file that a replay runs in another form, by position; see `RunContext.overrides`. */
  overrides?: ReadonlyMap<number, Command>;
  pins?: ReadonlyMap<string, string>;
}

/** A buy of a clean batch, with the lot it opened as the batch leaves it (its initial stop is the final one). */
export interface BuyTrade {
  kind: "buy";
  command: number;
  line: number;
  currency: Currency;
  ticker: Ticker;
  date: string;
  units: number;
  price: number;
  costs?: Money;
  lot: Lot;
  /** The system proposal the buy follows, cited by its entry as `related_id` (ADR-0009 §8); absent: it follows none. */
  relatedId?: string;
}

/** A sale of a clean batch: the exit of each lot it touched, with the lot as the batch leaves it. */
export interface SaleTrade {
  kind: "sale";
  command: number;
  line: number;
  currency: Currency;
  ticker: Ticker;
  date: string;
  price: number;
  stopExecuted: boolean;
  /** `sistema` when the sale follows a sell proposal of the system, `propietario` otherwise (ADR-0009 §8). */
  origin: DecisionOrigin;
  exits: { share: SaleShare; lot: Lot }[];
}

/** A conversion of a clean batch: `amount` of `currency` (the silo it came from) left, `costs` included. */
export interface ConversionTrade {
  kind: "convert";
  command: number;
  line: number;
  currency: Currency;
  /** YYYY-MM-DD, when the command gave it: the line takes the day of the run otherwise. */
  date?: string;
  amount: Money;
  costs: Money;
  /** The other currency per unit of `currency`, before the fee. */
  fxRate: number;
}

/** A split of a clean batch, one per silo it changed: `ratio` is the units after it per unit before it (4 for 1: 4). */
export interface SplitTrade {
  kind: "split";
  command: number;
  line: number;
  currency: Currency;
  ticker: Ticker;
  date: string;
  ratio: number;
}

/** A snapshot of a clean batch: what the broker showed of a silo and each difference from the state (#138). */
export interface SnapshotTrade {
  kind: "snapshot";
  command: number;
  line: number;
  currency: Currency;
  /** YYYY-MM-DD: the day the broker's figures are as of. */
  date: string;
  /** None when the broker and the engine agree. */
  differences: readonly Difference[];
}

/** A deposit or a withdrawal of a clean batch (#139: it has a line, so a correction can name it). */
interface CashMove {
  command: number;
  line: number;
  currency: Currency;
  amount: Money;
}
export type CashTrade = (CashMove & { kind: "deposit" }) | (CashMove & { kind: "withdrawal" });

/** A correction of a clean batch: one line of the log that changes, with the fields that do (#139). */
export interface CorrectionTrade {
  kind: "correction";
  command: number;
  line: number;
  currency: Currency;
  /** The id of the line corrected. */
  id: string;
  ticker: Ticker | null;
  patch: NonNullable<Decision["patch"]>;
}

/**
 * What a clean batch bought, sold, converted, split, deposited, corrected and compared with the broker, in order: what
 * `inbox:ingest` writes to the decision log.
 */
export type Trade = BuyTrade | SaleTrade | ConversionTrade | SplitTrade | SnapshotTrade | CashTrade | CorrectionTrade;

/**
 * How many units a lot the batch opened holds per unit it bought, as the fraction `n / d` of the splits of the batch so
 * far (`UNSCALED` before any). The decision log keeps a lot as it was bought and the exits of the batch carry the lot as
 * it was when they sold, so a lot is told back from the scale it is in to the one a line needs (`atScale`).
 */
interface Scale {
  n: number;
  d: number;
}
const UNSCALED: Scale = { n: 1, d: 1 };
const scaleOf = (scales: ReadonlyMap<string, Scale>, key: string): Scale => scales.get(key) ?? UNSCALED;

const composed = (scale: Scale, ratio: SplitRatio): Scale => ({ n: scale.n * ratio.new, d: scale.d * ratio.old });

/** `lot`, which is at the scale `from`, at the scale `to`: the same lot when they are one, else split by the difference. */
function atScale(lot: Lot, from: Scale, to: Scale): Lot {
  const ratio = { new: to.n * from.d, old: to.d * from.n };
  if (ratio.new === ratio.old) return lot;
  // Going back through a ratio leaves the noise of a division (9.000000000000002): what is told is 12 digits long.
  const tidy = (n: number): number => Number(n.toPrecision(12));
  const scaled = splitLot(lot, ratio);
  return {
    ...scaled,
    units: tidy(scaled.units),
    entryUnits: tidy(scaled.entryUnits),
    entryPrice: tidy(scaled.entryPrice),
    initialStop: scaled.initialStop === null ? null : tidy(scaled.initialStop),
  };
}

/** A rejected batch a clean batch gave up for good: replaced (`replaces:`) or discarded (`discard`). */
export interface Resolved {
  /** The name in `inbox/rejected/`. */
  file: string;
  how: "replaced" | "discarded";
}

export interface BatchCheck {
  /** Every problem of the batch; empty when the batch is clean. */
  issues: InboxIssue[];
  /**
   * The commands that were not checked, each with the command that blocked it (`reason`): the batch is not
   * clean while any is listed, and fixing `issues` and checking again checks them.
   */
  notChecked: InboxIssue[];
  /**
   * What a clean batch leaves that the owner should know, and that does not stop it: a position it touched
   * that ends with no stop. Empty when the batch has issues.
   */
  warnings: InboxIssue[];
  /**
   * The state the batch would produce, or the state it was checked against when it has issues: a batch
   * applies whole or not at all, so a rejected one changes nothing.
   */
  state: InboxState;
  /** The lots a clean batch opened, as the next files' refusals name them; none when it is not clean. */
  opened: ReadonlyMap<string, OpenedLot>;
  /** The stops a clean batch set or cleared; none when it is not clean. */
  stops: StopSources;
  /** What a clean batch bought and sold, in order; none when it is not clean. */
  trades: Trade[];
  /** The rejected batches a clean batch replaces or discards; none when it is not clean. */
  resolved: Resolved[];
  /** The ids taken after a clean batch (those of its lots too), and the entry costs its exits took. */
  takenIds: ReadonlySet<string>;
  entryCostsTaken: ReadonlyMap<string, Money>;
  /** The proposals cited after a clean batch (its buys' too). */
  cited: ReadonlySet<string>;
  /** What the batch changes, for the files after it if it is rejected. */
  footprint: readonly Footprint[];
  /** True for a batch of corrections (#139): the runner keeps it apart from the batches it replays. */
  corrective: boolean;
}

/** The first command that left something unknown, and how. */
interface Blocker {
  position: number;
  how: "was refused" | "could not be read" | "was not checked";
}

/** The lots of `ticker` (`null`: of any) in a silo are unknown: a buy or sale was refused, unread or not checked. */
interface LotsBlock {
  ticker: Ticker | null;
  blocker: Blocker;
}

/** The stop of `ticker` (any ticker when `undefined`) in `currencies` is unknown: a `set_stop` or `clear_stop` failed. */
interface StopBlock {
  currencies: readonly Currency[];
  ticker: Ticker | undefined;
  blocker: Blocker;
}

/**
 * Checks one batch against `state`. The commands are checked in order, each against the state the ones
 * before it would produce, so a buy and its sale in one batch are valid.
 *
 * A command that does not parse, or that a handler refuses, is reported with the rest. What it would have done
 * to its currency's cash and lots is unknown (the lot a refused buy would have opened, the cash a refused
 * deposit would have added), so the later commands of that currency are not checked against them: a cash or
 * lot error that only the blocked command explains would be misleading (N8). A command that does not parse and
 * has no readable currency blocks both silos. A `set_stop` or `clear_stop` changes no cash or lots, only the
 * stop of its ticker: when one fails, the later `clear_stop` of that ticker and the initial stops of its lots
 * are not checked (until a `set_stop` of that ticker and silo succeeds, which sets the stop for sure), and every
 * other command is. A `clear_stop` is blocked only by a refused, unread or unchecked buy or sale of its own
 * ticker, not by another ticker or currency. A silo the portfolio does not have has nothing unknown: every
 * command of it is refused for that. Each command not checked is listed in `notChecked` with the command that
 * blocked it, so nothing is skipped without a word. The errors listed are certain; fixing them can reveal errors
 * in the commands listed as not checked, and an initial-stop error in a blocked currency.
 *
 * A refusal that depends on a file `earlier.rejected` (see `dependsOn`: what that file would have changed, cash,
 * lots or stop, against what the command reads) is not checked either: the file is checked without what that
 * file would have changed, and the owner will fix the file first.
 */
export function checkBatch(state: InboxState, text: string, earlier: Earlier): BatchCheck {
  const parsed = withOverrides(parseBatch(text), earlier.overrides);
  // A correction replays the batches already applied: it is checked apart, over the ledger, and on its own in a batch (#139).
  if (isCorrection(parsed)) return checkCorrections(state, parsed, earlier);
  // What this batch can discard: the rejected batches awaiting one, but the one it replaces (that one is settled by `replaces:`).
  const awaiting = new Set(earlier.awaiting);
  const discarded: string[] = [];
  // The ids come from the one source of decision ids, never repeating one of the history's or the state's.
  const takenIds = new Set(earlier.takenIds);
  for (const silo of Object.values(state)) for (const l of silo.lots) takenIds.add(l.entryId);
  const newId = uniqueDecisionIds(takenIds, createHash("sha256").update(text).digest("hex"));
  // A replay keeps the id the log holds for a record whatever day or ticker its correction gives it.
  const nextId = (date: string, subject: string, type: string): string => {
    const id = newId(date, subject, type);
    return earlier.pins?.get(pinKey(earlier.name, id)) ?? id;
  };
  const entryCostsTaken = new Map(earlier.entryCostsTaken);
  /** The lots this batch opened, as the batch leaves them: a `set_stop` later in it can change their initial stop. */
  const lastSeen = new Map<string, { lot: Lot; scale: Scale }>();
  /** The splits the batch applied to each lot it opened (a key of `own`): the scale its lot is at now. */
  const scales = new Map<string, Scale>();
  const splits: { command: number; line: number; read: Extract<Command, { kind: "split" }>; currency: Currency }[] = [];
  const snapshots: {
    command: number;
    line: number;
    currency: Currency;
    date: string;
    differences: readonly Difference[];
  }[] = [];
  const bought: {
    command: number;
    line: number;
    key: string;
    read: Extract<Command, { kind: "buy" }>;
    relatedId?: string;
  }[] = [];
  const converted: { command: number; line: number; read: Extract<Command, { kind: "convert" }> }[] = [];
  const deposited: {
    command: number;
    line: number;
    read: Extract<Command, { kind: "deposit" | "withdrawal" }>;
  }[] = [];
  const sold: {
    command: number;
    line: number;
    read: Extract<Command, { kind: "sale" }>;
    exits: SaleShare[];
    origin: DecisionOrigin;
    /** The scale of the lots of the batch when it sold: the exits carry the lot as it was then. */
    scaleAtSale: ReadonlyMap<string, Scale>;
  }[] = [];
  /** The proposals cited by the buys so far, the earlier files' and this batch's: a proposal is followed by one buy. */
  const cited = new Set(earlier.cited);
  const trades = (): Trade[] => {
    const asBought = (key: string): Lot => {
      const seen = lastSeen.get(key)!;
      return atScale(seen.lot, seen.scale, UNSCALED);
    };
    // The lot as the batch leaves it (its initial stop is the final one), at the scale of the line it goes in.
    const final = (key: string, lot: Lot, at: Scale): Lot => {
      const seen = lastSeen.get(key);
      return seen === undefined ? lot : atScale(seen.lot, seen.scale, at);
    };
    return [
      ...bought.map((b): Trade => ({
        kind: "buy",
        command: b.command,
        line: b.line,
        currency: b.read.currency,
        ticker: b.read.ticker,
        date: b.read.date,
        units: b.read.units,
        price: b.read.price,
        ...(b.read.costs !== undefined ? { costs: b.read.costs } : {}),
        lot: asBought(b.key),
        ...(b.relatedId !== undefined ? { relatedId: b.relatedId } : {}),
      })),
      ...converted.map(({ command, line, read }): Trade => ({
        kind: "convert",
        command,
        line,
        currency: read.from,
        ...(read.date !== undefined ? { date: read.date } : {}),
        amount: read.amount,
        costs: read.costs ?? zero(read.from),
        fxRate: read.rate ?? round(read.received! / (read.amount - (read.costs ?? 0)), 6),
      })),
      ...deposited.map(({ command, line, read }): Trade => ({
        kind: read.kind,
        command,
        line,
        currency: read.currency,
        amount: read.amount,
      })),
      ...splits.map(({ command, line, read, currency }): Trade => ({
        kind: "split",
        command,
        line,
        currency,
        ticker: read.ticker,
        date: read.date,
        ratio: read.ratio.new / read.ratio.old,
      })),
      ...snapshots.map((s): Trade => ({ kind: "snapshot", ...s })),
      ...sold.map((s): Trade => ({
        kind: "sale",
        command: s.command,
        line: s.line,
        currency: s.read.currency,
        ticker: s.read.ticker,
        date: s.read.date,
        price: s.read.price,
        stopExecuted: s.read.stopExecuted,
        origin: s.origin,
        exits: s.exits.map((share) => ({
          share,
          lot: final(
            openedKey(s.read.currency, share.lot.entryId),
            share.lot,
            scaleOf(s.scaleAtSale, openedKey(s.read.currency, share.lot.entryId)),
          ),
        })),
      })),
    ].sort((a, b) => a.command - b.command);
  };
  const issues = [...parsed.issues];
  if (parsed.replaces !== undefined) {
    if (awaiting.has(parsed.replaces.file)) awaiting.delete(parsed.replaces.file);
    else {
      issues.push({
        command: null,
        line: parsed.replaces.line,
        reason: `cannot replace ${quoted(parsed.replaces.file)}: no rejected batch of that name is awaiting a replacement or a discard in inbox/rejected/`,
      });
    }
  }
  const notChecked: InboxIssue[] = [];
  let current = state;
  const present = (currency: Currency): boolean => state[currency] !== undefined;
  /** The lots of the earlier files and of this batch; `own` has this batch's alone. */
  const opened = new Map(earlier.lots);
  const own = new Map<string, OpenedLot>();
  /** Who set each stop: the earlier files', then this batch's, which the handlers write down as they apply the commands. */
  const stops = new Map(earlier.stops);
  const touched = new Map<string, { currency: Currency; ticker: Ticker; read: ParsedCommand }>();
  const blocked = new Map<Currency, Blocker>();
  const lotsBlocks: LotsBlock[] = [];
  /** The lots and the stop of `ticker` (any: `null`) are unknown in every silo: a split was refused, unread or not checked. */
  const splitBlocks: LotsBlock[] = [];
  let stopBlocks: StopBlock[] = [];
  const block = (currencies: readonly Currency[], blocker: Blocker): void => {
    for (const currency of currencies) if (present(currency) && !blocked.has(currency)) blocked.set(currency, blocker);
  };
  /** A buy, a sale, or a command that did not read as either, left the lots of `ticker` in the silos unknown. */
  const blockLots = (currencies: readonly Currency[], ticker: Ticker | null, blocker: Blocker): void => {
    if (currencies.some(present)) lotsBlocks.push({ ticker, blocker });
  };
  const blockStop = (currencies: readonly Currency[], ticker: Ticker | undefined, blocker: Blocker): void => {
    const where = currencies.filter(present);
    if (where.length > 0) stopBlocks.push({ currencies: where, ticker, blocker });
  };
  /** A `set_stop` that succeeded sets the stop of its ticker in its silo for sure: that stop is no longer unknown. */
  const liftStop = (currency: Currency, ticker: Ticker): void => {
    stopBlocks = stopBlocks
      .map((b) => (b.ticker === ticker ? { ...b, currencies: b.currencies.filter((c) => c !== currency) } : b))
      .filter((b) => b.currencies.length > 0);
  };
  const stopBlockOf = (ticker: Ticker, currency?: Currency): Blocker | undefined =>
    stopBlocks.find(
      (b) =>
        (b.ticker === undefined || b.ticker === ticker) && (currency === undefined || b.currencies.includes(currency)),
    )?.blocker;
  const lotsBlockOf = (ticker: Ticker): Blocker | undefined =>
    lotsBlocks.find((b) => b.ticker === null || b.ticker === ticker)?.blocker;
  const splitBlockOf = (ticker: Ticker): Blocker | undefined =>
    splitBlocks.find((b) => b.ticker === null || b.ticker === ticker)?.blocker;
  const touch = (currency: Currency, ticker: Ticker, read: ParsedCommand): void =>
    void touched.set(openedKey(currency, ticker), { currency, ticker, read });

  const unread = new Map(parsed.unread.map((u) => [u.position, u]));
  const order = [...parsed.commands.map((c) => c.position), ...unread.keys()].sort((a, b) => a - b);
  const byPosition = new Map(parsed.commands.map((c) => [c.position, c]));
  for (const position of order) {
    const read = byPosition.get(position);
    if (read === undefined) {
      const { currencies, kind, ticker } = unread.get(position)!;
      // A discard or a snapshot changes no cash, lots or stop: nothing is unknown because of it.
      if (kind === "discard" || kind === "snapshot") continue;
      // A conversion that did not read moved cash between both silos, whatever currencies were readable in it.
      const written = currencies.length > 0 && kind !== "convert" ? currencies : CURRENCIES;
      const blocker: Blocker = { position, how: "could not be read" };
      // A stop command changes no cash or lots: only the stop of its ticker is unknown.
      if (kind === "set_stop") blockStop(written, ticker, blocker);
      else if (kind === "clear_stop") blockStop(CURRENCIES, ticker, blocker);
      // A split changes no cash: only the lots and the stop of its ticker, in whichever silo holds it, are unknown.
      else if (kind === "split") splitBlocks.push({ ticker: ticker ?? null, blocker });
      else {
        block(written, blocker);
        if (kind !== "deposit" && kind !== "withdrawal" && kind !== "convert") {
          blockLots(written, ticker ?? null, blocker);
        }
      }
      continue;
    }
    const { command } = read;
    // A batch with a correction is checked apart (`checkCorrections`): none is left here.
    if (command.kind === "correct") continue;
    const currency = "currency" in command ? command.currency : undefined;
    // The silos whose cash a command changes: both for a conversion, its own for the others (`undefined`: none named).
    const silos: readonly Currency[] | undefined =
      command.kind === "convert" ? [command.from, command.to] : currency !== undefined ? [currency] : undefined;
    // A clear_stop names no currency: what it clears is the position of its ticker in whichever silo holds it, so
    // only a command that could have changed that ticker's lots, or its stop, makes it unknown.
    // A split names no currency either, so it reads the lots of its ticker the same way.
    const lotsBlock =
      command.kind === "clear_stop" || command.kind === "split" ? lotsBlockOf(command.ticker) : undefined;
    const cashBlock = silos?.map((c) => blocked.get(c)).find((b) => b !== undefined);
    // A refused split left the lots and the stop of its ticker unknown for every command that reads that ticker.
    // A snapshot reads the units of every ticker of its silo: a split refused anywhere left some of them unknown.
    const splitBlock =
      command.kind === "snapshot"
        ? splitBlocks[0]?.blocker
        : "ticker" in command
          ? splitBlockOf(command.ticker)
          : undefined;
    const blocker =
      cashBlock ?? lotsBlock ?? splitBlock ?? (command.kind === "clear_stop" ? stopBlockOf(command.ticker) : undefined);
    if (blocker !== undefined) {
      const unknown = unknownOf(
        command,
        silos,
        cashBlock === undefined && lotsBlock === undefined && splitBlock === undefined,
        cashBlock === undefined && lotsBlock === undefined && splitBlock !== undefined,
      );
      notChecked.push({
        command: position,
        line: read.line,
        reason: `not checked: command ${blocker.position} ${blocker.how}, so ${unknown}`,
      });
      // The stop it would have cleared is unknown in every silo: a breach that it would have removed is not an error.
      if (command.kind === "clear_stop") blockStop(CURRENCIES, command.ticker, { position, how: "was not checked" });
      // A `set_stop` that was not checked may have set or moved the stop of its ticker.
      else if (command.kind === "set_stop") {
        blockStop([command.currency], command.ticker, { position, how: "was not checked" });
      }
      // A split that was not checked may have scaled the lots and the stop of its ticker.
      else if (command.kind === "split")
        splitBlocks.push({ ticker: command.ticker, blocker: { position, how: "was not checked" } });
      // A conversion that was not checked may have moved the cash of both its silos, not only the one that was blocked.
      else if (command.kind === "convert") block([command.from, command.to], { position, how: "was not checked" });
      // A buy or a sale that was not checked may have opened or closed the lots of its ticker.
      else if (command.kind === "buy" || command.kind === "sale")
        blockLots([command.currency], command.ticker, blocker);
      continue;
    }
    const before = current;
    const context: BatchContext = {
      opened,
      earlierTickers: earlier.tickers,
      newEntryId: (date, ticker) => nextId(date, ticker, "entry"),
      rulesVersion: earlier.rulesVersion,
      entryCostsTaken,
      awaiting,
      entry: { ...earlier.entry, cited },
      record: { at: { command: position, line: read.line }, stops },
      today: earlier.today,
    };
    const result = applyCommand(current, command, context);
    if ("reason" in result) {
      // A refusal in a silo the portfolio has, that the rejected file before it could explain, is not an error of this one.
      const rejected =
        (silos === undefined || silos.every(present)) && command.kind !== "deposit"
          ? earlier.rejected.find((r) => dependsOn(r.footprint, command))
          : undefined;
      if (rejected !== undefined) {
        notChecked.push({
          command: position,
          line: read.line,
          reason: `not checked: depends on inbox/${printable(rejected.file)}, which was rejected, so ${unknownOf(command, silos, false)}`,
        });
      } else issues.push({ command: position, line: read.line, reason: result.reason });
      // What it would have done is unknown from here on. A silo the portfolio does not have has nothing unknown:
      // every command of it is refused for that (`block` leaves it out).
      const how = rejected === undefined ? "was refused" : "was not checked";
      if (command.kind === "set_stop") blockStop([command.currency], command.ticker, { position, how });
      else if (command.kind === "clear_stop") blockStop(CURRENCIES, command.ticker, { position, how });
      else if (command.kind === "convert") block([command.from, command.to], { position, how });
      else if (command.kind === "split") splitBlocks.push({ ticker: command.ticker, blocker: { position, how } });
      // A snapshot changes nothing: a refused one leaves nothing unknown.
      else if (command.kind === "snapshot") {
        // (nothing)
      } else if (currency !== undefined) {
        block([currency], { position, how });
        if (command.kind === "buy" || command.kind === "sale") blockLots([currency], command.ticker, { position, how });
      }
      continue;
    }
    // A snapshot that found differences is not told to be right when a file rejected before it could have changed what it
    // compares (a deposit or a buy that failed explains a cash or a position the engine lacks): the owner fixes that file first.
    if (command.kind === "snapshot" && result.snapshot !== undefined && result.snapshot.differences.length > 0) {
      const rejected = earlier.rejected.find((r) => dependsOn(r.footprint, command));
      if (rejected !== undefined) {
        notChecked.push({
          command: position,
          line: read.line,
          reason: `not checked: depends on inbox/${printable(rejected.file)}, which was rejected, so ${unknownOf(command, silos, false)}`,
        });
        continue;
      }
    }
    current = result.state;
    if (command.kind === "clear_stop") {
      // The silos it clears are the ones that held the ticker with a stop.
      for (const c of CURRENCIES) {
        if (before[c]?.positions.some((p) => p.ticker === command.ticker && stopOf(p) !== null)) {
          touch(c, command.ticker, read);
        }
      }
    } else if (
      command.kind !== "deposit" &&
      command.kind !== "withdrawal" &&
      command.kind !== "convert" &&
      command.kind !== "split" &&
      command.kind !== "snapshot" &&
      command.kind !== "discard"
    ) {
      touch(command.currency, command.ticker, read);
      if (command.kind === "set_stop") liftStop(command.currency, command.ticker);
    }
    if (result.discarded !== undefined) {
      awaiting.delete(result.discarded);
      discarded.push(result.discarded);
    }
    if (result.opened !== undefined && command.kind === "buy") {
      const lot = { currency: command.currency, ticker: command.ticker, command: position, line: read.line };
      opened.set(result.opened, lot);
      own.set(result.opened, lot);
      if (result.proposal !== undefined) cited.add(result.proposal);
      bought.push({
        command: position,
        line: read.line,
        key: result.opened,
        read: command,
        ...(result.proposal !== undefined ? { relatedId: result.proposal } : {}),
      });
    }
    if (command.kind === "convert") converted.push({ command: position, line: read.line, read: command });
    if (command.kind === "deposit" || command.kind === "withdrawal") {
      deposited.push({ command: position, line: read.line, read: command });
    }
    if (command.kind === "snapshot" && result.snapshot !== undefined) {
      snapshots.push({ command: position, line: read.line, ...result.snapshot });
    }
    if (command.kind === "split" && result.split !== undefined) {
      for (const key of result.split.lots) {
        if (own.has(key)) scales.set(key, composed(scaleOf(scales, key), command.ratio));
      }
      for (const silo of result.split.silos)
        splits.push({ command: position, line: read.line, read: command, currency: silo });
    }
    if (result.exits !== undefined && command.kind === "sale") {
      takeEntryCosts(entryCostsTaken, result.exits, command.currency);
      sold.push({
        command: position,
        line: read.line,
        read: command,
        exits: [...result.exits],
        origin: result.origin ?? "propietario",
        scaleAtSale: new Map(scales),
      });
    }
    // The lots of this batch as they are now: the last value of one a later command sells out is the one recorded.
    for (const key of own.keys()) {
      const [currencyOfKey, ...id] = key.split("/");
      const seen = current[currencyOfKey as Currency]?.lots.find((l) => l.entryId === id.join("/"));
      if (seen !== undefined) lastSeen.set(key, { lot: seen, scale: scaleOf(scales, key) });
    }
  }
  // The initial stop of a lot is the position's stop after the whole batch, so it is judged here, not per command (#159).
  const breaches = new Map<string, InitialStopBreach[]>();
  for (const breach of initialStopBreaches(current, opened, stops)) {
    const key = openedKey(breach.currency, breach.ticker);
    breaches.set(key, [...(breaches.get(key) ?? []), breach]);
  }
  for (const group of breaches.values()) {
    const [{ currency, ticker, stop, setBy }] = group;
    const lots = group.map((b) => ({ b, lot: opened.get(openedKey(b.currency, b.entryId))! }));
    const bought = joined(
      lots.map(
        ({ b, lot }) =>
          `the buy of ${printable(ticker)} (command ${lot.command}, line ${lot.line}) at an entry price of ${b.entryPrice} ${currency}`,
      ),
    );
    const [{ lot: first }] = lots;
    const unknown = blocked.get(currency) ?? stopBlockOf(ticker, currency) ?? splitBlockOf(ticker);
    if (unknown !== undefined) {
      // After a refusal the stop a lot ends with is not known (the set_stop that sets it may be among the commands not checked).
      notChecked.push({
        command: first.command,
        line: first.line,
        reason: `not checked: command ${unknown.position} ${unknown.how}, so the initial stop of ${bought} is unknown`,
      });
      continue;
    }
    // A stop an earlier file or portfolio.md holds is what a rejected file before this one may have changed.
    const rejected =
      setBy?.file === undefined && setBy !== null
        ? undefined
        : earlier.rejected.find((r) => changesStop(r.footprint, currency, ticker));
    if (rejected !== undefined) {
      notChecked.push({
        command: first.command,
        line: first.line,
        reason: `not checked: depends on inbox/${printable(rejected.file)}, which was rejected, so the initial stop of ${bought} is unknown`,
      });
      continue;
    }
    const plural = lots.length > 1;
    if (setBy?.file === undefined && setBy !== null) {
      issues.push({
        command: setBy.command,
        line: setBy.line,
        reason: `the set_stop at ${stop} ${currency} would be the initial stop of ${bought}, not below ${plural ? "them" : "it"}, so R would be zero or negative`,
      });
    } else {
      const holder =
        setBy != null ? `command ${setBy.command} of inbox/${printable(setBy.file!)} set` : "portfolio.md holds";
      issues.push({
        command: first.command,
        line: first.line,
        reason: `${bought} would take the stop of ${stop} ${currency} that ${holder} as its initial stop, which is not below ${plural ? "their entry prices" : "the entry price"}, so R would be zero or negative: set a stop below ${plural ? "them" : "it"} with a set_stop`,
      });
    }
  }
  issues.sort(byCommand);
  notChecked.sort(byCommand);
  const clean = issues.length === 0 && notChecked.length === 0;
  return {
    issues,
    notChecked,
    warnings: clean
      ? [...withoutStop(current, touched.values()), ...differenceWarnings(snapshots)].sort(byCommand)
      : [],
    state: clean ? current : state,
    opened: clean ? own : new Map(),
    stops: clean ? new Map([...stops].filter(([key, source]) => earlier.stops.get(key) !== source)) : new Map(),
    trades: clean ? trades() : [],
    resolved: clean
      ? [
          ...(parsed.replaces ? [{ file: parsed.replaces.file, how: "replaced" as const }] : []),
          ...discarded.map((file) => ({ file, how: "discarded" as const })),
        ]
      : [],
    takenIds: clean ? takenIds : earlier.takenIds,
    cited: clean ? cited : earlier.cited,
    entryCostsTaken: clean ? entryCostsTaken : earlier.entryCostsTaken,
    footprint: footprintOf(parsed),
    corrective: false,
  };
}

/** The batch with the commands a replay runs in another form (a correction's) put in place of the ones the file holds. */
function withOverrides(parsed: ParsedBatch, overrides: ReadonlyMap<number, Command> | undefined): ParsedBatch {
  if (overrides === undefined || overrides.size === 0) return parsed;
  return {
    ...parsed,
    commands: parsed.commands.map((c) => {
      const command = overrides.get(c.position);
      return command === undefined ? c : { ...c, command };
    }),
  };
}

/**
 * Checks a batch of corrections (#139) against `state`, the one the batches already applied left. Each `correct` command
 * names a record by the id the engine gave it; the applied batches are replayed with the correction and the state they
 * give is the state of the correction, so a later sale without lots or a cash below zero refuses it, in the words of
 * the command that would fail (`replay`). The corrections go on their own in a batch, and after the batches of the
 * run have been applied: what they rebuild is the applied history, which the log is written from.
 */
function checkCorrections(state: InboxState, parsed: ParsedBatch, earlier: Earlier): BatchCheck {
  const issues = [...parsed.issues];
  const awaiting = new Set(earlier.awaiting);
  const fail = (command: number | null, line: number | null, reason: string): void =>
    void issues.push({ command, line, reason });
  const footprint = footprintOf(parsed);
  const rejected = (): BatchCheck => ({
    issues: issues.sort(byCommand),
    notChecked: [],
    warnings: [],
    state,
    opened: new Map(),
    stops: new Map(),
    trades: [],
    resolved: [],
    takenIds: earlier.takenIds,
    entryCostsTaken: earlier.entryCostsTaken,
    cited: earlier.cited,
    footprint,
    corrective: true,
  });
  let resolved: Resolved[] = [];
  if (parsed.replaces !== undefined) {
    if (awaiting.has(parsed.replaces.file)) resolved = [{ file: parsed.replaces.file, how: "replaced" }];
    else {
      fail(
        null,
        parsed.replaces.line,
        `cannot replace ${quoted(parsed.replaces.file)}: no rejected batch of that name is awaiting a replacement or a discard in inbox/rejected/`,
      );
    }
  }
  const corrections: Correction[] = [];
  for (const { position, line, command } of parsed.commands) {
    if (command.kind === "correct") corrections.push({ file: "", command: position, line, fix: command });
    else
      fail(
        position,
        line,
        `a correction goes in a batch of corrections only: command ${position} is a ${command.kind}`,
      );
  }
  const [firstAt] = corrections;
  if (earlier.ledger === undefined) {
    fail(
      firstAt?.command ?? null,
      firstAt?.line ?? null,
      "a correction cannot be checked: the batches already applied (inbox/applied/) were not read",
    );
    return rejected();
  }
  if ((earlier.appliedInRun ?? 0) > 0) {
    fail(
      firstAt?.command ?? null,
      firstAt?.line ?? null,
      "a correction goes after the batches of the run are applied: run inbox:ingest, then send the correction",
    );
    return rejected();
  }

  const { ledger } = earlier;
  const options = {
    initial: earlier.starting ?? emptyState(state),
    history: earlier.entry.history,
    rulesVersion: earlier.rulesVersion,
    today: earlier.today,
  };
  const base = replay(runFiles, ledger, [], options);
  if (isReplayFailure(base)) {
    fail(
      firstAt?.command ?? null,
      firstAt?.line ?? null,
      `the batches already applied do not rebuild the state: inbox/applied/${printable(base.file ?? "")}${base.command === null ? "" : `, command ${base.command}`}: ${base.reason}`,
    );
    return rejected();
  }
  const drift = stateDifferences(state, base.state, "the state", "the applied batches");
  if (drift.length > 0) {
    fail(
      firstAt?.command ?? null,
      firstAt?.line ?? null,
      `the state is not what the batches already applied give (${drift.slice(0, 3).join("; ")}${drift.length > 3 ? `; and ${drift.length - 3} more` : ""}): rebuild it first with state:repair (docs/input-format.md › \`state:repair\`)`,
    );
    return rejected();
  }

  // One correction at a time, so that the one that fails is named; the ones accepted before it stay in the replay.
  const accepted: Correction[] = [];
  let latest = base;
  const shown = (r: ReplayResult) => patchesOf(r.lines, earlier.entry.history, r.undated);
  for (const correction of corrections) {
    const next = replay(runFiles, ledger, [...accepted, correction], options);
    if (isReplayFailure(next)) fail(correction.command, correction.line, next.reason);
    else if (isDeepStrictEqual(shown(next), shown(latest))) {
      fail(
        correction.command,
        correction.line,
        `cannot correct ${quoted(correction.fix.id)}: it changes nothing in the record`,
      );
    } else {
      accepted.push(correction);
      latest = next;
    }
  }
  if (issues.length > 0) return rejected();

  const last = corrections[corrections.length - 1];
  const known = CURRENCIES.flatMap((c) => (state[c]?.lots ?? []) as Lot[]);
  const rebuilt = withTelemetry(restoreMetadata(latest.state, known, earlier.entry.history), state);
  const taken = new Map(earlier.entryCostsTaken);
  for (const [id, amount] of costsTakenBy(latest.lines)) taken.set(id, amount);
  return {
    issues: [],
    notChecked: [],
    warnings: [],
    state: rebuilt,
    opened: new Map(),
    stops: new Map(),
    trades: patchesOf(latest.lines, earlier.entry.history, latest.undated).map(({ line, patch }): Trade => ({
      kind: "correction",
      command: last.command,
      line: last.line ?? 1,
      currency: line.currency,
      id: line.id,
      ticker: line.ticker,
      patch,
    })),
    resolved,
    takenIds: earlier.takenIds,
    entryCostsTaken: taken,
    cited: earlier.cited,
    footprint,
    corrective: true,
  };
}

/**
 * What a command not checked would have changed and is unknown, for the reason of its `not checked`: a stop command
 * changes no cash or lots, only a stop (`stopBlocked`: only the stop of the ticker is what the blocker left unknown).
 */
function unknownOf(
  command: Command,
  silos: readonly Currency[] | undefined,
  stopBlocked: boolean,
  splitBlocked = false,
): string {
  if (command.kind === "correct") return "the state it would rebuild is unknown";
  if (command.kind === "snapshot") return `the ${command.currency} cash and positions it would compare are unknown`;
  // A split that failed scaled the lots and the stop of its ticker, whatever command now reads them.
  if (splitBlocked && "ticker" in command)
    return `the lots and the stop of ${printable(command.ticker)} it would change are unknown`;
  if (command.kind === "split") return "the lots of the ticker it would change are unknown";
  if (command.kind === "set_stop" || command.kind === "clear_stop") {
    return stopBlocked ? "the stop it would change is unknown" : "the position it would change is unknown";
  }
  if (command.kind === "convert") return `the ${silos?.join(" and ")} cash it would change is unknown`;
  return `the ${silos?.join(" and ")} cash and lots it would change are unknown`;
}

/** `a`, `a and b`, `a, b and c`. */
const joined = (items: readonly string[]): string =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

const byCommand = (a: InboxIssue, b: InboxIssue): number => (a.command ?? 0) - (b.command ?? 0);

/** What the commands of a batch would change; a file that did not read at all could have changed anything. */
function footprintOf(parsed: ParsedBatch): Footprint[] {
  if (parsed.commands.length === 0 && parsed.unread.length === 0) {
    return [{ currencies: CURRENCIES, kind: null, ticker: null }];
  }
  return [
    ...parsed.commands.map(({ command }) => ({
      currencies:
        command.kind === "convert"
          ? [command.from, command.to]
          : "currency" in command && command.currency !== undefined
            ? [command.currency]
            : CURRENCIES,
      kind: command.kind,
      // A correction can change any ticker's lots and stop.
      ticker: command.kind === "correct" ? null : "ticker" in command ? command.ticker : undefined,
    })),
    ...parsed.unread.map((u) => ({
      currencies: u.currencies.length > 0 && u.kind !== "convert" ? u.currencies : CURRENCIES,
      kind: u.kind ?? null,
      ticker:
        u.kind === "deposit" || u.kind === "withdrawal" || u.kind === "convert" || u.kind === "discard"
          ? undefined
          : (u.ticker ?? null),
    })),
  ];
}

/** What each kind of command changes: the cash of its silo, the lots of its ticker, the stop of its ticker. */
const CHANGES: Record<CommandKind, { cash: boolean; lots: boolean; stop: boolean }> = {
  deposit: { cash: true, lots: false, stop: false },
  withdrawal: { cash: true, lots: false, stop: false },
  convert: { cash: true, lots: false, stop: false },
  buy: { cash: true, lots: true, stop: false },
  sale: { cash: true, lots: true, stop: false },
  set_stop: { cash: false, lots: false, stop: true },
  clear_stop: { cash: false, lots: false, stop: true },
  split: { cash: false, lots: true, stop: true },
  snapshot: { cash: false, lots: false, stop: false },
  discard: { cash: false, lots: false, stop: false },
  correct: { cash: true, lots: true, stop: true },
};

/**
 * True if the refusal of `command` could be explained by the file with this footprint, by what that file would
 * have changed and the command reads: a withdrawal or a buy reads the cash of the silo; a sale and a `set_stop`
 * read the lots of the ticker (the position has to exist); a `clear_stop` reads the lots and the stop of the
 * ticker. A file that only set or cleared stops changed no cash or lots, so it explains none of the first three.
 * A command that did not read (`kind` null) could have changed any of them.
 */
function dependsOn(footprint: readonly Footprint[], command: Command): boolean {
  const currencies =
    command.kind === "convert"
      ? [command.from, command.to]
      : "currency" in command && command.currency !== undefined
        ? [command.currency]
        : CURRENCIES;
  const ticker = command.kind === "correct" ? undefined : "ticker" in command ? command.ticker : undefined;
  const reads = {
    cash:
      command.kind === "withdrawal" ||
      command.kind === "convert" ||
      command.kind === "buy" ||
      command.kind === "snapshot",
    lots:
      command.kind === "sale" ||
      command.kind === "set_stop" ||
      command.kind === "clear_stop" ||
      command.kind === "split",
    stop: command.kind === "clear_stop",
  };
  return footprint.some((f) => {
    if (!f.currencies.some((c) => currencies.includes(c))) return false;
    const changes = f.kind === null ? { cash: true, lots: true, stop: true } : CHANGES[f.kind];
    if (reads.cash && changes.cash) return true;
    // A snapshot reads the units of every ticker of its silo, so a file that changed the lots of any is what explains it.
    if (command.kind === "snapshot" && changes.lots) return true;
    const sameTicker = f.ticker === null || f.ticker === ticker;
    return sameTicker && ((reads.lots && changes.lots) || (reads.stop && changes.stop));
  });
}

/**
 * True if the file with this footprint could have changed the stop of `ticker` in `currency`: set or cleared it,
 * or sold the position out, which takes its stop with it (a later buy opens a position with none).
 */
function changesStop(footprint: readonly Footprint[], currency: Currency, ticker: Ticker): boolean {
  return footprint.some(
    (f) =>
      f.currencies.includes(currency) &&
      (f.kind === null || f.kind === "sale" || CHANGES[f.kind].stop) &&
      (f.ticker === null || f.ticker === ticker),
  );
}

/**
 * The positions the commands touched that `state` (the one they produce) holds with no stop, one warning per
 * silo and ticker at the last command that touched it: risk watch cannot protect a position without a stop.
 * A command touches the position it buys, sells from, or sets or clears the stop of.
 */
function withoutStop(
  state: InboxState,
  touched: Iterable<{ currency: Currency; ticker: Ticker; read: ParsedCommand }>,
): InboxIssue[] {
  return [...touched]
    .filter(({ currency, ticker }) => state[currency]?.positions.some((p) => p.ticker === ticker && stopOf(p) === null))
    .map(({ currency, ticker, read: { position, line } }) => ({
      command: position,
      line,
      reason: `${printable(ticker)} has no stop in the ${currency} silo, so risk watch cannot protect it`,
    }))
    .sort(byCommand);
}

/** One warning per difference a snapshot found: it does not stop the batch, the owner corrects the state with a command. */
function differenceWarnings(
  snapshots: readonly {
    command: number;
    line: number;
    currency: Currency;
    date: string;
    differences: readonly Difference[];
  }[],
): InboxIssue[] {
  return snapshots.flatMap(({ command, line, currency, date, differences }) =>
    differences.map((d): InboxIssue => ({ command, line, reason: describeDifference(currency, date, d) })),
  );
}

const signed = (n: number, text: string): string => `${n > 0 ? "+" : n < 0 ? "-" : ""}${text}`;

/** A difference in words, as the check and the ingest tell it; its size is what the broker holds less what the engine does. */
export function describeDifference(currency: Currency, date: string, d: Difference): string {
  const head = `the ${currency} snapshot as of ${date} differs from the state in`;
  if (d.kind === "cash") {
    const size = round(d.broker - d.engine, 2);
    return `${head} the cash: the broker has ${formatMoney(d.broker)} ${currency}, the engine ${formatMoney(d.engine)} ${currency} (${signed(size, `${formatMoney(Math.abs(size))} ${currency}`)})`;
  }
  const size = round(d.broker - d.engine, 8);
  return `${head} ${printable(d.ticker)}: the broker has ${d.broker} units, the engine ${d.engine} (${signed(size, String(Math.abs(size)))})`;
}

/** A file of the inbox: its text, or why it could not be read (a symbolic link, which is reported and never followed). */
export type InboxFile = { name: string; text: string } | { name: string; problem: string };

export interface FileCheck {
  name: string;
  issues: InboxIssue[];
  /** The commands of the file that were not checked; see `BatchCheck`. */
  notChecked: InboxIssue[];
  warnings: InboxIssue[];
  /** True for a file that checks clean: `inbox:ingest` applies it. A file that could not be read is never clean. */
  clean: boolean;
  /** What a clean file bought and sold, in order. */
  trades: Trade[];
  /** The rejected batches a clean file replaces or discards. */
  resolved: Resolved[];
  /** The text of the file, absent for one that could not be read. */
  text?: string;
}

/** What running the files of the inbox over a state gives: the check of each, and the state the clean ones leave. */
export interface InboxRun {
  checks: FileCheck[];
  state: InboxState;
}

/**
 * Runs the files of the inbox in name order: the one runner of `inbox:check` and `inbox:ingest`. Each file is a
 * batch checked against the state the clean batches before it would produce (a rejected batch contributes
 * nothing, as when they are applied), so the result is what applying the inbox does. A batch with a command not
 * checked counts as rejected; so does a file that could not be read, which any later file may depend on.
 */
export function runFiles(state: InboxState, files: readonly InboxFile[], run: RunContext): InboxRun {
  let current = state;
  const lots = new Map<string, OpenedLot>();
  const tickers = new Set<string>();
  const stops = new Map<string, StopSource | null>();
  const rejected: RejectedFile[] = [];
  let awaiting: ReadonlySet<string> = run.awaiting;
  let takenIds: ReadonlySet<string> = run.takenIds;
  let entryCostsTaken: ReadonlyMap<string, Money> = run.entryCostsTaken;
  // What the history already cites is in `run.entry.history`; these are the proposals cited by this run's own buys.
  let cited: ReadonlySet<string> = new Set();
  // The batches applied so far, in order: those before the run, then each clean file (a correction replays them).
  const ledger = run.ledger === undefined ? undefined : [...run.ledger];
  let appliedInRun = 0;
  const checks = files.map((file): FileCheck => {
    const { name } = file;
    if ("problem" in file) {
      rejected.push({ file: name, footprint: [{ currencies: CURRENCIES, kind: null, ticker: null }] });
      return {
        name,
        issues: [{ command: null, line: null, reason: file.problem }],
        notChecked: [],
        warnings: [],
        clean: false,
        trades: [],
        resolved: [],
      };
    }
    const { text } = file;
    const checked = checkBatch(current, text, {
      lots,
      stops,
      rejected,
      tickers,
      awaiting,
      takenIds,
      entryCostsTaken,
      rulesVersion: run.rulesVersion,
      cited,
      entry: run.entry,
      today: run.today,
      ...(ledger !== undefined ? { ledger } : {}),
      ...(run.starting !== undefined ? { starting: run.starting } : {}),
      name,
      appliedInRun,
      ...(run.overrides?.get(name) !== undefined ? { overrides: run.overrides.get(name) } : {}),
      ...(run.pins !== undefined ? { pins: run.pins } : {}),
    });
    const clean = checked.issues.length === 0 && checked.notChecked.length === 0;
    if (!clean) {
      rejected.push({ file: name, footprint: checked.footprint });
    } else {
      current = checked.state;
      ledger?.push({ name, text });
      if (!checked.corrective) appliedInRun += 1;
      awaiting = new Set([...awaiting].filter((name) => !checked.resolved.some((r) => r.file === name)));
      takenIds = checked.takenIds;
      entryCostsTaken = checked.entryCostsTaken;
      cited = checked.cited;
      // For the next files, a lot or a stop this one left is the file's.
      for (const [key, lot] of checked.opened) {
        lots.set(key, { ...lot, file: name });
        tickers.add(openedKey(lot.currency, lot.ticker));
      }
      for (const [key, source] of checked.stops) {
        if (source === null) stops.delete(key);
        else stops.set(key, { ...source, file: name });
      }
      // A lot this file or an earlier one used up is no lot to name any more; its ticker stays in `tickers`.
      for (const [key, lot] of lots) {
        if (!current[lot.currency]?.lots.some((l) => openedKey(lot.currency, l.entryId) === key)) lots.delete(key);
      }
    }
    return {
      name,
      issues: checked.issues,
      notChecked: checked.notChecked,
      warnings: checked.warnings,
      clean,
      trades: checked.trades,
      resolved: checked.resolved,
      text,
    };
  });
  return { checks, state: current };
}

const where = (command: number | null, line: number | null): string =>
  [command === null ? "file" : `command ${command}`, line === null ? undefined : `line ${line}`]
    .filter(Boolean)
    .join(", ");

/**
 * One line per issue and per command not checked, in the order of the file:
 * `inbox/<file>: command <n>, line <l>: <reason>`.
 */
export function renderIssues(checks: readonly FileCheck[]): string[] {
  return checks.flatMap(({ name, issues, notChecked }) =>
    [...issues, ...notChecked]
      .sort(byCommand)
      .map(({ command, line, reason }) => `inbox/${printable(name)}: ${where(command, line)}: ${reason}`),
  );
}

/** One line per warning, like an issue with `warning: ` before the reason. */
export function renderWarnings(checks: readonly FileCheck[]): string[] {
  return checks.flatMap(({ name, warnings }) =>
    warnings.map(
      ({ command, line, reason }) => `inbox/${printable(name)}: ${where(command, line)}: warning: ${reason}`,
    ),
  );
}
