# CLAUDE.md

Guidance for Claude Code in this repository. The [README](README.md) is the single source of
truth for what the project is, how to run it and its design decisions; this file only adds what
an agent needs on top of it.

## Working here

- Agent workflow (issues, labels, autonomy): [docs/agents/workflow.md](docs/agents/workflow.md).
- Local quality gate: the same checks as CI (see README › _Development_). Run it before pushing.
- Code, comments, docs and issues in English. Engine output is localized with `OUTPUT_LANGUAGE`.
- The input data format (`docs/input-format.md`) is a public, versioned contract: an
  incompatible change bumps `schema_version` and ships a migration.

## Push and merge policy

Agents may push `issue-*` branches and open PRs. The work queue (`/github-work-queue`) may merge
a PR with `gh pr merge --squash` once both reviews are clean and CI is green
([Unattended merge](docs/agents/workflow.md#autonomy)). Outside the work queue, merging is done by
the owner. Ask before any other push; never merge with `--admin`.
