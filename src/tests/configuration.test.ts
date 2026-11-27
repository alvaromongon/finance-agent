/**
 * The configuration files and their last valid versions (#142, ADR-0018, spec #124): a file is validated when
 * it is read, a valid one is copied to `state/config/`, and an invalid one is refused with every error while the
 * engine goes on over the copy. Temporary vault, no network. VAULT_PROJECT_DIR is set before the first import.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const STRATEGY = `---\nversion: "1.0"\n---\n\n# Base strategy\n`;
const POLICY = "- At most 25% of a silo in one position.\n";
const PROMPT = "You write the weekly briefing.\n";
const UNIVERSE = `---
schema_version: 1
---

\`\`\`yaml
universe:
  eur:
    - { ticker: SAP.DE, name: SAP, market: Xetra, currency: EUR }
  usd:
    - { ticker: KO, name: Coca-Cola, market: NYSE, currency: USD }
  commodities: []
\`\`\`
`;

describe("configuration", () => {
  let vaultDir: string;
  let c: typeof import("../configuration.js");
  const path = (...parts: string[]) => join(vaultDir, ...parts);
  const put = async (file: string, text: string) => {
    await mkdir(join(vaultDir, file, ".."), { recursive: true });
    await writeFile(path(file), text, "utf8");
  };
  const stored = (file: string) => readFile(path("state", "config", file), "utf8");

  before(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "finance-agent-configuration-"));
    process.env.VAULT_PROJECT_DIR = vaultDir;
    c = await import("../configuration.js");
  });
  after(() => rm(vaultDir, { recursive: true, force: true }));
  beforeEach(async () => {
    for (const entry of await readdir(vaultDir)) await rm(path(entry), { recursive: true, force: true });
  });

  describe("validation", () => {
    it("accepts the example of each file", () => {
      assert.deepEqual(c.validateConfigurationFile("strategies/base.md", STRATEGY), []);
      assert.deepEqual(c.validateConfigurationFile("portfolio-policy.md", POLICY), []);
      assert.deepEqual(c.validateConfigurationFile("routines/monday-briefing.md", PROMPT), []);
      assert.deepEqual(c.validateConfigurationFile("screening-universe.md", UNIVERSE), []);
    });

    it("names the field and the reason of every error of the strategy", () => {
      assert.deepEqual(c.validateConfigurationFile("strategies/base.md", "# no frontmatter\n"), [
        { field: "frontmatter", reason: "missing: the file must start with a `---` block holding `version`" },
      ]);
      assert.deepEqual(c.validateConfigurationFile("strategies/base.md", "---\nversion: \n---\n"), [
        { field: "version", reason: "missing or empty: it is the rules version each decision records" },
      ]);
      const [bad] = c.validateConfigurationFile("strategies/base.md", "---\nversion: [1\n---\n");
      assert.equal(bad.field, "frontmatter");
      assert.match(bad.reason, /^not valid YAML/);
    });

    it("refuses a policy or a prompt that says nothing", () => {
      assert.deepEqual(c.validateConfigurationFile("portfolio-policy.md", " \n"), [
        { field: "content", reason: "empty" },
      ]);
      assert.deepEqual(c.validateConfigurationFile("routines/execution-analysis.md", ""), [
        { field: "content", reason: "empty" },
      ]);
    });

    it("reports every error of the screening universe, not the first", () => {
      assert.deepEqual(c.validateConfigurationFile("screening-universe.md", "# nothing here\n"), [
        { field: "schema_version", reason: "missing from the frontmatter (this engine reads version 1 of this file)" },
        { field: "universe", reason: "no ```yaml block" },
      ]);
      const errors = c.validateConfigurationFile(
        "screening-universe.md",
        "---\nschema_version: 1\n---\n\n```yaml\nuniverse:\n  eur: nope\n  commodities: {}\n```\n",
      );
      assert.deepEqual(
        errors.map((e) => e.field),
        ["universe.eur", "universe.usd", "universe.commodities"],
      );
    });

    it("refuses a universe whose YAML does not parse, with the parser's reason", () => {
      const [bad] = c.validateConfigurationFile(
        "screening-universe.md",
        "---\nschema_version: 1\n---\n\n```yaml\nuniverse: [\n```\n",
      );
      assert.equal(bad.field, "universe");
      assert.match(bad.reason, /^not valid YAML/);
    });
  });

  describe("the example brain", () => {
    it("has every configuration file, and each one validates", async () => {
      const example = join(import.meta.dirname, "..", "..", "examples", "brain");
      for (const file of c.CONFIGURATION_FILES) {
        const text = await readFile(join(example, file), "utf8");
        assert.deepEqual(c.validateConfigurationFile(file, text), [], file);
      }
    });
  });

  describe("the last valid version", () => {
    it("copies a valid file to state/config/ and reads it from the disk", async () => {
      await put("strategies/base.md", STRATEGY);
      const { problems } = await c.resolveConfiguration(["strategies/base.md"]);
      assert.deepEqual(problems, []);
      assert.equal(await stored("strategies/base.md"), STRATEGY);
      assert.equal(await c.readConfiguration("strategies/base.md"), STRATEGY);
    });

    it("leaves the copy alone when the file did not change", async () => {
      await put("strategies/base.md", STRATEGY);
      await c.resolveConfiguration(["strategies/base.md"]);
      const first = (await readFile(path("state", "config", "strategies", "base.md"))).toString();
      await c.resolveConfiguration(["strategies/base.md"]);
      assert.equal((await stored("strategies/base.md")).toString(), first);
    });

    it("refuses an invalid file with the errors and runs on the copy", async () => {
      await put("routines/monday-briefing.md", PROMPT);
      await c.resolveConfiguration(["routines/monday-briefing.md"]);
      await put("routines/monday-briefing.md", "  \n");

      const { problems } = await c.resolveConfiguration(["routines/monday-briefing.md"]);
      assert.deepEqual(problems, [
        {
          file: "routines/monday-briefing.md",
          errors: [{ field: "content", reason: "empty" }],
          usingLastValid: true,
        },
      ]);
      assert.equal(await c.readConfiguration("routines/monday-briefing.md"), PROMPT);
      assert.equal(await stored("routines/monday-briefing.md"), PROMPT, "the bad file never replaces the copy");
    });

    it("takes the first valid edit as the new copy, and the warning goes away", async () => {
      await put("strategies/base.md", STRATEGY);
      await c.resolveConfiguration(["strategies/base.md"]);
      await put("strategies/base.md", "# broken\n");
      assert.equal((await c.resolveConfiguration(["strategies/base.md"])).problems.length, 1);

      const edited = `---\nversion: "2.0"\n---\n`;
      await put("strategies/base.md", edited);
      assert.deepEqual((await c.resolveConfiguration(["strategies/base.md"])).problems, []);
      assert.equal(await stored("strategies/base.md"), edited);
    });

    it("refuses with every error when there is no copy yet (the first run)", async () => {
      await put("screening-universe.md", "# nothing here\n");
      const { problems } = await c.resolveConfiguration(["screening-universe.md"]);
      assert.equal(problems[0].usingLastValid, false);
      await assert.rejects(c.readConfiguration("screening-universe.md"), (err: Error) => {
        assert.ok(err instanceof c.ConfigurationRefusedError);
        assert.match(err.message, /screening-universe\.md: schema_version: missing/);
        assert.match(err.message, /screening-universe\.md: universe: no ```yaml block/);
        return true;
      });
    });

    it("says a required file that is not there, with the example to copy for a prompt", async () => {
      const { problems } = await c.resolveConfiguration(["routines/weekly-screening.md", "strategies/base.md"]);
      assert.equal(problems.length, 2);
      assert.match(problems[0].errors[0].reason, /not found: copy examples\/brain\/routines\/weekly-screening\.md/);
      assert.match(problems[1].errors[0].reason, /^not found/);
    });

    it("does not fall back to a copy that is itself invalid (it was edited by hand)", async () => {
      await put("strategies/base.md", STRATEGY);
      await c.resolveConfiguration(["strategies/base.md"]);
      await put("state/config/strategies/base.md", "# hand edited\n");
      await put("strategies/base.md", "# broken\n");
      assert.equal((await c.resolveConfiguration(["strategies/base.md"])).problems[0].usingLastValid, false);
      await assert.rejects(c.readConfiguration("strategies/base.md"), c.ConfigurationRefusedError);
    });

    it("treats an optional file that is not there as no file, and drops its copy", async () => {
      await put("portfolio-policy.md", POLICY);
      await c.resolveConfiguration(["portfolio-policy.md"]);
      await rm(path("portfolio-policy.md"));
      assert.deepEqual((await c.resolveConfiguration(["portfolio-policy.md"])).problems, []);
      assert.equal(await c.readConfiguration("portfolio-policy.md"), null);
      await assert.rejects(stored("portfolio-policy.md"), { code: "ENOENT" });
    });

    it("does not write the copy when asked not to (a check)", async () => {
      await put("strategies/base.md", STRATEGY);
      await c.resolveConfiguration(["strategies/base.md"], { save: false });
      await assert.rejects(stored("strategies/base.md"), { code: "ENOENT" });
    });

    it("reads a valid file without a prior resolve (the readers work on their own)", async () => {
      await put("routines/execution-analysis.md", PROMPT);
      assert.equal(await c.readConfiguration("routines/execution-analysis.md"), PROMPT);
    });
  });
});
