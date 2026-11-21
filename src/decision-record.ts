// CLI of `decision:record` (#134): the owner's stop adjustments, deposits, withdrawals and conversions, as a write of the
// state. It lives apart from `decision.ts` because the heartbeat imports that, and stop detection must not import the
// compare-and-swap (ADR-0015, ADR-0018).
import { config } from "./config.js";
import { describeOwnerDecision, recordOwnerDecision, type OwnerDecisionProvider } from "./decision.js";
import type { Decision } from "./decisions.js";
import { commitState, stateRemoteFromConfig, type StateRemote } from "./state-commit.js";

/**
 * `recordOwnerDecision` as a write of the state (ADR-0018, #134): a deposit, a withdrawal or a conversion moves the
 * cash of the store, so it is committed over the remote's last commit as a compare-and-swap, and done again over the
 * new state if another run committed meanwhile (see `commitState`). Throws, having recorded nothing, when the race is
 * lost every time: the owner says it again. With no remote the files are left in place.
 */
export async function recordCommitted(
  raw: unknown,
  remote: StateRemote | null = stateRemoteFromConfig(config.stateCommit, config.paths.vaultProjectDir),
  attempts = config.stateCommit.attempts(),
  provider?: OwnerDecisionProvider,
): Promise<Decision[]> {
  if (remote === null) return recordOwnerDecision(raw, provider);
  const write = await commitState(remote, () => recordOwnerDecision(raw, provider), {
    attempts,
    message: `chore(state): record owner decision ${new Date().toISOString().slice(0, 10)}`,
  });
  if (write.status === "deferred") {
    throw new Error(
      `Nothing was recorded: another run committed state ${write.attempts} time(s) while this one worked. Say it again.`,
    );
  }
  return write.result;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const isMain = process.argv[1] != null && import.meta.filename === process.argv[1];
if (isMain) {
  const [cmd] = process.argv.slice(2);
  if (cmd !== "record") {
    throw new Error("Usage: decision-record.ts record  (trade JSON on stdin)");
  }
  readStdin()
    .then((stdin) => recordCommitted(JSON.parse(stdin)))
    .then((decisions) => {
      for (const decision of decisions) {
        console.log(describeOwnerDecision(decision));
        console.log(JSON.stringify(decision));
      }
    })
    .catch((err) => {
      console.error("[decision]", err instanceof Error ? err.message : err);
      process.exitCode = 1;
    });
}
