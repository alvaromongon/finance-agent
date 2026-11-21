// The rejected batches that still await an answer (#152): a batch `inbox:ingest` rejected is never forgotten and never
// retried. It stays in `inbox/rejected/` as the audit trail and is named in every digest of the heartbeat until a later
// batch replaces it (`replaces:`) or discards it (`discard`), which the store remembers with the hash of the file.
import { createHash } from "node:crypto";
import { readRejected } from "./inbox-store.js";
import { readStoreIfAny } from "./portfolio-store.js";
import type { ResolvedRejection } from "./utils/portfolio-json.js";

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The names of the rejected batches no one settled: a file settled under the same name but another text is a new rejection. */
export function awaitingOf(
  rejected: readonly { name: string; text: string }[],
  resolved: readonly ResolvedRejection[],
): string[] {
  // Each file is hashed once, and only when something was settled under its name.
  return rejected
    .filter(({ name, text }) => {
      const settled = resolved.filter((r) => r.file === name);
      if (settled.length === 0) return true;
      const hash = sha256(text);
      return !settled.some((r) => r.sha256 === hash);
    })
    .map(({ name }) => name);
}

/** The rejected batches awaiting a replacement or a discard, from the folder and the store: what the digest names. */
export async function readAwaitingRejected(): Promise<string[]> {
  const [{ batches, unread }, store] = await Promise.all([readRejected(), readStoreIfAny()]);
  // A file that is not a batch the engine could have moved there is never settled (it has no text to match): said,
  // not followed, and left for the owner to remove.
  for (const { problem } of unread) console.warn(`[finance-agent] WARNING, ${problem}`);
  return awaitingOf(batches, store?.resolvedRejections ?? []);
}
