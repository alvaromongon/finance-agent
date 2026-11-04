// `inbox:check` without the I/O (#131): a batch (the text of one inbox file) against a state, and the files of
// the inbox in order. Pure; `inbox.ts` reads the files and the portfolio and prints what this returns.
import { applyCommand, type InboxState } from "./inbox-handlers.js";
import { parseBatch, type InboxIssue } from "./inbox-parse.js";

export interface BatchCheck {
  /** Every problem of the batch; empty when the batch is clean. */
  issues: InboxIssue[];
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
  for (const { position, line, command } of parsed.commands) {
    const result = applyCommand(current, command);
    if ("reason" in result) issues.push({ command: position, line, reason: result.reason });
    else current = result.state;
  }
  issues.sort((a, b) => (a.command ?? 0) - (b.command ?? 0));
  return { issues, state: issues.length === 0 ? current : state };
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
  return files.map(({ name, text }) => {
    const checked = checkBatch(current, text);
    current = checked.state;
    return { name, issues: checked.issues };
  });
}

/** One line per issue: `inbox/<file>: command <n>, line <l>: <reason>`. */
export function renderIssues(checks: readonly FileCheck[]): string[] {
  return checks.flatMap(({ name, issues }) =>
    issues.map(({ command, line, reason }) => {
      const where = [command === null ? "file" : `command ${command}`, line === null ? undefined : `line ${line}`];
      return `inbox/${name}: ${where.filter(Boolean).join(", ")}: ${reason}`;
    }),
  );
}
