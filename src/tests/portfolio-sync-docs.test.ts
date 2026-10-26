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

/** The ```json fences of a Markdown document: the parsed object and the text that precedes the fence. */
const JSON_FENCE = /```json\n([\s\S]*?)```/g;
const jsonBlocks = (md: string): { json: unknown; before: string }[] =>
  [...md.matchAll(JSON_FENCE)].map((m) => ({ json: JSON.parse(m[1]), before: md.slice(0, m.index) }));

describe("portfolio-sync guide", () => {
  it("ships with the example brain, where the stale-portfolio warning points", async () => {
    const guide = await read(GUIDE);
    assert.match(guide, /^# Portfolio sync/m);
    assert.match(guide, /PORTFOLIO_STALE_DAYS/);
  });

  it("shows every JSON block under the ### heading of its own event", async () => {
    const blocks = jsonBlocks(await read(GUIDE));
    assert.ok(blocks.length >= OWNER_TYPES.length, "fewer JSON examples than event types");
    for (const { json, before } of blocks) {
      const { type } = json as { type: string };
      const at = before.lastIndexOf("\n### ");
      assert.ok(at >= 0, `no ### heading above the ${type} block`);
      assert.ok(!before.slice(at + 1).includes("\n## "), `a ## section sits between the heading and the ${type} block`);
    }
  });

  it("fails the heading guard for a block with no event heading", () => {
    const [orphan] = jsonBlocks('## Events\n\n```json\n{ "type": "deposit" }\n```\n');
    assert.equal(orphan.before.lastIndexOf("\n### "), -1);
  });

  it("gives a JSON accepted by decision:record for every example, covering every event type", async () => {
    const examples = jsonBlocks(await read(GUIDE)).map(({ json }) => validateOwnerInput(json));
    const covered = new Set(examples.map((e) => e.type));
    for (const type of OWNER_TYPES) assert.ok(covered.has(type), `no example for ${type}`);
  });

  it("follows the lot model: decision:record keeps Lots, Volume and Avg price", async () => {
    const guide = await read(GUIDE);
    assert.match(guide, /`Lots`/);
    assert.match(guide, /`Volume`/);
    assert.match(guide, /`Avg price`/);
    assert.match(guide, /new lot/i);
    assert.match(guide, /correction commit/i);
    assert.doesNotMatch(guide, /before (you )?(delete|remov|touch|edit)/i, "the sale-before-its-row rule is gone");
    assert.doesNotMatch(guide, /then add the row/i);
  });

  it("links the glossary on first use of the decision log and of a setup, and no ADR for the log", async () => {
    const guide = await read(GUIDE);
    assert.match(guide, /\[decision log\]\([^)]*docs\/glossary\.md#decision-log\)/);
    assert.match(guide, /\[setup\]\([^)]*docs\/glossary\.md#setup\)/);
    assert.doesNotMatch(guide, /\[decision log\]\([^)]*0006/i);
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

  it("links the glossary for the decision log, not ADR-0006", async () => {
    assert.match(await read(RETENTION), /\[decision log\]\(glossary\.md#decision-log\)/);
    assert.doesNotMatch(await read(RETENTION), /\[decision log\]\([^)]*0006/i);
  });

  it("covers the report files written when email is off (#33) and says they archive like the Markdown logs", async () => {
    const doc = await read(RETENTION);
    assert.match(doc, /MAIL_TRANSPORT=none/);
    assert.match(doc, /#33/);
    assert.match(doc, /report files?/i);
  });

  it("says in .env.example that DECISIONS_ARCHIVE_DIR must be an absolute path", async () => {
    const env = await read(".env.example");
    const at = env.indexOf("DECISIONS_ARCHIVE_DIR=");
    assert.match(env.slice(env.lastIndexOf("\n\n", at), at), /absolute/i);
  });
});

/** The ```bash block of the "Archiving old logs" section. */
const markdownArchiveBlock = (md: string): string => {
  const section = md.slice(md.indexOf("## Archiving old logs"), md.indexOf("## Archiving decision-log quarters"));
  return /```bash\n([\s\S]*?)```/.exec(section)![1];
};

describe("log retention: archiving Markdown logs", () => {
  it("moves only the reviewed list, with quoted paths, never the whole glob", async () => {
    const block = markdownArchiveBlock(await read(RETENTION));
    assert.match(block, /FILES=\(/);
    assert.match(block, /mv [^\n]*"\$\{FILES\[@\]\}"/);
    assert.match(block, /git rm --cached [^\n]*"\$\{FILES\[@\]\}"/);
    assert.doesNotMatch(block.replace(/^ls .*$/m, ""), /\*\.md/, "a glob would move what was not reviewed");
  });

  it("moves exactly the listed files out of the repository and out of the index", async () => {
    const dir = await mkdtemp(join(tmpdir(), "retention-md-"));
    try {
      const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
      git("init", "-q");
      await mkdir(join(dir, "logs"));
      for (const name of ["2026-07-01-ko", "2026-08-01-ko", "2026-09-01-ko"]) {
        await writeFile(join(dir, "logs", `${name}.md`), name);
      }
      git("add", ".");
      const block = markdownArchiveBlock(await read(RETENTION))
        .replace(/^FILES=\(.*$/m, "FILES=(logs/2026-07-01-ko.md logs/2026-08-01-ko.md)")
        .replace("../archive/logs/2026-Q3", join(dir, "archive"));
      const out = spawnSync("bash", ["-c", block], { cwd: dir, encoding: "utf8" });
      assert.equal(out.status, 0, out.stderr);
      assert.equal(await readFile(join(dir, "archive", "2026-07-01-ko.md"), "utf8"), "2026-07-01-ko");
      assert.equal(git("ls-files").stdout.trim(), "logs/2026-09-01-ko.md", "only the unreviewed log stays");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
    line({ id: "x2", type: "exit", ticker: "SAP.DE", date: "2026-05-02", related_id: "e2", lot_units_left: 0 }),
    line({ id: "e3", type: "entry", ticker: "XOM", date: "2026-04-20" }), // sold in part: the lot is open
    line({ id: "x3", type: "exit", ticker: "XOM", date: "2026-05-03", related_id: "e3", lot_units_left: 2 }),
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
    assert.deepEqual(await ids(join(archive, "decisions-2026-Q2.jsonl")), ["e2", "x2", "x3", "d1"]);
    assert.notEqual(run([vars, copy]).status, 0, "step 2 repeated must refuse, not overwrite");
    assert.equal(run([vars, prune]).status, 0);
    assert.deepEqual(await ids(join(dir, "logs", "decisions.jsonl")), ["e1", "e3", "d2"]);
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
    assert.deepEqual(await ids(join(dir, "logs", "decisions.jsonl")), ["e1", "e3", "d2"]);
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
