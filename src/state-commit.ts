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
import { execFile } from "node:child_process";
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

/** What `GitStateRemote` runs git with; a test gives its own. */
export type Git = (args: readonly string[]) => Promise<string>;

export interface GitStateRemoteOptions {
  /** A folder of the checkout of the data repository; the paths are relative to it. */
  dir: string;
  remote: string;
  branch: string;
  /** What the engine writes and the commit may hold: `state`, `inbox`, `portfolio.md`, `logs`. */
  paths: readonly string[];
  git?: Git;
}

/** Commit identity of the engine's own commits, the one the `commit-changes` action uses. */
const IDENTITY = ["-c", "user.name=finance-agent[bot]", "-c", "user.email=finance-agent@users.noreply.github.com"];

/**
 * True for the refusal of a push because the remote moved: it has commits the local branch lacks, or its branch moved
 * between the push's start and its update (`cannot lock ref`). Both are the lost race.
 */
export const isLostRace = (message: string): boolean =>
  /\[(remote )?rejected\]/.test(message) &&
  /(non-fast-forward|fetch first|stale info|failed to update ref|cannot lock ref)/.test(message);

/**
 * The remote as a git remote. It is for a CI checkout: it moves the checkout to the remote's last commit (a hard
 * reset, and a clean of the state paths), so it refuses to start over changes it did not make.
 */
export class GitStateRemote implements StateRemote {
  private readonly git: Git;

  constructor(private readonly options: GitStateRemoteOptions) {
    this.git =
      options.git ??
      (async (args) => (await run("git", ["-C", options.dir, ...args], { maxBuffer: 16 * 1024 * 1024 })).stdout);
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
    const staged = await this.git(["diff", "--cached", "--name-only", "-z", "--", ...this.options.paths]);
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
    await this.git(["fetch", "--quiet", this.options.remote, this.options.branch]);
    await this.git(["reset", "--quiet", "--hard", this.ref]);
    await this.git(["clean", "--quiet", "-fd", "--", ...this.options.paths]);
  }

  async publish(message: string): Promise<"published" | "nothing" | "lost"> {
    // Only what changed is added: a path the run never created (no `logs/` yet) is not a pathspec git can name.
    const changed = await this.changed();
    if (changed.length === 0) return "nothing";
    await this.git(["add", "-A", "--", ...changed]);
    await this.git([...IDENTITY, "commit", "--quiet", "-m", message]);
    try {
      await this.git(["push", "--quiet", this.options.remote, `HEAD:${this.options.branch}`]);
      return "published";
    } catch (err) {
      const text = `${(err as { stderr?: string }).stderr ?? ""}${err instanceof Error ? err.message : ""}`;
      if (isLostRace(text)) return "lost";
      throw err; // a network or permission failure is transient, never a lost race
    }
  }
}

/** The remote the environment asks for (`STATE_COMMIT=git`), or `null`: the work then leaves its files in place. */
export function stateRemoteFromConfig(
  config: { mode: "none" | "git"; remote(): string; branch(): string },
  dir: string,
): GitStateRemote | null {
  if (config.mode !== "git") return null;
  return new GitStateRemote({
    dir,
    remote: config.remote(),
    branch: config.branch(),
    paths: ["state", "inbox", "portfolio.md", "logs"],
  });
}
