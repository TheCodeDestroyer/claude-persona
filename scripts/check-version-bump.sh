#!/usr/bin/env bash
# Pre-commit check: a commit that changes what the plugin ships must raise the
# version in .claude-plugin/plugin.json, and marketplace.json must list the
# same version. `claude plugin update` only sees a change through the version.
set -euo pipefail

plugin_json=".claude-plugin/plugin.json"
marketplace_json=".claude-plugin/marketplace.json"
# What an install copies and runs. Docs and repo tooling are left out.
shipped='^(hooks/|types/|personas\.example\.json$|tsconfig\.json$)'

staged=$(git diff --cached --name-only)
version_of() { jq -r "$2" 2>/dev/null <<<"$1" || true; }

staged_plugin=$(git show ":$plugin_json")
staged_version=$(version_of "$staged_plugin" '.version')
listed_version=$(version_of "$(git show ":$marketplace_json")" '.plugins[] | select(.name == "persona") | .version')

exit_code=0

if [ "$listed_version" != "$staged_version" ]; then
  echo "ERROR: $marketplace_json lists persona $listed_version, but $plugin_json says $staged_version"
  exit_code=1
fi

if grep -Eq "$shipped" <<<"$staged"; then
  head_version=$(version_of "$(git show "HEAD:$plugin_json" 2>/dev/null || true)" '.version')
  if [ -n "$head_version" ]; then
    highest=$(printf '%s\n%s\n' "$head_version" "$staged_version" | sort -V | tail -1)
    if [ "$staged_version" = "$head_version" ] || [ "$highest" != "$staged_version" ]; then
      echo "ERROR: plugin files changed, so $plugin_json must go above $head_version (it is $staged_version). Raise the version in both files:"
      grep -E "$shipped" <<<"$staged" | sed 's/^/  /'
      exit_code=1
    fi
  fi
fi

exit $exit_code
