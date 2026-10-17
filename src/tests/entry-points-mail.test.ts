/**
 * Fail fast: every CLI entry point that can deliver email checks the mail
 * configuration before doing any work, so a missing SMTP setup turns the run
 * red at once (and never after the analyst/API spend). With email off
 * (MAIL_TRANSPORT=none) the same entry points pass the check.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const tsx = join(root, "node_modules", ".bin", "tsx");

function run(script: string, args: string[], env: Record<string, string>, vault: string) {
  const clean = { ...process.env };
  for (const k of ["SMTP_USER", "SMTP_PASS", "ALERT_EMAIL_TO", "MAIL_TRANSPORT", "MAIL_REQUIRE_DELIVERY"]) {
    delete clean[k];
  }
  return spawnSync(tsx, [join(root, "src", script), ...args], {
    env: { ...clean, VAULT_PROJECT_DIR: vault, ANALYST_PROVIDER: "api", ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
}

const entryPoints: [string, string, string[]][] = [
  ["outbox:send", "outbox.ts", ["send"]],
  ["weekly-screening", "weekly-screening.ts", []],
  ["screening:summarize", "weekly-screening.ts", ["summarize"]],
  ["monday-briefing", "monday-briefing.ts", []],
];

describe("entry points — mail configuration is checked before any work", () => {
  let vault: string;

  before(() => {
    vault = mkdtempSync(join(tmpdir(), "entry-points-mail-"));
  });
  after(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  for (const [name, script, args] of entryPoints) {
    it(`${name}: email on without SMTP fails fast`, () => {
      const r = run(script, args, { MAIL_TRANSPORT: "smtp", MAIL_REQUIRE_DELIVERY: "true" }, vault);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /SMTP_USER\/SMTP_PASS\/ALERT_EMAIL_TO not configured/);
    });
  }

  it("outbox:send with email off (none) passes and sends nothing", () => {
    const r = run("outbox.ts", ["send"], { MAIL_TRANSPORT: "none", MAIL_REQUIRE_DELIVERY: "true" }, vault);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Email disabled/);
  });

  it("screening:summarize with email off (none) passes the check", () => {
    const r = run(
      "weekly-screening.ts",
      ["summarize"],
      { MAIL_TRANSPORT: "none", MAIL_REQUIRE_DELIVERY: "true" },
      vault,
    );
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /not configured/);
  });
});
