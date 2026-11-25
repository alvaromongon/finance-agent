/**
 * The `commit-changes` action's script (#134, ADR-0018): the patch of a heartbeat or a briefing is committed to the
 * data repository, but its changes to the engine's state are dropped when another run committed state since the
 * checkout it started from, and a push that loses a race is retried. Real git, over a bare repository in a temporary
 * folder: never the real remote.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SCRIPT = join(import.meta.dirname, "..", "..", ".github", "actions", "commit-changes", "commit.sh");
const STATE = "data/state/ data/portfolio.md";
const PATHS = "data/logs/ data/portfolio.md data/state/portfolio.json";

describe("commit-changes script", () => {
  let root: string;
  let bare: string;
  const dir = (name: string) => join(root, name);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
  const put = async (name: string, file: string, text: string) => {
    const path = join(dir(name), file);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, text, "utf8");
  };
  const onRemote = (file: string) => git(bare, "show", `main:${file}`);

  /** Another run commits `file` and pushes, from its own checkout. */
  async function otherCommits(file: string, text: string, message = "other"): Promise<void> {
    await put("other", file, text);
    git(dir("other"), "add", "-A");
    git(dir("other"), "commit", "--quiet", "-m", message);
    git(dir("other"), "push", "--quiet", "origin", "main");
  }

  /** The patch a run exports: what it changed in its checkout, as the reusable workflow's `Export changes` step. */
  async function patchOf(name: string, edit: () => Promise<void>): Promise<string> {
    await edit();
    git(dir(name), "add", "-A");
    const patch = join(root, `${name}.patch`);
    await writeFile(patch, git(dir(name), "diff", "--cached", "--binary"), "utf8");
    git(dir(name), "reset", "--quiet", "--hard");
    return patch;
  }

  function commit(patch: string, extra: Record<string, string> = {}) {
    return spawnSync("bash", [SCRIPT], {
      cwd: dir("heartbeat"),
      encoding: "utf8",
      env: {
        ...process.env,
        PATCH_FILE: patch,
        COMMIT_PATHS: PATHS,
        COMMIT_MESSAGE: "chore(logs): heartbeat",
        STATE_PATHS: STATE,
        GITHUB_REF_NAME: "main",
        ...extra,
      },
    });
  }

  /** A pre-push hook in the run's checkout: another run's push, made just before the run's own. */
  async function raceBeforePush(shell: string): Promise<void> {
    const hook = join(dir("heartbeat"), ".git", "hooks", "pre-push");
    await writeFile(hook, `#!/usr/bin/env bash\n${shell}\n`, "utf8");
    chmodSync(hook, 0o755);
  }
  const otherPushes = (change: string) =>
    `cd "${dir("other")}" && git pull -q --rebase origin main && ${change} && git add -A && ` +
    `git -c user.name=t -c user.email=t@t commit -q -m raced && git push -q origin main`;

  /**
   * The runner's git for one push: refuses it the way GitHub Actions' git does when the branch moved during the push,
   * with the refusal and its reason on separate lines, and does nothing; every other command and every later push is
   * the real git's.
   */
  async function runnerRefusesFirstPush(): Promise<string> {
    const bin = join(root, "bin");
    await mkdir(bin, { recursive: true });
    const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const shim = join(bin, "git");
    await writeFile(
      shim,
      `#!/usr/bin/env bash
if [ "$1" = push ] && [ ! -e "${root}/refused" ]; then
  touch "${root}/refused"
  echo "remote: error: cannot lock ref 'refs/heads/main': is at 6e1f5a2 but expected 0b3c9d1" >&2
  echo "To https://github.com/owner/data" >&2
  echo " ! [remote rejected] HEAD -> main (incorrect old value provided)" >&2
  echo "error: failed to push some refs to 'https://github.com/owner/data'" >&2
  exit 1
fi
exec "${real}" "$@"
`,
      "utf8",
    );
    chmodSync(shim, 0o755);
    return `${bin}:${process.env.PATH ?? ""}`;
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "finance-agent-commit-"));
    bare = join(root, "remote.git");
    execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", bare]);
    execFileSync("git", ["clone", "--quiet", bare, dir("seed")], { stdio: "ignore" });
    git(dir("seed"), "checkout", "--quiet", "-b", "main");
    await put("seed", "data/state/portfolio.json", "prices v0\n");
    await put("seed", "data/portfolio.md", "view v0\n");
    await put("seed", "data/logs/a.md", "log\n");
    git(dir("seed"), "add", "-A");
    git(dir("seed"), "commit", "--quiet", "-m", "start");
    git(dir("seed"), "push", "--quiet", "origin", "main");
    for (const name of ["heartbeat", "other"])
      execFileSync("git", ["clone", "--quiet", bare, dir(name)], { stdio: "ignore" });
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  /** What a heartbeat writes: its log and the price refresh of the store and its view. */
  const heartbeat = () =>
    patchOf("heartbeat", async () => {
      await put("heartbeat", "data/logs/b.md", "heartbeat log\n");
      await put("heartbeat", "data/state/portfolio.json", "prices v1\n");
      await put("heartbeat", "data/portfolio.md", "view v1\n");
    });

  it("commits the patch whole when nobody committed state meanwhile", async () => {
    const result = commit(await heartbeat());
    assert.equal(result.status, 0, result.stderr);
    assert.equal(onRemote("data/state/portfolio.json"), "prices v1\n");
    assert.equal(onRemote("data/portfolio.md"), "view v1\n");
    assert.equal(onRemote("data/logs/b.md"), "heartbeat log\n");
  });

  it("drops its changes to the state, and commits the rest, when another run committed state meanwhile", async () => {
    const patch = await heartbeat();
    await put("other", "data/portfolio.md", "view after ingest\n"); // an ingest applied a batch after the checkout
    await otherCommits("data/state/portfolio.json", "after ingest\n", "ingest");

    const result = commit(patch);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /::warning::The state changed in origin\/main since this run started/);
    assert.equal(onRemote("data/state/portfolio.json"), "after ingest\n", "the ingest's state stands, untouched");
    assert.equal(onRemote("data/portfolio.md"), "view after ingest\n");
    assert.equal(onRemote("data/logs/b.md"), "heartbeat log\n", "the logs of the run are still committed");
  });

  it("merges the patch over logs another run moved meanwhile, the state untouched", async () => {
    const patch = await heartbeat();
    await otherCommits("data/logs/c.md", "another log\n");

    const result = commit(patch);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /::warning::/);
    assert.equal(onRemote("data/state/portfolio.json"), "prices v1\n");
    assert.equal(onRemote("data/logs/c.md"), "another log\n");
  });

  it("retries a push that loses the race from the remote's new head, dropping the state it now finds moved", async () => {
    const patch = await heartbeat();
    await raceBeforePush(
      `if [ ! -e "${root}/raced" ]; then touch "${root}/raced"; ${otherPushes("echo raced > data/state/portfolio.json")}; fi`,
    );

    const result = commit(patch);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Attempt 1 of 3 lost the race/);
    assert.equal(onRemote("data/state/portfolio.json"), "raced\n", "the run that won the race keeps its state");
    assert.equal(onRemote("data/logs/b.md"), "heartbeat log\n");
  });

  it("retries a push the runner's git refuses with the reason on another line (the lost race is classified whole)", async () => {
    const patch = await heartbeat();
    const result = commit(patch, { PATH: await runnerRefusesFirstPush() });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Attempt 1 of 3 lost the race/);
    assert.equal(onRemote("data/logs/b.md"), "heartbeat log\n");
  });

  it("does not retry a push refused for another reason: it fails with git's message", async () => {
    const patch = await heartbeat();
    await raceBeforePush("echo '! [remote rejected] HEAD -> main (protected branch hook declined)' >&2; exit 1");
    const result = commit(patch);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /lost the race/);
  });

  it("after a lost race, files the patch created outside the given paths do not make the retry fail", async () => {
    const patch = await patchOf("heartbeat", async () => {
      await put("heartbeat", "data/logs/b.md", "heartbeat log\n");
      await put("heartbeat", "data/other/new.md", "outside, new\n");
    });
    const result = commit(patch, { PATH: await runnerRefusesFirstPush() });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Attempt 1 of 3 lost the race/);
    assert.equal(onRemote("data/logs/b.md"), "heartbeat log\n");
    assert.throws(() => onRemote("data/other/new.md"));
  });

  it("a lost race touches only what the run changed: other files of the checkout stay as they were", async () => {
    await put("heartbeat", "scratch/untracked.txt", "made by an earlier step\n");
    await put("heartbeat", "keep.md", "modified by an earlier step\n");
    git(dir("heartbeat"), "add", "keep.md");
    const patch = await heartbeat();
    const result = commit(patch, { PATH: await runnerRefusesFirstPush() });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Attempt 1 of 3 lost the race/);
    assert.ok(existsSync(join(dir("heartbeat"), "scratch", "untracked.txt")), "an untracked file is not cleaned");
    assert.equal(await readFile(join(dir("heartbeat"), "keep.md"), "utf8"), "modified by an earlier step\n");
  });

  it("merges the lines two runs appended to logs/decisions.jsonl when the data repository says merge=union", async () => {
    await put("seed", ".gitattributes", "data/logs/decisions.jsonl merge=union\n");
    await put("seed", "data/logs/decisions.jsonl", '{"id":0}\n');
    git(dir("seed"), "add", "-A");
    git(dir("seed"), "commit", "--quiet", "-m", "attributes");
    git(dir("seed"), "push", "--quiet", "origin", "main");
    for (const name of ["heartbeat", "other"]) git(dir(name), "pull", "--quiet");
    const patch = await patchOf("heartbeat", () =>
      put("heartbeat", "data/logs/decisions.jsonl", '{"id":0}\n{"id":"heartbeat"}\n'),
    );
    await otherCommits("data/logs/decisions.jsonl", '{"id":0}\n{"id":"ingest"}\n', "ingest");

    const result = commit(patch);
    assert.equal(result.status, 0, result.stderr);
    const lines = onRemote("data/logs/decisions.jsonl").trim().split("\n").sort();
    assert.deepEqual(lines, ['{"id":"heartbeat"}', '{"id":"ingest"}', '{"id":0}']);
  });

  it("without merge=union the same two appends conflict: the run fails loudly and commits nothing", async () => {
    await put("seed", "data/logs/decisions.jsonl", '{"id":0}\n');
    git(dir("seed"), "add", "-A");
    git(dir("seed"), "commit", "--quiet", "-m", "log");
    git(dir("seed"), "push", "--quiet", "origin", "main");
    for (const name of ["heartbeat", "other"]) git(dir(name), "pull", "--quiet");
    const patch = await patchOf("heartbeat", () =>
      put("heartbeat", "data/logs/decisions.jsonl", '{"id":0}\n{"id":"heartbeat"}\n'),
    );
    await otherCommits("data/logs/decisions.jsonl", '{"id":0}\n{"id":"ingest"}\n', "ingest");

    const result = commit(patch);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /::error::The run's changes do not apply/);
    assert.equal(onRemote("data/logs/decisions.jsonl"), '{"id":0}\n{"id":"ingest"}\n');
  });

  it("fails, committing nothing, when the push keeps losing", async () => {
    const patch = await heartbeat();
    await raceBeforePush(otherPushes("date +%s%N >> data/logs/c.md"));
    const result = commit(patch);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /::error::The push lost the race 3 times/);
    assert.throws(() => onRemote("data/logs/b.md"));
  });

  it("without state-paths a state that moved is the merge conflict the action always had", async () => {
    const patch = await heartbeat();
    await otherCommits("data/state/portfolio.json", "after ingest\n", "ingest");
    assert.equal(commit(patch, { STATE_PATHS: "" }).status, 1);
  });

  it("commits the paths the run wrote and leaves out those it never created (no store before the first ingest)", async () => {
    git(dir("seed"), "rm", "-q", "-r", "data/state");
    git(dir("seed"), "commit", "--quiet", "-m", "no store yet");
    git(dir("seed"), "push", "--quiet", "origin", "main");
    git(dir("heartbeat"), "pull", "--quiet");
    const patch = await patchOf("heartbeat", () => put("heartbeat", "data/logs/b.md", "heartbeat log\n"));
    const result = commit(patch);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(onRemote("data/logs/b.md"), "heartbeat log\n");
  });

  it("commits only the given paths, even when the patch touches a file outside them", async () => {
    const patch = await patchOf("heartbeat", async () => {
      await put("heartbeat", "data/logs/b.md", "heartbeat log\n");
      await put("heartbeat", "data/other/new.md", "outside, new\n");
      await put("heartbeat", "data/notes.md", "outside, new too\n");
    });
    const result = commit(patch);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(onRemote("data/logs/b.md"), "heartbeat log\n");
    assert.throws(() => onRemote("data/other/new.md"));
    assert.throws(() => onRemote("data/notes.md"));
  });

  it("an empty patch commits nothing", async () => {
    const patch = join(root, "empty.patch");
    await writeFile(patch, "", "utf8");
    const result = commit(patch);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /nothing to commit/);
    assert.equal(await readFile(join(dir("heartbeat"), "data", "logs", "a.md"), "utf8"), "log\n");
  });
});
