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
  return rejected
    .filter(({ name, text }) => !resolved.some((r) => r.file === name && r.sha256 === sha256(text)))
    .map(({ name }) => name);
}

/** The rejected batches awaiting a replacement or a discard, from the folder and the store: what the digest names. */
export async function readAwaitingRejected(): Promise<string[]> {
  const [rejected, store] = await Promise.all([readRejected(), readStoreIfAny()]);
  return awaitingOf(rejected, store?.resolvedRejections ?? []);
}
