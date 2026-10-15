/**
 * Tests of config.ts: nothing personal has a default in the code.
 * The vault path, the silo reference ETFs and the email recipient come from
 * the environment; without them the engine says which variable is missing
 * instead of falling back to the owner's values. config.js is imported
 * dynamically after clearing the variables, because it reads them on load.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

for (const name of [
  "VAULT_PROJECT_DIR",
  "REFERENCE_TICKER_EUR",
  "REFERENCE_TICKER_USD",
  "ALERT_EMAIL_TO",
  "ALERT_EMAIL_FROM",
  "SMTP_USER",
  "DECISIONS_ARCHIVE_DIR",
]) {
  process.env[name] = "";
}

describe("config — personal values come from the environment", () => {
  let config: typeof import("../config.js").config;

  before(async () => {
    ({ config } = await import("../config.js"));
  });

  it("requires VAULT_PROJECT_DIR when the vault is first used", () => {
    assert.throws(() => config.paths.vaultProjectDir, /VAULT_PROJECT_DIR/);
  });

  it("requires a reference ETF per silo", () => {
    assert.throws(() => config.reference.EUR, /REFERENCE_TICKER_EUR/);
    assert.throws(() => config.reference.USD, /REFERENCE_TICKER_USD/);
  });

  it("reads the reference ETFs when they are set", () => {
    process.env.REFERENCE_TICKER_EUR = "EXSA.DE";
    process.env.REFERENCE_TICKER_USD = "VOO";
    assert.equal(config.reference.EUR, "EXSA.DE");
    assert.equal(config.reference.USD, "VOO");
  });

  it("has no default email recipient or sender", () => {
    assert.equal(config.mail.to(), undefined);
    assert.equal(config.mail.from(), undefined);
  });

  it("sends from SMTP_USER when ALERT_EMAIL_FROM is not set", () => {
    process.env.SMTP_USER = "agent@example.com";
    assert.equal(config.mail.from(), "agent@example.com");
    process.env.SMTP_USER = "";
  });

  it("reads no decision archive unless DECISIONS_ARCHIVE_DIR is set", () => {
    assert.equal(config.paths.decisionsArchiveDir(), undefined);
  });
});
