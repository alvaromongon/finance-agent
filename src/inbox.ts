// CLI of the inbox (#131, #132, spec #124): `inbox:check` runs the batches in `inbox/` over the current portfolio and
// changes nothing; `inbox:ingest` applies them. Both run the same code, `runFiles` over the same plan: `check` is
// `ingest` without the write, so the batches one accepts and refuses are the batches the other does.
import { awaitingOf, sha256 } from "./inbox-rejected.js";
import { moveBatch, readApplied, readInbox, readRejected } from "./inbox-store.js";
import { readStoreIfAny, saveStore, storeFromPortfolioFile, type PortfolioStore } from "./portfolio-store.js";
import { appendDecisions, readDecisionHistory, readRulesVersion, readWatchlist } from "./vault-io.js";
import { config } from "./config.js";
import { YahooFinanceProvider } from "./providers/yahoo-finance.js";
import { validateDecision, type Decision } from "./decisions.js";
import { CURRENCIES, type Currency, type WatchlistEntry } from "./types.js";
import type { Ticker } from "./ticker.js";
import type { PriceSource } from "./utils/benchmark.js";
import { atr14d } from "./utils/technicals.js";
import { parseBatch } from "./utils/inbox-parse.js";
import { isCorrection, ledgerOrder, type LedgerFile } from "./utils/inbox-replay.js";
import { entryCostsTaken } from "./utils/portfolio-lots.js";
import { decisionsOf } from "./utils/inbox-decisions.js";
import {
  renderIssues,
  renderWarnings,
  runFiles,
  type FileCheck,
  type InboxFile,
  type InboxRun,
} from "./utils/inbox-check.js";
import type { EntryContext, InboxState } from "./utils/inbox-handlers.js";
import { printable } from "./utils/printable.js";
import { commitState, stateRemoteFromConfig, type StateRemote } from "./state-commit.js";

export interface InboxOutcome {
  lines: string[];
  exitCode: number;
}

/** What `check` and `ingest` both work out before they differ: the state they run over, the run and what it used. */
interface Plan {
  /** The batches an earlier run applied and could not move: they are only moved (see `PortfolioStore.unmoved`). */
  waiting: string[];
  store: PortfolioStore;
  history: readonly Decision[];
  rulesVersion: string;
  /** The rejected batches in `inbox/rejected/` with their text: which await a replacement or a discard is `awaitingOf`. */
  rejected: { name: string; text: string }[];
  /** The rejected batches (names in `inbox/rejected/`) awaiting a replacement or a discard before this run's batches. */
  awaiting: string[];
  /** Why `inbox/rejected/` or a file in it was not read; said, never a reason to stop the run (the batches are not rejected for it). */
  rejectedProblems: string[];
  run: InboxRun;
}

const stateOf = (store: PortfolioStore): InboxState => ({
  ...(store.silos.EUR ? { EUR: store.silos.EUR } : {}),
  ...(store.silos.USD ? { USD: store.silos.USD } : {}),
});

/** The ATR14 of `ticker` for the stop distance of an entry. Best-effort: without it that distance is not checked. */
async function fetchAtr(source: PriceSource, ticker: Ticker): Promise<number | null> {
  try {
    return atr14d((await source.getHistorical?.(ticker, "1y")) ?? []);
  } catch (err) {
    console.warn(
      `[inbox] ${ticker}: no ATR, the stop distance is not evaluated (${err instanceof Error ? err.message : String(err)})`,
    );
    return null;
  }
}

/**
 * What the rules of an entry read (ADR-0013 §4, ADR-0009 §5 and §8), read once for the run and only when a batch
 * buys something: the watchlist of each silo, the history and, from `atrSource` (none: no stop distance is checked),
 * the ATR of the tickers bought. A watchlist that cannot be read refuses an `ingest` (an entry cannot be judged
 * without it); `check` goes on without it, as it does without the rules version.
 */
async function entryContext(
  files: readonly InboxFile[],
  store: PortfolioStore,
  history: readonly Decision[],
  mustKnow: boolean,
  atrSource: PriceSource | undefined,
): Promise<Omit<EntryContext, "cited">> {
  const bought = new Set<Ticker>();
  for (const file of files) {
    if (!("text" in file)) continue;
    for (const { command } of parseBatch(file.text).commands) if (command.kind === "buy") bought.add(command.ticker);
  }
  const base = { history, minStopAtr: config.strategy.stopMinAtr };
  if (bought.size === 0) return { ...base, watchlist: {}, atr: new Map() };
  const currencies = CURRENCIES.filter((c) => store.silos[c] !== undefined);
  const lists = await Promise.all(
    currencies.map(async (c): Promise<[Currency, WatchlistEntry[]]> => {
      try {
        return [c, await readWatchlist(c)];
      } catch (err) {
        if (mustKnow) throw err;
        return [c, []];
      }
    }),
  );
  const atrs = await Promise.all(
    atrSource === undefined ? [] : [...bought].map(async (t) => [t, await fetchAtr(atrSource, t)] as const),
  );
  return {
    ...base,
    watchlist: Object.fromEntries(lists),
    atr: new Map(atrs.flatMap(([t, atr]) => (atr !== null && atr > 0 ? [[t, atr] as const] : []))),
  };
}

/** The rejected batches of `inbox/rejected/`; a folder that cannot be read is reported and the run goes on. */
async function readRejectedBatches(): Promise<{ batches: { name: string; text: string }[]; problems: string[] }> {
  try {
    const { batches, unread } = await readRejected();
    return { batches, problems: unread.map((u) => u.problem) };
  } catch (err) {
    return {
      batches: [],
      problems: [`inbox/rejected could not be read: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}

/**
 * The batches already applied, in the order they were, for a correction to replay (#139): `inbox/applied/` and the ones an
 * earlier run applied and could not move. Read only when a file of the run corrects something. A folder that cannot be
 * read is said and gives no ledger, so the correction is refused for that (the batches are not rejected for it).
 */
async function readLedger(waiting: readonly InboxFile[]): Promise<{ ledger?: LedgerFile[]; problems: string[] }> {
  try {
    const { batches, unread } = await readApplied();
    const apart = waiting.flatMap((file) => ("text" in file ? [{ name: file.name, text: file.text }] : []));
    return { ledger: ledgerOrder([...batches, ...apart]), problems: unread.map((u) => u.problem) };
  } catch (err) {
    return { problems: [`inbox/applied could not be read: ${err instanceof Error ? err.message : String(err)}`] };
  }
}

/**
 * Runs the files of the inbox over `store`. The state is read once per run, by the caller; what is read here is the
 * history of the decision log and the `version` of `strategies/base.md`, which a batch cannot be applied without:
 * `check` goes on without it (it cannot change what a batch accepts) and `ingest` refuses with the reason.
 */
async function plan(
  all: InboxFile[],
  store: PortfolioStore,
  mustKnowRules: boolean,
  now: Date,
  atrSource?: PriceSource,
): Promise<Plan> {
  const [history, rulesVersion, { batches: rejected, problems: rejectedProblems }] = await Promise.all([
    readDecisionHistory(),
    readRulesVersion().catch((err) => {
      if (mustKnowRules) throw err;
      return "";
    }),
    readRejectedBatches(),
  ]);
  const isWaiting = (file: InboxFile): boolean =>
    "text" in file && store.unmoved.some((u) => u.file === file.name && u.sha256 === sha256(file.text));
  const awaiting = awaitingOf(rejected, store.resolvedRejections);
  const toRun = all.filter((file) => !isWaiting(file));
  const corrects = toRun.some((file) => "text" in file && isCorrection(parseBatch(file.text)));
  const { ledger, problems: ledgerProblems } = corrects
    ? await readLedger(all.filter(isWaiting))
    : { ledger: undefined, problems: [] };
  const run = runFiles(stateOf(store), toRun, {
    awaiting: new Set(awaiting),
    rulesVersion,
    takenIds: new Set(history.map((d) => d.id)),
    entryCostsTaken: entryCostsTaken(history),
    entry: await entryContext(toRun, store, history, mustKnowRules, atrSource),
    today: now.toISOString().slice(0, 10),
    ...(ledger !== undefined ? { ledger } : {}),
  });
  return {
    waiting: all.filter(isWaiting).map((file) => file.name),
    store,
    history,
    rulesVersion,
    rejected,
    awaiting,
    rejectedProblems: [...rejectedProblems, ...ledgerProblems],
    run,
  };
}

/** The summary line for the errors of the files that did not check clean. */
function errorSummary(checks: readonly FileCheck[]): string {
  const errors = checks.reduce((sum, c) => sum + c.issues.length, 0);
  const skipped = checks.reduce((sum, c) => sum + c.notChecked.length, 0);
  const bad = checks.filter((c) => !c.clean).length;
  return `${errors} error(s) in ${bad} of ${checks.length} batch(es)${skipped > 0 ? `; ${skipped} command(s) not checked` : ""}`;
}

/** Not an error of the inbox: the batches it rejected before are named until one replaces or discards them. */
const awaitingLine = (awaiting: readonly string[]): string[] =>
  awaiting.length > 0
    ? [
        `${awaiting.length} rejected batch(es) awaiting a replacement or a discard: ${awaiting.map((n) => `inbox/rejected/${printable(n)}`).join(", ")}.`,
      ]
    : [];

/**
 * Checks the inbox and returns what to print and the exit code: 0 for a clean inbox, 1 for any error. It makes no
 * network call: the ATR the stop distance of a buy is judged with is for `ingest` (which writes the flag), and a flag
 * changes no verdict.
 */
export async function checkInbox(now: Date = new Date()): Promise<InboxOutcome> {
  const all = await readInbox();
  if (all.length === 0) {
    // An empty inbox can still have a rejected batch waiting: it is named, as with any other run.
    const [{ batches, problems }, existing] = await Promise.all([readRejectedBatches(), readStoreIfAny()]);
    return {
      lines: [
        "Inbox is empty: nothing to check.",
        ...problems,
        ...awaitingLine(awaitingOf(batches, existing?.resolvedRejections ?? [])),
      ],
      exitCode: 0,
    };
  }
  const planned = await plan(all, (await readStoreIfAny()) ?? (await storeFromPortfolioFile()), false, now);
  const { checks } = planned.run;
  const problems = renderIssues(checks);
  // Warnings never change the exit code: a position without a stop is for the owner to know, not a rejected batch.
  const warnings = renderWarnings(checks);
  const waiting =
    planned.waiting.length > 0
      ? [`${planned.waiting.length} batch(es) already applied, waiting to be moved by the next ingest.`]
      : [];
  // The ones a clean file of this inbox replaces or discards are settled by it, so they are not waiting.
  const settled = new Set(checks.flatMap((c) => (c.clean ? c.resolved.map((r) => r.file) : [])));
  const awaiting = [
    ...planned.rejectedProblems,
    ...awaitingLine(planned.awaiting.filter((name) => !settled.has(name))),
  ];
  if (problems.length === 0) {
    return {
      lines: [`Inbox is clean: ${checks.length} batch(es) would apply.`, ...waiting, ...warnings, ...awaiting],
      exitCode: 0,
    };
  }
  return { lines: [...problems, ...warnings, ...waiting, ...awaiting, `${errorSummary(checks)}.`], exitCode: 1 };
}

/**
 * Appends to the decision log the lines an earlier run committed to the store and did not get to write, the ones the
 * log does not hold by id, and returns the store without them. The store has them so that the state and the lines it
 * needs are committed together (see `PortfolioStore.pendingDecisions`).
 */
export async function writePendingDecisions(store: PortfolioStore): Promise<PortfolioStore> {
  if (store.pendingDecisions.length === 0) return store;
  const known = new Set((await readDecisionHistory()).map((d) => d.id));
  await appendDecisions(
    store.pendingDecisions.map((line) => validateDecision(JSON.parse(line))).filter((d) => !known.has(d.id)),
  );
  const cleared = { ...store, pendingDecisions: [] };
  await saveStore(cleared);
  return cleared;
}

/**
 * Applies the inbox: each clean batch, in file-name order, all or nothing; a refused batch changes nothing and is
 * moved to `inbox/rejected/` with its errors. The store is the commit point: it is written once, with the batches
 * applied and the decision lines of their trades, then the lines go to the log and the files move. A failure on the
 * way leaves the files in `inbox/` and the next run finishes it (the lines the log lacks, the moves) without applying
 * anything twice. Throws for a failure that is not a verdict on a batch (the store or the log cannot be read or
 * written, `strategies/base.md` has no version).
 */
export async function ingestInbox(now: Date = new Date(), atrSource?: PriceSource): Promise<InboxOutcome> {
  const all = await readInbox();
  // The state is read once. A store that exists first gets what an earlier run left in it written to the log.
  const existing = await readStoreIfAny();
  const stored = existing === null ? null : await writePendingDecisions(existing);
  if (all.length === 0) {
    // Nothing is waiting to be moved if there is no file: the files an earlier run applied were moved away by hand.
    if (stored !== null && stored.unmoved.length > 0) await saveStore({ ...stored, unmoved: [] });
    return { lines: ["Inbox is empty: nothing to apply."], exitCode: 0 };
  }

  const {
    run,
    history,
    rulesVersion,
    waiting,
    store,
    rejected: inRejected,
    rejectedProblems,
  } = await plan(all, stored ?? (await storeFromPortfolioFile()), true, now, atrSource);
  const clean = run.checks.filter((c) => c.clean);
  const rejected = run.checks.filter((c) => !c.clean && c.text !== undefined);
  const unreadable = run.checks.filter((c) => !c.clean && c.text === undefined);

  // The files an earlier run applied stay on the list until they are moved; the others are gone or are new files.
  const present = new Map(all.flatMap((file) => ("text" in file ? [[file.name, sha256(file.text)] as const] : [])));
  const stillWaiting = store.unmoved.filter((u) => present.get(u.file) === u.sha256);

  let committed = store;
  if (clean.length > 0) {
    const taken = new Set(history.map((d) => d.id));
    for (const silo of Object.values(run.state)) for (const lot of silo.lots) taken.add(lot.entryId);
    const lines = clean.flatMap((c) =>
      decisionsOf(c.trades, c.text!, { rulesVersion, takenIds: taken, today: now.toISOString().slice(0, 10) }),
    );
    committed = {
      ...store,
      silos: Object.fromEntries(
        CURRENCIES.flatMap((currency) => {
          const silo = run.state[currency];
          if (silo === undefined) return [];
          // A silo a batch changed is synced now; one it did not touch keeps its own time.
          return [[currency, silo === store.silos[currency] ? silo : { ...silo, syncedAt: now.toISOString() }]];
        }),
      ),
      unmoved: [
        ...stillWaiting,
        ...clean.map((c) => ({ file: c.name, sha256: sha256(c.text!), at: now.toISOString() })),
      ],
      pendingDecisions: lines.map((d) => JSON.stringify(validateDecision(d))),
      // What a clean batch replaced or discarded is settled with the state it was applied with.
      resolvedRejections: [
        ...store.resolvedRejections,
        ...clean.flatMap((c) =>
          c.resolved.map(({ file, how }) => ({
            file,
            sha256: sha256(inRejected.find((r) => r.name === file)?.text ?? ""),
            how,
            by: c.name,
            at: now.toISOString(),
          })),
        ),
      ],
    };
    await saveStore(committed);
    await appendDecisions(lines);
  }

  const applied = [...waiting, ...clean.map((c) => c.name)];
  for (const name of applied) await moveBatch(name, "applied");
  for (const c of rejected) {
    await moveBatch(
      c.name,
      "rejected",
      renderIssues([c]).map((line) => line.slice(`inbox/${printable(c.name)}: `.length)),
    );
  }
  // Everything that had to be written and moved has been: the state no longer needs to remember it.
  // (An entry of the list whose file is gone or changed is forgotten too: nothing is left to move for it.)
  if (applied.length > 0 || stillWaiting.length > 0 || store.unmoved.length > 0) {
    await saveStore({ ...committed, unmoved: [], pendingDecisions: [] });
  }

  const files = (names: readonly string[]): string => names.map((n) => `inbox/${printable(n)}`).join(", ");
  const lines = [
    ...rejectedProblems,
    ...(applied.length > 0 ? [`Applied ${applied.length} batch(es): ${files(applied)}.`] : []),
    ...renderWarnings(clean),
    ...(rejected.length > 0
      ? [
          ...renderIssues(rejected),
          `Rejected ${rejected.length} batch(es), moved to inbox/rejected/: ${files(rejected.map((c) => c.name))}.`,
        ]
      : []),
    ...(unreadable.length > 0
      ? [...renderIssues(unreadable), `${unreadable.length} file(s) left in inbox/ unread.`]
      : []),
  ];
  return { lines, exitCode: rejected.length + unreadable.length > 0 ? 1 : 0 };
}

/**
 * A price source that asks the provider for a history once per ticker and range: a retried ingest (see
 * `ingestCommitted`) judges the stop distance of the same buys again and must not ask again. Only the history is
 * cached; the source is read-only and best-effort, so a failure is cached too (the stop distance is then unjudged,
 * as it was in the attempt that lost).
 */
export function remembering(source: PriceSource): PriceSource {
  const histories = new Map<string, ReturnType<NonNullable<PriceSource["getHistorical"]>>>();
  return {
    getPrices: (tickers) => source.getPrices(tickers),
    ...(source.getHistorical
      ? {
          getHistorical: (ticker: string, range?: string) => {
            const key = `${ticker}|${range ?? ""}`;
            const known = histories.get(key);
            if (known !== undefined) return known;
            const asked = source.getHistorical!(ticker, range);
            histories.set(key, asked);
            return asked;
          },
        }
      : {}),
  };
}

/**
 * `ingestInbox` as a write of the state (ADR-0018, #134): over the remote's last commit, committed on top of exactly
 * that commit as a compare-and-swap. A run that loses the race (another run committed state meanwhile) throws its
 * work away and ingests again over what is there now, `attempts` times at most, so the batches are judged against the
 * state they meet and the result is that of a fresh run (a batch valid before and invalid now is rejected like any
 * other). A run that keeps losing applies nothing, rejects nothing and exits 0: the batches stay in `inbox/` for the
 * next run, which is a delay and never a verdict on them. With no remote the files are left in place, as `ingestInbox`.
 */
export async function ingestCommitted(
  remote: StateRemote | null,
  attempts: number,
  now: Date = new Date(),
  atrSource?: PriceSource,
): Promise<InboxOutcome> {
  if (remote === null) return ingestInbox(now, atrSource);
  const source = atrSource && remembering(atrSource);
  const write = await commitState(remote, () => ingestInbox(now, source), {
    attempts,
    message: `chore(state): apply inbox ${now.toISOString().slice(0, 10)}`,
  });
  if (write.status === "deferred") {
    return {
      lines: [
        `State not committed: another run committed state ${write.attempts} time(s) while this one worked. Nothing was ` +
          `applied or rejected; the batches stay in inbox/ and the next run applies them.`,
      ],
      exitCode: 0,
    };
  }
  return write.result;
}

const isMain = process.argv[1] != null && import.meta.filename === process.argv[1];
if (isMain) {
  const [cmd] = process.argv.slice(2);
  if (cmd !== "check" && cmd !== "ingest") {
    console.error("Usage: inbox.ts check|ingest");
    process.exitCode = 2;
  } else {
    // The ATR of the tickers bought, for the stop distance of an entry, comes from the market data provider; only
    // `ingest` asks for it, `check` makes no network call.
    (cmd === "check"
      ? checkInbox()
      : ingestCommitted(
          stateRemoteFromConfig(config.stateCommit, config.paths.vaultProjectDir),
          config.stateCommit.attempts(),
          new Date(),
          new YahooFinanceProvider(),
        )
    )
      .then(({ lines, exitCode }) => {
        for (const line of lines) (exitCode === 0 ? console.log : console.error)(line);
        process.exitCode = exitCode;
      })
      .catch((err) => {
        console.error("[inbox]", err);
        process.exitCode = 1;
      });
  }
}
