/**
 * The example workflows share one data repository and append to the same logs (`logs/decisions.jsonl`), in different
 * concurrency groups: no two of them may fire at the same minute (#134).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Two runners of the same flow: you install one of them, so they share a schedule on purpose. */
const ALTERNATIVES = new Set(["heartbeat-eu.yml", "heartbeat-eu-handoff.yml"]);
const DIR = join(import.meta.dirname, "..", "..", "examples", "workflows");

/** The values a cron field matches, for the forms the examples use: `*`, `n`, `a-b`, and comma lists of them. */
function expand(field: string, min: number, max: number): number[] {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    if (part === "*") for (let n = min; n <= max; n++) values.add(n);
    else {
      const [from, to = from] = part.split("-").map(Number);
      assert.ok(Number.isInteger(from) && Number.isInteger(to), `unsupported cron field ${field}`);
      for (let n = from; n <= to; n++) values.add(n);
    }
  }
  return [...values];
}

describe("example workflow schedules", () => {
  it("no two cron entries fire at the same minute", async () => {
    const seen = new Map<string, string>();
    for (const file of (await readdir(DIR)).filter((name) => name.endsWith(".yml"))) {
      const text = await readFile(join(DIR, file), "utf8");
      for (const [, cron] of text.matchAll(/^\s*- cron: "([^"]+)"/gm)) {
        const [minute, hour, dom, month, dow] = cron.split(" ");
        assert.equal(`${dom} ${month}`, "* *", `${file}: day-of-month and month are not supported by this check`);
        for (const d of expand(dow, 0, 6))
          for (const h of expand(hour, 0, 23))
            for (const m of expand(minute, 0, 59)) {
              const slot = `day ${d} ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
              const other = seen.get(slot);
              assert.ok(
                other === undefined || other === file || (ALTERNATIVES.has(file) && ALTERNATIVES.has(other)),
                `${file} and ${other} both fire at ${slot} UTC`,
              );
              seen.set(slot, file);
            }
      }
    }
    assert.ok(seen.size > 0);
  });
});
