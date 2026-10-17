/**
 * Email on/off (MAIL_TRANSPORT=none), the three cases a caller of the reusable
 * workflows can be in, all with MAIL_REQUIRE_DELIVERY=true as the workflows set it:
 *   - disabled: nothing is sent and the run passes;
 *   - enabled without SMTP: the run fails;
 *   - enabled with SMTP: the email is sent.
 */
import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import nodemailer from "nodemailer";

const ENV_KEYS = ["MAIL_REQUIRE_DELIVERY", "MAIL_TRANSPORT", "SMTP_USER", "SMTP_PASS", "ALERT_EMAIL_TO"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

process.env.MAIL_REQUIRE_DELIVERY = "true";

describe("mailer — email switched on or off", () => {
  let mailer: typeof import("../mailer.js");

  before(async () => {
    mailer = await import("../mailer.js");
  });

  after(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  beforeEach(() => {
    process.env.MAIL_TRANSPORT = "smtp";
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    delete process.env.ALERT_EMAIL_TO;
  });

  it("disabled: passes the startup check, sends nothing and reports the email as handled", async (t) => {
    process.env.MAIL_TRANSPORT = "none";
    const createTransport = t.mock.method(nodemailer, "createTransport", () => {
      throw new Error("must not open a transport");
    });
    t.mock.method(console, "log", () => {});

    assert.doesNotThrow(() => {
      mailer.assertMailConfigured();
    });
    assert.equal(await mailer.sendSummaryEmail("subject", "body"), true);
    assert.equal(createTransport.mock.callCount(), 0);
  });

  it("enabled without SMTP: fails up front and at delivery", async () => {
    assert.throws(() => {
      mailer.assertMailConfigured();
    }, mailer.MailDeliveryError);
    await assert.rejects(mailer.sendSummaryEmail("subject", "body"), mailer.MailDeliveryError);
  });

  it("enabled with SMTP: sends the email", async (t) => {
    process.env.SMTP_USER = "agent@example.com";
    process.env.SMTP_PASS = "test-password";
    process.env.ALERT_EMAIL_TO = "owner@example.com";
    const sendMail = t.mock.fn(() => Promise.resolve({}));
    t.mock.method(nodemailer, "createTransport", () => ({ sendMail }));
    t.mock.method(console, "log", () => {});

    assert.doesNotThrow(() => {
      mailer.assertMailConfigured();
    });
    assert.equal(await mailer.sendSummaryEmail("subject", "body"), true);
    assert.equal(sendMail.mock.callCount(), 1);
  });
});
