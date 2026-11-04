// The inbox folder as the storage layer reads it (#131, docs/input-format.md › `inbox/`): the YAML files a
// person, an AI or a routine dropped in `inbox/` of the data directory, as text, in name order. It only reads:
// moving a file to `applied/` or `rejected/` is `inbox:ingest` (#132).
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";
import { readTextFile } from "./utils/fs-text.js";
import type { InboxFile } from "./utils/inbox-check.js";

const inboxDir = () => join(config.paths.vaultProjectDir, "inbox");

/** The `.yaml` and `.yml` files of `inbox/`, sorted by name; no folder is an empty inbox. Other files are not batches. */
export async function readInbox(): Promise<InboxFile[]> {
  const entries = await readdir(inboxDir(), { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return [];
    throw err;
  });
  const names = entries
    .filter((e) => e.isFile() && /\.ya?ml$/i.test(e.name))
    .map((e) => e.name)
    .sort();
  return Promise.all(names.map(async (name) => ({ name, text: await readTextFile(join(inboxDir(), name)) })));
}
