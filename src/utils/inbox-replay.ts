// The batches applied again (#139, spec #124, ADR-0018): what a correction and the repair of a corrupt store are made of.
// Pure: the files are read by the storage layer (`inbox-store.ts`), the state and the decision log by the caller.
//
// The state is what the batches in `inbox/applied/` give, in order, from an empty portfolio. Replaying them is how
// the engine rebuilds it, and the one way it corrects a record without editing the state: a `correct` command names
// a record by the id the engine gave it, the batch that wrote it is run again with the corrected values, and every
// later command is judged against them, so a sale left without lots or a cash below zero refuses the correction in
// the words of the command that would fail. The lines the corrected batches would write are compared with the ones
// in the decision log, and the difference is what a `correction` line records; the original line stays.
//
// What a replay is not: it does not know the watchlist, the proposals or the prices of the day a batch was applied,
// so the origin and the rules a lot broke come from the decision log (`restoreMetadata`), and a store that did
// not start empty, or whose files were applied in an order other than the order of their names, does not replay to
// itself: `stateDifferences` says so, and neither a correction nor the repair touches such a store.
import { CURRENCIES, type Currency, type Lot, type PortfolioSnapshot, type Position } from "../types.js";
import { PATCH_FIELDS, type Decision, type PatchField } from "../decisions.js";
import { asNumber, countedInCents, formatMoney, zero, type Money } from "../money.js";
import type { Ticker } from "../ticker.js";
import { decisionsOf } from "./inbox-decisions.js";
import { silosOf, type Command, type Correct, type InboxState } from "./inbox-handlers.js";
import { parseBatch, type ParsedBatch } from "./inbox-parse.js";
import type { InboxFile, InboxRun, RunContext, Trade } from "./inbox-check.js";
import { printable, quoted } from "./printable.js";
import { UNITS_TOLERANCE } from "./units.js";
import { withPrices } from "./portfolio-json.js";

/** A batch that was applied: its name (in `inbox/applied/`, or in `inbox/` while it waits to be moved) and its text. */
export interface LedgerFile {
  name: string;
  text: string;
}

/** `runFiles` of the inbox runner, handed in so that this module needs nothing from it at run time. */
export type RunFiles = (state: InboxState, files: readonly InboxFile[], run: RunContext) => InboxRun;

/**
 * The order the applied batches are replayed in: the order of their names, the order `inbox:ingest` applies them in. A
 * batch moved to `applied/` under a name already taken got a counter before its extension (`a-2.yaml`): it was applied
 * after `a.yaml`, so the counter is read as an order and not as part of the name.
 */
export function ledgerOrder<T extends { name: string }>(files: readonly T[]): T[] {
  const names = new Set(files.map((f) => f.name));
  // A trailing number is a counter only when the file without it is there too: `2026-11-05.yaml` is a date.
  const split = (name: string): [string, number] => {
    const match = /^(.*)-(\d+)(\.ya?ml)$/i.exec(name);
    return match !== null && names.has(`${match[1]}${match[3]}`)
      ? [`${match[1]}${match[3]}`, Number(match[2])]
      : [name, 0];
  };
  return [...files].sort((a, b) => {
    const [nameA, countA] = split(a.name);
    const [nameB, countB] = split(b.name);
    return nameA < nameB ? -1 : nameA > nameB ? 1 : countA - countB;
  });
}

/**
 * The part of an id that names a record whatever day it carries: `entry-1a2b3c4d` for `20261112-sapde-entry-1a2b3c4d`.
 * The suffix is worked out from the batch and the count of ids it gave, so a replay finds the same record under the id
 * the log holds even when the day in it is the day of the run (a deposit has no date of its own).
 */
export const idKey = (id: string): string => id.split("-").slice(-2).join("-");

/** What a replay's pins are keyed by: the file and the `idKey`, since two applied batches with one text write the same keys. */
export const pinKey = (file: string | undefined, id: string): string => `${file ?? ""}|${idKey(id)}`;

/** A `correct` command of a batch: where it is, and what it says. */
export interface Correction {
  file: string;
  command: number;
  line: number | null;
  fix: Correct;
}

/** Where a line of the decision log comes from: the command of an applied batch that writes it. */
export interface LineSource {
  file: string;
  command: number;
  line: number;
  kind: Trade["kind"];
}

/** Why a replay stopped: where, and in whose words. `correction` is set when the correction it was asked for is the cause. */
export interface ReplayFailure {
  file: string | null;
  command: number | null;
  line: number | null;
  reason: string;
  correction: Correction | null;
}

export interface ReplayResult {
  /** What each batch gave when it was run, in order: the rejected batches it settled (`resolved`) are read from them. */
  checks: InboxRun["checks"];
  /** The state the batches give, with the corrections applied. */
  state: InboxState;
  /** The lines the batches write, under the ids the log holds; the snapshots' differences are left out. */
  lines: Decision[];
  /** The command each line comes from, by id. */
  sources: ReadonlyMap<string, LineSource>;
  /** The lines whose command has no date of its own (a deposit's): their date is the day of the run, not a fact to compare. */
  undated: ReadonlySet<string>;
}

const where = (file: string, command: number | null, line: number | null): string =>
  `inbox/applied/${printable(file)}` +
  (command === null ? "" : `: command ${command}`) +
  (line === null ? "" : `, line ${line}`);

const OPTIONS_NONE = { entry: { history: [], atr: new Map(), minStopAtr: 0 } } as const;

/** The silos as they were before the first batch: the cash is zero and nothing is held. */
export function emptyState(state: InboxState): InboxState {
  const empty = <C extends Currency>(silo: PortfolioSnapshot<C>): PortfolioSnapshot<C> => ({
    currency: silo.currency,
    cash: zero(silo.currency),
    positions: [],
    lots: [],
    syncedAt: silo.syncedAt,
  });
  return {
    ...(state.EUR ? { EUR: empty(state.EUR) } : {}),
    ...(state.USD ? { USD: empty(state.USD) } : {}),
  };
}

/** The currencies a batch writes amounts in: the silos an applied batch needs, when no store tells which there were. */
export function currenciesOf(files: readonly LedgerFile[]): Currency[] {
  const found = new Set<Currency>();
  for (const file of files) {
    for (const { command } of parseBatch(file.text).commands) {
      if (command.kind === "convert") {
        found.add(command.from);
        found.add(command.to);
      } else if (command.kind === "watch" || command.kind === "stop_watching") {
        // The watchlist is no silo's: it does not make one.
      } else if ("currency" in command && command.currency !== undefined) found.add(command.currency);
    }
  }
  return CURRENCIES.filter((c) => found.has(c));
}

/**
 * `command` with the corrected values of `fix`, or why the record cannot be corrected so (the command is another kind
 * than the correction supposes, or it would move the record to another silo). The corrected command goes through
 * the same checks of the handlers as the original did.
 */
export function correctedCommand(command: Command, fix: Correct): Command | { reason: string } {
  const sameSilo = (currency: Currency): { reason: string } | undefined =>
    fix.currency !== undefined && fix.currency !== currency
      ? {
          reason: `the record is in the ${currency} silo and a correction does not move it: its amounts are in ${fix.currency}`,
        }
      : undefined;
  if (command.kind === "buy" || command.kind === "sale") {
    const wrongSilo = sameSilo(command.currency);
    if (wrongSilo !== undefined) return wrongSilo;
    if (fix.amount !== undefined) {
      return { reason: `a ${command.kind} has no "amount": correct its "units" and "price"` };
    }
    const costs: Money | undefined =
      fix.costs === undefined ? command.costs : fix.costs === zero(command.currency) ? undefined : fix.costs;
    const next = {
      ...command,
      ...(fix.ticker !== undefined ? { ticker: fix.ticker } : {}),
      ...(fix.date !== undefined ? { date: fix.date } : {}),
      ...(fix.units !== undefined ? { units: fix.units } : {}),
      ...(fix.price !== undefined ? { price: fix.price } : {}),
    };
    // `costs` is left out of the spread: an absent costs must not stay from the original when the correction removes it.
    delete next.costs;
    return costs === undefined ? next : { ...next, costs };
  }
  if (command.kind === "deposit" || command.kind === "withdrawal") {
    const wrongSilo = sameSilo(command.currency);
    if (wrongSilo !== undefined) return wrongSilo;
    const loose = (["ticker", "date", "units", "price", "costs"] as const).find((f) => fix[f] !== undefined);
    if (loose !== undefined) return { reason: `a ${command.kind} has only an "amount": "${loose}" does not apply` };
    return fix.amount === undefined ? command : { ...command, amount: fix.amount };
  }
  return { reason: `a ${command.kind} cannot be corrected: only a buy, a sale, a deposit or a withdrawal can` };
}

/** What is different between two states, one text each: the cash, each lot and the units and stop of each position. */
export function stateDifferences(mine: InboxState, theirs: InboxState, mineName: string, theirsName: string): string[] {
  const found: string[] = [];
  for (const currency of CURRENCIES) {
    const a = mine[currency];
    const b = theirs[currency];
    if (a === undefined && b === undefined) continue;
    if (a === undefined || b === undefined) {
      found.push(`the ${currency} silo is only in ${a === undefined ? theirsName : mineName}`);
      continue;
    }
    if (a.cash !== b.cash) {
      found.push(`${currency} cash: ${formatMoney(a.cash)} in ${mineName}, ${formatMoney(b.cash)} in ${theirsName}`);
    }
    const lots = (silo: PortfolioSnapshot): Map<string, Lot> => new Map(silo.lots.map((l) => [l.entryId, l]));
    const lotsA = lots(a);
    const lotsB = lots(b);
    for (const id of new Set([...lotsA.keys(), ...lotsB.keys()])) {
      const x = lotsA.get(id);
      const y = lotsB.get(id);
      const text = (lot: Lot | undefined): string => (lot === undefined ? "none" : `${lot.units} units`);
      if (x === undefined || y === undefined || Math.abs(x.units - y.units) > UNITS_TOLERANCE) {
        found.push(`${currency} lot ${quoted(id)}: ${text(x)} in ${mineName}, ${text(y)} in ${theirsName}`);
      }
    }
    const positions = (silo: PortfolioSnapshot): Map<Ticker, Position> =>
      new Map(silo.positions.map((p) => [p.ticker, p]));
    const posA = positions(a);
    const posB = positions(b);
    for (const ticker of new Set([...posA.keys(), ...posB.keys()])) {
      const x = posA.get(ticker);
      const y = posB.get(ticker);
      const text = (p: Position | undefined): string =>
        p === undefined ? "none" : `${p.volume} units, stop ${p.stopLoss ?? "none"}`;
      if (
        x === undefined ||
        y === undefined ||
        Math.abs(x.volume - y.volume) > UNITS_TOLERANCE ||
        (x.stopLoss ?? null) !== (y.stopLoss ?? null)
      ) {
        found.push(`${currency} position ${printable(ticker)}: ${text(x)} in ${mineName}, ${text(y)} in ${theirsName}`);
      }
    }
  }
  // The watchlist (#140): a ticker on one list and not on the other. No list is an empty one.
  const listA = new Map((mine.watchlist ?? []).map((e) => [e.ticker, e.currency]));
  const listB = new Map((theirs.watchlist ?? []).map((e) => [e.ticker, e.currency]));
  for (const ticker of new Set([...listA.keys(), ...listB.keys()])) {
    const [x, y] = [listA.get(ticker), listB.get(ticker)];
    if (x === y) continue;
    found.push(
      `the watchlist ${printable(ticker)}: ${x === undefined ? "not on it" : `on it (${x})`} in ${mineName}, ${y === undefined ? "not on it" : `on it (${y})`} in ${theirsName}`,
    );
  }
  return found;
}

/**
 * The origin and the rules each lot of `state` broke, as the decision log or the old state says: a replay does not know the
 * watchlist, the proposals or the ATR of the day a lot was bought (`ids` first, then `history`).
 */
export function restoreMetadata(state: InboxState, known: readonly Lot[], history: readonly Decision[]): InboxState {
  const fromState = new Map(known.map((l) => [l.entryId, l]));
  const fromLog = new Map(history.filter((d) => d.type === "entry").map((d) => [d.id, d]));
  const restore = <C extends Currency>(silo: PortfolioSnapshot<C>): PortfolioSnapshot<C> => ({
    ...silo,
    lots: silo.lots.map((lot) => {
      const old = fromState.get(lot.entryId);
      if (old !== undefined) {
        return { ...lot, origin: old.origin, rulesVersion: old.rulesVersion, rulesViolations: old.rulesViolations };
      }
      const entry = fromLog.get(lot.entryId);
      return entry === undefined
        ? lot
        : {
            ...lot,
            origin: entry.origin,
            rulesVersion: entry.rules_version,
            rulesViolations: entry.rule_violations ?? [],
          };
    }),
  });
  return {
    ...(state.EUR ? { EUR: restore(state.EUR) } : {}),
    ...(state.USD ? { USD: restore(state.USD) } : {}),
    ...(state.watchlist !== undefined ? { watchlist: state.watchlist } : {}),
  };
}

/**
 * The silos of `rebuilt` with what the batches do not tell, taken from `old` (the store they replace): the day it was
 * synced and the snapshot of the broker, the prices of the positions (and the P/L they give) and the total cash, moved
 * as the cash was, and the join date of the watchlist entries. A silo `old` does not have is left as it was rebuilt.
 */
export function withTelemetry(rebuilt: InboxState, old: InboxState): InboxState {
  const keep = <C extends Currency>(
    silo: PortfolioSnapshot<C>,
    was: PortfolioSnapshot<C> | undefined,
  ): PortfolioSnapshot<C> => {
    if (was === undefined) return silo;
    const prices = new Map(was.positions.map((p) => [p.ticker, p.currentPrice]));
    const priced = withPrices(silo, prices) ?? silo;
    return {
      ...priced,
      syncedAt: was.syncedAt,
      ...(was.reconciled !== undefined ? { reconciled: was.reconciled } : {}),
      ...(was.totalCash !== undefined
        ? {
            totalCash: countedInCents(
              asNumber(was.totalCash) + (asNumber(silo.cash) - asNumber(was.cash)),
              `the ${silo.currency} total cash after the replay`,
              silo.currency,
            ),
          }
        : {}),
    };
  };
  return {
    ...(rebuilt.EUR ? { EUR: keep(rebuilt.EUR, old.EUR) } : {}),
    ...(rebuilt.USD ? { USD: keep(rebuilt.USD, old.USD) } : {}),
    // An undated `watch` takes the day of the run as its join date: a replay keeps the date the store holds, or the 4-week
    // `no_setup` exit counter would restart at every correction or repair (#140).
    ...(rebuilt.watchlist !== undefined
      ? {
          watchlist: rebuilt.watchlist.map((e) => {
            const was = old.watchlist?.find((o) => o.ticker === e.ticker && o.currency === e.currency);
            return was?.date !== undefined ? { ...e, date: was.date } : e;
          }),
        }
      : {}),
  };
}

/**
 * The id the log holds for each line a replay wrote, by the replay's id: the n-th line of the replay with a key (`idKey`) is the
 * n-th line of the log with it. A line the log has no counterpart of is not in the map.
 */
export function canonicalIds(lines: readonly Decision[], history: readonly Decision[]): Map<string, string> {
  const held = new Map<string, string[]>();
  for (const d of history) held.set(idKey(d.id), [...(held.get(idKey(d.id)) ?? []), d.id]);
  const seen = new Map<string, number>();
  const found = new Map<string, string>();
  for (const line of lines) {
    const key = idKey(line.id);
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    const id = held.get(key)?.[n];
    if (id !== undefined) found.set(line.id, id);
  }
  return found;
}

/** True for two numbers that are one value: the lines are written by one code, so only float noise may differ. */
const sameNumber = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

/**
 * What the lines of a replay say differently from the lines of the log, by id: the fields of `PATCH_FIELDS` that moved.
 * A line the log does not hold is not compared. A field the replay has not and the log has stays, unless a correction
 * may remove it (the costs, a stop).
 */
export function patchesOf(
  lines: readonly Decision[],
  history: readonly Decision[],
  undated: ReadonlySet<string>,
): { line: Decision; patch: NonNullable<Decision["patch"]> }[] {
  const byId = new Map(history.map((d) => [d.id, d]));
  const removable: readonly PatchField[] = ["costs", "stop_initial", "entry_costs"];
  const found: { line: Decision; patch: NonNullable<Decision["patch"]> }[] = [];
  for (const line of lines) {
    const original = byId.get(line.id);
    if (original === undefined) continue;
    const patch: NonNullable<Decision["patch"]> = {};
    for (const field of PATCH_FIELDS) {
      if (field === "date" && undated.has(line.id)) continue;
      const now = patchValue(line[field]);
      const was = patchValue(original[field]);
      if (now === undefined && was === undefined) continue;
      if (now === undefined) {
        if (removable.includes(field)) patch[field] = null;
      } else if (
        was === undefined ||
        typeof now !== typeof was ||
        (typeof now === "number" ? !sameNumber(now, was as number) : now !== was)
      ) {
        patch[field] = now;
      }
    }
    if (Object.keys(patch).length > 0) found.push({ line, patch });
  }
  return found;
}

/**
 * The names of the rejected batches the applied ones refer to (`replaces:` and `discard`): they were awaiting an answer
 * when the batch was applied, and the replay has no `inbox/rejected/` to tell it so.
 */
/** A field of a line as a correction patch holds it: an amount is its plain number. */
const patchValue = (value: string | number | Money | null | undefined): string | number | null | undefined =>
  typeof value === "object" && value !== null ? asNumber(value) : value;

function awaitingOf(parsed: readonly ParsedBatch[]): Set<string> {
  const names = new Set<string>();
  for (const batch of parsed) {
    if (batch.replaces !== undefined) names.add(batch.replaces.file);
    for (const { command } of batch.commands) if (command.kind === "discard") names.add(command.file);
  }
  return names;
}

/** The ids of the pending escalations the applied batches closed: they were open when the batch was applied. */
function escalationsOf(parsed: readonly ParsedBatch[]): Set<string> {
  const ids = new Set<string>();
  for (const batch of parsed)
    for (const { command } of batch.commands) if (command.kind === "resolve") ids.add(command.id);
  return ids;
}

/** True for a batch of corrections: it has a `correct` command, read or not. */
export const isCorrection = (batch: ParsedBatch): boolean =>
  batch.commands.some((c) => c.command.kind === "correct") || batch.unread.some((u) => u.kind === "correct");

interface Replayed {
  checks: InboxRun["checks"];
  state: InboxState;
  lines: Decision[];
  sources: Map<string, LineSource>;
  undated: Set<string>;
}

/**
 * The batches applied again over `initial` through `runFiles` (the one runner of `check` and `ingest`), with the commands
 * `overrides` replaces and the ids `pins` holds, and the lines they write (`decisionsOf`). Stops at the first batch that is
 * refused, naming it.
 */
function run(
  runFiles: RunFiles,
  initial: InboxState,
  files: readonly LedgerFile[],
  parsed: readonly ParsedBatch[],
  options: {
    rulesVersion: string;
    today: string;
    overrides?: ReadonlyMap<string, ReadonlyMap<number, Command>>;
    pins?: ReadonlyMap<string, string>;
  },
): Replayed | ReplayFailure {
  const result = runFiles(initial, files, {
    awaiting: awaitingOf(parsed),
    escalations: escalationsOf(parsed),
    rulesVersion: options.rulesVersion,
    takenIds: new Set(),
    entryCostsTaken: new Map(),
    ...OPTIONS_NONE,
    today: options.today,
    ...(options.overrides ? { overrides: options.overrides } : {}),
    ...(options.pins ? { pins: options.pins } : {}),
  });
  for (const check of result.checks) {
    if (check.clean) continue;
    const first = [...check.issues, ...check.notChecked].sort((a, b) => (a.command ?? 0) - (b.command ?? 0))[0];
    return {
      file: check.name,
      command: first?.command ?? null,
      line: first?.line ?? null,
      reason: first?.reason ?? "it is not clean",
      correction: null,
    };
  }
  const taken = new Set<string>();
  for (const silo of silosOf(result.state)) for (const l of silo.lots) taken.add(l.entryId);
  // The line of a deposit has no date of its own: each batch is given a day of its own, so that two batches with one text
  // (a monthly deposit) are not told apart by the number the ids count up with, as the log's, of different days, are not.
  const dayOf = (index: number): string => {
    const day = new Date(`${options.today}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() - index);
    return day.toISOString().slice(0, 10);
  };
  const lines: Decision[] = [];
  const sources = new Map<string, LineSource>();
  const undated = new Set<string>();
  for (const [index, check] of result.checks.entries()) {
    const written = decisionsOf(check.trades, check.text!, {
      rulesVersion: options.rulesVersion,
      takenIds: taken,
      today: dayOf(index),
      file: check.name,
      ...(options.pins ? { pins: options.pins } : {}),
    });
    let at = 0;
    for (const trade of check.trades) {
      // One trade is one line, but for the exits of a sale (a line per lot) and the differences of a snapshot (a line each).
      const count =
        trade.kind === "sale" ? trade.exits.length : trade.kind === "snapshot" ? trade.differences.length : 1;
      for (const line of written.slice(at, at + count)) {
        sources.set(line.id, { file: check.name, command: trade.command, line: trade.line, kind: trade.kind });
        if (isUndated(trade)) undated.add(line.id);
      }
      at += count;
    }
    lines.push(...written);
  }
  return {
    checks: result.checks,
    state: result.state,
    lines: lines.filter((l) => l.type !== "reconcile"),
    sources,
    undated,
  };
}

/** A trade whose line is dated the day of the run: the command gave no date (a deposit, a conversion without one). */
const isUndated = (trade: Trade): boolean =>
  trade.kind === "deposit" || trade.kind === "withdrawal" || (trade.kind === "convert" && trade.date === undefined);

const isFailure = (value: Replayed | ReplayFailure): value is ReplayFailure => "reason" in value;

/**
 * The state and the lines the applied batches give, `extra` corrections (those of the batch under check) and the ones
 * the applied correction batches carry included; or the first thing that stops it. `initial` is the portfolio before the first
 * batch, `history` the decision log (the ids of its lines are the ones the corrections name).
 */
export function replay(
  runFiles: RunFiles,
  files: readonly LedgerFile[],
  extra: readonly Correction[],
  options: { initial: InboxState; history: readonly Decision[]; rulesVersion: string; today: string },
): ReplayResult | ReplayFailure {
  const parsed = files.map((file) => parseBatch(file.text));
  const base: LedgerFile[] = [];
  const baseParsed: ParsedBatch[] = [];
  const corrections: Correction[] = [];
  for (const [index, file] of files.entries()) {
    const batch = parsed[index];
    if (batch.issues.length > 0) {
      const [issue] = batch.issues;
      return {
        file: file.name,
        command: issue.command,
        line: issue.line,
        reason: `the applied batch does not read: ${issue.reason}`,
        correction: null,
      };
    }
    if (!isCorrection(batch)) {
      base.push(file);
      baseParsed.push(batch);
      continue;
    }
    if (batch.commands.some((c) => c.command.kind !== "correct")) {
      return {
        file: file.name,
        command: null,
        line: null,
        reason: "an applied batch of corrections holds another command",
        correction: null,
      };
    }
    for (const { position, line, command } of batch.commands) {
      if (command.kind === "correct") corrections.push({ file: file.name, command: position, line, fix: command });
    }
  }
  const first = run(runFiles, options.initial, base, baseParsed, options);
  if (isFailure(first)) return first;
  const all = [...corrections, ...extra];
  if (all.length === 0) return first;

  // Each correction names a record by the id the log holds; the command that wrote it is the one that is run again.
  const canon = canonicalIds(first.lines, options.history);
  const canonical = (id: string): string => canon.get(id) ?? id;
  const written = new Map(first.lines.map((l) => [canonical(l.id), first.sources.get(l.id)!]));
  const commands = new Map<string, Command>(
    baseParsed.flatMap((batch, i) => batch.commands.map((c) => [`${base[i].name}#${c.position}`, c.command] as const)),
  );
  const fixes = new Map<string, Correct>();
  for (const correction of all) {
    const source = written.get(correction.fix.id);
    if (source === undefined) {
      return {
        file: correction.file,
        command: correction.command,
        line: correction.line,
        reason: `no applied record has the id ${quoted(correction.fix.id)}: a correction names the id the engine gave a buy, a sale, a deposit or a withdrawal`,
        correction,
      };
    }
    const key = `${source.file}#${source.command}`;
    // A record corrected twice has both corrections: the later one wins where they say the same field.
    fixes.set(key, { ...fixes.get(key), ...correction.fix, kind: "correct" });
  }
  const overrides = new Map<string, Map<number, Command>>();
  for (const [key, fix] of fixes) {
    const [file, position] = [key.slice(0, key.lastIndexOf("#")), Number(key.slice(key.lastIndexOf("#") + 1))];
    const corrected = correctedCommand(commands.get(key)!, fix);
    if ("reason" in corrected) {
      const culprit = [...all]
        .reverse()
        .find((c) => written.get(c.fix.id)?.file === file && written.get(c.fix.id)?.command === position)!;
      return {
        file: culprit.file,
        command: culprit.command,
        line: culprit.line,
        reason: `cannot correct ${quoted(culprit.fix.id)}: ${corrected.reason}`,
        correction: culprit,
      };
    }
    overrides.set(file, new Map([...(overrides.get(file) ?? []), [position, corrected]]));
  }
  const last = all[all.length - 1];
  // The record keeps its id whatever its date or its ticker becomes: the lots and the lines of the log cite it.
  const pins = new Map(first.lines.map((l) => [pinKey(first.sources.get(l.id)!.file, l.id), canonical(l.id)] as const));
  const second = run(runFiles, options.initial, base, baseParsed, { ...options, overrides, pins });
  if (isFailure(second)) {
    return {
      ...second,
      correction: last,
      file: last.file,
      command: last.command,
      line: last.line,
      reason: `cannot correct ${quoted(last.fix.id)}: ${where(second.file ?? "", second.command, second.line)} would be refused: ${second.reason}`,
    };
  }
  // A sale that now takes other lots writes other lines than the ones in the log: the log is append-only, so it is not rebuilt.
  const keys = (r: Replayed): Set<string> => new Set(r.lines.map((l) => pinKey(r.sources.get(l.id)?.file, l.id)));
  const before = keys(first);
  const after = keys(second);
  const moved = [...before].filter((k) => !after.has(k)).length + [...after].filter((k) => !before.has(k)).length;
  if (moved > 0) {
    return {
      file: last.file,
      command: last.command,
      line: last.line,
      reason: `cannot correct ${quoted(last.fix.id)}: it would change which lots a later sale takes, or how many lines the batches write, and the decision log is not rewritten`,
      correction: last,
    };
  }
  return second;
}

export const isReplayFailure = (value: ReplayResult | ReplayFailure): value is ReplayFailure => "reason" in value;
