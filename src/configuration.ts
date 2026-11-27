// The configuration files and their last valid versions (#142, ADR-0018, spec #124).
//
// Configuration (the screening universe, the strategy, the portfolio policy and the prompts) stays in hand-edited files,
// but a bad edit must not stop the engine, risk watch above all (ADR-0015). So a file is validated each time it is
// read: a valid one is copied by the engine to `state/config/<file>` (the *last valid configuration*, written only
// here and committed with the rest of the state, so it survives a fresh CI checkout), and an invalid one is refused
// with every error (file, field, reason) while the engine goes on over that copy. With no copy yet (the first run) an
// invalid file is refused, and a flow that needs it fails with the errors; the heartbeat has done its stop check by then.
//
// The flows read a configuration file only through `readConfiguration`; `resolveConfiguration` is the step a run takes
// at its start to save the copy and learn what its digest has to warn about. Nothing is cached: each read judges the
// file as it is, so a run and its tests always see the current file.
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import yaml from "js-yaml";
import { config } from "./config.js";
import { normalizeEol } from "./utils/eol.js";
import { expectedSchemaVersion, extractFrontmatter } from "./utils/vault-parser.js";
import { printable } from "./utils/printable.js";

/** The configuration files the engine reads, relative to the data directory (the brain). */
export const CONFIGURATION_FILES = [
  "strategies/base.md",
  "portfolio-policy.md",
  "screening-universe.md",
  "routines/monday-briefing.md",
  "routines/weekly-screening.md",
  "routines/execution-analysis.md",
] as const;
export type ConfigurationFile = (typeof CONFIGURATION_FILES)[number];

/** One thing wrong with a file: where in it, and why. */
export interface FieldError {
  field: string;
  reason: string;
}

/** What a run has to warn about: a file that is not valid, and whether the engine runs on a copy of an earlier version. */
export interface ConfigurationProblem {
  file: ConfigurationFile;
  errors: FieldError[];
  /** `true`: the engine runs on the last valid version of the file; `false`: there is none (the first run). */
  usingLastValid: boolean;
}

/** An invalid file with no last valid version to fall back on: the flow that needs it cannot run. */
export class ConfigurationRefusedError extends Error {
  constructor(
    readonly file: ConfigurationFile,
    readonly errors: readonly FieldError[],
  ) {
    super(
      `${file} is not valid and there is no last valid version to run on:\n` +
        errors.map((e) => `- ${file}: ${e.field}: ${e.reason}`).join("\n"),
    );
    this.name = "ConfigurationRefusedError";
  }
}

const parsesAs = (text: string, what: string): { value: unknown } | { error: FieldError } => {
  try {
    return { value: yaml.load(text) };
  } catch (err) {
    return { error: { field: what, reason: `not valid YAML: ${(err as Error).message.split("\n")[0]}` } };
  }
};

const blank = (text: string): boolean => text.trim() === "";

function validateStrategy(text: string): FieldError[] {
  const front = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!front) {
    return [{ field: "frontmatter", reason: "missing: the file must start with a `---` block holding `version`" }];
  }
  const parsed = parsesAs(front[1], "frontmatter");
  if ("error" in parsed) return [parsed.error];
  const version = (parsed.value as Record<string, unknown> | null)?.version;
  if (typeof version === "number" || (typeof version === "string" && version.trim() !== "")) return [];
  return [{ field: "version", reason: "missing or empty: it is the rules version each decision records" }];
}

const validateText = (text: string): FieldError[] => (blank(text) ? [{ field: "content", reason: "empty" }] : []);

function validateUniverse(text: string): FieldError[] {
  const errors: FieldError[] = [];
  let version: unknown;
  try {
    version = extractFrontmatter(text)?.schema_version;
  } catch (err) {
    errors.push({ field: "frontmatter", reason: `not valid YAML: ${(err as Error).message.split("\n")[0]}` });
  }
  const expected = expectedSchemaVersion("screening-universe.md");
  if (version == null && errors.length === 0) {
    errors.push({
      field: "schema_version",
      reason: `missing from the frontmatter (this engine reads version ${expected} of this file)`,
    });
  } else if (version != null && version !== expected) {
    errors.push({
      field: "schema_version",
      reason: `unknown value ${JSON.stringify(version)} (this engine reads version ${expected} of this file)`,
    });
  }
  const block = /```yaml\n([\s\S]*?)\n```/.exec(text);
  if (!block) return [...errors, { field: "universe", reason: "no ```yaml block" }];
  const parsed = parsesAs(block[1], "universe");
  if ("error" in parsed) return [...errors, parsed.error];
  const universe = (parsed.value as { universe?: Record<string, unknown> } | null)?.universe;
  if (universe === null || typeof universe !== "object") {
    return [...errors, { field: "universe", reason: "missing: the block must hold `universe:` with its pools" }];
  }
  for (const pool of ["eur", "usd"]) {
    if (!Array.isArray(universe[pool])) errors.push({ field: `universe.${pool}`, reason: "missing: must be a list" });
  }
  if (universe.commodities != null && !Array.isArray(universe.commodities)) {
    errors.push({ field: "universe.commodities", reason: "must be a list when present" });
  }
  return errors;
}

interface Spec {
  /** A file the flows cannot do without: its absence is an error. The others are optional. */
  required: boolean;
  validate(text: string): FieldError[];
  /** What to say when a required file is not there. */
  missing?: string;
}

const prompt = (name: string): Spec => ({
  required: true,
  validate: validateText,
  missing: `not found: copy examples/brain/routines/${name}.md into your brain and adapt it`,
});

const SPECS: Record<ConfigurationFile, Spec> = {
  "strategies/base.md": { required: true, validate: validateStrategy },
  // Free text for the reasoner: it is optional, but a file that is there and says nothing is an accident, not a policy.
  "portfolio-policy.md": { required: false, validate: validateText },
  "screening-universe.md": { required: true, validate: validateUniverse },
  "routines/monday-briefing.md": prompt("monday-briefing"),
  "routines/weekly-screening.md": prompt("weekly-screening"),
  "routines/execution-analysis.md": prompt("execution-analysis"),
};

/** Every error of a file's text: none when it is valid. */
export function validateConfigurationFile(file: ConfigurationFile, text: string): FieldError[] {
  return SPECS[file].validate(normalizeEol(text));
}

const projectDir = () => config.paths.vaultProjectDir;
const diskPath = (file: ConfigurationFile) => join(projectDir(), file);
/** Where the last valid version of a file lives: the engine's state, in the data repository. */
const storedPath = (file: ConfigurationFile) => join(projectDir(), "state", "config", file);

async function readIfThere(path: string): Promise<{ text: string } | { absent: true } | { unreadable: string }> {
  try {
    return { text: normalizeEol(await readFile(path, "utf8")) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { absent: true };
    return { unreadable: (err as Error).message };
  }
}

interface Inspected {
  errors: FieldError[];
  text?: string;
}

/** The file as it is on disk: its text when valid, or its errors. */
async function inspect(file: ConfigurationFile): Promise<Inspected> {
  const spec = SPECS[file];
  const read = await readIfThere(diskPath(file));
  if ("unreadable" in read)
    return { errors: [{ field: "file", reason: `cannot be read: ${printable(read.unreadable)}` }] };
  if ("absent" in read) {
    return spec.required ? { errors: [{ field: "file", reason: spec.missing ?? "not found" }] } : { errors: [] };
  }
  const errors = spec.validate(read.text);
  return errors.length === 0 ? { errors, text: read.text } : { errors };
}

/** The last valid version of a file, or `null`: a copy that does not validate (edited by hand) is no copy. */
async function readStored(file: ConfigurationFile): Promise<string | null> {
  const read = await readIfThere(storedPath(file));
  if (!("text" in read)) return null;
  return SPECS[file].validate(read.text).length === 0 ? read.text : null;
}

async function saveStored(file: ConfigurationFile, text: string | undefined): Promise<void> {
  const path = storedPath(file);
  if (text === undefined) {
    await unlink(path).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
    });
    return;
  }
  const read = await readIfThere(path);
  if ("text" in read && read.text === text) return;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, text, "utf8");
  await rename(temporary, path);
}

/**
 * The text a flow works on for a file: the file on disk when it is valid, else the last valid version. `null`: an
 * optional file that is not there. Throws `ConfigurationRefusedError` for an invalid file with no last valid version.
 */
export async function readConfiguration(file: ConfigurationFile): Promise<string | null> {
  const seen = await inspect(file);
  if (seen.errors.length === 0) return seen.text ?? null;
  const last = await readStored(file);
  if (last !== null) return last;
  throw new ConfigurationRefusedError(file, seen.errors);
}

/**
 * The step a run takes at its start for the files it reads: validates each, copies a valid one to `state/config/` (unless
 * `save` is false: a check writes nothing) and returns what its digest must warn about. Never throws for a bad file; a
 * copy that cannot be written is said in the log and never stops the run.
 */
export async function resolveConfiguration(
  files: readonly ConfigurationFile[],
  { save = true }: { save?: boolean } = {},
): Promise<{ problems: ConfigurationProblem[] }> {
  const problems: ConfigurationProblem[] = [];
  for (const file of files) {
    const seen = await inspect(file);
    if (seen.errors.length > 0) {
      problems.push({ file, errors: seen.errors, usingLastValid: (await readStored(file)) !== null });
      continue;
    }
    if (!save) continue;
    try {
      await saveStored(file, seen.text);
    } catch (err) {
      console.warn(
        `[finance-agent] WARNING, configuration: the last valid copy of ${file} was not saved: ${(err as Error).message}`,
      );
    }
  }
  return { problems };
}

/** One line per problem for the log: the file, whether the engine runs on a copy, and each error (printed escaped: a reason can quote the file). */
export function describeProblems(problems: readonly ConfigurationProblem[]): string[] {
  return problems.map((p) =>
    printable(
      `${p.file} is not valid, ${p.usingLastValid ? "running on its last valid version" : "no last valid version"}: ` +
        p.errors.map((e) => `${e.field}: ${e.reason}`).join("; "),
    ),
  );
}
