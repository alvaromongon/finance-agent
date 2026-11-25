// A stand-in for the remote the state is committed to (#134): a folder holds "the remote's last commit" and a counter
// says which one it is. A run reads it into its working folder, publishes by copying the folder back, and loses the
// race when the counter moved since it read. `competitor` is another run's commit, made when the test says. Never the
// real remote.
import { cp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { StateRemote } from "../../state-commit.js";

async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      out[path.slice(dir.length)] = await readFile(path, "utf8");
    }
  }
  return out;
}

async function empty(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const name of await readdir(dir)) await rm(join(dir, name), { recursive: true, force: true });
}

export class DirectoryStateRemote implements StateRemote {
  /** Which commit the remote is at. */
  version = 0;
  /** The messages of the commits published, in order. */
  readonly published: string[] = [];
  /** What the working folder was read from. */
  private seen = 0;
  /** Another run's commit, made just before the next publish of this one (one entry per publish). */
  private readonly races: ((remoteDir: string) => Promise<void>)[] = [];
  /** How many times `begin` and `refresh` read the remote. */
  reads = 0;

  constructor(
    readonly workDir: string,
    readonly remoteDir: string,
  ) {}

  /** The next publish finds that another run committed first: `edit` changes the remote as that run did. */
  raceOnce(edit: (remoteDir: string) => Promise<void>): void {
    this.races.push(edit);
  }

  /** Another run's commit, now. */
  async commit(edit: (remoteDir: string) => Promise<void>): Promise<void> {
    await edit(this.remoteDir);
    this.version++;
  }

  async begin(): Promise<void> {
    await this.refresh();
  }

  async refresh(): Promise<void> {
    this.reads++;
    await empty(this.workDir);
    await cp(this.remoteDir, this.workDir, { recursive: true });
    this.seen = this.version;
  }

  async publish(message: string): Promise<"published" | "nothing" | "lost"> {
    const race = this.races.shift();
    if (race !== undefined) await this.commit(race);
    if (this.seen !== this.version) return "lost";
    const [mine, theirs] = [await tree(this.workDir), await tree(this.remoteDir)];
    if (JSON.stringify(mine) === JSON.stringify(theirs)) return "nothing";
    await empty(this.remoteDir);
    await cp(this.workDir, this.remoteDir, { recursive: true });
    this.version++;
    this.seen = this.version;
    this.published.push(message);
    return "published";
  }

  /** What the remote holds, file by file. */
  snapshot(): Promise<Record<string, string>> {
    return tree(this.remoteDir);
  }
}
