// `inbox:check` without the I/O (#131): a batch (the text of one inbox file) against a state, and the files of
// the inbox in order. Pure; `inbox.ts` reads the files and the portfolio and prints what this returns.
import { CURRENCIES, type Currency } from "../types.js";
import { applyCommand, type Command, type InboxState } from "./inbox-handlers.js";
import { parseBatch, type InboxIssue, type ParsedCommand } from "./inbox-parse.js";

export interface BatchCheck {
  /** Every problem of the batch; empty when the batch is clean. */
  issues: InboxIssue[];
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

/**
 * Checks one batch against `state`. The commands are checked in order, each against the state the ones
 * before it would produce, so a buy and its sale in one batch are valid. A command that does not parse, or
 * that a handler refuses, is reported with the rest and leaves the state as it was for the next one.
 */
export function checkBatch(state: InboxState, text: string): BatchCheck {
  const parsed = parseBatch(text);
  const issues = [...parsed.issues];
  let current = state;
  // A command that did not parse might have changed the cash or the lots of its currency: what a later command
  // of that currency finds there is unknown, so it is not checked against it (N8) rather than reported wrongly.
  const unknown = new Set<Currency>();
  const opened = new Set<string>();
  const unread = new Map(parsed.unread.map((u) => [u.position, u.currencies]));
  const order = [...parsed.commands.map((c) => c.position), ...unread.keys()].sort((a, b) => a - b);
  const byPosition = new Map(parsed.commands.map((c) => [c.position, c]));
  for (const position of order) {
    const read = byPosition.get(position);
    if (read === undefined) {
      const written = unread.get(position)!;
      for (const currency of written.length > 0 ? written : CURRENCIES) unknown.add(currency);
      continue;
    }
    // A clear_stop names no currency: it waits for every unknown one.
    if ("currency" in read.command ? unknown.has(read.command.currency) : unknown.size > 0) continue;
    const result = applyCommand(current, read.command, opened);
    if ("reason" in result) {
      issues.push({ command: position, line: read.line, reason: result.reason });
    } else {
      current = result.state;
      if (result.opened !== undefined) opened.add(result.opened);
    }
  }
  issues.sort((a, b) => (a.command ?? 0) - (b.command ?? 0));
  const clean = issues.length === 0;
  return {
    issues,
    warnings: clean ? withoutStop(current, parsed.commands) : [],
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
    return { name, issues: checked.issues, warnings: checked.warnings };
  });
}

/** A file name as printed: JSON string escapes for every control character (an ANSI sequence must not reach the terminal), none for the rest (S4). */
const printable = (name: string): string => JSON.stringify(name).slice(1, -1);

const renderAll = (checks: readonly FileCheck[], pick: (c: FileCheck) => InboxIssue[], label: string): string[] =>
  checks.flatMap((check) =>
    pick(check).map(({ command, line, reason }) => {
      const where = [command === null ? "file" : `command ${command}`, line === null ? undefined : `line ${line}`];
      return `inbox/${printable(check.name)}: ${where.filter(Boolean).join(", ")}: ${label}${reason}`;
    }),
  );

/** One line per issue: `inbox/<file>: command <n>, line <l>: <reason>`. */
export const renderIssues = (checks: readonly FileCheck[]): string[] => renderAll(checks, (c) => c.issues, "");

/** One line per warning, like an issue with `warning: ` before the reason. */
export const renderWarnings = (checks: readonly FileCheck[]): string[] =>
  renderAll(checks, (c) => c.warnings, "warning: ");
