// The pending escalations that still await an answer (#141): a signal the engine escalated and left in `logs/pending/`
// is never forgotten. It is named in every digest until a `resolve` command closes it, which the store remembers with
// the hash of the file. The file itself is never edited or deleted by the engine's commands: it is the record.
import { readInbox } from "./inbox-store.js";
import { sha256 } from "./inbox-rejected.js";
import { readStoreIfAny } from "./portfolio-store.js";
import { readPendingEscalations } from "./vault-io.js";
import { parseBatch } from "./utils/inbox-parse.js";
import type { ClosedEscalationRecord } from "./utils/portfolio-json.js";

/** The ids of the escalations no one closed: a file closed under the same name but another text is a new escalation. */
export function openEscalationsOf(
  pending: readonly { id: string; text: string }[],
  closed: readonly ClosedEscalationRecord[],
): string[] {
  // Each file is hashed once, and only when something was closed under its name.
  return pending
    .filter(({ id, text }) => {
      const settled = closed.filter((c) => c.id === id);
      if (settled.length === 0) return true;
      const hash = sha256(text);
      return !settled.some((c) => c.sha256 === hash);
    })
    .map(({ id }) => id);
}

/** The pending escalations still open, from the folder and the store: what the digest names and `pending:list` lists. */
export async function readOpenEscalations(): Promise<string[]> {
  const [pending, store] = await Promise.all([readPendingEscalations(), readStoreIfAny()]);
  return openEscalationsOf(pending, store?.closedEscalations ?? []);
}

/** The ids that a batch waiting in `inbox/` already closes with a `resolve`: handled, only the next ingest is missing. */
async function closingInInbox(): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const file of await readInbox()) {
    if (!("text" in file)) continue;
    for (const { command } of parseBatch(file.text).commands) if (command.kind === "resolve") ids.add(command.id);
  }
  return ids;
}

/**
 * The open escalations the reasoner's session still has to work on: open (no command closed them) and not already closed
 * by a batch waiting in `inbox/`. The digest names the first list, until ingest; the routine works on this one.
 */
export async function readEscalationsToDo(): Promise<string[]> {
  const [open, closing] = await Promise.all([readOpenEscalations(), closingInInbox()]);
  return open.filter((id) => !closing.has(id));
}
