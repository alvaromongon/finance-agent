// The compare-and-swap that serializes every write of the engine's state (ADR-0018, #134, spec #124).
//
// The state is committed to the data repository, and two runs (a scheduled one, a manual one, one started by a push to
// `inbox/`, `decision:record`) can write it at the same time. A write is therefore a compare-and-swap: a run reads
// the remote's last commit, does its work over it, and publishes the result as a commit on top of exactly that commit.
// If the remote moved meanwhile the publish is refused ("lost the race"): the run throws its work away, reads the
// state as it is now and does the work again, a bounded number of times. A run that still loses leaves its work for
// the next run; that is a delay, never a rejection of what the owner asked (spec #124 > Decisions).
//
// Nothing here takes a lock, and the heartbeat never calls it: stop detection reads the last commit of the checkout
// it started with, so a run that keeps losing delays the state and never a stop check (ADR-0015).
import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** What a state write needs from the place the state is committed to. Fakes of it are the tests' remote. */
export interface StateRemote {
  /**
   * Starts a write: refuses a working copy that already has changes under the state paths (they would be lost) and
   * brings it to the remote's last commit.
   */
  begin(): Promise<void>;
  /**
   * Commits what the work changed under the state paths on top of the last commit `begin` or `refresh` read and
   * publishes it. `nothing`: the work changed nothing. `lost`: the remote moved, nothing was published.
   */
  publish(message: string): Promise<"published" | "nothing" | "lost">;
  /** Throws away what the work changed and brings the working copy to the remote's last commit again. */
  refresh(): Promise<void>;
}

export type StateWrite<T> =
  { status: "committed" | "unchanged"; attempts: number; result: T } | { status: "deferred"; attempts: number };

/**
 * Runs `work` over the remote's last state and commits what it wrote, as a compare-and-swap: when the remote moved in
 * between, the work is done again over the new state, at most `attempts` times in all. The work reads the state
 * anew each time, so a retried batch is judged against the state it now meets and its result is that of a fresh run.
 * A failure of the work or of the remote that is not a lost race is not retried: it throws, nothing is published, and
 * the next run starts from the remote.
 */
export async function commitState<T>(
  remote: StateRemote,
  work: () => Promise<T>,
  { attempts, message }: { attempts: number; message: string },
): Promise<StateWrite<T>> {
  await remote.begin();
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await work();
    const outcome = await remote.publish(message);
    if (outcome === "published") return { status: "committed", attempts: attempt, result };
    if (outcome === "nothing") return { status: "unchanged", attempts: attempt, result };
    await remote.refresh();
  }
  return { status: "deferred", attempts };
}

/**
 * What `GitStateRemote` runs git with; a test gives its own. `env` is what is added to the environment of that one git
 * process: the credential, for the two commands that talk to the remote.
 */
export type Git = (args: readonly string[], env?: NodeJS.ProcessEnv) => Promise<string>;

/** How the commands that talk to the remote (`fetch`, `push`) sign in; of the processes the engine spawns, only those get it. */
export interface RemoteAuth {
  /** The git server, e.g. `https://github.com`. */
  serverUrl: string;
  token: string;
}

export interface GitStateRemoteOptions {
  /** A folder of the checkout of the data repository; the paths are relative to it. */
  dir: string;
  remote: string;
  branch: string;
  /** What the engine writes and the commit may hold: `state`, `inbox`, `portfolio.md`, `logs`. */
  paths: readonly string[];
  git?: Git;
  auth?: RemoteAuth;
}

/** Commit identity of the engine's own commits, the one the `commit-changes` action uses. */
const IDENTITY = ["-c", "user.name=finance-agent[bot]", "-c", "user.email=finance-agent@users.noreply.github.com"];

/** The one definition of a lost race: a script, because the `commit-changes` action (bash) needs the same rule. */
const LOST_RACE_RULE = join(import.meta.dirname, "..", ".github", "actions", "commit-changes", "is-lost-race.sh");

/**
 * True for the refusal of a push because the remote moved: it has commits the local branch lacks, or its branch moved
 * between the push's start and its update (`cannot lock ref`). Both are the lost race. `output` is the whole output of
 * the push, which spreads the refusal and its reason over several lines. The rule is `is-lost-race.sh`, shared with the
 * `commit-changes` action: it needs bash, as the CI checkout this runs on has.
 */
export const isLostRace = (output: string): Promise<boolean> =>
  new Promise((resolve, reject) => {
    const rule = spawn("bash", [LOST_RACE_RULE], { stdio: ["pipe", "ignore", "ignore"] });
    rule.on("error", reject);
    rule.on("close", (code) => resolve(code === 0));
    rule.stdin.on("error", () => undefined); // the rule may answer before it has read it all
    rule.stdin.end(output);
  });

/**
 * The remote as a git remote. It is for a CI checkout: it moves the checkout to the remote's last commit and brings
 * the state paths to what is there (nothing outside them is touched), so it refuses to start over changes it did not
 * make under them.
 */
export class GitStateRemote implements StateRemote {
  private readonly git: Git;

  constructor(private readonly options: GitStateRemoteOptions) {
    this.git =
      options.git ??
      (async (args, env) =>
        (
          await run("git", ["-C", options.dir, ...args], {
            maxBuffer: 16 * 1024 * 1024,
            ...(env ? { env: { ...process.env, ...env } } : {}),
          })
        ).stdout);
  }

  /** The credential as git's configuration for one process (`GIT_CONFIG_*`), or nothing when there is none. */
  private get authEnv(): NodeJS.ProcessEnv | undefined {
    const auth = this.options.auth;
    if (auth === undefined) return undefined;
    const basic = Buffer.from(`x-access-token:${auth.token}`).toString("base64");
    return {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `http.${auth.serverUrl}/.extraheader`,
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    };
  }

  private get ref(): string {
    return `${this.options.remote}/${this.options.branch}`;
  }

  /** What changed under the state paths and is not committed (modified, deleted or new), relative to `dir`. */
  private async changed(): Promise<string[]> {
    const listed = await this.git([
      "ls-files",
      "-z",
      "--modified",
      "--deleted",
      "--others",
      "--exclude-standard",
      "--",
      ...this.options.paths,
    ]);
    const staged = await this.git(["diff", "--cached", "--name-only", "--relative", "-z", "--", ...this.options.paths]);
    return [...new Set([...listed.split("\0"), ...staged.split("\0")].filter((name) => name !== ""))];
  }

  async begin(): Promise<void> {
    const dirty = await this.changed();
    if (dirty.length > 0) {
      throw new Error(
        `STATE_COMMIT=git needs a clean checkout of ${this.options.paths.join(", ")}, and it has changes ` +
          `(it moves the checkout to ${this.ref}, which would discard them): ${dirty.join(", ")}`,
      );
    }
    await this.refresh();
  }

  async refresh(): Promise<void> {
    await this.git(["fetch", "--quiet", this.options.remote, this.options.branch], this.authEnv);
    // Only the state paths are brought to the remote's commit: HEAD and the index move, the working tree does not, and
    // what is under the paths is then restored from the commit and cleaned. Nothing else of the checkout is touched
    // (a `reset --hard` would reach the whole repository).
    await this.git(["reset", "--quiet", "--mixed", this.ref]);
    const there = (await this.git(["ls-tree", "--name-only", "-z", this.ref, "--", ...this.options.paths]))
      .split("\0")
      .filter((name) => name !== "");
    if (there.length > 0) await this.git(["checkout", "--quiet", this.ref, "--", ...there]);
    await this.git(["clean", "--quiet", "-fd", "--", ...this.options.paths]);
  }

  async publish(message: string): Promise<"published" | "nothing" | "lost"> {
    // Only what changed is added: a path the run never created (no `logs/` yet) is not a pathspec git can name.
    const changed = await this.changed();
    if (changed.length === 0) return "nothing";
    await this.git(["add", "-A", "--", ...changed]);
    await this.git([...IDENTITY, "commit", "--quiet", "-m", message]);
    try {
      await this.git(["push", "--quiet", this.options.remote, `HEAD:${this.options.branch}`], this.authEnv);
      return "published";
    } catch (err) {
      const text = `${(err as { stderr?: string }).stderr ?? ""}\n${err instanceof Error ? err.message : ""}`;
      if (await isLostRace(text)) return "lost";
      throw err; // a network or permission failure is transient, never a lost race
    }
  }
}

/**
 * The remote the environment asks for (`STATE_COMMIT=git`), or `null`: the work then leaves its files in place. The
 * credential is taken out of the environment here (`takeToken`), so that of the processes the engine spawns, only the
 * `git fetch` and `git push` of this remote get it.
 */
export function stateRemoteFromConfig(
  config: {
    mode: "none" | "git";
    remote(): string;
    branch(): string;
    serverUrl(): string;
    takeToken(): string | undefined;
  },
  dir: string,
): GitStateRemote | null {
  if (config.mode !== "git") return null;
  const token = config.takeToken();
  return new GitStateRemote({
    dir,
    remote: config.remote(),
    branch: config.branch(),
    paths: ["state", "inbox", "portfolio.md", "logs"],
    ...(token ? { auth: { serverUrl: config.serverUrl(), token } } : {}),
  });
}
