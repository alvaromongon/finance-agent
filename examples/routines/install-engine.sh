#!/usr/bin/env bash
# Example SessionStart hook: installs the Finance Agent engine at a pinned tag.
# Copy it to .claude/hooks/install-engine.sh in your data repository and register it as a
# SessionStart hook (docs/routine-runner.md). Change ENGINE_REF to upgrade the engine.
set -euo pipefail

ENGINE_REPOSITORY="${ENGINE_REPOSITORY:-https://github.com/alvaromongon/finance-agent.git}"
ENGINE_REF="${ENGINE_REF:-v0.1.0}"
ENGINE_DIR="${ENGINE_DIR:-$HOME/finance-agent-engine}"

if [ -d "$ENGINE_DIR/.git" ]; then
  git -C "$ENGINE_DIR" fetch --depth 1 origin "tag" "$ENGINE_REF"
  git -C "$ENGINE_DIR" checkout --force "$ENGINE_REF"
else
  git clone --depth 1 --branch "$ENGINE_REF" "$ENGINE_REPOSITORY" "$ENGINE_DIR"
fi

cd "$ENGINE_DIR"
npm ci --no-audit --no-fund

# Fail the session start loudly if the engine cannot run: the prompts assume it works.
npx tsc --version >/dev/null
echo "Finance Agent engine $ENGINE_REF installed in $ENGINE_DIR"
