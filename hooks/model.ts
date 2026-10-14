/**
 * The persona file and the filters it holds. Pure functions, so the tests
 * reach every rule without an engine.
 */

import type { CheckMark, CheckRow, CheckView } from '../types'

/**
 * Names a persona keeps (`allow`) or hides (`deny`); `*` matches any run of
 * characters. `quiet` names stay out of what the model is shown but may still
 * be called, for a skill another plugin's hook asks for by name.
 */
export type Filter = { [key in FilterKey]?: string[] }

const FILTER_KEYS = ['allow', 'deny', 'quiet'] as const
type FilterKey = (typeof FILTER_KEYS)[number]

export type Persona = {
  description?: string
  /** Text added to the end of the system prompt while the persona is active. */
  instructions?: string
  /** MCP servers, by the name /mcp shows (`claude.ai Gmail`) or the tool spelling (`claude_ai_Gmail`). */
  mcp?: Filter
  /** Skills, by the name the skill listing shows (`gideon:gideon`, `agent-browser`); `quiet` applies here. */
  skills?: Filter
  /** Subagent types (`Explore`, `claude-code-guide`). */
  agents?: Filter
  /** The color the band above the prompt draws the name in: a theme key (`success`) or a color (`cyan`, `#ff8800`). */
  color?: string
}

/**
 * `logins` names Claude logins by the config folder that holds each one
 * (`"work": "~/.claude-work"`, or `{ "folder": "~/.claude-work", "color": "magenta" }`);
 * `/persona login <name>` moves the session's requests to that login and keeps
 * everything else. `loginColors` holds the colors given.
 */
export type Config = {
  default?: string
  personas: Record<string, Persona>
  logins?: Record<string, string>
  loginColors?: Record<string, string>
}

export const EMPTY: Config = { personas: {} }

/** The shape of `logins`, for the messages that ask for one. */
export const LOGINS_SHAPE = '{ "<name>": "<config folder>" } or { "<name>": { "folder": "<config folder>", "color": "<color>" } }'

/** The names `/persona <name>` takes to turn every filter off. */
export const OFF = ['off', 'none']

/** The words `/persona <word>` runs as a command, so no persona can take them. */
export const COMMANDS = ['list', 'reload', 'debug', 'check', 'login', 'dump']

export function parseConfig(text: string): Config {
  const raw: unknown = JSON.parse(text)
  if (!isObject(raw) || !isObject(raw.personas)) {
    throw new Error('expected { "personas": { "<name>": { ... } } }')
  }
  const personas: Record<string, Persona> = {}
  for (const [name, value] of Object.entries(raw.personas)) {
    if (OFF.includes(name)) throw new Error(`"${name}" is reserved`)
    if (COMMANDS.includes(name)) throw new Error(`"${name}" is reserved: /persona ${name} runs a command. Rename the persona`)
    if (!isObject(value)) throw new Error(`persona "${name}" is not an object`)
    personas[name] = {
      description: optionalString(value.description, `${name}.description`),
      instructions: optionalString(value.instructions, `${name}.instructions`),
      mcp: optionalFilter(value.mcp, `${name}.mcp`),
      skills: optionalFilter(value.skills, `${name}.skills`),
      agents: optionalFilter(value.agents, `${name}.agents`),
      color: optionalColor(value.color, `${name}.color`),
    }
  }
  let logins: Record<string, string> | undefined
  let loginColors: Record<string, string> | undefined
  if (raw.logins !== undefined) {
    if (!isObject(raw.logins)) throw new Error(`logins must be ${LOGINS_SHAPE}`)
    logins = {}
    for (const [name, value] of Object.entries(raw.logins)) {
      const folder = isObject(value) ? value.folder : value
      if (typeof folder !== 'string' || folder === '') {
        throw new Error(`logins.${name} must be a config folder, or { "folder": ..., "color": ... }`)
      }
      logins[name] = folder
      const color = isObject(value) ? optionalColor(value.color, `logins.${name}.color`) : undefined
      if (color !== undefined) loginColors = { ...loginColors, [name]: color }
    }
  }
  const fallback = optionalString(raw.default, 'default')
  if (fallback !== undefined && !(fallback in personas)) {
    throw new Error(`default persona "${fallback}" is not defined`)
  }
  return { default: fallback, personas, logins, loginColors }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown, where: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${where} must be a string`)
  return value
}

function optionalColor(value: unknown, where: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${where} must be a color name or #rrggbb`)
  return value.trim()
}

function optionalFilter(value: unknown, where: string): Filter | undefined {
  if (value === undefined) return undefined
  if (!isObject(value)) throw new Error(`${where} must be { "allow": [...] } or { "deny": [...] }`)
  const list = (key: FilterKey) => {
    const names = value[key]
    if (names === undefined) return undefined
    if (!Array.isArray(names) || !names.every(n => typeof n === 'string')) {
      throw new Error(`${where}.${key} must be a list of names`)
    }
    return names as string[]
  }
  return { allow: list('allow'), deny: list('deny'), quiet: list('quiet') }
}

/** What this session has seen, hidden names included: MCP servers by their /mcp name, skills, agent types. */
export type Known = { mcp: readonly string[]; skills: readonly string[]; agents: readonly string[] }

const KIND_TITLES = { mcp: 'MCP servers', skills: 'Skills', agents: 'Agent types' } as const
const KINDS = Object.keys(KIND_TITLES) as (keyof Known)[]

/**
 * The filter names that match nothing the session has seen, as
 * `<persona>.<kind>.<key>: "<name>"`. A kind with nothing seen yet is left
 * out, so a session that has not sent a request flags nothing.
 */
export function unmatchedNames(config: Config, known: Known): string[] {
  return Object.entries(config.personas).flatMap(([name, persona]) =>
    KINDS.flatMap(kind => {
      // One glob as an allow filter: MCP names match in either spelling, as the filters do.
      const matches = (glob: string, seen: string) =>
        kind === 'mcp' ? isServerAllowed({ allow: [glob] }, seen) : isAllowed({ allow: [glob] }, seen)
      const names = known[kind]
      if (names.length === 0) return []
      return FILTER_KEYS.flatMap(key =>
        (persona[kind]?.[key] ?? [])
          .filter(glob => !names.some(seen => matches(glob, seen)))
          .map(glob => `${name}.${kind}.${key}: "${glob}"`),
      )
    }),
  )
}

/** The kinds with no name seen yet, which a check cannot hold filters to. */
function uncheckedKinds(known: Known): string[] {
  return KINDS.filter(kind => known[kind].length === 0).map(kind => KIND_TITLES[kind])
}

export function describeCheck(config: Config, known: Known, path: string, error?: string): string {
  const lines: string[] = []
  if (error !== undefined) lines.push(`${path}: ${error}`, '')
  lines.push('Names this session has seen, hidden ones included. Filters take these names, and * matches any run of characters.')
  for (const kind of KINDS) {
    const names = [...known[kind]].sort()
    lines.push(`${KIND_TITLES[kind]} (${names.length}): ${names.length === 0 ? 'none seen yet' : names.join(', ')}`)
  }
  lines.push(...checkFooter(uncheckedKinds(known), unmatchedNames(config, known), path))
  return lines.join('\n')
}

/** How a check ends, in the text and the pane alike: the kinds not checked, and the filter names that match nothing. */
export function checkFooter(unchecked: readonly string[], unmatched: readonly string[], path: string): string[] {
  const lines: string[] = []
  if (unchecked.length > 0) {
    lines.push(`Not checked, as none were seen yet: ${unchecked.join(', ')}. Send a prompt, then run /persona check again.`)
  }
  lines.push('')
  if (unmatched.length === 0) {
    lines.push(
      unchecked.length === 0
        ? `Every filter name in ${path} matches something.`
        : `Every checked filter name in ${path} matches something, but the check is not complete.`,
    )
  } else {
    lines.push(`Filter names in ${path} that match nothing:`, ...unmatched.map(row => `  ${row}`))
    lines.push('An MCP server that is not connected has no tools, so it is not seen.')
  }
  return lines
}

/** Characters a persona took out of the request: the skill listing, and the MCP tool names and instructions. */
export type Removed = { skills: number; mcp: number }

/** A token count, as `4.2k` or `730`. */
export function tokenCount(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`
}

/** About how many tokens some characters are, as `~4.2k` or `~730`. */
export function approxTokens(chars: number): string {
  return `~${tokenCount(Math.round(chars / 4))}`
}

/** The context's own lists, before any filter: each MCP tool, skill and custom agent, with its estimated tokens. */
export type ContextLists = {
  mcpTools: readonly { name: string; serverName: string; tokens: number }[]
  skills: readonly { name: string; tokens: number }[]
  agents: readonly { agentType: string; tokens: number }[]
}

/** How a persona treats a skill: hidden, kept in the listing, or callable but left out of it (quiet). */
function skillMark(filter: Filter | undefined, skill: string): CheckMark {
  return !isCallable(filter, skill) ? 'hidden' : isListed(filter, skill) ? 'kept' : 'quiet'
}

/** Each server's total over its tools, as `weight` counts a tool. */
function byServer<T extends { serverName: string }>(tools: readonly T[], weight: (tool: T) => number): Map<string, number> {
  const servers = new Map<string, number>()
  for (const tool of tools) servers.set(tool.serverName, (servers.get(tool.serverName) ?? 0) + weight(tool))
  return servers
}

/** Rows by tokens, most first. */
function byTokens(rows: CheckRow[]): CheckRow[] {
  return rows.sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name))
}

/** What the /persona check pane draws: how the active persona treats each name the context lists, and its tokens. */
export function checkView(
  config: Config,
  name: string | null,
  lists: ContextLists,
  known: Known,
  path: string,
  error?: string,
): CheckView {
  const persona = name === null ? undefined : config.personas[name]
  const groups = [
    {
      title: KIND_TITLES.mcp,
      rows: [...byServer(lists.mcpTools, tool => tool.tokens)].map(([server, tokens]): CheckRow => ({ name: server, tokens, mark: isServerAllowed(persona?.mcp, server) ? 'kept' : 'hidden' })),
    },
    { title: KIND_TITLES.skills, rows: lists.skills.map(skill => ({ name: skill.name, tokens: skill.tokens, mark: skillMark(persona?.skills, skill.name) })) },
    {
      title: KIND_TITLES.agents,
      rows: lists.agents.map((agent): CheckRow => ({ name: agent.agentType, tokens: agent.tokens, mark: isAllowed(persona?.agents, agent.agentType) ? 'kept' : 'hidden' })),
    },
  ].map(group => ({ ...group, rows: byTokens(group.rows) }))
  const rows = groups.flatMap(group => group.rows)
  const tokens = (rows: CheckRow[]) => rows.reduce((total, row) => total + row.tokens, 0)
  return { persona: name, total: tokens(rows), hidden: tokens(rows.filter(row => row.mark !== 'kept')), groups, unmatched: unmatchedNames(config, known), unchecked: uncheckedKinds(known), path, error }
}

/** The check's first line, as a title and what follows it: what the persona hides of the tokens the context lists. */
export function checkHeadline(view: CheckView): [title: string, detail: string] {
  return view.persona === null
    ? ['No persona', `every name kept, ~${tokenCount(view.total)} tokens`]
    : [`${view.persona} persona`, `hides ~${tokenCount(view.hidden)} of ~${tokenCount(view.total)} tokens`]
}

/** The check pane as text, for a session that does not draw panes. */
export function describeCheckTokens(view: CheckView): string {
  const [title, detail] = checkHeadline(view)
  const lines = [`${title}: ${detail}.`]
  for (const group of view.groups) {
    if (group.rows.length === 0) continue
    lines.push(`${group.title}:`, ...group.rows.map(row => `  ${row.mark.padEnd(6)} ${tokenCount(row.tokens).padStart(6)}  ${row.name}`))
  }
  return lines.join('\n')
}

/**
 * The section the mod adds to the end of /context: about how many tokens the
 * persona saves, and what it hides. /context counts skills and MCP
 * instructions before the persona filters them.
 */
export function describeContext(
  name: string,
  persona: Persona,
  known: Known,
  mcpTools: readonly { serverName: string }[],
  removed: Removed | null,
): string {
  const skills = [...known.skills].sort()
  const marked = (mark: CheckMark) => skills.filter(skill => skillMark(persona.skills, skill) === mark)
  const [shown, hidden, quiet] = [marked('kept').length, marked('hidden'), marked('quiet')]
  const servers = byServer(mcpTools.filter(tool => !isServerAllowed(persona.mcp, tool.serverName)), () => 1)
  const hiddenServers = [...servers].map(([server, tools]) => `${server} (${tools} tool${tools === 1 ? '' : 's'})`)
  const agents = known.agents.filter(agent => !isAllowed(persona.agents, agent)).sort()

  if (removed === null) {
    return `${name} persona is active. It shows the tokens it saves after the first request.`
  }
  const lines = [
    `${name} persona saves ${approxTokens(removed.skills + removed.mcp)} tokens. The counts above are from before it filters skills and MCP servers.`,
    `  Skills: ${approxTokens(removed.skills)} saved. ${shown} shown, ${hidden.length} hidden, ${quiet.length} quiet.`,
  ]
  if (hidden.length > 0) lines.push(`    Hidden: ${hidden.join(', ')}`)
  if (quiet.length > 0) lines.push(`    Quiet: ${quiet.join(', ')}`)
  lines.push(
    `  MCP: ${approxTokens(removed.mcp)} saved. ${hiddenServers.length === 0 ? 'No server hidden.' : `Hidden: ${hiddenServers.join(', ')}.`}`,
    `  Agent types: ${known.agents.length - agents.length} of ${known.agents.length} offered.${agents.length > 0 ? ` Hidden: ${agents.join(', ')}.` : ''}`,
  )
  return lines.join('\n')
}

/** A line that opens a listing entry, `- <name>: <text>`; group 1 is the name. */
const LISTING_ENTRY = /^- (\S+?):?(\s|$)/

/** The names of a listing, as `filterListing` reads them. */
export function listingNames(text: string): string[] {
  return text.split('\n').flatMap(line => LISTING_ENTRY.exec(line)?.[1] ?? [])
}

/** A listing entry that gives a skill's full name too, `- <name> (<full name>): <text>`. */
const LISTING_ALIAS = /^- (\S+) \((\S+?)\):/

/** Each skill's listing name by its full name, for the skills a listing names both ways. */
export function listingAliases(text: string): [full: string, name: string][] {
  return text.split('\n').flatMap(line => {
    const match = LISTING_ALIAS.exec(line)
    return match?.[1] !== undefined && match[2] !== undefined ? [[match[2], match[1]] as [string, string]] : []
  })
}

function globSource(glob: string): string {
  return glob
    .split('*')
    .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
}

function matchesAny(globs: string[], name: string): boolean {
  return globs.some(glob => new RegExp(`^${globSource(glob)}$`).test(name))
}

/** Whether a filter lets `name` through: no filter keeps everything. */
export function isAllowed(filter: Filter | undefined, name: string): boolean {
  if (filter === undefined) return true
  if (filter.allow !== undefined && !matchesAny(filter.allow, name)) return false
  if (filter.deny !== undefined && matchesAny(filter.deny, name)) return false
  return true
}

/** Whether the model is shown `name`: allowed, and not quiet. */
export function isListed(filter: Filter | undefined, name: string): boolean {
  return isAllowed(filter, name) && !(filter?.quiet !== undefined && matchesAny(filter.quiet, name))
}

/** Whether a call to `name` may run: allowed, or quiet. */
export function isCallable(filter: Filter | undefined, name: string): boolean {
  return isAllowed(filter, name) || (filter?.quiet !== undefined && matchesAny(filter.quiet, name))
}

/** A server's name as its tools spell it: `claude.ai Gmail` is `claude_ai_Gmail`. */
export function toolSpelling(server: string): string {
  return server.replace(/[^A-Za-z0-9_*-]/g, '_')
}

/**
 * Whether an MCP server, by its /mcp name or its tool spelling, passes the
 * filter. Both the name and the patterns are compared in the tool spelling, so
 * `claude.ai Gmail` and `claude_ai_Gmail` are one server to every rule.
 */
export function isServerAllowed(filter: Filter | undefined, server: string): boolean {
  if (filter === undefined) return true
  return isAllowed(spelledFilter(filter), toolSpelling(server))
}

function spelledFilter(filter: Filter): Filter {
  return { allow: filter.allow?.map(toolSpelling), deny: filter.deny?.map(toolSpelling) }
}

/**
 * Whether an MCP tool (`mcp__<server>__<tool>`) belongs to a server the filter
 * keeps. `server` is the server's name when the engine has said it. Without it,
 * the tool name is all there is, and a server name may hold `__` itself: a deny
 * that matches any possible server hides the tool, and an allow must match one.
 */
export function isMcpToolAllowed(filter: Filter | undefined, tool: string, server?: string): boolean {
  if (filter === undefined || !tool.startsWith('mcp__')) return true
  if (server !== undefined) return isServerAllowed(filter, server)
  const servers: string[] = []
  const rest = tool.slice('mcp__'.length)
  for (let at = rest.indexOf('__'); at > 0; at = rest.indexOf('__', at + 1)) {
    servers.push(rest.slice(0, at))
  }
  const { allow, deny } = spelledFilter(filter)
  if (deny !== undefined && servers.some(server => matchesAny(deny, server))) return false
  return allow === undefined || servers.some(server => matchesAny(allow, server))
}

/**
 * Drops hidden entries from a listing of `- <name>: <text>` lines. Lines that
 * do not open an entry belong to the entry above (a description that wraps);
 * lines before the first entry are kept.
 */
export function filterListing(text: string, isVisible: (name: string) => boolean): string {
  const kept: string[] = []
  let isKeeping = true
  for (const line of text.split('\n')) {
    const entry = LISTING_ENTRY.exec(line)
    if (entry?.[1] !== undefined) isKeeping = isVisible(entry[1])
    if (isKeeping) kept.push(line)
  }
  return kept.join('\n')
}

/**
 * Drops the lines of a tool list that name a hidden tool, then any heading
 * (`...available...:`) left with no names under it.
 */
export function filterToolNames(text: string, isVisible: (tool: string) => boolean): string {
  const lines = text.split('\n').filter(line => {
    const name = line.trim().replace(/^- /, '')
    return !name.startsWith('mcp__') || isVisible(name)
  })
  const isHeading = (line: string | undefined) => line !== undefined && /available.*:\s*$/.test(line)
  return lines
    .filter((line, at) => {
      if (!isHeading(line)) return true
      const below = lines.slice(at + 1).find(next => next.trim() !== '')
      return below !== undefined && !isHeading(below) && !below.startsWith('</')
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
}

/**
 * A ToolSearch `select:a,b` query without the hidden names: null when it
 * selects nothing else. Keyword queries pass as they are.
 */
export function visibleSelect(query: string, isVisible: (tool: string) => boolean): string | null {
  const select = /^\s*select:(.*)$/.exec(query)
  if (select?.[1] === undefined) return query
  const names = select[1].split(',').map(n => n.trim()).filter(Boolean)
  const kept = names.filter(isVisible)
  return kept.length === 0 ? null : `select:${kept.join(',')}`
}

const MCP_HEADING = '# MCP Server Instructions'

/**
 * Drops the `## <server>` blocks under the MCP instructions heading for
 * servers the filter hides, wherever in `text` the heading stands; the heading
 * goes too when no server is left. Null when nothing is left at all.
 */
export function filterMcpInstructions(text: string, filter: Filter | undefined): string | null {
  const at = text.indexOf(MCP_HEADING)
  if (filter === undefined || at < 0) return text
  const before = text.slice(0, at)
  const rest = text.slice(at)
  const end = rest.slice(1).search(/\n# (?!#)/)
  const part = end < 0 ? rest : rest.slice(0, end + 1)
  const after = end < 0 ? '' : rest.slice(end + 1)
  const [head = '', ...blocks] = part.split(/\n(?=## )/)
  const kept = blocks.filter(block => {
    const server = /^## (.+)/.exec(block)?.[1]?.trim()
    return server === undefined || isServerAllowed(filter, server)
  })
  const result = kept.length === 0 ? before + after.replace(/^\n/, '') : before + [head, ...kept].join('\n') + after
  return result.trim() === '' ? null : result
}

function expandHome(path: string, home: string): string {
  return path.replace(/^~(?=\/|$)/, home).replace(/\/+$/, '')
}

/**
 * The value of CLAUDE_SECURESTORAGE_CONFIG_DIR that reaches a config folder's
 * login: Claude Code files the login of ~/.claude under its plain name, which
 * an empty value selects, and any other folder's under that folder.
 */
export function loginStorage(folder: string, home: string): string {
  const path = expandHome(folder, home)
  return path === `${home}/.claude` ? '' : path
}

/**
 * Which named login a session's environment reaches: CLAUDE_SECURESTORAGE_CONFIG_DIR
 * when set, else the login of the config folder the session runs on.
 */
export function loginOf(
  logins: Record<string, string> | undefined,
  home: string,
  storage: string | undefined,
  configDir: string | undefined,
): string | undefined {
  if (logins === undefined) return undefined
  const current = storage !== undefined ? storage : configDir ? loginStorage(configDir, home) : ''
  return Object.keys(logins).find(name => loginStorage(logins[name] ?? '', home) === current)
}

/** What `claude auth status --json` says of a login: signed in, and on which plan. */
export function parseAuthStatus(stdout: string): { isSignedIn: boolean; plan?: string } | undefined {
  try {
    const status: unknown = JSON.parse(stdout)
    if (!isObject(status)) return undefined
    const plan = typeof status.subscriptionType === 'string' ? status.subscriptionType : undefined
    return { isSignedIn: status.loggedIn === true, plan }
  } catch {
    return undefined
  }
}

/**
 * The command that signs a login's folder in, for the person to run once. It
 * clears CLAUDE_SECURESTORAGE_CONFIG_DIR, which a per-folder setup may export
 * and which would otherwise send the sign-in to that login instead.
 */
export function signInCommand(storage: string): string {
  return storage === ''
    ? 'env -u CLAUDE_CONFIG_DIR -u CLAUDE_SECURESTORAGE_CONFIG_DIR claude auth login'
    : `env -u CLAUDE_SECURESTORAGE_CONFIG_DIR CLAUDE_CONFIG_DIR=${shellQuote(storage)} claude auth login`
}

function shellQuote(text: string): string {
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`
}

export type Request =
  | { kind: 'list' }
  | { kind: 'reload' }
  | { kind: 'debug' }
  | { kind: 'check' }
  | { kind: 'dump'; path?: string }
  | { kind: 'login'; name?: string }
  | { kind: 'switch'; name: string | null; isKeeping: boolean }

/** Reads `/persona` arguments: nothing, `reload`, `debug`, `check`, `dump [path]`, `login [name]`, or `<name> [--keep]`. */
export function parseArgs(args: string): Request {
  const words = args.trim().split(/\s+/).filter(Boolean)
  const isKeeping = words.includes('--keep')
  const name = words.find(w => !w.startsWith('--'))
  if (name === undefined || name === 'list') return { kind: 'list' }
  if (name === 'reload') return { kind: 'reload' }
  if (name === 'debug') return { kind: 'debug' }
  if (name === 'check') return { kind: 'check' }
  if (name === 'login') return { kind: 'login', name: words.filter(w => !w.startsWith('--'))[1] }
  if (name === 'dump') return { kind: 'dump', path: words.filter(w => !w.startsWith('--'))[1] }
  return { kind: 'switch', name: OFF.includes(name) ? null : name, isKeeping }
}

export function compactInstructions(name: string, persona: Persona): string {
  const about = persona.description ? ` (${persona.description})` : ''
  return [
    `The session is switching to the "${name}" persona${about}.`,
    'Keep what that work needs: goals, decisions, open tasks, file paths and commands that worked.',
    'Drop detail about tools and topics it will not use.',
  ].join(' ')
}

export function describeList(config: Config, active: string | null, path: string, error?: string): string {
  const lines: string[] = []
  if (error !== undefined) lines.push(`${path}: ${error}`)
  const names = Object.keys(config.personas)
  if (names.length === 0 && error === undefined) {
    lines.push(`No personas yet. Add them to ${path}.`)
  }
  if (names.length > 0) lines.push(`${names.length} in ${path}:`)
  for (const name of names) {
    const marker = name === active ? '*' : ' '
    const about = config.personas[name]?.description
    lines.push(`${marker} ${name}${about ? ` - ${about}` : ''}`)
  }
  if (names.length > 0) {
    lines.push('', active === null ? 'No persona is active.' : `Active: ${active}.`)
    lines.push('/persona <name> switches and compacts; add --keep to keep the conversation as it is.')
    lines.push('/persona check lists the names filters take and flags the ones that match nothing.')
  }
  return lines.join('\n')
}
