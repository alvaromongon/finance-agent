// `inbox:check` without the I/O (#131): a batch (the text of one inbox file) against a state, and the files of
// the inbox in order. Pure; `inbox.ts` reads the files and the portfolio and prints what this returns.
import { CURRENCIES, type Currency } from "../types.js";
import type { Ticker } from "../ticker.js";
import {
  applyCommand,
  initialStopBreaches,
  openedKey,
  stopOf,
  type Command,
  type InboxState,
  type InitialStopBreach,
  type OpenedLot,
  type OpenedLots,
  type StopSource,
  type StopSources,
} from "./inbox-handlers.js";
import { parseBatch, type CommandKind, type InboxIssue, type ParsedBatch, type ParsedCommand } from "./inbox-parse.js";
import { printable } from "./printable.js";

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

/** What the files before the batch under check left behind. */
export interface Earlier {
  /** The lots the clean files opened and that are still open. */
  lots: OpenedLots;
  stops: StopSources;
  rejected: readonly RejectedFile[];
  /** `openedKey(currency, ticker)` of every ticker the clean files opened, also when all of it was sold since. */
  tickers?: ReadonlySet<string>;
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
  /** What the batch changes, for the files after it if it is rejected. */
  footprint: readonly Footprint[];
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

const NOTHING: Earlier = { lots: new Map(), stops: new Map(), rejected: [] };

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
export function checkBatch(state: InboxState, text: string, earlier: Earlier = NOTHING): BatchCheck {
  const parsed = parseBatch(text);
  const issues = [...parsed.issues];
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
  const touch = (currency: Currency, ticker: Ticker, read: ParsedCommand): void =>
    void touched.set(openedKey(currency, ticker), { currency, ticker, read });

  const unread = new Map(parsed.unread.map((u) => [u.position, u]));
  const order = [...parsed.commands.map((c) => c.position), ...unread.keys()].sort((a, b) => a - b);
  const byPosition = new Map(parsed.commands.map((c) => [c.position, c]));
  for (const position of order) {
    const read = byPosition.get(position);
    if (read === undefined) {
      const { currencies, kind, ticker } = unread.get(position)!;
      const written = currencies.length > 0 ? currencies : CURRENCIES;
      const blocker: Blocker = { position, how: "could not be read" };
      // A stop command changes no cash or lots: only the stop of its ticker is unknown.
      if (kind === "set_stop") blockStop(written, ticker, blocker);
      else if (kind === "clear_stop") blockStop(CURRENCIES, ticker, blocker);
      else {
        block(written, blocker);
        if (kind !== "deposit" && kind !== "withdrawal") blockLots(written, ticker ?? null, blocker);
      }
      continue;
    }
    const { command } = read;
    const currency = "currency" in command ? command.currency : undefined;
    // A clear_stop names no currency: what it clears is the position of its ticker in whichever silo holds it, so
    // only a command that could have changed that ticker's lots, or its stop, makes it unknown.
    const lotsBlock = command.kind === "clear_stop" ? lotsBlockOf(command.ticker) : undefined;
    const cashBlock = currency !== undefined ? blocked.get(currency) : undefined;
    const blocker = cashBlock ?? lotsBlock ?? (command.kind === "clear_stop" ? stopBlockOf(command.ticker) : undefined);
    if (blocker !== undefined) {
      const unknown = unknownOf(command, currency, cashBlock === undefined && lotsBlock === undefined);
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
      // A buy or a sale that was not checked may have opened or closed the lots of its ticker.
      else if (command.kind === "buy" || command.kind === "sale")
        blockLots([command.currency], command.ticker, blocker);
      continue;
    }
    const before = current;
    const result = applyCommand(current, command, opened, earlier.tickers, {
      at: { command: position, line: read.line },
      stops,
    });
    if ("reason" in result) {
      // A refusal in a silo the portfolio has, that the rejected file before it could explain, is not an error of this one.
      const rejected =
        (currency === undefined || present(currency)) && command.kind !== "deposit"
          ? earlier.rejected.find((r) => dependsOn(r.footprint, command))
          : undefined;
      if (rejected !== undefined) {
        notChecked.push({
          command: position,
          line: read.line,
          reason: `not checked: depends on inbox/${printable(rejected.file)}, which was rejected, so ${unknownOf(command, currency, false)}`,
        });
      } else issues.push({ command: position, line: read.line, reason: result.reason });
      // What it would have done is unknown from here on. A silo the portfolio does not have has nothing unknown:
      // every command of it is refused for that (`block` leaves it out).
      const how = rejected === undefined ? "was refused" : "was not checked";
      if (command.kind === "set_stop") blockStop([command.currency], command.ticker, { position, how });
      else if (command.kind === "clear_stop") blockStop(CURRENCIES, command.ticker, { position, how });
      else if (currency !== undefined) {
        block([currency], { position, how });
        if (command.kind === "buy" || command.kind === "sale") blockLots([currency], command.ticker, { position, how });
      }
      continue;
    }
    current = result.state;
    if (command.kind === "clear_stop") {
      // The silos it clears are the ones that held the ticker with a stop.
      for (const c of CURRENCIES) {
        if (before[c]?.positions.some((p) => p.ticker === command.ticker && stopOf(p) !== null)) {
          touch(c, command.ticker, read);
        }
      }
    } else if (command.kind !== "deposit" && command.kind !== "withdrawal") {
      touch(command.currency, command.ticker, read);
      if (command.kind === "set_stop") liftStop(command.currency, command.ticker);
    }
    if (result.opened !== undefined && command.kind === "buy") {
      const lot = { currency: command.currency, ticker: command.ticker, command: position, line: read.line };
      opened.set(result.opened, lot);
      own.set(result.opened, lot);
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
    const unknown = blocked.get(currency) ?? stopBlockOf(ticker, currency);
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
    warnings: clean ? withoutStop(current, touched.values()) : [],
    state: clean ? current : state,
    opened: clean ? own : new Map(),
    stops: clean ? new Map([...stops].filter(([key, source]) => earlier.stops.get(key) !== source)) : new Map(),
    footprint: footprintOf(parsed),
  };
}

/**
 * What a command not checked would have changed and is unknown, for the reason of its `not checked`: a stop command
 * changes no cash or lots, only a stop (`stopBlocked`: only the stop of the ticker is what the blocker left unknown).
 */
function unknownOf(command: Command, currency: Currency | undefined, stopBlocked: boolean): string {
  if (command.kind === "set_stop" || command.kind === "clear_stop") {
    return stopBlocked ? "the stop it would change is unknown" : "the position it would change is unknown";
  }
  return `the ${currency} cash and lots it would change are unknown`;
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
      currencies: "currency" in command ? [command.currency] : CURRENCIES,
      kind: command.kind,
      ticker: "ticker" in command ? command.ticker : undefined,
    })),
    ...parsed.unread.map((u) => ({
      currencies: u.currencies.length > 0 ? u.currencies : CURRENCIES,
      kind: u.kind ?? null,
      ticker: u.kind === "deposit" || u.kind === "withdrawal" ? undefined : (u.ticker ?? null),
    })),
  ];
}

/** What each kind of command changes: the cash of its silo, the lots of its ticker, the stop of its ticker. */
const CHANGES: Record<CommandKind, { cash: boolean; lots: boolean; stop: boolean }> = {
  deposit: { cash: true, lots: false, stop: false },
  withdrawal: { cash: true, lots: false, stop: false },
  buy: { cash: true, lots: true, stop: false },
  sale: { cash: true, lots: true, stop: false },
  set_stop: { cash: false, lots: false, stop: true },
  clear_stop: { cash: false, lots: false, stop: true },
};

/**
 * True if the refusal of `command` could be explained by the file with this footprint, by what that file would
 * have changed and the command reads: a withdrawal or a buy reads the cash of the silo; a sale and a `set_stop`
 * read the lots of the ticker (the position has to exist); a `clear_stop` reads the lots and the stop of the
 * ticker. A file that only set or cleared stops changed no cash or lots, so it explains none of the first three.
 * A command that did not read (`kind` null) could have changed any of them.
 */
function dependsOn(footprint: readonly Footprint[], command: Command): boolean {
  const currencies = "currency" in command ? [command.currency] : CURRENCIES;
  const ticker = "ticker" in command ? command.ticker : undefined;
  const reads = {
    cash: command.kind === "withdrawal" || command.kind === "buy",
    lots: command.kind === "sale" || command.kind === "set_stop" || command.kind === "clear_stop",
    stop: command.kind === "clear_stop",
  };
  return footprint.some((f) => {
    if (!f.currencies.some((c) => currencies.includes(c))) return false;
    const changes = f.kind === null ? { cash: true, lots: true, stop: true } : CHANGES[f.kind];
    if (reads.cash && changes.cash) return true;
    const sameTicker = f.ticker === null || f.ticker === ticker;
    return sameTicker && ((reads.lots && changes.lots) || (reads.stop && changes.stop));
  });
}

/** True if the file with this footprint could have set or cleared the stop of `ticker` in `currency`. */
function changesStop(footprint: readonly Footprint[], currency: Currency, ticker: Ticker): boolean {
  return footprint.some(
    (f) =>
      f.currencies.includes(currency) &&
      (f.kind === null || CHANGES[f.kind].stop) &&
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

export interface InboxFile {
  name: string;
  text: string;
}

export interface FileCheck {
  name: string;
  issues: InboxIssue[];
  /** The commands of the file that were not checked; see `BatchCheck`. */
  notChecked: InboxIssue[];
  warnings: InboxIssue[];
}

/**
 * Checks the files of the inbox in name order. Each file is a batch checked against the state the clean
 * batches before it would produce (a rejected batch contributes nothing, as when they are applied), so the
 * result predicts what applying the inbox would do. A batch with a command not checked counts as rejected.
 */
export function checkFiles(state: InboxState, files: readonly InboxFile[]): FileCheck[] {
  let current = state;
  const lots = new Map<string, OpenedLot>();
  const tickers = new Set<string>();
  const stops = new Map<string, StopSource | null>();
  const rejected: RejectedFile[] = [];
  return files.map(({ name, text }) => {
    const checked = checkBatch(current, text, { lots, stops, rejected, tickers });
    if (checked.issues.length > 0 || checked.notChecked.length > 0) {
      rejected.push({ file: name, footprint: checked.footprint });
    } else {
      current = checked.state;
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
    return { name, issues: checked.issues, notChecked: checked.notChecked, warnings: checked.warnings };
  });
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
