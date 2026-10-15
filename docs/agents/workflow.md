# Agent workflow

This repo uses the GitHub-native workflow from `~/.claude/skills/github-*`
(design: [ADR 0001](https://github.com/alvaromongon/claude-config/blob/main/docs/decisions/0001-github-driven-triage-refinement-and-autonomous-implementation.md)
and [ADR 0004](https://github.com/alvaromongon/claude-config/blob/main/docs/decisions/0004-three-layer-baseline-decisions-shaping-implementation.md)
in `claude-config`). A `spec` issue holds the shaped what and why; its milestone is the epic;
issues are tracer-bullet tickets; blocking dependencies are GitHub's native issue-blocking
relations.

## Cycle

0. **Shape** (`github-shape`) — the owner's idea becomes a `spec` issue (problem, why it matters,
   success metric, appetite, options, not doing); open questions are `decision` issues that block
   it. Skipped for work that is already bounded. When the milestone closes, the spec is closed
   with the metric checked against its target.
1. **Triage** (`github-triage`) — incoming issues start `needs-triage`. Classified into
   `needs-info`, `ready-for-agent`, `ready-for-human`, or closed `wontfix`. External PRs are
   reviewed as text and never checked out or run on the host.
2. **Refine** (`github-refine`) — a spec with a success metric (a `spec` issue, or a bounded change stating its metric) is broken into tracer-bullet issues with
   blocking edges (GitHub's native issue dependencies), each ending up `ready-for-agent` or
   `ready-for-human`.
3. **Implement** (`github-implement`) — one `ready-for-agent` issue at a time, TDD, in an
   isolated subagent; ends with a pushed branch and an open PR.
4. **Review** — two separate subagents review the PR's branch in parallel, each in its own git
   worktree, report-only: `code-review` (correctness) and `security-review` (security). One fix
   round if either finds blocking issues.
5. **Work queue** (`github-work-queue`) — orchestrates steps 3-4 sequentially over the
   `ready-for-agent` backlog, waits for CI, merges, and escalates individual tickets to a human
   when needed (see below) without stopping the rest of the queue.

## Autonomy

Per-issue, via labels:

- `ready-for-agent`: the agent may implement it without asking after every step.
- `ready-for-human`: needs supervision; the work queue skips it.

Per repo:

- **Unattended merge**: no — `yes`: the work queue merges once both reviews and
  CI are green; `no`: it stops at "ready for your review" and moves on to the next ticket. With
  `no`, waiting PRs can conflict with each other once you merge one: merge one, then re-run the
  work queue — it refreshes the conflicting ones (merges the default branch in, re-reviews) and
  leaves them ready for review again.
- **Push policy**: see `CLAUDE.md` › _Push and merge policy_ (enforced by `.claude/settings.json`).

## Intake

New issues come through the issue forms in `.github/ISSUE_TEMPLATE/`, which apply
`needs-triage`. When the reporter answers a `needs-info` issue, the `needs-info-reply` workflow
moves it back to `needs-triage`; GitHub notifies the maintainers of the reply as usual.

## Escalation triggers

The work queue stops working on a ticket — leaves its branch/PR as-is, relabels it
`ready-for-human` with a comment explaining why — and moves on to the next one when:

- tests don't stabilize after 3 attempts,
- acceptance criteria turn out ambiguous mid-implementation,
- the change touches a sensitive area — trading rules and position sizing (`src/utils/sizing.ts`, eligibility, setups, stops), the input data format and its `schema_version`, secrets and email delivery, CI and the reusable workflows —
  not listed in the brief's _Sensitive areas_,
- the issue lacks the `ready-for-agent` label or still has an open blocker,
- the review fix round didn't produce a clean review.

## Overrides for this repo

None.
