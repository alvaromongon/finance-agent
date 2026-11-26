// Drops the engine's stop proposals in `inbox/` (#136, spec #124, ADR-0018). A flow that proposes an `ADJUST_STOP`
// (the heartbeat, `pending:resolve`, the Monday briefing) never changes `state/portfolio.json` for it: it calls this,
// and `inbox:ingest` applies the `set_stop` like any command of the owner's. Risk watch never waits for it (ADR-0015),
// so a failure here is said and never thrown: the stops are still watched and the proposal is in the decision log
// and in the email.
import { dropBatch, readInbox } from "./inbox-store.js";
import { newStopProposals, renderStopBatch, type StopProposal } from "./utils/stop-proposals.js";

export interface DropOutcome {
  /** The file dropped in `inbox/`; `null` when nothing was written. */
  file: string | null;
  dropped: StopProposal[];
  /** Proposals already waiting in `inbox/` (the same ticker and price): not dropped twice. */
  waiting: StopProposal[];
}

/**
 * One batch file with a `set_stop` per proposal that is not already waiting in `inbox/`; none when every one is.
 * `origin` names the flow in the file's name and comment (`heartbeat-eur`, `monday-briefing`, `pending`).
 */
export async function dropStopProposals(
  proposals: readonly StopProposal[],
  origin: string,
  today = new Date().toISOString().slice(0, 10),
  logPrefix = "[finance-agent] ",
): Promise<DropOutcome> {
  const none: DropOutcome = { file: null, dropped: [], waiting: [] };
  if (proposals.length === 0) return none;
  try {
    const texts = (await readInbox()).flatMap((f) => ("text" in f ? [f.text] : []));
    const { fresh, waiting } = newStopProposals(proposals, texts);
    for (const p of waiting) {
      console.log(`${logPrefix}${p.ticker}: stop ${p.stop} ${p.currency} already waits in inbox/, not dropped again`);
    }
    if (fresh.length === 0) return { ...none, waiting };
    const file = await dropBatch(`${today}-${origin}-stops`, renderStopBatch(fresh, origin, today));
    console.log(
      `${logPrefix}Stop proposal(s) dropped in inbox/${file}: ${fresh.map((p) => `${p.ticker} ${p.stop} ${p.currency}`).join(", ")}`,
    );
    return { file, dropped: fresh, waiting };
  } catch (err) {
    console.warn(
      `${logPrefix}WARNING, the stop proposal(s) were not dropped in inbox/: ${err instanceof Error ? err.message : String(err)}`,
    );
    return none;
  }
}
