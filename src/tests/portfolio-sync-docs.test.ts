/**
 * The portfolio-sync guide and the retention doc (spec #14): the guide the
 * stale-portfolio warning points to ships with the example brain, every JSON
 * example in it is accepted by `decision:record`, and the README links both.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

/** The event types each `###` heading of the guide may carry. */
const HEADING_EVENTS: Record<string, readonly string[]> = {
  "Deposit or withdrawal": ["deposit", "withdrawal"],
  "Currency conversion": ["fx_conversion"],
  Buy: ["entry"],
  Sell: ["exit"],
  "Stop change": ["adjust_stop"],
};

/**
 * What is wrong with a JSON block, or null: it needs a `###` heading above it, in the same `##` section,
 * and the heading must be the one of the block's own event type.
 */
const headingProblem = (json: unknown, before: string): string | null => {
  const { type } = json as { type: string };
  const at = before.lastIndexOf("\n### ");
  if (at < 0) return `no ### heading above the ${type} block`;
  const under = before.slice(at + 1);
  if (under.includes("\n## ")) return `a ## section sits between the heading and the ${type} block`;
  const heading = under.slice(4, under.indexOf("\n")).trim();
  if (!HEADING_EVENTS[heading]?.includes(type)) return `the ${type} block sits under "### ${heading}"`;
  return null;
};

describe("portfolio-sync guide", () => {
  it("ships with the example brain, where the stale-portfolio warning points", async () => {
    const guide = await read(GUIDE);
    assert.match(guide, /^# Portfolio sync/m);
    assert.match(guide, /PORTFOLIO_STALE_DAYS/);
  });

  it("shows every JSON block under the ### heading of its own event", async () => {
    const blocks = jsonBlocks(await read(GUIDE));
    assert.ok(blocks.length >= OWNER_TYPES.length, "fewer JSON examples than event types");
    for (const { json, before } of blocks) assert.equal(headingProblem(json, before), null);
  });

  it("fails the heading guard for a block with no event heading, in another section, or under another event", () => {
    const problem = (md: string) => {
      const [block] = jsonBlocks(md);
      return headingProblem(block.json, block.before);
    };
    assert.match(problem('## Events\n\n```json\n{ "type": "deposit" }\n```\n') ?? "", /no ### heading/);
    assert.match(
      problem('\n### Buy\n\n## Other\n\n```json\n{ "type": "entry" }\n```\n') ?? "",
      /a ## section sits between/,
    );
    assert.match(problem('\n### Buy\n\n```json\n{ "type": "withdrawal" }\n```\n') ?? "", /under "### Buy"/);
    assert.equal(problem('\n### Deposit or withdrawal\n\n```json\n{ "type": "withdrawal" }\n```\n'), null);
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

  it("says a buy changes Stop loss only for a new position, and that adding to a position leaves it to you", async () => {
    const guide = await read(GUIDE);
    assert.match(guide, /`Stop loss` \(new position only\)/);
    assert.match(guide, /edit `Stop loss` by hand/i);
  });

  it("orders events by date, flows first within a date", async () => {
    const guide = await read(GUIDE);
    assert.match(guide, /by date; within a date, flows first/);
    assert.doesNotMatch(guide, /in the order they happened at the broker/);
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

  it("links the glossary on first use of heartbeat, lot and SLO instead of redefining them", async () => {
    const doc = await read(RETENTION);
    assert.match(doc, /\[heartbeat\]\(glossary\.md#heartbeat\)/);
    assert.match(doc, /\[lot\]\(glossary\.md#lot\)/);
    assert.match(doc, /\[SLO\]\(glossary\.md#sli-and-slo\)/);
    assert.doesNotMatch(doc, /one no `exit` has\s+used up/);
    const glossary = await read("docs/glossary.md");
    for (const heading of ["Heartbeat", "Lot", "SLI and SLO"])
      assert.match(glossary, new RegExp(`^### ${heading}$`, "m"));
  });

  it("names the live-file-only readers as the heartbeat and the two-month rule, not the attribution", async () => {
    const doc = await read(RETENTION);
    assert.doesNotMatch(doc, /attribution of trades to\s+proposals \(10-day window\)\s+read the live file only/);
    assert.match(doc, /read\s+the\s+live\s+file\s+only:\s+the\s+heartbeat\s+and\s+the\s+two-month\s+rule/);
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

/** The environment without any `GIT_*` variable, so a hook's `GIT_DIR` cannot point the script at another repository. */
const cleanEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));

/** Replaces `text` by `by`, failing if the doc no longer holds it: the script must never run with the doc's own paths. */
const replaceExisting = (block: string, text: string | RegExp, by: string): string => {
  const found = typeof text === "string" ? block.includes(text) : text.test(block);
  assert.ok(found, `the block no longer contains ${String(text)}`);
  return block.replace(text, by);
};

const fillMarkdownBlock = (block: string, dir: string): string =>
  replaceExisting(
    replaceExisting(block, /^FILES=\(.*$/m, "FILES=(logs/2026-07-01-ko.md logs/2026-08-01-ko.md)"),
    "../archive/logs/2026-Q3",
    join(dir, "archive"),
  );

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
      const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8", env: cleanEnv() });
      assert.equal(git("init", "-q").status, 0);
      await mkdir(join(dir, "logs"));
      for (const name of ["2026-07-01-ko", "2026-08-01-ko", "2026-09-01-ko"]) {
        await writeFile(join(dir, "logs", `${name}.md`), name);
      }
      git("add", ".");
      const block = fillMarkdownBlock(markdownArchiveBlock(await read(RETENTION)), dir);
      const out = spawnSync("bash", ["-c", block], { cwd: dir, encoding: "utf8", env: cleanEnv() });
      assert.equal(out.status, 0, out.stderr);
      assert.equal(await readFile(join(dir, "archive", "2026-07-01-ko.md"), "utf8"), "2026-07-01-ko");
      assert.equal(git("ls-files").stdout.trim(), "logs/2026-09-01-ko.md", "only the unreviewed log stays");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never overwrites a file already in the destination, and moves nothing then", async () => {
    const dir = await mkdtemp(join(tmpdir(), "retention-md-"));
    try {
      const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8", env: cleanEnv() });
      assert.equal(git("init", "-q").status, 0);
      await mkdir(join(dir, "logs"));
      await mkdir(join(dir, "archive"));
      for (const name of ["2026-07-01-ko", "2026-08-01-ko"]) await writeFile(join(dir, "logs", `${name}.md`), name);
      await writeFile(join(dir, "archive", "2026-08-01-ko.md"), "older copy");
      git("add", ".");
      const block = fillMarkdownBlock(markdownArchiveBlock(await read(RETENTION)), dir);
      const out = spawnSync("bash", ["-c", block], { cwd: dir, encoding: "utf8", env: cleanEnv() });
      assert.notEqual(out.status, 0);
      assert.equal(await readFile(join(dir, "archive", "2026-08-01-ko.md"), "utf8"), "older copy");
      assert.equal(await readFile(join(dir, "logs", "2026-08-01-ko.md"), "utf8"), "2026-08-01-ko");
      assert.equal(await readFile(join(dir, "logs", "2026-07-01-ko.md"), "utf8"), "2026-07-01-ko", "nothing moved");
      assert.equal(git("ls-files", "logs").stdout.trim().split("\n").length, 2, "nothing left the index");
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
    line({ id: "e4", type: "entry", ticker: "NESN", date: "2026-02-10" }), // bought in Q1, closed in Q2
    line({ id: "e1", type: "entry", ticker: "KO", date: "2026-04-10" }), // still held
    line({ id: "e2", type: "entry", ticker: "SAP.DE", date: "2026-04-12" }),
    line({ id: "x2", type: "exit", ticker: "SAP.DE", date: "2026-05-02", related_id: "e2", lot_units_left: 0 }),
    line({ id: "e3", type: "entry", ticker: "XOM", date: "2026-04-20" }), // sold in part: the lot is open
    line({ id: "x3", type: "exit", ticker: "XOM", date: "2026-05-03", related_id: "e3", lot_units_left: 2 }),
    line({ id: "x4", type: "exit", ticker: "NESN", date: "2026-05-10", related_id: "e4", lot_units_left: 0 }),
    line({ id: "e5", type: "entry", ticker: "ITX", date: "2026-04-15" }), // its exit is a legacy one
    line({ id: "x5", type: "exit", ticker: "ITX", date: "2026-05-15", related_id: "e5" }), // no lot_units_left
    line({ id: "d1", type: "deposit", date: "2026-05-05" }),
    line({ id: "d2", type: "deposit", date: "2026-09-01" }),
    line({ id: "e6", type: "entry", ticker: "MSFT", date: "2026-04-05" }), // sold in part in Q2, used up in Q3
    line({ id: "x6", type: "exit", ticker: "MSFT", date: "2026-05-20", related_id: "e6", lot_units_left: 1 }),
    line({ id: "x7", type: "exit", ticker: "MSFT", date: "2026-08-01", related_id: "e6", lot_units_left: 0 }),
    line({ id: "x8", type: "exit", ticker: "BP", date: "2026-05-21" }), // cites no lot: archived by its date
  ];
  let dir: string;
  let archive: string;

  const run = (blocks: string[], archiveDir = archive) => {
    const script = replaceExisting(blocks.join("\n"), "/absolute/path/to/archive", archiveDir);
    return spawnSync("bash", ["-c", script], { cwd: dir, encoding: "utf8", env: cleanEnv() });
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

  it("archives a lot's entry and exits together once the quarter closes it, and keeps every line of an open lot (legacy exit included) and what is out of range", async () => {
    const [vars, copy, prune] = archiveBlocks(await read(RETENTION));
    const first = run([vars, copy]);
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(await ids(join(archive, "decisions-2026-Q2.jsonl")), ["e4", "e2", "x2", "x4", "d1", "x8"]);
    assert.notEqual(run([vars, copy]).status, 0, "step 2 repeated must refuse, not overwrite");
    assert.equal(run([vars, prune]).status, 0);
    assert.deepEqual(await ids(join(dir, "logs", "decisions.jsonl")), [
      "e1",
      "e3",
      "x3",
      "e5",
      "x5",
      "d2",
      "e6",
      "x6",
      "x7",
    ]);
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
    assert.deepEqual(await ids(join(dir, "logs", "decisions.jsonl")), [
      "e1",
      "e3",
      "x3",
      "e5",
      "x5",
      "d2",
      "e6",
      "x6",
      "x7",
    ]);
  });

  it("fails on an empty or relative archive directory", async () => {
    const [vars, copy] = archiveBlocks(await read(RETENTION));
    assert.notEqual(run([vars, copy], "").status, 0);
    assert.notEqual(run([vars, copy], "relative/archive").status, 0);
  });

  it("leaves no archive behind when jq fails on a bad line, so the retry is not blocked", async () => {
    const [vars, copy] = archiveBlocks(await read(RETENTION));
    const live = join(dir, "logs", "decisions.jsonl");
    await writeFile(live, LIVE.join("\n") + "\n{not json\n");
    assert.notEqual(run([vars, copy]).status, 0);
    assert.deepEqual(await readdir(archive), [], "a failed copy left a file in the archive directory");
    await writeFile(live, LIVE.join("\n") + "\n");
    const retry = run([vars, copy]);
    assert.equal(retry.status, 0, retry.stderr);
    assert.deepEqual(await readdir(archive), ["decisions-2026-Q2.jsonl"], "the temporary file is gone");
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
