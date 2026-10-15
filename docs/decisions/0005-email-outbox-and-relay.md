---
status: Accepted
date: 2026-10-15
decision-makers: Repository owner
---

# 0005. Email outbox and relay for environments that can't open SMTP

- **Issue**: initial publication (v0.1.0)

**Decision**: with `MAIL_TRANSPORT=outbox`, the engine writes each email as a JSON file in `logs/outbox/` instead of opening SMTP. The `email-relay.yml` workflow later sends the queued emails from GitHub Actions and deletes each one only after it was delivered.

## Context and problem statement

Agent sessions running in handoff mode ([ADR-0004](0004-handoff-mode-for-the-reasoner.md)) run in a sandbox whose egress proxy only tunnels port 443. SMTP (465/587) can't connect from there.

**Why it matters**: alerts about risk on open positions must arrive. An alert lost in silence is the worst failure of this system.

## Decision drivers

- No email is lost: delete only after a successful send.
- The same mailer code works in every environment.
- A run that can't deliver must fail visibly where delivery is required (`MAIL_REQUIRE_DELIVERY=true`).

## Considered options

- Tunnel SMTP through the sandbox proxy.
- Send through an HTTPS email API.
- Queue in the repository (outbox) and send from GitHub Actions (relay).

## Decision outcome

Chosen option: "outbox and relay". It needs nothing beyond what the system already uses: git and GitHub Actions.

**What we give up**: delivery waits for the next push that triggers the relay (or its daily backup schedule). An HTTPS email API would be immediate, but would add a provider and a secret.

**Scope**: email from handoff sessions. GitHub Actions runs keep using SMTP directly.

**Confidence**: high. Revisit if the sandbox allows SMTP, or if latency becomes a problem for risk alerts.

### Consequences

- Good: emails are committed with the run that produced them, which makes them easy to audit.
- Bad: email bodies sit in the data repository until they are sent.

### Confirmation

`src/tests/outbox.test.ts` checks that a failed send keeps the file and a successful one deletes it.

**Success measure**: no queued email is deleted without delivery, enforced by that test.

## More information

Tunnelling SMTP through the proxy was tried in July 2026 and reverted: the proxy only tunnels 443 by design, so it is not a bug to debug.
