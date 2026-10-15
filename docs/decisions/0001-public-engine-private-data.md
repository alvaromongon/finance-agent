---
status: Accepted
date: 2026-10-15
decision-makers: Repository owner
---

# 0001. Public engine, private data: the user's repo calls reusable workflows pinned to a tag

- **Issue**: initial publication (v0.1.0)

**Decision**: the engine lives in this public repository. Each user keeps their data (portfolio, watchlist, theses, logs) in their own repository, which runs the engine through this repo's reusable workflows pinned to a release tag. Upgrading means changing that tag.

## Context and problem statement

The engine was born inside a private notes repository, next to the owner's portfolio and decision log. Publishing it means separating code from data. Both still have to work together: the engine writes notes that the user reads in their own tools, for example Obsidian.

**Why it matters**: anyone can then configure and run the engine without seeing someone else's positions. The owner's data, including commits that mention positions and amounts, never becomes public.

## Decision drivers

- Nothing personal in the public repo, neither in the code nor in its history.
- The user's notes stay where the user reads them.
- Upgrading the engine has to be explicit and reversible.
- The engine must not need write access to the data repository.

## Considered options

- Keep everything in one private repository (do nothing).
- A public repo plus a private fork holding the data.
- A public engine consumed by a private data repo through reusable workflows pinned to a tag.
- A public engine plus a separate data repository that is not the user's notes.

## Decision outcome

Chosen option: "public engine consumed through reusable workflows pinned to a tag". It keeps data out of the public history. The user's notes remain the data. Each upgrade is a one-line change of tag.

**What we give up**: the input format becomes a public contract, with versions and migrations ([ADR-0003](0003-state-as-versioned-markdown.md)). A change to the format now spans two repositories: release a tag here, then update the data repo.

**Scope**: this repository, every data repository that calls its workflows, and the people who run them.

**Confidence**: high. We would revisit if GitHub dropped cross-repository `workflow_call`, or if most users preferred a packaged CLI to GitHub Actions.

### Consequences

- Good: the reusable workflows run the engine with `contents: read` and return the changes as a patch artifact. The calling workflow decides what to commit.
- Good: the public history starts from a reviewed copy, not from a filtered history.
- Bad: two repos to coordinate on every format change.
- Bad: the engine assumes two currency silos (EUR and USD), inherited from the original deployment.

### Confirmation

The workflows in `.github/workflows/` declare `on: workflow_call` and `permissions: contents: read`. `gitleaks` ran on the content before the first push.

**Success measure**: a data repository upgrades the engine by changing only the `engine-ref` tag. Verified by the owner's own data repository when it switches to the tag.

## Pros and cons of the options

### One private repository

- Good: no cost, and format and code change in the same commit.
- Bad: cannot be published, and it mixes notes with code.

### Public repo and private fork

- Bad: GitHub does not allow private forks of public repositories. It would need a manual mirror that drifts.

### Separate data repository that is not the notes

- Good: separates data from both code and notes.
- Bad: loses the main value: reading what the agent writes in the user's own notes.

## More information

Retroactive record of a decision taken on 2026-09-30 in the private repository this engine was extracted from.
