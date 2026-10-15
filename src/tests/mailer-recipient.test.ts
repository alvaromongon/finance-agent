/**
 * Without ALERT_EMAIL_TO there is no default recipient: the email
 * is not sent, as without SMTP credentials — dumped to the log, or a failed run
 * where delivery is required.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

process.env.MAIL_TRANSPORT = "smtp";
process.env.SMTP_USER = "agent@example.com";
process.env.SMTP_PASS = "test-password";
process.env.ALERT_EMAIL_TO = "";

describe("mailer — no recipient configured", () => {
  let mailer: typeof import("../mailer.js");

  before(async () => {
    mailer = await import("../mailer.js");
  });

  it("does not send and reports it as not delivered", async (t) => {
    t.mock.method(console, "warn", () => {});
    t.mock.method(console, "log", () => {});
    process.env.MAIL_REQUIRE_DELIVERY = "false";
    assert.equal(await mailer.sendSummaryEmail("subject", "body"), false);
  });

  it("fails up front where delivery is required", () => {
    process.env.MAIL_REQUIRE_DELIVERY = "true";
    assert.throws(() => {
      mailer.assertMailConfigured();
    }, /ALERT_EMAIL_TO/);
  });

  it("refuses a strict SMTP send without a recipient", async () => {
    await assert.rejects(mailer.sendEmailSmtp("subject", "body"), /ALERT_EMAIL_TO/);
  });
});
