/**
 * The compare-and-swap of the state writes (#134, spec #124, ADR-0018): `commitState` over a stand-in remote, the
 * `GitStateRemote` over a real git remote that is a bare repository in a temporary folder (never the real remote),
 * and the list of every writer of the engine's store and how each is serialized.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { config } from "../config.js";
import {
  commitState,
  GitStateRemote,
  isLostRace,
  stateRemoteFromConfig,
  type Git,
  type StateRemote,
} from "../state-commit.js";

/** What the runner's git (GitHub Actions, 2026-11-21) prints when the branch moved during the push. */
const RUNNER_LOST_RACE = [
  "remote: error: cannot lock ref 'refs/heads/main': is at 6e1f5a2 but expected 0b3c9d1",
  "To https://github.com/owner/data",
  " ! [remote rejected] HEAD -> main (incorrect old value provided)",
  "error: failed to push some refs to 'https://github.com/owner/data'",
].join("\n");
const LOST_RACE_RULE = join(import.meta.dirname, "..", "..", ".github", "actions", "commit-changes", "is-lost-race.sh");

/** A remote that answers `outcomes` one publish at a time and counts what is asked of it. */
function scripted(...outcomes: ("published" | "nothing" | "lost")[]) {
  const calls: string[] = [];
  const remote: StateRemote = {
    begin: async () => void calls.push("begin"),
    refresh: async () => void calls.push("refresh"),
    publish: async () => {
      calls.push("publish");
      return outcomes.shift() ?? "lost";
    },
  };
  return { remote, calls };
}

describe("commitState", () => {
  it("reads the remote, does the work and publishes it once when nobody else wrote", async () => {
    const { remote, calls } = scripted("published");
    let works = 0;
    const write = await commitState(remote, async () => ++works, { attempts: 3, message: "m" });
    assert.deepEqual(write, { status: "committed", attempts: 1, result: 1 });
    assert.deepEqual(calls, ["begin", "publish"]);
  });

  it("does the work again over a fresh read after each lost race, and returns the result of the one that won", async () => {
    const { remote, calls } = scripted("lost", "lost", "published");
    let works = 0;
    const write = await commitState(remote, async () => ++works, { attempts: 3, message: "m" });
    assert.deepEqual(write, { status: "committed", attempts: 3, result: 3 });
    assert.deepEqual(calls, ["begin", "publish", "refresh", "publish", "refresh", "publish"]);
  });

  it("is bounded: after the attempts it gives the work up, publishes nothing and says so", async () => {
    const { remote, calls } = scripted("lost", "lost");
    let works = 0;
    const write = await commitState(remote, async () => ++works, { attempts: 2, message: "m" });
    assert.deepEqual(write, { status: "deferred", attempts: 2 });
    assert.equal(works, 2);
    assert.equal(
      calls.at(-1),
      "refresh",
      "the working copy is left at the remote's last commit, not with the lost work",
    );
  });

  it("an attempt that changes nothing is not a commit and is not retried", async () => {
    const { remote } = scripted("nothing");
    assert.deepEqual(await commitState(remote, async () => "x", { attempts: 3, message: "m" }), {
      status: "unchanged",
      attempts: 1,
      result: "x",
    });
  });

  it("a failure of the work is not retried and nothing is published", async () => {
    const { remote, calls } = scripted("published");
    await assert.rejects(
      commitState(
        remote,
        async () => {
          throw new Error("boom");
        },
        { attempts: 3, message: "m" },
      ),
      /boom/,
    );
    assert.deepEqual(calls, ["begin"]);
  });
});

describe("isLostRace", () => {
  it("is a push the remote refused because it has commits the local branch lacks, and nothing else", async () => {
    assert.ok(await isLostRace(" ! [rejected]        HEAD -> main (fetch first)\nerror: failed to push some refs"));
    assert.ok(await isLostRace(" ! [rejected]        HEAD -> main (non-fast-forward)"));
    assert.ok(await isLostRace(" ! [remote rejected] HEAD -> main (stale info)"));
    assert.ok(
      await isLostRace(
        " ! [remote rejected] HEAD -> main (failed to update ref)\nerror: cannot lock ref 'refs/heads/main'",
      ),
    );
    assert.equal(await isLostRace("fatal: unable to access 'https://github.com/x/y/': Could not resolve host"), false);
    assert.equal(await isLostRace(" ! [remote rejected] HEAD -> main (protected branch hook declined)"), false);
    assert.equal(await isLostRace("remote: Permission to x/y.git denied"), false);
  });

  it("classifies the whole output: the runner's git says the refusal and its reason on separate lines", async () => {
    assert.ok(await isLostRace(RUNNER_LOST_RACE));
  });

  it("is the same rule the commit-changes action uses: one definition, in is-lost-race.sh", async () => {
    for (const [output, lost] of [
      [RUNNER_LOST_RACE, true],
      [" ! [rejected]        HEAD -> main (fetch first)", true],
      [" ! [remote rejected] HEAD -> main (protected branch hook declined)", false],
      ["remote: Permission to x/y.git denied", false],
    ] as const) {
      const script = spawnSync("bash", [LOST_RACE_RULE], { input: output, encoding: "utf8" });
      assert.equal(script.status === 0, lost, output);
      assert.equal(await isLostRace(output), lost, output);
    }
  });
});

describe("stateRemoteFromConfig", () => {
  const settings = (mode: "none" | "git") => ({
    mode,
    remote: () => "origin",
    branch: () => "main",
    serverUrl: () => "https://github.com",
    takeToken: () => undefined,
  });
  it("is no remote unless STATE_COMMIT=git", () => {
    assert.equal(stateRemoteFromConfig(settings("none"), "/data"), null);
    assert.ok(stateRemoteFromConfig(settings("git"), "/data") instanceof GitStateRemote);
  });
});

describe("the credential of the state commit", () => {
  const SECRET = "ghs_secret";
  const basic = Buffer.from(`x-access-token:${SECRET}`).toString("base64");

  /** A git that answers nothing and records which commands got which extra environment. */
  function recording() {
    const calls: { command: string; env: NodeJS.ProcessEnv | undefined }[] = [];
    const git: Git = async (args, env) => {
      calls.push({ command: args[0] ?? "", env });
      return args[0] === "ls-files" ? "state/portfolio.json\0" : "";
    };
    return { git, calls };
  }
  const remote = (git: Git) =>
    new GitStateRemote({
      dir: "/data",
      remote: "origin",
      branch: "main",
      paths: ["state"],
      git,
      auth: { serverUrl: "https://github.com", token: SECRET },
    });

  it("signs in the commands that talk to the remote (fetch, push) and no other git command", async () => {
    const { git, calls } = recording();
    const r = remote(git);
    await r.refresh();
    assert.equal(await r.publish("m"), "published");
    const withCredential = calls.filter((call) => call.env !== undefined).map((call) => call.command);
    assert.deepEqual(withCredential, ["fetch", "push"]);
    assert.deepEqual(calls.find((call) => call.command === "fetch")?.env, {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    });
  });

  it("is taken out of the environment when the remote is built, so no other process inherits it", () => {
    process.env.STATE_COMMIT_TOKEN = SECRET;
    try {
      assert.equal(config.stateCommit.takeToken(), SECRET);
      assert.equal(process.env.STATE_COMMIT_TOKEN, undefined);
      assert.equal(config.stateCommit.takeToken(), undefined);
    } finally {
      delete process.env.STATE_COMMIT_TOKEN;
    }
  });
});

describe("GitStateRemote, over a real git remote in a temporary folder", () => {
  let root: string;
  let bare: string;
  const clone = (name: string) => join(root, name);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });

  /** A clone of the remote: the checkout of one run. The data lives in `data/` of the repository. */
  async function checkout(name: string): Promise<string> {
    execFileSync("git", ["clone", "--quiet", bare, clone(name)]);
    return clone(name);
  }
  const remoteOf = (name: string) =>
    new GitStateRemote({
      dir: join(clone(name), "data"),
      remote: "origin",
      branch: "main",
      paths: ["state", "inbox", "portfolio.md", "watchlist.md", "logs"],
    });
  const write = async (name: string, file: string, text: string) => {
    const path = join(clone(name), "data", file);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, text, "utf8");
  };
  const headFile = (file: string) => git(bare, "show", `main:data/${file}`);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "finance-agent-git-"));
    bare = join(root, "remote.git");
    execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", bare]);
    const seed = join(root, "seed");
    execFileSync("git", ["clone", "--quiet", bare, seed], { stdio: "ignore" });
    git(seed, "checkout", "--quiet", "-b", "main");
    await mkdir(join(seed, "data", "state"), { recursive: true });
    await writeFile(join(seed, "data", "state", "portfolio.json"), "v0\n", "utf8");
    await writeFile(join(seed, "data", "portfolio.md"), "view v0\n", "utf8");
    await mkdir(join(seed, "data", "inbox"), { recursive: true });
    await writeFile(join(seed, "data", "inbox", "a.yaml"), "batch\n", "utf8");
    git(seed, "add", "-A");
    git(seed, "commit", "--quiet", "-m", "start");
    git(seed, "push", "--quiet", "origin", "main");
    await checkout("run1");
    await checkout("run2");
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it("publishes what the work changed under the state paths, new files and moves included, and nothing else", async () => {
    const remote = remoteOf("run1");
    await remote.begin();
    await write("run1", "state/portfolio.json", "v1\n");
    await mkdir(join(clone("run1"), "data", "inbox", "applied"), { recursive: true });
    await rm(join(clone("run1"), "data", "inbox", "a.yaml"));
    await write("run1", "inbox/applied/a.yaml", "batch\n");
    await write("run1", "logs/decisions.jsonl", "{}\n"); // logs/ did not exist
    await write("run1", "elsewhere.txt", "not state\n");

    assert.equal(await remote.publish("chore(state): x"), "published");
    assert.equal(headFile("state/portfolio.json"), "v1\n");
    assert.equal(headFile("logs/decisions.jsonl"), "{}\n");
    assert.equal(headFile("inbox/applied/a.yaml"), "batch\n");
    assert.throws(() => headFile("inbox/a.yaml"), /exists on disk, but not in|does not exist/);
    assert.throws(() => headFile("elsewhere.txt"));
    assert.match(git(bare, "log", "-1", "--format=%an %s", "main"), /finance-agent\[bot\] chore\(state\): x/);
  });

  it("publishes nothing when the work changed nothing", async () => {
    const remote = remoteOf("run1");
    await remote.begin();
    assert.equal(await remote.publish("m"), "nothing");
  });

  it("loses the race when another run committed first, and the refresh brings the new state without the lost work", async () => {
    const [first, second] = [remoteOf("run1"), remoteOf("run2")];
    await first.begin();
    await second.begin();
    await write("run1", "state/portfolio.json", "from run1\n");
    await write("run2", "state/portfolio.json", "from run2\n");
    await write("run2", "logs/lost.md", "lost\n");

    assert.equal(await first.publish("run1"), "published");
    assert.equal(await second.publish("run2"), "lost");
    assert.equal(headFile("state/portfolio.json"), "from run1\n", "the winner's write stands");

    await second.refresh();
    assert.equal(await readFile(join(clone("run2"), "data", "state", "portfolio.json"), "utf8"), "from run1\n");
    assert.deepEqual(await readdir(join(clone("run2"), "data")).then((names) => names.sort()), [
      "inbox",
      "portfolio.md",
      "state",
    ]);
    await write("run2", "state/portfolio.json", "from run1, then run2\n");
    assert.equal(await second.publish("run2 again"), "published");
    assert.equal(headFile("state/portfolio.json"), "from run1, then run2\n");
  });

  it("brings only the state paths to the remote's commit: what is outside them is left as it is", async () => {
    const [first, second] = [remoteOf("run1"), remoteOf("run2")];
    await first.begin();
    await second.begin();
    await write("run2", "state/portfolio.json", "lost work\n");
    await write("run2", "scratch/untracked.txt", "created by the run, outside the state paths\n");
    await write("run2", "notes.md", "modified outside the state paths\n");
    git(clone("run2"), "add", "data/notes.md"); // staged outside the state paths too
    await write("run1", "state/portfolio.json", "from run1\n");
    assert.equal(await first.publish("run1"), "published");
    assert.equal(await second.publish("run2"), "lost");

    await second.refresh();
    const data = (file: string) => readFile(join(clone("run2"), "data", file), "utf8");
    assert.equal(await data("state/portfolio.json"), "from run1\n");
    assert.equal(await data("scratch/untracked.txt"), "created by the run, outside the state paths\n");
    assert.equal(await data("notes.md"), "modified outside the state paths\n");
  });

  it("starts from the remote's last commit, even for a checkout that is behind", async () => {
    const [first, second] = [remoteOf("run1"), remoteOf("run2")];
    await first.begin();
    await write("run1", "state/portfolio.json", "newer\n");
    await first.publish("m");
    await second.begin();
    assert.equal(await readFile(join(clone("run2"), "data", "state", "portfolio.json"), "utf8"), "newer\n");
  });

  it("refuses a checkout that already has changes under the state paths: it would discard them", async () => {
    await write("run1", "state/portfolio.json", "by hand\n");
    await assert.rejects(remoteOf("run1").begin(), /needs a clean checkout.*state\/portfolio\.json/);
    assert.equal(await readFile(join(clone("run1"), "data", "state", "portfolio.json"), "utf8"), "by hand\n");
  });

  it("a push that fails for any other reason is a failure, never a lost race", async () => {
    const remote = remoteOf("run1");
    await remote.begin();
    await write("run1", "state/portfolio.json", "v1\n");
    git(clone("run1"), "remote", "set-url", "origin", join(root, "gone.git"));
    await assert.rejects(remote.publish("m"));
  });
});

describe("every writer of the engine's store", () => {
  /**
   * The modules that write the store (call `saveStore`, `changeCash` or `seedStore`) and how each
   * one's write is serialized with the others (#134). The heartbeat and the briefing are not among them (#133): they
   * record the last prices as telemetry (`recordPrices`) and never write the store. A new writer fails this test until it is listed here with its
   * answer.
   */
  const WRITERS: Record<string, string> = {
    "inbox.ts": "compare-and-swap: `ingestCommitted` (`inbox:ingest`)",
    "decision.ts":
      "compare-and-swap: `recordCommitted` in `decision-record.ts` (`decision:record`: deposits, withdrawals, conversions)",
    "state-repair.ts": "compare-and-swap: `repairCommitted` (`state:repair`, #139)",
    "demo.ts": "a throwaway copy of the example brain in a temporary folder: no remote",
  };

  it("are exactly these, and each says how its write is serialized", () => {
    // The whole source tree, not only the top folder: a writer in a subfolder (`utils/`, `providers/`) counts as well.
    const src = join(import.meta.dirname, "..");
    const found: string[] = [];
    for (const entry of readdirSync(src, { recursive: true, encoding: "utf8" }).map((name) =>
      name.split(sep).join("/"),
    )) {
      if (!entry.endsWith(".ts") || entry.startsWith("tests/") || entry === "portfolio-store.ts") continue;
      const text = readFileSync(join(src, entry), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      if (/\b(saveStore|changeCash|seedStore)\(/.test(text)) found.push(entry);
    }
    assert.deepEqual(found.sort(), Object.keys(WRITERS).sort());
  });

  it("finds a writer in a subfolder: the scan is recursive", () => {
    const src = join(import.meta.dirname, "..");
    const listed = readdirSync(src, { recursive: true, encoding: "utf8" }).map((name) => name.split(sep).join("/"));
    assert.ok(listed.includes("utils/printable.ts"), "the scan reaches the subfolders of src/");
  });
});
