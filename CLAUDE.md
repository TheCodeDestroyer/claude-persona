# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

## Build & Test

```bash
claude plugin validate .   # manifest, marketplace and hooks module
claude plugin test .       # hooks/persona.test.ts
claude --plugin-dir .      # try it in a session
mise run check             # validate + test
```

A commit that changes `hooks/`, `types/`, `personas.example.json` or `tsconfig.json` must raise `version` in `.claude-plugin/plugin.json` and the same `version` in `.claude-plugin/marketplace.json` (pre-commit hook, `scripts/check-version-bump.sh`).

## Architecture Overview

A Claude Code mod (2.1.299+), no build step. `hooks/register.tsx` holds the hooks; `hooks/model.ts` holds pure functions (config parsing, filters, args) so tests reach them without an engine. See README.md "How it works".

## Conventions & Patterns

- Helpers that call `$` stay at the top level: the validator refuses `$` passed into inner closures.
- `$.session.compact` is refused inside `command.run`; it runs through `$.clock.after`.
- Never set `CLAUDE_CONFIG_DIR` to `~/.claude` explicitly: Claude Code then reports signed out.
- On Team/Enterprise logins the built-in `sec-default` guard skips `prompt.attachment`/`prompt.compose` for user mods and refuses `env.set` of login variables.
