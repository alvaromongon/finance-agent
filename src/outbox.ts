// Email relay CLI: `outbox:send` sends by SMTP the messages the
// Routines left in logs/outbox/ (MAIL_TRANSPORT=outbox) and deletes each file
// ONLY if sending it succeeded. The finance-agent-email-relay workflow runs it
// from GitHub Actions, where direct SMTP does work.
import { config } from "./config.js";
import { assertMailConfigured, sendEmailSmtp } from "./mailer.js";
import { listOutboxFiles, readOutboxMessage, deleteOutboxFile } from "./vault-io.js";

/**
 * Processes the outbox in chronological order. A malformed file or a failed
 * send is kept (never deleted unsent) and does not stop the rest.
 * `sender` is injectable for tests; in production it is sendEmailSmtp.
 */
export async function processOutbox(
  sender: (subject: string, body: string) => Promise<void> = sendEmailSmtp,
): Promise<{ sent: string[]; failed: string[] }> {
  if (config.mail.transport() === "outbox") {
    // Anti-loop guard: with MAIL_TRANSPORT=outbox the "send" would enqueue into
    // the outbox itself again. The relay must run in smtp mode.
    throw new Error("outbox:send requires MAIL_TRANSPORT=smtp (with outbox it would re-enqueue itself)");
  }

  if (config.mail.transport() === "none") {
    // Email switched off: nothing is sent and the queue is left untouched.
    console.log("[outbox] Email disabled (MAIL_TRANSPORT=none) — nothing sent.");
    return { sent: [], failed: [] };
  }

  const files = await listOutboxFiles();
  if (files.length === 0) {
    console.log("[outbox] Empty — nothing to send.");
    return { sent: [], failed: [] };
  }

  const sent: string[] = [];
  const failed: string[] = [];
  for (const filename of files) {
    try {
      const msg = await readOutboxMessage(filename);
      await sender(msg.subject, msg.body);
      await deleteOutboxFile(filename);
      sent.push(filename);
      console.log(`[outbox] Sent and deleted: ${filename}`);
    } catch (err) {
      failed.push(filename);
      console.error(`[outbox] Failure with ${filename} (kept for the next run):`, err);
    }
  }

  console.log(`[outbox] Sent: ${sent.length}, failed: ${failed.length}`);
  return { sent, failed };
}

// CLI dispatch only when the file runs directly (same pattern as pending.ts).
const isMain = process.argv[1] != null && import.meta.filename === process.argv[1];
if (isMain) {
  const [cmd] = process.argv.slice(2);
  if (cmd !== "send") {
    throw new Error("Usage: outbox.ts send");
  }
  Promise.resolve()
    .then(() => {
      assertMailConfigured();
      return processOutbox();
    })
    .then(({ failed }) => {
      // Red run if anything was left unsent — visibility in Actions.
      if (failed.length > 0) process.exitCode = 1;
    })
    .catch((err) => {
      console.error("[outbox]", err);
      process.exitCode = 1;
    });
}
