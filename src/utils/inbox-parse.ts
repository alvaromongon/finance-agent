// The format of an inbox file (#131, docs/input-format.md › `inbox/`): YAML text in, commands and issues out.
// Pure: the text is read by the storage layer (`inbox-store.ts`), the commands are checked by the handlers
// (`inbox-handlers.ts`). This is the one place where a ticker, an amount or a date of the inbox is parsed.
//
// Every scalar is read as text (`FAILSAFE_SCHEMA`): YAML never turns `1e3` into a number or `2026-09-15`
// into a date, so the notation rules below are ours and the same for every value. An amount is
// `<plain decimal> <currency>` (`100.50 EUR`): digits with an optional decimal point, no sign, no thousands
// separator, no exponent.
import yaml from "js-yaml";
import { CURRENCIES, type Currency } from "../types.js";
import { canCountInCents, money } from "../money.js";
import { checkTicker, type Ticker } from "../ticker.js";
import type { Command } from "./inbox-handlers.js";

/** The `schema_version` of the inbox format this engine reads. */
export const INBOX_SCHEMA_VERSION = "1";

/** One problem of a batch: the command's position in it (1-based; null for the file as a whole), its line and why. */
export interface InboxIssue {
  command: number | null;
  line: number | null;
  reason: string;
}

/** A command that parsed, with where it is in the file. */
export interface ParsedCommand {
  position: number;
  line: number;
  command: Command;
}

/**
 * A command that did not parse. What it would have done to the state is unknown, so the commands after it are
 * not checked against the cash and lots of `currencies`: the ones it was written in, or both silos when none of
 * its amounts read (N8: a later command must not report a cash or lot error that only this one explains). A
 * `set_stop` or `clear_stop` changes no cash or lots: only the stop of its `ticker` (any, when it did not
 * read) is unknown.
 */
export interface UnreadCommand {
  position: number;
  currencies: Currency[];
  /** The command's kind, when it read that far. */
  kind?: CommandKind;
  /** The ticker, when it read that far. */
  ticker?: Ticker;
}

export interface ParsedBatch {
  commands: ParsedCommand[];
  /** The commands that did not parse, in order. Every problem of them is in `issues`. */
  unread: UnreadCommand[];
  issues: InboxIssue[];
}

const COMMAND_KINDS = ["deposit", "withdrawal", "buy", "sale", "set_stop", "clear_stop"] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];
const FIELDS: Record<CommandKind, readonly string[]> = {
  deposit: ["command", "amount"],
  withdrawal: ["command", "amount"],
  buy: ["command", "ticker", "date", "units", "price", "costs"],
  sale: ["command", "ticker", "date", "units", "price", "costs", "lot", "stop_executed"],
  set_stop: ["command", "ticker", "date", "price"],
  clear_stop: ["command", "ticker", "date"],
};

/** Fields that used to exist: a command that still carries one is told where it went. */
const REMOVED_FIELDS: Partial<Record<CommandKind, Record<string, string>>> = {
  buy: { stop: 'a buy carries no "stop": set it with a set_stop command (docs/input-format.md › `inbox/`)' },
};

const DECIMAL = /^\d+(\.\d+)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A plain decimal number in text, or why not. */
function decimal(raw: string, what: string): number | string {
  if (!DECIMAL.test(raw)) {
    return `${what} must be a plain decimal number (digits with an optional decimal point: no sign, thousands separator or exponent); got: ${JSON.stringify(raw)}`;
  }
  const n = Number(raw);
  if (!canCountInCents(n)) return `${what} is too large to count; got: ${JSON.stringify(raw)}`;
  return n;
}

/** An amount with its currency (`100.50 EUR`), or why not. `cents`: a money amount, to the cent at most; otherwise a price. */
function amountWithCurrency(raw: string, what: string, cents: boolean): { value: number; currency: Currency } | string {
  const parts = raw.trim().split(/\s+/);
  if (parts.length === 1 && DECIMAL.test(parts[0])) {
    return `${what} needs its currency: write it as "${parts[0]} EUR" or "${parts[0]} USD"; got: ${JSON.stringify(raw)}`;
  }
  if (parts.length !== 2) {
    return `${what} must be a plain decimal number and its currency, such as 100.50 EUR; got: ${JSON.stringify(raw)}`;
  }
  const [number, code] = parts;
  const currency = CURRENCIES.find((c) => c === code);
  if (currency === undefined) return `${what} has an unknown currency ${JSON.stringify(code)} (EUR or USD)`;
  const value = decimal(number, what);
  if (typeof value === "string") return value;
  if (cents && (number.split(".")[1]?.length ?? 0) > 2) {
    return `${what} must not have more than two decimals; got: ${JSON.stringify(raw)}`;
  }
  return { value, currency };
}

/** A real calendar date, YYYY-MM-DD. */
function isDate(raw: string): boolean {
  if (!DATE.test(raw)) return false;
  const [y, m, d] = raw.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** What a command that did not read says: its problems and the currencies its amounts were written in. */
interface Unread {
  problems: string[];
  currencies: Currency[];
  commandKind?: CommandKind;
  ticker?: Ticker;
}

/** One command's mapping read into a command, or every problem found in it. */
function readCommand(raw: unknown): Command | Unread {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      problems: ["a command must be a mapping of fields (command: deposit, amount: 100 EUR, ...)"],
      currencies: [],
    };
  }
  const fields = raw as Record<string, unknown>;
  const kind = COMMAND_KINDS.find((k) => k === fields.command);
  if (kind === undefined) {
    return {
      problems: [
        fields.command === undefined
          ? `missing field "command" (${COMMAND_KINDS.join(", ")})`
          : `unknown command ${JSON.stringify(fields.command)} (${COMMAND_KINDS.join(", ")})`,
      ],
      currencies: [],
    };
  }
  const problems: string[] = [];
  /** The currencies of the amounts that read, in the order written: what is left to say about a command that fails. */
  const seen: Currency[] = [];
  let tickerRead: Ticker | undefined;
  const unread = (): Unread => ({ problems, currencies: seen, commandKind: kind, ticker: tickerRead });
  for (const name of Object.keys(fields)) {
    const removed = REMOVED_FIELDS[kind]?.[name];
    if (removed !== undefined) problems.push(removed);
    // Printed as JSON: a name written in the file may hold control characters (S4).
    else if (!FIELDS[kind].includes(name)) problems.push(`unknown field ${JSON.stringify(name)} for a ${kind}`);
  }

  /** The text of a field: undefined (and a problem when `required`) if absent or not text. */
  const text = (name: string, required: boolean): string | undefined => {
    const value = fields[name];
    if (value === undefined) {
      if (required) problems.push(`missing field "${name}"`);
      return undefined;
    }
    // `amount:` with nothing after it is null, not a list: it is empty (N3).
    const empty = value === null || (typeof value === "string" && value.trim() === "");
    if (typeof value !== "string" || empty) {
      problems.push(empty ? `field "${name}" is empty` : `field "${name}" must be a value, not a list or a mapping`);
      return undefined;
    }
    return value.trim();
  };
  const amount = (name: string, required: boolean, cents: boolean) => {
    const value = text(name, required);
    if (value === undefined) return undefined;
    const read = amountWithCurrency(value, `"${name}"`, cents);
    if (typeof read === "string") {
      problems.push(read);
      return undefined;
    }
    if (!seen.includes(read.currency)) seen.push(read.currency);
    return read;
  };
  const date = (required = true): string | undefined => {
    const value = text("date", required);
    if (value !== undefined && !isDate(value)) {
      problems.push(`"date" must be a calendar date as YYYY-MM-DD; got: ${JSON.stringify(value)}`);
      return undefined;
    }
    return value;
  };
  const ticker = () => {
    const value = text("ticker", true);
    if (value === undefined) return undefined;
    // The one place the inbox applies the ticker rule (docs/input-format.md, #93): nothing below checks it again.
    const checked = checkTicker(value);
    if ("problem" in checked) {
      problems.push(checked.problem);
      return undefined;
    }
    tickerRead = checked.ticker;
    return checked.ticker;
  };
  const units = (): number | undefined => {
    const value = text("units", true);
    if (value === undefined) return undefined;
    const n = decimal(value, '"units"');
    if (typeof n === "string") problems.push(n);
    else if (n <= 0) problems.push(`"units" must be greater than zero; got: ${JSON.stringify(value)}`);
    else return n;
    return undefined;
  };
  const positive = (read: { value: number; currency: Currency } | undefined, name: string) => {
    if (read !== undefined && read.value <= 0) {
      problems.push(`"${name}" must be greater than zero`);
      return undefined;
    }
    return read;
  };
  /** The currency every amount of a command must share, and the first that did not. */
  const sameCurrency = (reads: Record<string, { currency: Currency } | undefined>): Currency | undefined => {
    const present = Object.entries(reads).filter((e): e is [string, { currency: Currency }] => e[1] !== undefined);
    const [first, ...rest] = present;
    if (first === undefined) return undefined;
    for (const [name, read] of rest) {
      if (read.currency !== first[1].currency) {
        problems.push(
          `"${name}" is in ${read.currency} but "${first[0]}" is in ${first[1].currency}: one command, one currency`,
        );
      }
    }
    return first[1].currency;
  };

  if (kind === "deposit" || kind === "withdrawal") {
    const read = positive(amount("amount", true, true), "amount");
    if (problems.length > 0 || read === undefined) return unread();
    return { kind, currency: read.currency, amount: money(read.value, read.currency) };
  }

  if (kind === "set_stop" || kind === "clear_stop") {
    const t = ticker();
    const when = date(false);
    const price = kind === "set_stop" ? positive(amount("price", true, false), "price") : undefined;
    if (problems.length > 0 || !t) return unread();
    if (kind === "clear_stop") return { kind, ticker: t, ...(when ? { date: when } : {}) };
    if (!price) return unread();
    return { kind, currency: price.currency, ticker: t, price: price.value, ...(when ? { date: when } : {}) };
  }

  const t = ticker();
  const when = date();
  const n = units();
  const price = positive(amount("price", true, false), "price");
  const costs = positive(amount("costs", false, true), "costs");
  const currency = sameCurrency({ price, costs });
  if (kind === "buy") {
    if (problems.length > 0 || !t || !when || !n || !price || !currency) return unread();
    return {
      kind,
      currency,
      ticker: t,
      date: when,
      units: n,
      price: price.value,
      ...(costs ? { costs: money(costs.value, currency) } : {}),
    };
  }
  const lot = text("lot", false);
  const executed = text("stop_executed", false);
  if (executed !== undefined && executed !== "true" && executed !== "false") {
    problems.push(`"stop_executed" must be true or false; got: ${JSON.stringify(executed)}`);
  }
  if (problems.length > 0 || !t || !when || !n || !price || !currency) return unread();
  return {
    kind,
    currency,
    ticker: t,
    date: when,
    units: n,
    price: price.value,
    ...(costs ? { costs: money(costs.value, currency) } : {}),
    ...(lot ? { lot } : {}),
    stopExecuted: executed === "true",
  };
}

/**
 * The 1-based line of each `- ` item of the block list under `commands:`, for the items the YAML listener
 * gives no line (a text or an empty item). Empty when the list is not written in block style.
 */
function blockItemLines(text: string): number[] {
  const rows = text.split(/\r?\n/);
  const start = rows.findIndex((row) => /^commands\s*:/.test(row));
  const found: number[] = [];
  let indent: number | undefined;
  for (let i = start + 1; start >= 0 && i < rows.length; i++) {
    const item = /^(\s*)-(\s|$)/.exec(rows[i]);
    if (item === null) {
      // A comment at column 0 is part of the list; any other text at column 0 ends it (N4).
      if (/^[^\s#]/.test(rows[i])) break;
      continue;
    }
    indent ??= item[1].length;
    if (item[1].length === indent) found.push(i + 1);
  }
  return found;
}

/**
 * Reads the text of one inbox file. A file that is not YAML is one issue (never a crash); otherwise every
 * command is read on its own, so one bad command does not hide the problems of the next.
 */
export function parseBatch(text: string): ParsedBatch {
  const lines = new Map<object, number>();
  const open: number[] = [];
  let doc: unknown;
  try {
    doc = yaml.load(text, {
      // Pinned (S3): every scalar is text, whatever the file looks like; a test fails if this changes.
      schema: yaml.FAILSAFE_SCHEMA,
      listener(type, state) {
        if (type === "open") open.push(state.line);
        else {
          const line = open.pop();
          if (line !== undefined && state.result !== null && typeof state.result === "object") {
            lines.set(state.result as object, line + 1);
          }
        }
      },
    });
  } catch (err) {
    if (err instanceof yaml.YAMLException) {
      return {
        commands: [],
        unread: [],
        // The reason can quote the file: printed as JSON, so no control character reaches the terminal (S4).
        issues: [
          { command: null, line: (err.mark?.line ?? 0) + 1, reason: `not valid YAML: ${JSON.stringify(err.reason)}` },
        ],
      };
    }
    throw err;
  }

  const issues: InboxIssue[] = [];
  const fileIssue = (reason: string): void => void issues.push({ command: null, line: 1, reason });
  if (doc === null || doc === undefined) {
    fileIssue("the file is empty: expected schema_version and commands");
    return { commands: [], unread: [], issues };
  }
  if (typeof doc !== "object" || Array.isArray(doc)) {
    fileIssue("the file must be a mapping with schema_version and commands");
    return { commands: [], unread: [], issues };
  }
  const top = doc as Record<string, unknown>;
  if (top.schema_version === undefined) {
    fileIssue(`missing schema_version: the inbox format is version ${INBOX_SCHEMA_VERSION}`);
    return { commands: [], unread: [], issues };
  } else if (top.schema_version !== INBOX_SCHEMA_VERSION) {
    fileIssue(
      `schema_version ${JSON.stringify(top.schema_version)} is not the version this engine reads (${INBOX_SCHEMA_VERSION})`,
    );
    return { commands: [], unread: [], issues };
  }
  for (const name of Object.keys(top)) {
    if (name !== "schema_version" && name !== "commands") fileIssue(`unknown field ${JSON.stringify(name)}`);
  }
  if (!Array.isArray(top.commands) || top.commands.length === 0) {
    fileIssue('"commands" must be a list with at least one command');
    return { commands: [], unread: [], issues };
  }

  let itemLines: number[] | undefined;
  const commands: ParsedCommand[] = [];
  const unread: UnreadCommand[] = [];
  top.commands.forEach((raw: unknown, index: number) => {
    const position = index + 1;
    const line =
      (typeof raw === "object" && raw !== null ? lines.get(raw) : undefined) ??
      (itemLines ??= blockItemLines(text))[index] ??
      1;
    const read = readCommand(raw);
    if ("problems" in read) {
      for (const reason of read.problems) issues.push({ command: position, line, reason });
      unread.push({ position, currencies: read.currencies, kind: read.commandKind, ticker: read.ticker });
    } else {
      commands.push({ position, line, command: read });
    }
  });
  return { commands, unread, issues };
}
