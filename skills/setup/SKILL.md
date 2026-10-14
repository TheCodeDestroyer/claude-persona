---
name: setup
description: Set up or change personas.json for the persona plugin - personas, the MCP server, skill and agent filters (allow, deny, quiet), logins for more than one Claude account, and a per-folder persona or login with mise. Use when the person wants to create, edit or fix their personas, add a login or account, asks which names go in a filter, or a filter hides the wrong thing.
---

# Set up personas.json

## 1. Find the file

The plugin reads `$CLAUDE_CONFIG_DIR/personas.json` if it exists, else `~/.claude/personas.json`. Read the file before you change it. Two levels above this file, in the plugin's folder:

- `personas.example.json`: a starting file. Copy it if there is no file yet. Keep its `$schema` line, so editors complete and check the file.
- `personas.schema.json`: every field and filter key, and what each one does. Read it before you write.

## 2. Get the real names

Filters only work with exact names. Do not guess them, and do not use the skill or tool names in your own prompt: the active persona hides some of them from you.

- If `/persona check` output is not already in the conversation, ask the person to run `/persona check`. You cannot run slash commands. The output lists every MCP server, skill and agent type the session has seen, hidden ones included, and the filter names that match nothing.
- If a kind shows "none seen yet", ask the person to send one prompt, then run `/persona check` again.
- An MCP server that is not connected has no tools, so it is not in the list. `/mcp` shows all servers.

## 3. Ask what each persona is for

Ask only for what the person has not told you: the persona names, and what work each one does. Then pick the filters.

## 4. Write the personas

Follow `personas.schema.json`. Also:
- A field you leave out keeps everything of that kind.
- `off`, `none` and the command words (`list`, `reload`, `debug`, `check`, `login`, `dump`) are not valid persona names.
- Use `allow` for a narrow persona (brainstorm, docs). Use `deny` for a broad one (dev).
- Use `quiet` for a skill that a hook or another skill calls by name: it stays out of the listing, but a call still works.
- An `allow` list for skills hides this skill too. Add `"persona:setup"` to it, or tell the person that `/persona off` brings it back.

## 5. Logins (more than one Claude account)

Each login is a config folder that holds one sign-in:

```json
"logins": {
  "personal": { "folder": "~/.claude", "color": "blue" },
  "work": { "folder": "~/.claude-work", "color": "#ff8800" }
}
```

- The short form `"work": "~/.claude-work"` also works.
- Each folder other than `~/.claude` must be signed in once. Ask the person to run it themselves (`!` before the command runs it in this session): `CLAUDE_CONFIG_DIR=~/.claude-work claude auth login`.
- Never set `CLAUDE_CONFIG_DIR` to `~/.claude`. Claude Code then reports that the person is signed out.
- `/persona login <name>` moves a running session to that login. It works only on a personal (Pro or Max) login, not on Team or Enterprise.

## 6. A persona and login per folder

To start every session in a folder with a given persona and login, add a `mise.toml` to that folder:

```toml
[env]
CLAUDE_PERSONA = "dev"
CLAUDE_SECURESTORAGE_CONFIG_DIR = "{{env.HOME}}/.claude-work"
```

- The person runs `mise trust` in that folder once.
- `CLAUDE_SECURESTORAGE_CONFIG_DIR` changes only the login. It is an internal Claude Code variable, so a future release can break it. The supported choice is `CLAUDE_CONFIG_DIR`, but that also moves plugins, settings and history, so the plugin must be installed in that folder too.
- With direnv, the same lines go in `.envrc` as `export NAME=value`.

## 7. Check the result

Ask the person to run `/persona reload`, then `/persona check`. Fix each name that matches nothing, until the check reports that every filter name matches something.
