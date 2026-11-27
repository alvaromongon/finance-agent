// CLI of the repair (#139, spec #124, ADR-0018): `npm run state:repair` rebuilds the engine's store from the decision log and
// the batches in `inbox/applied/`, and refuses, changing nothing, when they disagree, saying where. It does exactly that and
// nothing else: it never edits a batch or a line of the log, it is never run by the engine itself, and every run, a refusal
// included, writes a `repair` line to the decision log with the date, the result and what it found.
import { buildDecision, type Decision } from "./decisions.js";
import { readApplied, readInbox, readRejected } from "./inbox-store.js";
import { sha256 } from "./inbox-rejected.js";
import { writePendingDecisions } from "./inbox.js";
import { readStoreForRepair, saveStore, type PortfolioStore } from "./portfolio-store.js";
import { commitState, stateRemoteFromConfig, type StateRemote } from "./state-commit.js";
import { config } from "./config.js";
import { appendDecisions, readDecisionHistory, readRulesVersion } from "./vault-io.js";
import { CURRENCIES, type Currency } from "./types.js";
import type { InboxState } from "./utils/inbox-handlers.js";
import type { LedgerFile } from "./utils/inbox-replay.js";
import { printable } from "./utils/printable.js";
import { planRepair, type Finding } from "./utils/state-repair.js";

export interface RepairOutcome {
  lines: string[];
  exitCode: number;
}

/** Most differences a line of the log carries: a store that is wrong in many places says the first ones and how many more. */
const MOST_FINDINGS = 50;

const asState = (store: PortfolioStore): InboxState => ({
  ...(store.silos.EUR ? { EUR: store.silos.EUR } : {}),
  ...(store.silos.USD ? { USD: store.silos.USD } : {}),
});

/** The `repair` line of one silo: the day, the result and what the run found about that silo (or about both). */
function auditLine(
  currency: Currency,
  result: "rebuilt" | "unchanged" | "refused",
  findings: readonly Finding[],
  context: { today: string; rulesVersion: string },
): Decision {
  const own = findings.filter((f) => f.currency === null || f.currency === currency).map((f) => f.text);
  const shown =
    own.length > MOST_FINDINGS ? [...own.slice(0, MOST_FINDINGS), `and ${own.length - MOST_FINDINGS} more`] : own;
  return buildDecision({
    date: context.today,
    ticker: null,
    currency,
    source: "portfolio-sync",
    rules_version: context.rulesVersion,
    origin: "propietario",
    type: "repair",
    result,
    ...(shown.length > 0 ? { differences: shown } : {}),
  });
}

/**
 * Rebuilds the store from the decision log and `inbox/applied/` (see the head of this file). The store is the commit point:
 * it is written with the audit lines, then the lines go to the log (a run that stops between the two leaves them in the
 * store, and the next `inbox:ingest` writes them, as it does with the lines of its trades). A run that refuses, or finds
 * the store as the audit trail gives it, writes only the line. Throws for a failure that is not a verdict (a file that cannot
 * be read or written).
 */
export async function repairStore(now: Date = new Date()): Promise<RepairOutcome> {
  const today = now.toISOString().slice(0, 10);
  const { store: existing, problem, starting } = await readStoreForRepair();
  // A store that reads first gets what an earlier run left in it written to the log.
  const old = existing === null ? null : await writePendingDecisions(existing);

  const { batches, unread } = await readApplied();
  const waiting =
    old === null
      ? []
      : (await readInbox()).flatMap((file): LedgerFile[] =>
          "text" in file && old.unmoved.some((u) => u.file === file.name && u.sha256 === sha256(file.text))
            ? [{ name: file.name, text: file.text }]
            : [],
        );
  const [history, rulesVersion] = await Promise.all([readDecisionHistory(), readRulesVersion().catch(() => "unknown")]);
  const plan = planRepair({
    applied: [...batches, ...waiting],
    history,
    old: old === null ? null : asState(old),
    ...(starting !== undefined ? { starting: asState({ silos: starting } as PortfolioStore) } : {}),
    rulesVersion,
    today,
    now: now.toISOString(),
  });
  const findings: Finding[] = [
    ...(problem !== null ? [{ currency: null, text: `the store cannot be read: ${problem}` }] : []),
    ...plan.findings,
  ];
  const silos = CURRENCIES.filter(
    (c) => old?.silos[c] !== undefined || (plan.result !== "refused" && plan.state[c] !== undefined),
  );
  const lines = (silos.length > 0 ? silos : CURRENCIES).map((c) =>
    auditLine(c, plan.result, findings, { today, rulesVersion }),
  );
  const said = [
    ...unread.map((u) => `${u.problem}: not part of the audit trail`),
    ...findings.map((f) => `  - ${f.text}`),
  ];

  if (plan.result === "refused") {
    await appendDecisions(lines);
    return {
      lines: [
        `Repair refused: the decision log and the ${plan.batches} batch(es) in inbox/applied/ do not tell one story, so nothing was changed:`,
        ...said,
      ],
      exitCode: 1,
    };
  }
  if (plan.result === "unchanged") {
    await appendDecisions(lines);
    return {
      lines: [
        `Nothing to repair: the store is what the decision log and the ${plan.batches} batch(es) in inbox/applied/ give.`,
        ...unread.map((u) => `${u.problem}: not part of the audit trail`),
      ],
      exitCode: 0,
    };
  }

  const rejected = old === null ? (await readRejected()).batches : [];
  const at = now.toISOString();
  const committed: PortfolioStore = {
    silos: plan.state,
    ...(starting !== undefined ? { starting } : {}),
    ...(old?.accountEnv !== undefined ? { accountEnv: old.accountEnv } : {}),
    unmoved: old?.unmoved ?? [],
    pendingDecisions: lines.map((d) => JSON.stringify(d)),
    resolvedRejections:
      old?.resolvedRejections ??
      plan.resolved.map(({ file, how, by }) => ({
        file,
        sha256: sha256(rejected.find((r) => r.name === file)?.text ?? ""),
        how,
        by,
        at,
      })),
  };
  await saveStore(committed);
  await appendDecisions(lines);
  await saveStore({ ...committed, pendingDecisions: [] });
  return {
    lines: [
      `Rebuilt state/portfolio.json from the decision log and ${plan.batches} batch(es) in inbox/applied/. It differed in:`,
      ...said,
    ],
    exitCode: 0,
  };
}

/** `repairStore` as a write of the state (ADR-0018, #134): over the remote's last commit, committed on top of it as a compare-and-swap. */
export async function repairCommitted(
  remote: StateRemote | null,
  attempts: number,
  now: Date = new Date(),
): Promise<RepairOutcome> {
  if (remote === null) return repairStore(now);
  const write = await commitState(remote, () => repairStore(now), {
    attempts,
    message: `chore(state): repair ${now.toISOString().slice(0, 10)}`,
  });
  if (write.status === "deferred") {
    return {
      lines: [
        `State not repaired: another run committed state ${write.attempts} time(s) while this one worked. Run it again.`,
      ],
      exitCode: 1,
    };
  }
  return write.result;
}

const isMain = process.argv[1] != null && import.meta.filename === process.argv[1];
if (isMain) {
  repairCommitted(
    stateRemoteFromConfig(config.stateCommit, config.paths.vaultProjectDir),
    config.stateCommit.attempts(),
  )
    .then(({ lines, exitCode }) => {
      for (const line of lines) (exitCode === 0 ? console.log : console.error)(line);
      process.exitCode = exitCode;
    })
    .catch((err) => {
      console.error("[state-repair]", err instanceof Error ? printable(err.message) : err);
      process.exitCode = 1;
    });
}
