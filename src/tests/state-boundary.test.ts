/**
 * The state boundary (#130, spec #124, ADR-0018): the engine's state is read and written by the storage
 * layer only. This test lists every module outside it that reads or writes a file (imports `node:fs`) or
 * parses what a file stores (imports a parser of the storage layer), and fails when one appears that is
 * not in the allowlist, or when an allowlisted one no longer offends (so the list only shrinks).
 *
 * The allowlist is the measure of the milestone "Commands and engine-owned state": #130 reports its length
 * and #143 empties it. Each entry names the slice that removes it. Three entries are not state files in
 * the strict sense (market fixtures and two report writers); the last slice moves them behind the storage
 * layer or says why they stay.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dirname, "..");

/**
 * The storage layer, relative to `src/`: the modules that may read or write a state file and parse what
 * it stores. `portfolio-store.ts` is the portfolio state port; the others are its parsers, codec and
 * writer, the engine's own JSON store of the portfolio and its generated view (`portfolio-json.ts`, #132), and
 * the vault reader/writer of the other files.
 */
const STORAGE_LAYER: readonly string[] = [
  "vault-io.ts",
  "portfolio-store.ts",
  "utils/vault-parser.ts",
  "utils/portfolio-codec.ts",
  "utils/portfolio-writer.ts",
  "utils/portfolio-json.ts",
  "utils/parse.ts",
  "utils/fs-text.ts",
  "inbox-store.ts",
];

/** What a module imports to read or write a file (`node:fs`) or to parse a stored value (the storage layer's parsers). */
const FILE_MODULES = new Set(["node:fs", "node:fs/promises", "fs", "fs/promises"]);
const PARSER_MODULES = ["parse", "vault-parser", "portfolio-codec", "portfolio-writer", "fs-text"];

/** Modules outside the storage layer that still do it today, and the slice of the milestone that removes each. */
const ALLOWLIST: Readonly<Record<string, { slices: string; why: string }>> = {
  "claude-analyst.ts": { slices: "#142", why: "reads the strategy file (configuration)" },
  "decisions-chart.ts": { slices: "#143", why: "writes the chart file (a report, not state)" },
  "decisions-evaluate.ts": { slices: "#143", why: "writes the evaluation file (a report, not state)" },
  "demo.ts": {
    slices: "#143",
    why: "copies the example brain to a temporary directory and reads the outbox of its copy",
  },
  "monday-briefing.ts": {
    slices: "#140, #143",
    why: "puts watchlist.md as text in the prompt; reads the theses and logs; writes the report",
  },
  "providers/fixtures.ts": { slices: "#143", why: "reads market fixture files (not state)" },
  "screening-outcomes.ts": { slices: "#143", why: "reads screening-log.md and writes its report" },
  "utils/cooldown.ts": { slices: "#143", why: "reads the frontmatter of the last decision log" },
  "utils/monday-briefing-helpers.ts": { slices: "#143", why: "reads the plan summary of the briefing's text" },
  "utils/screening-helpers.ts": { slices: "#143", why: "reads the theses and screening files" },
  "utils/screening-outcomes-helpers.ts": { slices: "#143", why: "uses the screening-log result values" },
  "weekly-screening.ts": {
    slices: "#140, #142, #143",
    why: "reads screening-universe.md and watchlist.md as text, writes the theses",
  },
};

/** The imports of a source that read or write a file or parse a stored value; type-only imports do neither. */
export function stateOffences(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const modules = [
    ...[...code.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]),
    ...[...code.matchAll(/^\s*import\s+["']([^"']+)["']/gm)].map((m) => m[1]), // side-effect import
    ...[...code.matchAll(/\b(?:import|require)\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]),
  ];
  return modules.filter(
    (module) =>
      FILE_MODULES.has(module) || PARSER_MODULES.some((parser) => new RegExp(`(^|/)${parser}\\.js$`).test(module)),
  );
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "tests" ? [] : sources(path);
    return entry.name.endsWith(".ts") ? [relative(SRC, path)] : [];
  });
}

describe("the state boundary: only the storage layer reads or writes state or parses a stored number", () => {
  const offenders = new Map(
    sources(SRC)
      .filter((file) => !STORAGE_LAYER.includes(file))
      .map((file) => [file, stateOffences(readFileSync(join(SRC, file), "utf8"))] as const)
      .filter(([, offences]) => offences.length > 0),
  );

  it("no module outside the storage layer is new to it: the ones that do it are the allowlist", () => {
    const unlisted = [...offenders].filter(([file]) => !(file in ALLOWLIST));
    assert.deepEqual(
      unlisted,
      [],
      "these modules read or write a state file or parse a stored number: go through the storage layer " +
        "(the portfolio through portfolio-store.ts), or, for a later slice of #124, add them to the allowlist with it",
    );
  });

  it("the allowlist only shrinks: an entry that no longer offends is removed from it", () => {
    const stale = Object.keys(ALLOWLIST).filter((file) => !offenders.has(file));
    assert.deepEqual(stale, [], "remove these from ALLOWLIST");
  });

  it("every entry names the slice that removes it and why it is there", () => {
    for (const [file, { slices, why }] of Object.entries(ALLOWLIST)) {
      assert.match(slices, /^#\d+(, #\d+)*$/, file);
      assert.ok(why.length > 0, file);
    }
  });

  it("the storage layer is what it says it is", () => {
    for (const file of STORAGE_LAYER) assert.doesNotThrow(() => readFileSync(join(SRC, file)), file);
  });

  it("the flows do not parse the portfolio: nothing outside the storage layer imports its text API", () => {
    // `portfolio-store.ts` is the only door to portfolio.md; its text-level parts are not exported.
    const store = readFileSync(join(SRC, "portfolio-store.ts"), "utf8");
    assert.doesNotMatch(store, /export (async )?function (readPortfolioText|writePortfolioText|parsePortfolioText)/);
    const TEXT_API = ["portfolio-writer", "portfolio-codec"];
    for (const file of sources(SRC).filter((f) => !STORAGE_LAYER.includes(f))) {
      const source = readFileSync(join(SRC, file), "utf8");
      assert.deepEqual(
        stateOffences(source).filter((module) => TEXT_API.some((api) => module.endsWith(`${api}.js`))),
        [],
        `${file} imports the portfolio's text API`,
      );
      assert.doesNotMatch(
        source,
        /\b(applyLotChange|applyPrices|parseLotRows|parsePositions|parsePortfolioText)\b/,
        file,
      );
    }
  });

  it("no flow reads portfolio.md as a source: nothing outside the storage layer opens the file (#132)", () => {
    // `portfolio.md` is the view the port generates from the store; the port is the only door to the state.
    const named = sources(SRC)
      .filter((file) => !STORAGE_LAYER.includes(file))
      .filter((file) => {
        const code = readFileSync(join(SRC, file), "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^\s*\/\/.*$/gm, "");
        return /\b(?:join|resolve|readFile|readTextFile|safeRead|writeFile)\([^)]*["']portfolio\.md["']/.test(code);
      });
    assert.deepEqual(named, []);
  });

  it("reports the length of the allowlist: the early measure of the milestone", (t) => {
    t.diagnostic(`state boundary allowlist: ${Object.keys(ALLOWLIST).length} modules (emptied by #143)`);
    assert.equal(Object.keys(ALLOWLIST).length, offenders.size);
  });

  describe("the detector", () => {
    it("flags a file system import and an import of a storage parser, value or re-export, in one line or several", () => {
      assert.equal(stateOffences(`import { readFile } from "node:fs/promises";`).length, 1);
      assert.equal(stateOffences(`import { parseMarkdownNumber } from "./utils/parse.js";`).length, 1);
      assert.equal(stateOffences(`import {\n  a,\n  b,\n} from "../utils/vault-parser.js";`).length, 1);
      assert.equal(stateOffences(`export { x } from "./portfolio-codec.js";`).length, 1);
      assert.equal(stateOffences(`const fs = await import("node:fs");`).length, 1);
      assert.equal(stateOffences(`import "node:fs";`).length, 1);
      assert.equal(stateOffences(`const fs = require("node:fs/promises");`).length, 1);
      assert.equal(stateOffences(`export * from "./portfolio-codec.js";`).length, 1);
    });

    it("does not flag a type-only import, a comment, a module that only has a similar name or other modules", () => {
      assert.deepEqual(stateOffences(`import type { Row } from "./vault-parser.js";`), []);
      assert.deepEqual(stateOffences(`// import { readFile } from "node:fs/promises";`), []);
      assert.deepEqual(stateOffences(`/* import { x } from "./parse.js"; */`), []);
      assert.deepEqual(stateOffences(`import { x } from "./reparse.js";`), []);
      assert.deepEqual(stateOffences(`import { join } from "node:path";\nimport { money } from "../money.js";`), []);
    });
  });
});
