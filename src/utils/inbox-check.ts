// `inbox:check` without the I/O (#131): a batch (the text of one inbox file) against a state, and the files of
// the inbox in order. Pure; `inbox.ts` reads the files and the portfolio and prints what this returns.
import { CURRENCIES, type Currency } from "../types.js";
import { applyCommand, type Command, type InboxState } from "./inbox-handlers.js";
import { parseBatch, type InboxIssue, type ParsedCommand } from "./inbox-parse.js";
import { printable } from "./printable.js";

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
}

/** The first command that left a silo's cash and lots unknown, and how. */
interface Blocker {
  position: number;
  how: "was refused" | "could not be read";
}

/**
 * Checks one batch against `state`. The commands are checked in order, each against the state the ones
 * before it would produce, so a buy and its sale in one batch are valid.
 *
 * A command that does not parse, or that a handler refuses, is reported with the rest. What it would have done
 * to its currency's cash and lots is unknown (the lot a refused buy would have opened, the cash a refused
 * deposit would have added), so the later commands of that currency are not checked against them: a cash or
 * lot error that only the blocked command explains would be misleading (N8). Each is listed in `notChecked`
 * with the command that blocked it, so nothing is skipped without a word and the next check shows no error that
 * this one hid. A command that does not parse and has no readable currency blocks both silos.
 */
export function checkBatch(state: InboxState, text: string): BatchCheck {
  const parsed = parseBatch(text);
  const issues = [...parsed.issues];
  const notChecked: InboxIssue[] = [];
  let current = state;
  const blocked = new Map<Currency, Blocker>();
  const block = (currencies: readonly Currency[], blocker: Blocker): void => {
    for (const currency of currencies) if (!blocked.has(currency)) blocked.set(currency, blocker);
  };
  const opened = new Set<string>();
  const unread = new Map(parsed.unread.map((u) => [u.position, u.currencies]));
  const order = [...parsed.commands.map((c) => c.position), ...unread.keys()].sort((a, b) => a - b);
  const byPosition = new Map(parsed.commands.map((c) => [c.position, c]));
  for (const position of order) {
    const read = byPosition.get(position);
    if (read === undefined) {
      const written = unread.get(position)!;
      block(written.length > 0 ? written : CURRENCIES, { position, how: "could not be read" });
      continue;
    }
    // A clear_stop names no currency: it waits for the first blocked one.
    const currency = "currency" in read.command ? read.command.currency : undefined;
    const blocker = currency !== undefined ? blocked.get(currency) : blocked.values().next().value;
    if (blocker !== undefined) {
      notChecked.push({
        command: position,
        line: read.line,
        reason: `not checked: command ${blocker.position} ${blocker.how}, so ${currency !== undefined ? `the ${currency} cash and lots` : "the position"} it would change ${currency !== undefined ? "are" : "is"} unknown`,
      });
      continue;
    }
    const result = applyCommand(current, read.command, opened);
    if ("reason" in result) {
      issues.push({ command: position, line: read.line, reason: result.reason });
      // A silo the portfolio does not have: nothing to be unknown about, every command of it is refused for that.
      // A refused clear_stop names no currency and changes no cash or lots: it blocks nothing.
      if (currency !== undefined && current[currency] !== undefined)
        block([currency], { position, how: "was refused" });
    } else {
      current = result.state;
      if (result.opened !== undefined) opened.add(result.opened);
    }
  }
  const byCommand = (a: InboxIssue, b: InboxIssue): number => (a.command ?? 0) - (b.command ?? 0);
  issues.sort(byCommand);
  notChecked.sort(byCommand);
  const clean = issues.length === 0;
  return {
    issues,
    notChecked,
    warnings: clean && notChecked.length === 0 ? withoutStop(current, parsed.commands) : [],
    state: clean ? current : state,
  };
}

/** A command that changes the stop of a position, or opens one. */
const touchesStop = (c: Command): c is Extract<Command, { kind: "buy" | "set_stop" | "clear_stop" }> =>
  c.kind === "buy" || c.kind === "set_stop" || c.kind === "clear_stop";

/**
 * The positions the commands touched that `state` (the one they produce) holds with no stop, one warning per
 * ticker at the last command that touched it: risk watch cannot protect a position without a stop.
 */
function withoutStop(state: InboxState, commands: readonly ParsedCommand[]): InboxIssue[] {
  const last = new Map<string, ParsedCommand>();
  for (const read of commands) if (touchesStop(read.command)) last.set(read.command.ticker, read);
  const open = (ticker: string) =>
    CURRENCIES.some((c) => state[c]?.positions.some((p) => p.ticker === ticker && p.stopLoss === null));
  return [...last]
    .filter(([ticker]) => open(ticker))
    .map(([ticker, { position, line }]) => ({
      command: position,
      line,
      reason: `${ticker} has no stop, so risk watch cannot protect it`,
    }));
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
 * result predicts what applying the inbox would do.
 */
export function checkFiles(state: InboxState, files: readonly InboxFile[]): FileCheck[] {
  let current = state;
  return files.map(({ name, text }) => {
    const checked = checkBatch(current, text);
    current = checked.state;
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
      .map((issue, index) => ({ issue, index }))
      .sort((a, b) => (a.issue.command ?? 0) - (b.issue.command ?? 0) || a.index - b.index)
      .map(({ issue: { command, line, reason } }) => `inbox/${printable(name)}: ${where(command, line)}: ${reason}`),
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
