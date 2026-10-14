#!/usr/bin/env bash
# Pre-commit check: a commit that changes what the plugin ships must raise the
# version in .claude-plugin/plugin.json. `claude plugin update` only sees a
# change through the version.
set -euo pipefail

plugin_json=".claude-plugin/plugin.json"
# An install copies the whole repo, so every path ships but these docs and
# repo tooling: a new path needs a version raise until it is listed here.
changed=$(git diff --cached --name-only -- . \
  ':!README.md' ':!CLAUDE.md' ':!.gitignore' ':!.github' \
  ':!lefthook.yml' ':!mise.toml' ':!scripts' ':!.claude-plugin/marketplace.json')
[ -n "$changed" ] || exit 0

# HEAD has no plugin.json on the first commit: nothing to compare against.
head_version=$( (git show "HEAD:$plugin_json" 2>/dev/null || true) | jq -r '.version // empty')
[ -n "$head_version" ] || exit 0
staged_version=$(git show ":$plugin_json" | jq -r '.version')

if [ "$(printf '%s\n' "$head_version" "$staged_version" | sort -V | tail -1)" = "$head_version" ]; then
  echo "ERROR: plugin files changed, so $plugin_json must go above $head_version (it is $staged_version):"
  sed 's/^/  /' <<<"$changed"
  exit 1
fi
