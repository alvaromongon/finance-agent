// CLI of the inbox (#131, #132, spec #124): `inbox:check` runs the batches in `inbox/` over the current portfolio and
// changes nothing; `inbox:ingest` applies them. Both run the same code, `runFiles` over the same plan: `check` is
// `ingest` without the write, so the batches one accepts and refuses are the batches the other does.
import { createHash } from "node:crypto";
import { moveBatch, readInbox } from "./inbox-store.js";
import { readStoreIfAny, saveStore, storeFromPortfolioFile, type PortfolioStore } from "./portfolio-store.js";
import { appendDecisions, readDecisionHistory, readRulesVersion } from "./vault-io.js";
import { validateDecision, type Decision } from "./decisions.js";
import { CURRENCIES } from "./types.js";
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
import type { InboxState } from "./utils/inbox-handlers.js";
import { printable } from "./utils/printable.js";

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
  run: InboxRun;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const stateOf = (store: PortfolioStore): InboxState => ({
  ...(store.silos.EUR ? { EUR: store.silos.EUR } : {}),
  ...(store.silos.USD ? { USD: store.silos.USD } : {}),
});

/**
 * Runs the files of the inbox over `store`. The state is read once per run, by the caller; what is read here is the
 * history of the decision log and the `version` of `strategies/base.md`, which a batch cannot be applied without:
 * `check` goes on without it (it cannot change what a batch accepts) and `ingest` refuses with the reason.
 */
async function plan(all: InboxFile[], store: PortfolioStore, mustKnowRules: boolean): Promise<Plan> {
  const [history, rulesVersion] = await Promise.all([
    readDecisionHistory(),
    readRulesVersion().catch((err) => {
      if (mustKnowRules) throw err;
      return "";
    }),
  ]);
  const isWaiting = (file: InboxFile): boolean =>
    "text" in file && store.unmoved.some((u) => u.file === file.name && u.sha256 === sha256(file.text));
  const run = runFiles(
    stateOf(store),
    all.filter((file) => !isWaiting(file)),
    { rulesVersion, takenIds: new Set(history.map((d) => d.id)), entryCostsTaken: entryCostsTaken(history) },
  );
  return { waiting: all.filter(isWaiting).map((file) => file.name), store, history, rulesVersion, run };
}

/** The summary line for the errors of the files that did not check clean. */
function errorSummary(checks: readonly FileCheck[]): string {
  const errors = checks.reduce((sum, c) => sum + c.issues.length, 0);
  const skipped = checks.reduce((sum, c) => sum + c.notChecked.length, 0);
  const bad = checks.filter((c) => !c.clean).length;
  return `${errors} error(s) in ${bad} of ${checks.length} batch(es)${skipped > 0 ? `; ${skipped} command(s) not checked` : ""}`;
}

/** Checks the inbox and returns what to print and the exit code: 0 for a clean inbox, 1 for any error. */
export async function checkInbox(): Promise<InboxOutcome> {
  const all = await readInbox();
  if (all.length === 0) return { lines: ["Inbox is empty: nothing to check."], exitCode: 0 };
  const planned = await plan(all, (await readStoreIfAny()) ?? (await storeFromPortfolioFile()), false);
  const { checks } = planned.run;
  const problems = renderIssues(checks);
  // Warnings never change the exit code: a position without a stop is for the owner to know, not a rejected batch.
  const warnings = renderWarnings(checks);
  const waiting =
    planned.waiting.length > 0
      ? [`${planned.waiting.length} batch(es) already applied, waiting to be moved by the next ingest.`]
      : [];
  if (problems.length === 0) {
    return {
      lines: [`Inbox is clean: ${checks.length} batch(es) would apply.`, ...waiting, ...warnings],
      exitCode: 0,
    };
  }
  return { lines: [...problems, ...warnings, ...waiting, `${errorSummary(checks)}.`], exitCode: 1 };
}

/**
 * Appends to the decision log the lines an earlier run committed to the store and did not get to write, the ones the
 * log does not hold by id, and returns the store without them. The store has them so that the state and the lines it
 * needs are committed together (see `PortfolioStore.pendingDecisions`).
 */
async function writePendingDecisions(store: PortfolioStore): Promise<PortfolioStore> {
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
export async function ingestInbox(now: Date = new Date()): Promise<InboxOutcome> {
  const all = await readInbox();
  // The state is read once. A store that exists first gets what an earlier run left in it written to the log.
  const existing = await readStoreIfAny();
  const stored = existing === null ? null : await writePendingDecisions(existing);
  if (all.length === 0) return { lines: ["Inbox is empty: nothing to apply."], exitCode: 0 };

  const { run, history, rulesVersion, waiting, store } = await plan(
    all,
    stored ?? (await storeFromPortfolioFile()),
    true,
  );
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
    const lines = clean.flatMap((c) => decisionsOf(c.trades, c.text!, { rulesVersion, takenIds: taken }));
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
      renderIssues([c]).map((line) => line.replace(/^inbox\/[^:]*: /, "")),
    );
  }
  // Everything that had to be written and moved has been: the state no longer needs to remember it.
  if (applied.length > 0 || stillWaiting.length > 0) {
    await saveStore({ ...committed, unmoved: [], pendingDecisions: [] });
  }

  const files = (names: readonly string[]): string => names.map((n) => `inbox/${printable(n)}`).join(", ");
  const lines = [
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

const isMain = process.argv[1] != null && import.meta.filename === process.argv[1];
if (isMain) {
  const [cmd] = process.argv.slice(2);
  if (cmd !== "check" && cmd !== "ingest") {
    console.error("Usage: inbox.ts check|ingest");
    process.exitCode = 2;
  } else {
    (cmd === "check" ? checkInbox() : ingestInbox())
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
