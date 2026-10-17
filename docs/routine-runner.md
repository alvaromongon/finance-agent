# Runner: handoff with Claude Code routines

One way to run the reasoning without the Anthropic API: scheduled Claude Code routines reason over
what the engine prepares ([ADR-0004](decisions/0004-handoff-mode-for-the-reasoner.md)). It is one
runner among possible others; the [README](../README.md#handoff) describes the commands any
runner uses. Everything here is an example to copy and adapt.

## How the pieces fit

| Flow                  | Woken by                                                          | Routine prompt                                                          |
| --------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Heartbeat escalations | The heartbeat caller after its commit, plus a daily fallback cron | [`pending-escalations.md`](../examples/routines/pending-escalations.md) |
| Monday briefing       | Weekly schedule of the routine                                    | [`monday-briefing.md`](../examples/routines/monday-briefing.md)         |
| Weekly screening      | Weekly schedule of the routine                                    | [`weekly-screening.md`](../examples/routines/weekly-screening.md)       |
| Emails                | `email-relay.yml` in GitHub Actions (required)                    | none: routines only queue them in `logs/outbox/`                        |

The heartbeat still runs in GitHub Actions, with `analyst-provider: handoff`
([`heartbeat-eu-handoff.yml`](../examples/workflows/heartbeat-eu-handoff.yml)). The routines
resolve what it leaves in `logs/pending/` and write to the same repository. The system prompts the
reasoning follows live in your brain, under `routines/`
([examples](../examples/brain/routines)); the orchestration prompts in this guide only say which
commands to run and when to commit.

## Routine environment

Create one environment for the routines (in claude.ai) with the variables below; the prompts stop
and report if one is missing.

| Variable                                       | Value                                                                                                                                         |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `VAULT_PROJECT_DIR`                            | Absolute path of the brain in the routine's checkout of your data repository.                                                                 |
| `ANALYST_PROVIDER`                             | `handoff`.                                                                                                                                    |
| `MAIL_TRANSPORT`                               | `outbox`: the sandbox cannot open SMTP, so emails are queued and the relay sends them ([ADR-0005](decisions/0005-email-outbox-and-relay.md)). |
| `OUTPUT_LANGUAGE`                              | `en` or `es`: the language of emails, reports and notes.                                                                                      |
| `REFERENCE_TICKER_EUR`, `REFERENCE_TICKER_USD` | The silo benchmark ETFs, as in the [configuration](../README.md#configuration-step-by-step).                                                  |
| `ENGINE_REF`                                   | The engine tag to install, for example `v0.1.0` (used by the hook below).                                                                     |
| `ENGINE_DIR`                                   | Where the hook installs the engine; the prompts run their commands from there.                                                                |

Leave the SMTP variables and `ANTHROPIC_API_KEY` out: neither is used in this runner. The other
variables in [`.env.example`](../.env.example) keep their defaults.

The email relay is required: with `MAIL_TRANSPORT=outbox` nothing leaves the routine, so install
[`email-relay.yml`](../examples/workflows/email-relay.yml) with its SMTP variables and secret.
Its push trigger starts it when a routine pushes `logs/outbox/**`, and its hourly cron covers
pushes that do not trigger workflows.

## Network access

The sandbox only allows outbound HTTPS to the hosts you allow. Allow at least:

- `query1.finance.yahoo.com`: prices and history.
- `feeds.finance.yahoo.com`: the news feed. The engine calls this host directly because
  `finance.yahoo.com` redirects to it; in the author's observation the allowlist did not follow
  such a redirect (not verified against the official documentation).
- `github.com` (clone of the engine and push to your data repository) and `registry.npmjs.org`
  (`npm ci`).
- Whatever the web search tool needs for the macro and business context.

Without the news host the headlines come back empty and the run continues with a warning; without
the Yahoo price host `monday-briefing:prepare` and `screening:prepare` fail, and the prompts say
to stop.

## Installing the engine at a pinned tag

Add [`install-engine.sh`](../examples/routines/install-engine.sh) to your data repository as
`.claude/hooks/install-engine.sh` and register it as a `SessionStart` hook in
`.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [{ "type": "command", "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/install-engine.sh\"" }]
      }
    ]
  }
}
```

It clones the engine at `ENGINE_REF` into `ENGINE_DIR` and runs `npm ci`, so every session starts
with the version you chose. Upgrading the engine means changing `ENGINE_REF`, as with the `engine-ref` of
the workflow callers; keep both on the same tag.

## Committing to the default branch

Routine sessions work on a session branch by default. The prompts tell the session to check out
the default branch, commit only the paths each flow writes, and `git pull --rebase` before
`git push`. Branch protection or rulesets on the default branch must allow the GitHub identity
connected to the routine to push there (the routine settings have no option for it). Nothing
reads a session branch: the next heartbeat, the email relay and the Monday briefing all look at
the default branch.

The paths each flow commits are the same as in the Actions callers: `logs/` and `portfolio.md` for
escalations; plus `watchlist.md` and `tesis/` for the briefing and the screening, and
`screening-log.md` for the screening.

## Waking the routine

1. In claude.ai, create the pending-escalations routine with two triggers: an **API** trigger
   (it gives a URL and a token, shown once) and a **daily schedule** as a fallback. The fallback
   covers a failed webhook and escalations the heartbeat committed while the routine was running.
2. Store the URL and the token as the repository secrets `ROUTINE_FIRE_URL` and `ROUTINE_TOKEN`.
3. Use [`heartbeat-eu-handoff.yml`](../examples/workflows/heartbeat-eu-handoff.yml): its `wake-routine` job
   checks out the branch tip, fires the routine only after the commit job pushed, and only if
   `logs/pending/` holds files. To adapt `heartbeat-us.yml` the same way: set
   `analyst-provider: handoff`, drop `ANTHROPIC_API_KEY` from `secrets`, and copy the
   `wake-routine` job (and the `needs` chain after `commit`). The fire request follows
   [Trigger a routine](https://code.claude.com/docs/en/routines) (checked 2026-10-17). It is a
   research-preview feature, so the `anthropic-beta` header may change; recheck it from time to
   time. The `text` of the request reaches the session as untrusted informational data, and the
   prompts do not depend on it.
4. Create the Monday briefing and weekly screening routines with a weekly schedule and the
   prompts in [`examples/routines/`](../examples/routines).

If the routine runs while a heartbeat is committing, the session's `git pull --rebase` handles the
race; anything left pending is picked up by the next wake or the daily fallback. The pending item
keeps the detection snapshot (strength, benchmark, setup, conviction and price), but entry,
position, cash and silo value are rebuilt from the current `watchlist.md` and `portfolio.md` when
it is resolved, so a late resolution mixes the day's signal with today's portfolio.

## Security of the routine

The routines process untrusted text (news headlines, web search results) while holding push
rights. Scope the GitHub identity connected to them to this single repository, without the
`workflow` permission, and protect `.github/**` with rulesets so a manipulated session cannot
change the workflows. The prompts commit only the paths each flow writes and use a delimiter for
the JSON answer that news text is unlikely to contain.

## Checklist

- [ ] Brain in the data repository, `routines/` system prompts in the brain.
- [ ] Routine environment with the variables and network allowlist above.
- [ ] `install-engine.sh` registered as a SessionStart hook, tag pinned.
- [ ] Three routines created from the example prompts, allowed to push to the default branch.
- [ ] `heartbeat-eu-handoff.yml` (adapted for USD if you use it) and `email-relay.yml` in `.github/workflows/`, with the
      `ROUTINE_FIRE_URL`, `ROUTINE_TOKEN` and SMTP settings.
