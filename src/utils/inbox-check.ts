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
} from "./inbox-handlers.js";
import { parseBatch, type InboxIssue, type ParsedBatch, type ParsedCommand } from "./inbox-parse.js";
import { printable } from "./printable.js";

/** Who set the stop of a position: a `set_stop` of the batch under check (no `file`), or of an earlier file. */
export interface StopSource {
  command: number;
  line: number;
  file?: string;
}

/** The stop of a position (`<currency>/<ticker>`) after the commands so far: who set it, or `null` for cleared. */
export type StopSources = ReadonlyMap<string, StopSource | null>;

const stopKey = (currency: Currency, ticker: Ticker): string => `${currency}/${ticker}`;

/**
 * What a command would have changed, as far as other commands can depend on it: the silos, and the ticker whose
 * lots and stop it changes (`undefined`: none, a cash command; `null`: any, a command that did not read).
 */
interface Footprint {
  currencies: readonly Currency[];
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
 * are not checked, and every other command is. A silo the portfolio does not have has nothing unknown: every
 * command of it is refused for that. Each command not checked is listed in `notChecked` with the command that
 * blocked it, so nothing is skipped without a word and the next check shows no error of its own batch that this
 * one hid.
 *
 * A refusal that depends on a file `earlier.rejected` (a command of it touched the same currency, and for a
 * lot or a stop the same ticker) is not checked either: the file is checked without what that file would have
 * changed, and the owner will fix the file first.
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
  const stops = new Map<string, StopSource | null>();
  const touched = new Map<string, { currency: Currency; ticker: Ticker; read: ParsedCommand }>();
  const blocked = new Map<Currency, Blocker>();
  const stopBlocks: StopBlock[] = [];
  const block = (currencies: readonly Currency[], blocker: Blocker): void => {
    for (const currency of currencies) if (present(currency) && !blocked.has(currency)) blocked.set(currency, blocker);
  };
  const blockStop = (currencies: readonly Currency[], ticker: Ticker | undefined, blocker: Blocker): void => {
    const where = currencies.filter(present);
    if (where.length > 0) stopBlocks.push({ currencies: where, ticker, blocker });
  };
  const stopBlockOf = (ticker: Ticker, currency?: Currency): Blocker | undefined =>
    stopBlocks.find(
      (b) =>
        (b.ticker === undefined || b.ticker === ticker) && (currency === undefined || b.currencies.includes(currency)),
    )?.blocker;
  const touch = (currency: Currency, ticker: Ticker, read: ParsedCommand): void =>
    void touched.set(stopKey(currency, ticker), { currency, ticker, read });

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
      else block(written, blocker);
      continue;
    }
    const { command } = read;
    // A clear_stop names no currency: it waits for the first blocked one.
    const currency = "currency" in command ? command.currency : undefined;
    const changesStop = command.kind === "set_stop" || command.kind === "clear_stop";
    const cashBlock = currency !== undefined ? blocked.get(currency) : blocked.values().next().value;
    const blocker = cashBlock ?? (command.kind === "clear_stop" ? stopBlockOf(command.ticker) : undefined);
    if (blocker !== undefined) {
      const unknown = changesStop
        ? cashBlock
          ? "the position it would change is unknown"
          : "the stop it would change is unknown"
        : `the ${currency} cash and lots it would change are unknown`;
      notChecked.push({
        command: position,
        line: read.line,
        reason: `not checked: command ${blocker.position} ${blocker.how}, so ${unknown}`,
      });
      continue;
    }
    const before = current;
    const result = applyCommand(current, command, opened);
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
          reason: `not checked: depends on inbox/${printable(rejected.file)}, which was rejected, so the ${currency === undefined ? "position" : `${currency} cash and lots`} it would change ${currency === undefined ? "is" : "are"} unknown`,
        });
      } else issues.push({ command: position, line: read.line, reason: result.reason });
      // What it would have done is unknown from here on. A silo the portfolio does not have has nothing unknown:
      // every command of it is refused for that (`block` leaves it out).
      const how = rejected === undefined ? "was refused" : "was not checked";
      if (command.kind === "set_stop") blockStop([command.currency], command.ticker, { position, how });
      else if (command.kind === "clear_stop") blockStop(CURRENCIES, command.ticker, { position, how });
      else if (currency !== undefined) block([currency], { position, how });
      continue;
    }
    current = result.state;
    if (command.kind === "clear_stop") {
      // The silos it clears are the ones that held the ticker with a stop.
      for (const c of CURRENCIES) {
        if (before[c]?.positions.some((p) => p.ticker === command.ticker && stopOf(p) !== null)) {
          touch(c, command.ticker, read);
          stops.set(stopKey(c, command.ticker), null);
        }
      }
    } else if (command.kind !== "deposit" && command.kind !== "withdrawal") {
      touch(command.currency, command.ticker, read);
      if (command.kind === "set_stop") {
        stops.set(stopKey(command.currency, command.ticker), { command: position, line: read.line });
      }
    }
    if (result.opened !== undefined && command.kind === "buy") {
      const lot = { ticker: command.ticker, command: position, line: read.line };
      opened.set(result.opened, lot);
      own.set(result.opened, lot);
    }
  }
  // The initial stop of a lot is the position's stop after the whole batch, so it is judged here, not per command (#159).
  const breaches = new Map<string, InitialStopBreach[]>();
  for (const breach of initialStopBreaches(current, opened)) {
    const key = stopKey(breach.currency, breach.ticker);
    breaches.set(key, [...(breaches.get(key) ?? []), breach]);
  }
  for (const [key, group] of breaches) {
    const [{ currency, ticker, stop }] = group;
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
    const setBy = stops.has(key) ? stops.get(key) : earlier.stops.get(key);
    const plural = lots.length > 1;
    if (setBy?.file === undefined && setBy != null) {
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
    stops: clean ? stops : new Map(),
    footprint: footprintOf(parsed),
  };
}

/** `a`, `a and b`, `a, b and c`. */
const joined = (items: readonly string[]): string =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

const byCommand = (a: InboxIssue, b: InboxIssue): number => (a.command ?? 0) - (b.command ?? 0);

/** What the commands of a batch would change; a file that did not read at all could have changed anything. */
function footprintOf(parsed: ParsedBatch): Footprint[] {
  if (parsed.commands.length === 0 && parsed.unread.length === 0) return [{ currencies: CURRENCIES, ticker: null }];
  return [
    ...parsed.commands.map(({ command }) => ({
      currencies: "currency" in command ? [command.currency] : CURRENCIES,
      ticker: "ticker" in command ? command.ticker : undefined,
    })),
    ...parsed.unread.map((u) => ({
      currencies: u.currencies.length > 0 ? u.currencies : CURRENCIES,
      ticker: u.kind === "deposit" || u.kind === "withdrawal" ? undefined : (u.ticker ?? null),
    })),
  ];
}

/**
 * True if the refusal of `command` could be explained by the file with this footprint: it changed the cash of the
 * silo (a withdrawal or a buy is refused for the cash), or the lots and the stop of the ticker (a sale, a
 * `set_stop`, a `clear_stop`).
 */
function dependsOn(footprint: readonly Footprint[], command: Command): boolean {
  const currencies = "currency" in command ? [command.currency] : CURRENCIES;
  const cash = command.kind === "withdrawal" || command.kind === "buy";
  const ticker = "ticker" in command ? command.ticker : undefined;
  return footprint.some(
    (f) => f.currencies.some((c) => currencies.includes(c)) && (cash || f.ticker === null || f.ticker === ticker),
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
  const stops = new Map<string, StopSource | null>();
  const rejected: RejectedFile[] = [];
  return files.map(({ name, text }) => {
    const checked = checkBatch(current, text, { lots, stops, rejected });
    if (checked.issues.length > 0 || checked.notChecked.length > 0) {
      rejected.push({ file: name, footprint: checked.footprint });
    } else {
      current = checked.state;
      // For the next files, a lot or a stop this one left is the file's.
      for (const [key, lot] of checked.opened) lots.set(key, { ...lot, file: name });
      for (const [key, source] of checked.stops) {
        if (source === null) stops.delete(key);
        else stops.set(key, { ...source, file: name });
      }
      // A lot this file or an earlier one used up is the portfolio's concern no more: nothing to name.
      const open = new Set(CURRENCIES.flatMap((c) => (current[c]?.lots ?? []).map((l) => openedKey(c, l.entryId))));
      for (const key of lots.keys()) if (!open.has(key)) lots.delete(key);
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
