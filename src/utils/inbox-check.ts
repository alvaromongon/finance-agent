// `inbox:check` without the I/O (#131): a batch (the text of one inbox file) against a state, and the files of
// the inbox in order. Pure; `inbox.ts` reads the files and the portfolio and prints what this returns.
import { CURRENCIES, type Currency } from "../types.js";
import { applyCommand, lotSourceKey, type InboxState, type LotSources } from "./inbox-handlers.js";
import { parseBatch, type InboxIssue } from "./inbox-parse.js";

export interface BatchCheck {
  /** Every problem of the batch; empty when the batch is clean. */
  issues: InboxIssue[];
  /**
   * The state the batch would produce, or the state it was checked against when it has issues: a batch
   * applies whole or not at all, so a rejected one changes nothing.
   */
  state: InboxState;
  /** The lots the clean batches so far opened, as the next batch's refusals name them. */
  sources: LotSources;
}

/**
 * Checks one batch against `state`. The commands are checked in order, each against the state the ones
 * before it would produce, so a buy and its sale in one batch are valid. A command that does not parse, or
 * that a handler refuses, is reported with the rest and leaves the state as it was for the next one.
 */
export function checkBatch(state: InboxState, text: string, earlier: LotSources = new Map()): BatchCheck {
  const parsed = parseBatch(text);
  const issues = [...parsed.issues];
  let current = state;
  const sources = new Map(earlier);
  // A command that did not parse might have changed the cash or the lots of its currency: what a later command
  // of that currency finds there is unknown, so it is not checked against it (N8) rather than reported wrongly.
  const unknown = new Set<Currency>();
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
    if (unknown.has(read.command.currency)) continue;
    const result = applyCommand(current, read.command, sources);
    if ("reason" in result) issues.push({ command: position, line: read.line, reason: result.reason });
    else {
      if (read.command.kind === "buy") {
        const { currency } = read.command;
        const before = new Set(current[currency]?.lots.map((l) => l.entryId));
        for (const lot of result.state[currency]?.lots ?? []) {
          if (!before.has(lot.entryId))
            sources.set(lotSourceKey(currency, lot.entryId), `command ${position} of this batch`);
        }
      }
      current = result.state;
    }
  }
  issues.sort((a, b) => (a.command ?? 0) - (b.command ?? 0));
  return {
    issues,
    state: issues.length === 0 ? current : state,
    sources: issues.length === 0 ? sources : new Map(earlier),
  };
}

export interface InboxFile {
  name: string;
  text: string;
}

export interface FileCheck {
  name: string;
  issues: InboxIssue[];
}

/**
 * Checks the files of the inbox in name order. Each file is a batch checked against the state the clean
 * batches before it would produce (a rejected batch contributes nothing, as when they are applied), so the
 * result predicts what applying the inbox would do.
 */
export function checkFiles(state: InboxState, files: readonly InboxFile[]): FileCheck[] {
  let current = state;
  let sources: LotSources = new Map();
  return files.map(({ name, text }) => {
    const checked = checkBatch(current, text, sources);
    current = checked.state;
    // For the next file, a lot this one opened is an earlier batch's.
    sources = new Map([...checked.sources.keys()].map((key) => [key, "an earlier batch"]));
    return { name, issues: checked.issues };
  });
}

/** A file name as printed: JSON string escapes for every control character (an ANSI sequence must not reach the terminal), none for the rest (S4). */
const printable = (name: string): string => JSON.stringify(name).slice(1, -1);

/** One line per issue: `inbox/<file>: command <n>, line <l>: <reason>`. */
export function renderIssues(checks: readonly FileCheck[]): string[] {
  return checks.flatMap(({ name, issues }) =>
    issues.map(({ command, line, reason }) => {
      const where = [command === null ? "file" : `command ${command}`, line === null ? undefined : `line ${line}`];
      return `inbox/${printable(name)}: ${where.filter(Boolean).join(", ")}: ${reason}`;
    }),
  );
}
