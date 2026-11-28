/**
 * Nothing the examples commit bypasses the compare-and-swap of the state commit (#134): the routine prompts commit
 * no state, and a workflow that names the view of the state (`portfolio.md`) guards it with `state-paths` (#193).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const EXAMPLES = join(import.meta.dirname, "..", "..", "examples");
/** Files and folders that are the engine's state or a view of it: only the engine's own state commit writes them. */
const STATE = /\b(?:portfolio\.md|watchlist\.md|state\/(?!config\/))/;

describe("example commit paths", () => {
  it("no routine prompt commits state", async () => {
    const dir = join(EXAMPLES, "routines");
    const files = (await readdir(dir)).filter((name) => name.endsWith(".md"));
    assert.ok(files.length > 0);
    for (const file of files) {
      const text = await readFile(join(dir, file), "utf8");
      for (const [line] of text.matchAll(/^.*git add .*$/gm))
        assert.doesNotMatch(line, STATE, `${file} commits state: ${line.trim()}`);
    }
  });

  it("a workflow that commits the view of the state guards it with state-paths", async () => {
    const dir = join(EXAMPLES, "workflows");
    const files = (await readdir(dir)).filter((name) => name.endsWith(".yml"));
    assert.ok(files.length > 0);
    for (const file of files) {
      const text = await readFile(join(dir, file), "utf8");
      const paths = /^ {10}paths: (.*)$/m.exec(text)?.[1];
      if (paths === undefined) continue;
      if (!STATE.test(paths)) continue;
      assert.match(text, /^ {10}state-paths: .*portfolio\.md/m, `${file} commits state without state-paths`);
    }
  });
});
