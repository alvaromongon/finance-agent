// The repair of a corrupt state (#139, spec #124, ADR-0018 › _Bad_ consequences): the one thing it does is rebuild the store
// from the decision log and the batches in `inbox/applied/`, the audit trail, and refuse when the two disagree, saying
// where. Pure: the files are read, and the store and the log written, by `state-repair.ts` at the root.
//
// The audit trail is the batches: their commands, applied again in order from an empty portfolio (`replay`), give the cash,
// the lots and the positions. The decision log is what each batch wrote when it was applied, and the check that the
// two tell one story: every line the batches would write must be in the log with the same figures, and every line
// of an applied batch that the log holds must be one the batches write. What neither has (the origin of a lot and the
// rules it broke, the prices) is taken from the log and from the store that is replaced, when it reads.
import type { Currency, Lot } from "../types.js";
import { CURRENCIES } from "../types.js";
import { zero } from "../money.js";
import type { Decision } from "../decisions.js";
import { printable, quoted } from "./printable.js";
import type { InboxState } from "./inbox-handlers.js";
import { runFiles } from "./inbox-check.js";
import {
  currenciesOf,
  canonicalIds,
  isReplayFailure,
  ledgerOrder,
  patchesOf,
  replay,
  restoreMetadata,
  stateDifferences,
  withTelemetry,
  type LedgerFile,
  type ReplayResult,
} from "./inbox-replay.js";

/** One thing the repair found, and the silo it is about (`null`: both). */
export interface Finding {
  currency: Currency | null;
  text: string;
}

export interface RepairInput {
  /** The batches in `inbox/applied/` (and those applied and waiting to be moved), in any order: they are put in order here. */
  applied: readonly LedgerFile[];
  /** The decision log, with the corrections applied. */
  history: readonly Decision[];
  /** The store that is replaced, when it reads; `null` when it does not (or there is none). */
  old: InboxState | null;
  /** The silos before the first batch (the store's `starting`, or its last readable copy's); absent: the portfolio began empty. */
  starting?: InboxState;
  rulesVersion: string;
  /** The day of the run, YYYY-MM-DD. */
  today: string;
  /** The time of the run, ISO: the `synced_at` of a silo the old store does not have. */
  now: string;
}

export type Repair =
  | {
      /** `rebuilt`: the store is not what the batches give and the rebuilt one replaces it. `unchanged`: it is what they give. */
      result: "rebuilt" | "unchanged";
      state: InboxState;
      /** The batches the rebuilt state settled of the rejected ones, for the store to remember. */
      resolved: { file: string; how: "replaced" | "discarded"; by: string }[];
      findings: Finding[];
      batches: number;
    }
  | { result: "refused"; findings: Finding[]; batches: number };

/** What the inbox writes into the decision log: the lines a repair compares with the batches (a snapshot's differences are history). */
const INBOX_LINES: readonly Decision["type"][] = ["entry", "exit", "fx_conversion", "split", "deposit", "withdrawal"];

const silo = (text: string): Currency | null =>
  CURRENCIES.find((c) => text.startsWith(`${c} `) || text.includes(`the ${c} silo`)) ?? null;

/**
 * Where the decision log and the applied batches disagree: a line the batches write that the log does not hold, a line the
 * log holds that no batch writes, and the figures that differ in one both have. Empty when they tell one story.
 */
function disagreements(result: ReplayResult, history: readonly Decision[]): Finding[] {
  const found: Finding[] = [];
  const log = history.filter((d) => d.source === "portfolio-sync" && INBOX_LINES.includes(d.type));
  const logById = new Map(log.map((d) => [d.id, d]));
  const canon = canonicalIds(result.lines, log);
  const matched = new Set(canon.values());
  const at = (id: string): string => {
    const source = result.sources.get(id);
    return source === undefined
      ? "an applied batch"
      : `inbox/applied/${printable(source.file)}, command ${source.command}, line ${source.line}`;
  };
  for (const line of result.lines) {
    const held = logById.get(canon.get(line.id) ?? "");
    if (held === undefined) {
      found.push({
        currency: line.currency,
        text: `${line.currency} ${line.type} ${quoted(line.id)}: written by ${at(line.id)}, but not in logs/decisions.jsonl`,
      });
      continue;
    }
    const same = { ...line, id: held.id };
    // A line with no date of its own (a deposit) took the day it was applied: that day is not told by the batch.
    const undated = new Set(result.undated.has(line.id) ? [held.id] : []);
    for (const { patch } of patchesOf([same], log, undated)) {
      for (const [field, value] of Object.entries(patch)) {
        found.push({
          currency: line.currency,
          text: `${line.currency} ${line.type} ${quoted(held.id)}: ${field} is ${String((held[field as keyof Decision] as string | number | undefined) ?? "none")} in logs/decisions.jsonl and ${String(value ?? "none")} in ${at(line.id)}`,
        });
      }
    }
  }
  for (const held of log) {
    if (!matched.has(held.id)) {
      found.push({
        currency: held.currency,
        text: `${held.currency} ${held.type} ${quoted(held.id)}: in logs/decisions.jsonl, but no batch in inbox/applied/ writes it`,
      });
    }
  }
  return found;
}

/**
 * Rebuilds the state from the applied batches and checks it against the log (see the head of this file). It refuses, changing
 * nothing, when a batch no longer reads or is no longer accepted, or when the batches and the log disagree.
 */
export function planRepair(input: RepairInput): Repair {
  const applied = ledgerOrder(input.applied);
  const batches = applied.length;
  const currencies = CURRENCIES.filter((c) => input.old?.[c] !== undefined || currenciesOf(applied).includes(c));
  // The silos start as the store began (`starting`), else empty: the old store's, when it reads, give their day of sync; one it lacks is of today.
  const blank =
    input.starting ??
    Object.fromEntries(
      currencies.map((c) => [
        c,
        { currency: c, cash: zero(c), positions: [], lots: [], syncedAt: input.old?.[c]?.syncedAt ?? input.now },
      ]),
    );
  const result = replay(runFiles, applied, [], {
    initial: blank,
    history: input.history,
    rulesVersion: input.rulesVersion,
    today: input.today,
  });
  if (isReplayFailure(result)) {
    return {
      result: "refused",
      batches,
      findings: [
        {
          currency: null,
          text: `the applied batches cannot be replayed: ${result.file === null ? "" : `inbox/applied/${printable(result.file)}`}${result.command === null ? "" : `, command ${result.command}`}${result.line === null ? "" : `, line ${result.line}`}: ${result.reason}`,
        },
      ],
    };
  }
  const apart = disagreements(result, input.history);
  if (apart.length > 0) return { result: "refused", batches, findings: apart };

  const known = CURRENCIES.flatMap((c) => (input.old?.[c]?.lots ?? []) as Lot[]);
  const state = withTelemetry(restoreMetadata(result.state, known, input.history), input.old ?? {});
  const resolved = result.checks.flatMap((check) => check.resolved.map((r) => ({ ...r, by: check.name })));
  if (input.old === null) {
    return {
      result: "rebuilt",
      state,
      resolved,
      batches,
      findings: [{ currency: null, text: "the store could not be read: it is rebuilt whole" }],
    };
  }
  const differences = stateDifferences(input.old, state, "the store", "the rebuilt state");
  return {
    result: differences.length > 0 ? "rebuilt" : "unchanged",
    state,
    resolved,
    batches,
    findings: differences.map((text) => ({ currency: silo(text), text })),
  };
}
