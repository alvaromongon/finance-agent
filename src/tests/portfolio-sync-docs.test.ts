/**
 * The portfolio-sync guide and the retention doc (spec #14): the guide the
 * stale-portfolio warning points to ships with the example brain, every JSON
 * example in it is accepted by `decision:record`, and the README links both.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { OWNER_TYPES, validateOwnerInput } from "../decisions.js";

const ROOT = join(import.meta.dirname, "..", "..");
const GUIDE = "examples/brain/routines/portfolio-sync.md";
const RETENTION = "docs/log-retention.md";

const read = (path: string) => readFile(join(ROOT, path), "utf8");

/** The JSON objects in the ```json fences of a Markdown document. */
const jsonBlocks = (md: string): unknown[] => [...md.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));

describe("portfolio-sync guide", () => {
  it("ships with the example brain, where the stale-portfolio warning points", async () => {
    const guide = await read(GUIDE);
    assert.match(guide, /^# /m);
  });

  it("gives a valid decision:record JSON for every event type the owner can narrate", async () => {
    const examples = jsonBlocks(await read(GUIDE)).map((raw) => validateOwnerInput(raw));
    const covered = new Set(examples.map((e) => e.type));
    for (const type of OWNER_TYPES) assert.ok(covered.has(type), `no example for ${type}`);
  });

  it("says to record an exit before deleting the position row, which sets its P&L", async () => {
    assert.match(await read(GUIDE), /before (you )?(delete|remov)/i);
  });
});

describe("log retention doc", () => {
  it("covers the queue files, the archive and DECISIONS_ARCHIVE_DIR", async () => {
    const doc = await read(RETENTION);
    for (const term of ["logs/pending/", "logs/outbox/", "logs/pending-screening/", "DECISIONS_ARCHIVE_DIR"]) {
      assert.ok(doc.includes(term), `missing ${term}`);
    }
    assert.match(doc, /decisions-YYYY-QN\.jsonl/);
  });
});

describe("README", () => {
  it("links the sync guide and the retention doc", async () => {
    const readme = await read("README.md");
    assert.ok(readme.includes(GUIDE), "no link to the sync guide");
    assert.ok(readme.includes(RETENTION), "no link to the retention doc");
  });
});
