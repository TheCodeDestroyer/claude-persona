# claude-persona

A Claude Code mod that gives each session only the tools it needs.

A persona is a named set of MCP servers, skills and agents. When a persona is active, the mod hides everything else from the model, adds the persona's own instructions, and shows the persona above the prompt:

```
── dev persona · work login ────────────────────────────────
❯
```

With many plugins installed, most of the start-up context is tool and skill descriptions that the current task never uses. In one test session, switching to a small persona changed the first request like this:

| Part of the request | No persona | `brainstorm` persona |
| --- | --- | --- |
| Skills in the listing | 62 (~7,100 tokens) | 6 (~560 tokens) |
| Agent types | 6 | 2 |
| MCP server instructions | ~680 tokens | removed |
| MCP tool names in the deferred list | 10 | 0 |
| **Total** | **~8,700 tokens** | **~1,000 tokens** |

Requires Claude Code 2.1.299 or later (mods).

## Install

At the prompt of a terminal session:

```
/plugin install persona --marketplace TheCodeDestroyer/claude-persona
```

From a shell:

```sh
claude plugin install persona --marketplace TheCodeDestroyer/claude-persona
```

Answer `y` to add the marketplace, then pick a scope (user scope is the usual choice).

In the desktop app: click **+** next to the prompt box, then **Plugins** → **Add marketplace** with `TheCodeDestroyer/claude-persona`, then **Add plugin**.

## Quick start

1. Copy the example file to your config folder:
   ```sh
   cp personas.example.json ~/.claude/personas.json
   ```
2. Run `/persona check`. It lists the names of your MCP servers, skills and agents, and the names in the file that match nothing. Edit the file to match.
3. Run `/persona reload`, then `/persona` to list the personas, and `/persona dev` to switch.

Or ask Claude to set it up: the `persona:setup` skill knows the file format, the logins and the per-folder setup, and reads the names from `/persona check`.

## Commands

| Command | What it does |
| --- | --- |
| `/persona` | Lists the personas and shows which one is active. |
| `/persona <name>` | Switches to that persona and compacts the conversation for it. |
| `/persona <name> --keep` | Switches without compacting. |
| `/persona off` | Turns the persona off. Everything is available again. |
| `/persona login` | Lists the logins. |
| `/persona login <name>` | Moves the next request to that login (see [Logins](#logins)). |
| `/persona check` | Lists the MCP servers, skills and agent types the session has seen, hidden ones too, and the filter names that match nothing. Claude reads the list too. |
| `/persona reload` | Reads `personas.json` again. |
| `/persona debug` | Shows how many tokens the mod removed from each part of the request. |
| `/persona dump [path]` | Writes the last request, as the mod sees it, to a file (default `persona-dump.txt` in your config folder). It holds the whole conversation.. |

A session starts with the persona in the `CLAUDE_PERSONA` environment variable, or else the file's `default`.

## personas.json

The mod reads `$CLAUDE_CONFIG_DIR/personas.json` first, and then `~/.claude/personas.json`. That way a work config folder can keep its own file.

```json
{
  "$schema": "https://raw.githubusercontent.com/TheCodeDestroyer/claude-persona/main/personas.schema.json",
  "default": "dev",
  "personas": {
    "dev": {
      "description": "coding in a repo",
      "instructions": "This session is for writing and reviewing code.",
      "color": "cyan",
      "mcp": { "allow": ["plugin:context7:context7"] },
      "skills": { "deny": ["anthropic-skills:*"], "quiet": ["my-plugin:save-session"] },
      "agents": { "deny": ["claude-code-guide"] }
    }
  },
  "logins": {
    "personal": { "folder": "~/.claude", "color": "blue" },
    "work": { "folder": "~/.claude-work", "color": "#ff8800" }
  }
}
```

### Persona fields

| Field | What it does |
| --- | --- |
| `description` | Shown by `/persona`, and used to guide compaction. |
| `instructions` | Added to the end of the system prompt while the persona is active. |
| `color` | Color of the persona name above the prompt. |
| `mcp` | Filter for MCP servers, by the name `/mcp` shows (`claude.ai Gmail`, `plugin:context7:context7`). |
| `skills` | Filter for skills, by the name the skill listing shows (`my-plugin:my-skill`, `agent-browser`). |
| `agents` | Filter for subagent types (`Explore`, `general-purpose`). |

A field you leave out keeps everything of that kind.

### Filters

| Key | What it does |
| --- | --- |
| `allow` | Keep only these names. `[]` hides all of them. |
| `deny` | Hide these names. |
| `quiet` | Skills only. Not in the listing, so they cost no tokens, but a call still works. Use this for a skill that a hook or another skill calls by name. |

`*` matches any run of characters: `"ops:*"` matches every skill of the `ops` plugin.

### Colors

A color is a name (`cyan`), a hex value (`#ff8800`), or a theme key (`success`, `warning`, `claude`, `suggestion`). Theme keys follow your light or dark theme. If you set no color, the persona is `claude` (orange) and the login is `suggestion` (blue).

## Per-folder setup with mise

Install everything once in `~/.claude`, and let each folder pick its persona and login through environment variables. Any tool that sets environment variables per folder works. This example uses [mise](https://mise.jdx.dev).

**1. Sign the second login in once.** Each login needs a folder that holds its sign-in:

```sh
CLAUDE_CONFIG_DIR=~/.claude-work claude auth login
```

**2. Name the login in `~/.claude/personas.json`**, so the status row can show it:

```json
"logins": {
  "personal": { "folder": "~/.claude", "color": "blue" },
  "work": { "folder": "~/.claude-work", "color": "#ff8800" }
}
```

**3. Add a `mise.toml` at the top of your work projects**

```toml
# ~/Work/acme/mise.toml
[env]
CLAUDE_PERSONA = "dev"
CLAUDE_SECURESTORAGE_CONFIG_DIR = "{{env.HOME}}/.claude-work"
```

Run `mise trust` in that folder once. With mise active in your shell (`eval "$(mise activate zsh)"`), every `claude` you start under `~/Work/acme` starts in the `dev` persona, on the work login. Plugins, settings, history and `personas.json` stay the ones in `~/.claude`.

To check which login a folder gets:

```sh
cd ~/Work/acme && claude auth status
```

Things to know:
- `CLAUDE_SECURESTORAGE_CONFIG_DIR` is an internal Claude Code variable that picks only the login. A future release can break it. If it breaks, use the supported way below.
- `claude auth status` shows the plan of the work login, but the email and organization name come from `~/.claude`.
- Because the login is set before Claude Code starts, a Team or Enterprise login gets its organization's policies, as usual. See [Team and Enterprise logins](#team-and-enterprise-logins) for what that means for the mod.
- The app versions of Claude Code that you start from the Dock do not read your shell, so they do not get mise variables.
- With [direnv](https://direnv.net), the same lines go in `.envrc` as `export NAME=value`.

### The supported way: a separate config folder

`CLAUDE_CONFIG_DIR` is the setting Claude Code documents. It moves everything, not only the login: the folder has its own plugins, settings and history. Install the mod there as well:

```toml
[env]
CLAUDE_PERSONA = "dev"
CLAUDE_CONFIG_DIR = "{{env.HOME}}/.claude-work"
```

```sh
CLAUDE_CONFIG_DIR=~/.claude-work claude plugin install persona --marketplace TheCodeDestroyer/claude-persona
```

The mod reads `~/.claude-work/personas.json` if it exists, and `~/.claude/personas.json` if not.

Do not set `CLAUDE_CONFIG_DIR` to `~/.claude`. Claude Code then looks for the login in a different place and reports that you are signed out. To use the default folder, leave the variable unset.

## Logins

`/persona login <name>` moves the session's requests to the login of another config folder. Settings, plugins and history stay the same; only the account that pays changes. This is useful to move a long session to the account with more usage left.

- Before it switches, the mod runs `claude auth status` for that login. A login with no sign-in is refused, and the reply gives the sign-in command.
- The status above the prompt shows the current login.
- Each switch costs one prompt-cache miss.
- A resumed session goes back to the login it last switched to.

Limits:
- It uses `CLAUDE_SECURESTORAGE_CONFIG_DIR`, which is an internal Claude Code variable. A future release can break it.
- It works only while the session runs on a personal (Pro or Max) login. See the next section.
- To start a folder on a given login, use the [mise setup](#per-folder-setup-with-mise) instead. It is set before Claude Code starts, so it also works for Team logins.

## Team and Enterprise logins

Claude Code has a built-in guard (`sec-default`). It turns on when the session runs on a Team or Enterprise login, or on a machine with managed settings. The guard stops plugins that a person installs from changing some parts of the request. Under it:

| Feature | Works? |
| --- | --- |
| Hiding MCP tools behind ToolSearch | Yes, except servers and agents the organization manages |
| Refusing calls to hidden tools and skills | Yes |
| Hiding agent types | Yes, except servers and agents the organization manages |
| Status above the prompt | Yes |
| Removing hidden MCP tool names from the deferred list | No |
| Hiding skills from the skill listing | No |
| Removing MCP instructions of hidden servers | No |
| Persona instructions in the system prompt | No (they are still sent once, when you switch) |
| `/persona login` | No |

Only the organization's managed settings can change this.

## How it works

| What the model sees | How the mod changes it |
| --- | --- |
| MCP tools | A hidden server's tools are moved behind ToolSearch (`tool.describe`). Their names are removed from the deferred tool list (`prompt.attachment`). |
| ToolSearch results | Hidden tools are removed from search results. A `select:` of a hidden tool is refused (`tool.call`). |
| MCP server instructions | The instructions of hidden servers are removed (`prompt.compose`, `prompt.attachment`). |
| Skill listing | Hidden and quiet skills are removed (`prompt.attachment`). A call to a hidden skill is refused. |
| Agent types | Hidden types are not offered (`agent.offer`). |
| System prompt | The persona's `instructions` are added at the end (`prompt.compose`). |

The mod hides; it does not unload. Hidden MCP servers stay connected, and `/persona off` brings everything back at once.

Things to know:
- `/context` reads Claude Code's own lists, not the filtered request, so it shows more than is sent. Use the token count in your status line or `/persona debug`.
- The request's tool list still names hidden MCP tools as deferred, because a mod cannot change that list. The model cannot find them with ToolSearch or call them.
- The status row shows in the terminal and the desktop app, not in VS Code or on mobile.

## Development

```sh
claude plugin validate .        # check the manifest and the hooks module
claude plugin test .            # run hooks/persona.test.ts
claude --plugin-dir .           # start a session with this folder loaded
```

`tsc -p .` type-checks the mod once Claude Code has loaded it, because loading writes the types to `.claude-plugin/types/`.

Git hooks come from [lefthook](https://lefthook.dev). `mise` installs it and `jq` (which the pre-commit check reads `plugin.json` with) when you enter the folder (run `mise trust` once):

- **pre-commit:** a change to what the plugin ships (every path but the docs and repo tooling that `scripts/check-version-bump.sh` lists) must raise `version` in `.claude-plugin/plugin.json`. `claude plugin update` sees a new release only through the version.
- **pre-push:** `mise run check` (`claude plugin validate .` and `claude plugin test .`).

| File | What it holds |
| --- | --- |
| `hooks/register.tsx` | The hooks: the command, the filters, the status row. |
| `hooks/model.ts` | Pure functions: config parsing, filters, argument parsing. |
| `hooks/persona.test.ts` | Tests against a mocked engine. |
| `types/index.d.ts` | The mod's session state. |
| `skills/setup/SKILL.md` | The `persona:setup` skill: how to write `personas.json`. |
| `personas.example.json` | A starting `personas.json`. |
| `personas.schema.json` | The JSON schema of `personas.json`, for editors. |
