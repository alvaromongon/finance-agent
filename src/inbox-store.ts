// The inbox folder as the storage layer reads and moves it (#131, #132, docs/input-format.md › `inbox/`): the YAML
// files a person, an AI or a routine dropped in `inbox/` of the data directory, as text, in name order, and the
// move of a file to `inbox/applied/` or `inbox/rejected/` once `inbox:ingest` is done with it.
//
// The owner's folder is not trusted: a symbolic link is never followed (a batch must be a regular file, opened with
// `O_NOFOLLOW` and checked on the handle it is read from, so nothing can change between the check and the read), the
// `inbox/` folder itself and the two destination folders must be real folders, and a name that came from the folder is
// never joined into a path before it is checked to be a plain file name.
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, unlink, writeFile } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import { config } from "./config.js";
import { normalizeEol } from "./utils/eol.js";
import { printable } from "./utils/printable.js";
import type { InboxFile } from "./utils/inbox-check.js";

const inboxDir = () => join(config.paths.vaultProjectDir, "inbox");

/** The words for a batch file that cannot be read as a regular file. */
const notRegular = (name: string, what: string, folder = "inbox"): string =>
  `${folder}/${printable(name)} is ${what}: a batch must be a regular file, so it is not read`;

/**
 * The `.yaml` and `.yml` files of `inbox/`, sorted by name; no folder is an empty inbox. A file that is not a regular
 * file (a symbolic link, above all) is in the list too, with the reason it was not read, so it is reported and never
 * skipped. Other files are not batches. Throws if `inbox/` itself is a symbolic link or not a folder.
 */
export async function readInbox(): Promise<InboxFile[]> {
  const dir = inboxDir();
  const folder = await lstat(dir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (folder === null) return [];
  if (folder.isSymbolicLink())
    throw new Error("inbox/ is a symbolic link: the inbox must be a real folder, so it is not read");
  if (!folder.isDirectory()) throw new Error("inbox is not a folder");
  const names = (await readdir(dir, { withFileTypes: true }))
    .filter((e) => /\.ya?ml$/i.test(e.name))
    .map((e) => e.name)
    .sort();
  return Promise.all(names.map((name) => readBatch(dir, name)));
}

/**
 * The batches in `inbox/<folder>/` (`rejected` or `applied`): the regular `.yaml` and `.yml` files there, with their text,
 * sorted by name; no folder is none. A `.yaml` that cannot be read as a batch (a link, a hidden file, not a regular
 * file) is not one the engine moved there: it is returned in `unread` with the reason, to be named and never followed.
 * Throws if `inbox/` or the folder is a link or not a folder.
 */
async function readMoved(folder: "rejected" | "applied"): Promise<{
  batches: { name: string; text: string }[];
  unread: { name: string; problem: string }[];
}> {
  const dir = inboxDir();
  for (const [path, label] of [
    [dir, "inbox"],
    [join(dir, folder), `inbox/${folder}`],
  ] as const) {
    const found = await lstat(path).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    if (found === null) return { batches: [], unread: [] };
    if (found.isSymbolicLink() || !found.isDirectory()) {
      throw new Error(`${label} is not a real folder (a link or a file): the ${folder} batches are not read`);
    }
  }
  const moved = join(dir, folder);
  const names = (await readdir(moved, { withFileTypes: true }))
    .filter((e) => /\.ya?ml$/i.test(e.name))
    .map((e) => e.name)
    .sort();
  const read = await Promise.all(names.map((name) => readBatch(moved, name, `inbox/${folder}`)));
  return {
    batches: read.flatMap((file) => ("text" in file ? [{ name: file.name, text: file.text }] : [])),
    unread: read.flatMap((file) => ("problem" in file ? [{ name: file.name, problem: file.problem }] : [])),
  };
}

/** The batches `inbox:ingest` rejected and moved to `inbox/rejected/` (#152). */
export const readRejected = (): ReturnType<typeof readMoved> => readMoved("rejected");

/** The batches `inbox:ingest` applied and moved to `inbox/applied/`: the audit trail a correction and the repair replay (#139). */
export const readApplied = (): ReturnType<typeof readMoved> => readMoved("applied");

/** One batch file: a hidden file is reported, never read; the rest opened without following a link and read from the handle that was checked. */
async function readBatch(dir: string, name: string, folder = "inbox"): Promise<InboxFile> {
  // `moveBatch` refuses such a name, so the file could never be moved: it is reported and left where it is
  // (macOS writes `._name.yaml` beside a file copied to a foreign volume).
  if (name.startsWith(".")) return { name, problem: notRegular(name, "a hidden file", folder) };
  let handle;
  try {
    // O_NONBLOCK: opening a named pipe would otherwise wait for a writer that never comes.
    handle = await open(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ELOOP (Linux) or EMLINK (macOS): the last part of the path is a symbolic link.
    if (code === "ELOOP" || code === "EMLINK") return { name, problem: notRegular(name, "a symbolic link", folder) };
    throw err;
  }
  try {
    if (!(await handle.stat()).isFile()) return { name, problem: notRegular(name, "not a regular file", folder) };
    return { name, text: normalizeEol(await handle.readFile("utf8")) };
  } finally {
    await handle.close();
  }
}

/** `a-2.yaml` for `a.yaml` and 2: the counter goes before the extension. */
const numbered = (name: string, n: number): string => {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? `${name}-${n}` : `${name.slice(0, dot)}-${n}${name.slice(dot)}`;
};

/**
 * Moves the batch file `name` of `inbox/` to `inbox/<folder>/`, never over a file that is there (a name taken gets a
 * counter), and returns where it went. For a rejected one `errors` are written beside it, one per line, in
 * `<file>.errors.txt`: the engine never edits the batch itself. Refuses a name that is not a plain file name, a
 * destination folder that is a link or not a folder, and a file that has stopped being a regular file.
 */
export async function moveBatch(
  name: string,
  folder: "applied" | "rejected",
  errors: readonly string[] = [],
): Promise<string> {
  if (name === "" || name !== basename(name) || name.includes(sep) || name.startsWith(".")) {
    throw new Error(`${printable(name)} is not a plain file name: not moved`);
  }
  const dir = inboxDir();
  const source = join(dir, name);
  if (!(await lstat(source)).isFile()) throw new Error(notRegular(name, "not a regular file"));
  const destinationDir = join(dir, folder);
  const existing = await lstat(destinationDir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (existing === null) await mkdir(destinationDir);
  else if (existing.isSymbolicLink() || !existing.isDirectory()) {
    throw new Error(`inbox/${folder} is not a real folder (a link or a file): ${printable(name)} is not moved`);
  }
  for (let n = 1; ; n++) {
    const target = join(destinationDir, n === 1 ? name : numbered(name, n));
    if (!target.startsWith(`${destinationDir}${sep}`))
      throw new Error(`${printable(name)} would leave inbox/${folder}`);
    // The errors file of a name taken by an earlier one (left there by hand, or by a run that stopped) is not written
    // over, and a name is not reused with it: the next counter is tried.
    if (
      errors.length > 0 &&
      (await lstat(`${target}.errors.txt`).then(
        () => true,
        () => false,
      ))
    )
      continue;
    try {
      // A hard link never replaces what is there; the source goes once the file is in place.
      await link(source, target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
    await unlink(source);
    if (errors.length > 0)
      await writeFile(`${target}.errors.txt`, `${errors.join("\n")}\n`, { encoding: "utf8", flag: "wx" });
    return target;
  }
}

/**
 * Drops a new batch in `inbox/` (the engine writing the inbox, #136): `<stem>.yaml`, or `<stem>-2.yaml`... when the
 * name is taken, never over a file that is there (`wx`: a name that is a symbolic link counts as taken, and is not
 * followed). Creates `inbox/` if it does not exist; refuses one that is a symbolic link or not a folder. Returns the
 * file name.
 */
export async function dropBatch(stem: string, text: string): Promise<string> {
  if (stem === "" || stem !== basename(stem) || stem.includes(sep) || stem.startsWith(".")) {
    throw new Error(`${printable(stem)} is not a plain file name: not written`);
  }
  const dir = inboxDir();
  const folder = await lstat(dir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (folder === null) await mkdir(dir, { recursive: true });
  else if (folder.isSymbolicLink() || !folder.isDirectory()) {
    throw new Error("inbox is not a real folder (a link or a file): nothing is written there");
  }
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${stem}.yaml` : `${stem}-${n}.yaml`;
    try {
      await writeFile(join(dir, name), text, { encoding: "utf8", flag: "wx" });
      return name;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
}

/**
 * Drops a batch in `inbox/` as the owner would (#140): a flow of the engine that proposes a change of the watchlist writes
 * the batch and leaves applying it to `inbox:ingest`. A file of that name already in `inbox/` is left as it is (`exists`):
 * a flow that runs again before the ingest proposes the same change once. Refuses a name that is not a plain file name
 * and an `inbox/` that is a link or not a folder; creates the folder when there is none.
 */
export async function dropBatchOnce(name: string, text: string): Promise<"written" | "exists"> {
  if (name === "" || name !== basename(name) || name.includes(sep) || name.startsWith(".") || !/\.ya?ml$/i.test(name)) {
    throw new Error(`${printable(name)} is not a plain batch file name (.yaml or .yml): not written`);
  }
  const dir = inboxDir();
  const folder = await lstat(dir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (folder === null) await mkdir(dir, { recursive: true });
  else if (folder.isSymbolicLink() || !folder.isDirectory()) {
    throw new Error(`inbox/ is not a real folder (a link or a file): ${printable(name)} is not written`);
  }
  try {
    await writeFile(join(dir, name), text, { encoding: "utf8", flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return "exists";
    throw err;
  }
  return "written";
}
