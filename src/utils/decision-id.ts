// The id of a decision, in one place (#132): the id `decision:record` gives a decision and the entry id of the lot
// an `inbox:ingest` buy opens are the same kind of id, from this source, so no two decisions or lots of the whole
// history share one (the lot's `Entry id` is the id of its `entry` decision, ADR-0015). Pure but for the random suffix.
import { createHash, randomUUID } from "node:crypto";
import { tickerIdPart } from "../ticker.js";

/** Readable id: date, asset (or silo) and type, plus a suffix, random unless the caller gives one. */
export function newDecisionId(date: string, subject: string, type: string, suffix = randomUUID().slice(0, 8)): string {
  return `${date.replace(/-/g, "")}-${tickerIdPart(subject)}-${type}-${suffix}`;
}

/**
 * A source of ids that never repeats one in `taken` (the ids of the whole history, closed lots included, and of the
 * lots the state holds) nor one it gave before. The suffix comes from `seed` and the count of ids given, so the
 * same seed over the same `taken` gives the same ids (a check and the ingest that follows it name the same lots).
 */
export function uniqueDecisionIds(
  taken: Set<string>,
  seed: string,
): (date: string, subject: string, type: string) => string {
  let count = 0;
  return (date, subject, type) => {
    for (;;) {
      count += 1;
      const suffix = createHash("sha256").update(`${seed}:${count}`).digest("hex").slice(0, 8);
      const id = newDecisionId(date, subject, type, suffix);
      if (!taken.has(id)) {
        taken.add(id);
        return id;
      }
    }
  };
}
