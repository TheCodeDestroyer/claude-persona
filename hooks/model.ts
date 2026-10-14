/**
 * The persona file and the filters it holds. Pure functions, so the tests
 * reach every rule without an engine.
 */

/**
 * Names a persona keeps (`allow`) or hides (`deny`); `*` matches any run of
 * characters. `quiet` names stay out of what the model is shown but may still
 * be called, for a skill another plugin's hook asks for by name.
 */
export type Filter = { allow?: string[]; deny?: string[]; quiet?: string[] }

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

/** The names `/persona <name>` takes to turn every filter off. */
export const OFF = ['off', 'none']

export function parseConfig(text: string): Config {
  const raw: unknown = JSON.parse(text)
  if (!isObject(raw) || !isObject(raw.personas)) {
    throw new Error('expected { "personas": { "<name>": { ... } } }')
  }
  const personas: Record<string, Persona> = {}
  for (const [name, value] of Object.entries(raw.personas)) {
    if (OFF.includes(name)) throw new Error(`"${name}" is reserved`)
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
    if (!isObject(raw.logins)) throw new Error('logins must be { "<name>": "<config folder>" }')
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
  const list = (key: 'allow' | 'deny' | 'quiet') => {
    const names = value[key]
    if (names === undefined) return undefined
    if (!Array.isArray(names) || !names.every(n => typeof n === 'string')) {
      throw new Error(`${where}.${key} must be a list of names`)
    }
    return names as string[]
  }
  return { allow: list('allow'), deny: list('deny'), quiet: list('quiet') }
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
 * Whether an MCP tool (`mcp__<server>__<tool>`) belongs to a server the filter
 * keeps. A server name may hold `__` itself, so every split is tried.
 */
export function isMcpToolAllowed(filter: Filter | undefined, tool: string): boolean {
  if (filter === undefined || !tool.startsWith('mcp__')) return true
  const servers: string[] = []
  const rest = tool.slice('mcp__'.length)
  for (let at = rest.indexOf('__'); at > 0; at = rest.indexOf('__', at + 1)) {
    servers.push(rest.slice(0, at))
  }
  const spelled: Filter = {
    allow: filter.allow?.map(toolSpelling),
    deny: filter.deny?.map(toolSpelling),
  }
  return servers.some(server => isAllowed(spelled, server))
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
    const entry = /^- (\S+?):?(\s|$)/.exec(line)
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
    return server === undefined || isAllowed(filter, server) || isAllowed(filter, toolSpelling(server))
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

/** The command that signs a login's folder in, for the person to run once. */
export function signInCommand(storage: string, folder: string): string {
  return storage === '' ? 'env -u CLAUDE_CONFIG_DIR claude auth login' : `CLAUDE_CONFIG_DIR=${folder} claude auth login`
}

export type Request =
  | { kind: 'list' }
  | { kind: 'reload' }
  | { kind: 'debug' }
  | { kind: 'dump'; path?: string }
  | { kind: 'login'; name?: string }
  | { kind: 'switch'; name: string | null; isKeeping: boolean }

/** Reads `/persona` arguments: nothing, `reload`, `debug`, `dump [path]`, `login [name]`, or `<name> [--keep]`. */
export function parseArgs(args: string): Request {
  const words = args.trim().split(/\s+/).filter(Boolean)
  const isKeeping = words.includes('--keep')
  const name = words.find(w => !w.startsWith('--'))
  if (name === undefined || name === 'list') return { kind: 'list' }
  if (name === 'reload') return { kind: 'reload' }
  if (name === 'debug') return { kind: 'debug' }
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
  }
  return lines.join('\n')
}
