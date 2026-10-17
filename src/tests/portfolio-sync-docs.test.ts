/**
 * The portfolio-sync guide and the retention doc (spec #14): the guide the
 * stale-portfolio warning points to ships with the example brain, every JSON
 * example in it is accepted by `decision:record`, and the README links both.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
    assert.match(guide, /^# Portfolio sync/m);
    assert.match(guide, /PORTFOLIO_STALE_DAYS/);
  });

  it("names each event type in the JSON block that shows it", async () => {
    const guide = await read(GUIDE);
    for (const match of guide.matchAll(/```json\n([\s\S]*?)```/g)) {
      const { type } = JSON.parse(match[1]) as { type: string };
      assert.ok(OWNER_TYPES.includes(type as never), `unknown type ${type}`);
      const before = guide.slice(0, match.index);
      const heading = before.slice(before.lastIndexOf("\n### "));
      assert.ok(heading.length > 0 && !heading.includes("\n## "), `no event section above the ${type} block`);
    }
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
    assert.match(doc, /must be an \*\*absolute\*\* path/);
    assert.match(doc, /decisions:chart/);
  });
});

/** The ```bash blocks of the "Archiving decision-log quarters" section, in order. */
const archiveBlocks = (md: string): string[] => {
  const section = md.slice(md.indexOf("## Archiving decision-log quarters"), md.indexOf("## Reading the archive back"));
  return [...section.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
};

describe("log retention: the documented archive commands", () => {
  const line = (o: object) => JSON.stringify(o);
  const LIVE = [
    line({ id: "e1", type: "entry", ticker: "KO", date: "2026-04-10" }), // still held
    line({ id: "e2", type: "entry", ticker: "SAP.DE", date: "2026-04-12" }),
    line({ id: "x2", type: "exit", ticker: "SAP.DE", date: "2026-05-02", related_id: "e2" }),
    line({ id: "d1", type: "deposit", date: "2026-05-05" }),
    line({ id: "d2", type: "deposit", date: "2026-09-01" }),
  ];
  let dir: string;
  let archive: string;

  const run = (blocks: string[], archiveDir = archive) => {
    const script = blocks.join("\n").replace("/absolute/path/to/archive", archiveDir);
    return spawnSync("bash", ["-c", script], { cwd: dir, encoding: "utf8" });
  };
  const lines = async (path: string) => (await readFile(path, "utf8")).split("\n").filter(Boolean);
  const ids = async (path: string) => (await lines(path)).map((l) => (JSON.parse(l) as { id: string }).id);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "retention-"));
    archive = join(dir, "archive");
    await mkdir(join(dir, "logs"));
    await writeFile(join(dir, "logs", "decisions.jsonl"), LIVE.join("\n") + "\n");
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("archives the quarter, keeps the entry of an open position and what is out of range", async () => {
    const [vars, copy, prune] = archiveBlocks(await read(RETENTION));
    const first = run([vars, copy]);
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(await ids(join(archive, "decisions-2026-Q2.jsonl")), ["e2", "x2", "d1"]);
    assert.notEqual(run([vars, copy]).status, 0, "step 2 repeated must refuse, not overwrite");
    assert.equal(run([vars, prune]).status, 0);
    assert.deepEqual(await ids(join(dir, "logs", "decisions.jsonl")), ["e1", "d2"]);
  });

  it("is safe to repeat: step 2 refuses an existing archive and step 3 does not touch the log", async () => {
    const [vars, copy, prune] = archiveBlocks(await read(RETENTION));
    assert.equal(run([vars, copy]).status, 0);
    assert.equal(run([vars, prune]).status, 0);
    const target = join(archive, "decisions-2026-Q2.jsonl");
    const archived = await readFile(target, "utf8");
    assert.notEqual(run([vars, copy]).status, 0);
    assert.equal(await readFile(target, "utf8"), archived, "the archive was overwritten");
    assert.notEqual(run([vars, prune]).status, 0, "line counts no longer add up");
    assert.deepEqual(await ids(join(dir, "logs", "decisions.jsonl")), ["e1", "d2"]);
  });

  it("fails on an empty or relative archive directory", async () => {
    const [vars, copy] = archiveBlocks(await read(RETENTION));
    assert.notEqual(run([vars, copy], "").status, 0);
    assert.notEqual(run([vars, copy], "relative/archive").status, 0);
  });

  it("leaves the live log untouched when a line is malformed", async () => {
    const [vars, copy, prune] = archiveBlocks(await read(RETENTION));
    const live = join(dir, "logs", "decisions.jsonl");
    await writeFile(live, LIVE.join("\n") + "\n{not json\n");
    const before = await readFile(live, "utf8");
    assert.notEqual(run([vars, copy, prune]).status, 0);
    assert.equal(await readFile(live, "utf8"), before);
  });
});

describe("README", () => {
  it("links the sync guide and the retention doc", async () => {
    const readme = await read("README.md");
    assert.ok(readme.includes(GUIDE), "no link to the sync guide");
    assert.ok(readme.includes(RETENTION), "no link to the retention doc");
  });
});
