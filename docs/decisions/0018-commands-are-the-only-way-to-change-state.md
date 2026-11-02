---
status: Proposed
date: 2026-11-02
decision-makers: Repository owner
---

# 0018. Commands dropped in an inbox are the only way to change the engine's state

- **Builds on**: [0003](0003-state-as-versioned-markdown.md) — state is text files in a versioned data directory, and the engine rejects what it can't read. This ADR keeps that and changes who writes them.
- **Builds on**: [0006](0006-single-append-only-decision-log.md) — a single append-only decision log, in a format made for machines.
- **Builds on**: [0015](0015-open-lots-live-in-the-portfolio.md) — a typo must never switch off stop alerts.
- **Builds on**: [0016](0016-domain-values-are-branded-types-made-by-parsing.md) — a domain value is made by parsing it at the boundary where it enters.

**Decision**: the engine's state changes only through commands, each batch dropped as one file in an inbox folder and applied all or nothing by independent pure handlers; state files are written only by the engine, and configuration stays in hand-edited files validated when they change. We expect the share of tickets caused by how stored data is read or written to fall from 64 % to at most 10 % of new tickets.

## Context and problem statement

The owner keeps the state by hand in Markdown files that the engine also writes. Different parts of the engine read and write them in different ways: some skip a bad row and others refuse the file, numbers are written in two notations, and a recorded trade still needs a hand edit of the cash. There is no broker integration, so the owner remains the source of truth for what happened at the broker.

**Why it matters**: 43 of the 67 issues that were neither specifications nor decisions had such a cause, 64 % (measured on 2026-10-29, one pass by an agent over titles and bodies; not reviewed by the owner, and not a measure of hand edits as the cause). New work is built on that base and inherits its defects.

## Decision drivers

- Risk watch must never stop or be skipped because of an input error or a queued run.
- State needs one way in, so that a value is validated once and every reader shares one model.
- The owner reports facts only they know, from any device, and may have an AI write them.
- Text stays versioned in git and readable by a person.
- A command line or a hosted service must stay possible later, without building it now.

## Considered options

- Inbox folder of command batches, with engine-owned state.
- One inbox file, emptied by the engine after each batch.
- Commands on the command line, as today, with engine-owned state.
- An abstraction layer over today's Markdown, with the state files still edited by hand.
- A last-valid fallback over today's portfolio file.
- Do nothing: keep fixing findings one by one.

## Decision outcome

Chosen option: "Inbox folder of command batches, with engine-owned state", because it gives state one way in, keeps a bad batch from affecting any other, and lets a person, an AI or a scheduled routine submit work the same way.

- **Commands**: a fixed set of user actions. Each has its own pure handler, which takes the state and the command and returns the new state or an error. Handlers run over an in-memory copy and the state is saved once, so a batch applies whole or not at all.
- **Inbox**: one file per batch. The engine never edits it: it moves it to `applied/` or, with the line and the reason, to `rejected/`, and the digest reports a rejection. Batches apply in file-name order.
- **Public entries**: `check` and `ingest` only. `check` is `ingest` without the save, so it simulates the whole batch rather than reading its syntax.
- **State and telemetry**: state changes only through commands, and a stop raised by the engine is a command too. Prices, logs and sent markers are telemetry that the engine writes directly. Routines submit commands and no longer commit state.
- **Trigger and concurrency**: any trigger is valid as long as state writes never overlap. Stop detection reads the last commit and takes no lock. Only the state write is serialized, with the push to the data repository acting as a compare-and-swap with retry.
- **Configuration**: the screening universe, strategy, portfolio policy and prompts stay in hand-edited files, validated when they change. The engine works on the last valid version, so a bad edit never stops risk watch.

**What we give up**: state can no longer be fixed by editing a file; instant feedback, except through `check`; reading the state files directly in a notes app, which get generated read-only views instead; and the input format, which changes without a migration because the first customer starts from scratch. Order between batches rests on file names.

**Sequence**: the first slice covers cash, buy and sale end to end, because those produced most findings and it tests the expected fall before the rest is built.

**Scope**: every flow of the engine and every user's data directory. Individual public commands, a hosted API and multiple tenants are not built; the handlers keep that door open.

**Confidence**: medium. The 64 % does not prove this remedy, and money and ticker parsing stay at the new boundary. If the first slice does not cut the findings it produces, revisit this before the next one. A need to apply something instantly without waiting for a run would also reopen it.

### Consequences

- Good: a value is validated once, at the inbox, and the rest of the engine trusts one model.
- Good: a bad batch affects only itself, and `applied/` and `rejected/` are an audit trail.
- Good: no file is shared between the owner and the engine, so there are no conflicts over the input.
- Bad: a buy in a rejected batch is not watched until the owner fixes it, so a rejection must be visible in every digest.
- Bad: a corrupt state has no hand repair, so a documented and audited repair path is needed.
- Bad: "last valid configuration" needs a home and a warning while it is stale.
- Bad: the state write can lose a race and must retry; a run that keeps losing delays state, not stop detection.
- Bad: the new format is public, so later changes need a version and a migration again.

### Confirmation

A test proves that an invalid batch or configuration leaves the state untouched while the heartbeat still detects stops, and a check proves that `check` and `ingest` accept and refuse the same batches. Both name this ADR.

**Success measure**: at most 10 % of new tickets carry a cause in how stored data is read or written, and none of those is fixed outside the storage layer, over the 2 weeks after the work closes (an estimate of what is reachable, read from ticket labels and the files each fix touches).

## Pros and cons of the options

### Inbox folder of command batches

- Good: one file per batch needs no merge and isolates failures.
- Good: it repeats the pending-files and outbox pattern the engine already uses.
- Bad: "one file" becomes "one folder", with order by file name.

### One inbox file

- Good: the simplest thing for a person to learn.
- Bad: the owner, an AI and the engine all touch one file, the two-writer problem again.
- Bad: a typo blocks every command in it, and a buy in it stays unwatched.

### Commands on the command line

- Good: instant feedback.
- Bad: it needs a local install, can't be used from a phone, and adds the owner's machine as another writer.

### Abstraction layer over today's Markdown

- Good: smaller change, and no format change.
- Bad: hand edits keep each file as a two-writer contract.

### Last-valid fallback over today's portfolio file

- Good: cheapest way to keep risk watch running over a bad file.
- Bad: it keeps the two writers, the cause this decision addresses.

### Do nothing

- Good: no cost now.
- Bad: the cost grows with every feature.

## More information

GitHub Actions keeps one running and one pending run per concurrency group, and a newer pending run cancels the older one (platform behaviour as understood on 2026-11-02, not tested here). That is why risk watch takes no shared lock.

Doubt review (2026-11-02, fresh context, one round). Addressed: the shared concurrency group could cancel a heartbeat; "one writer" was false, since routines and the heartbeat also write state; one inbox file repeated the two-writer problem and blocked valid commands, which led to the inbox folder. Accepted, under _Bad_ consequences or _Confidence_: the figure does not prove the remedy; a repair path and the home of the last valid configuration are still to define. Rejected: the last-valid fallback alone, because it keeps the two writers.
