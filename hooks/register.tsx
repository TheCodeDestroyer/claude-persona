import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CheckMark, PersonaView } from '../types'

import {
  approxTokens,
  checkFooter,
  checkHeadline,
  checkView,
  compactInstructions,
  type Config,
  type ContextLists,
  describeCheck,
  describeCheckTokens,
  describeContext,
  describeList,
  EMPTY,
  filterListing,
  filterMcpInstructions,
  filterToolNames,
  isAllowed,
  isCallable,
  isListed,
  isMcpToolAllowed,
  type Known,
  listingAliases,
  listingNames,
  LOGINS_SHAPE,
  loginOf,
  loginStorage,
  visibleSelect,
  type Persona,
  parseArgs,
  parseAuthStatus,
  parseConfig,
  type Removed,
  signInCommand,
  tokenCount,
} from './model'

const ACTIVE = { plugin: 'persona', key: 'active' } as const
const LOGIN = { plugin: 'persona', key: 'login' } as const
const VIEW = atom({ plugin: 'persona', key: 'view' } as const, null)
const CHECK = atom({ plugin: 'persona', key: 'check' } as const, null)
const CHECK_PANE = 'persona-check'
/** How the check pane marks each row: theme keys, so they follow the person's theme. */
const MARKS: Record<CheckMark, { glyph: string; color: string }> = {
  kept: { glyph: '✓', color: 'success' },
  quiet: { glyph: '◌', color: 'warning' },
  hidden: { glyph: '✗', color: 'inactive' },
}
/** Colors for a persona or login that names none: theme keys, so they follow the person's theme. */
const PERSONA_COLOR = 'claude'
const LOGIN_COLOR = 'suggestion'
const COMPACT_DELAY_MS = 100

/**
 * The server of each MCP tool, as `tool.describe` names it (`mcp:<server>`), so a
 * filter need not guess where the server name ends inside the tool name.
 */
const mcpServers = new Map<string, string>()

/** Skills and agent types the engine offered, hidden ones too, for `/persona check`. */
const knownSkills = new Set<string>()
const knownAgents = new Set<string>()
/** A skill's listing name, which filters take, by the full name the context counts it under. */
const skillNames = new Map<string, string>()

/**
 * The context's lists before the persona filters them, under the names filters take;
 * estimated locally, so no request is sent. The context spells servers as tools do,
 * so a server `tool.describe` named keeps its /mcp name.
 */
async function contextLists($: EngineInterface): Promise<ContextLists> {
  const { breakdown } = (await $.session.usage({ breakdown: 'summary' })).context
  return {
    mcpTools: (breakdown?.mcpTools ?? []).map(tool => ({ ...tool, serverName: mcpServers.get(tool.name) ?? tool.serverName })),
    skills: (breakdown?.skills?.skillFrontmatter ?? []).map(skill => ({ ...skill, name: skillNames.get(skill.name) ?? skill.name })),
    agents: breakdown?.agents ?? [],
  }
}

/**
 * Every name this session has seen. MCP servers come from the context's tools,
 * hidden ones and those plugins ship too; skills and agent types from what the
 * engine offered, as the context counts only custom agents.
 */
function known(mcpTools: ContextLists['mcpTools']): Known {
  return { mcp: [...new Set(mcpTools.map(tool => tool.serverName))], skills: [...knownSkills], agents: [...knownAgents] }
}

function isToolVisible(persona: Persona | undefined, tool: string): boolean {
  return isMcpToolAllowed(persona?.mcp, tool, mcpServers.get(tool))
}

/** Counts persona switches, so a compaction asked for by an earlier switch can tell it is stale. */
let switches = 0
const LOGIN_CHECK_MS = 20_000
/** How many more ToolSearch matches to ask for, so hidden ones dropped still leave enough. */
const HIDDEN_SEARCH_SLACK = 10
/** The widest ToolSearch window a search with hidden matches grows to. */
const SEARCH_WINDOW_MAX = 200

type Loaded = { config: Config; path: string; error?: string }

/** What the engine sent and what this mod made of it, by section id or attachment type, for `/persona debug`. */
type Seen = { before: number; after: number; count: number }
const sections = new Map<string, Seen>()
const attachments = new Map<string, Seen>()
let deferredTools = 0
/** The last system prompt as this mod answered it, and the tools that request offered. */
let lastSystem: readonly { id: string; text: string }[] = []
let lastTools: readonly string[] = []

/** The dump holds the whole conversation, so by default it goes in the config folder, never a shared /tmp. */
async function dumpPath($: EngineInterface): Promise<string> {
  const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await $.env.get('HOME')}/.claude`
  return `${configDir.replace(/\/+$/, '')}/persona-dump.txt`
}

/** Writes what the last request carried, as far as a mod can see it, so a test can grep it. */
async function dump($: EngineInterface, name: string | null, path: string): Promise<string> {
  const messages = await $.session.messages({ as: 'api' })
  const text = [
    `# persona: ${name ?? 'none'}`,
    '',
    `# tools offered by the last request (${lastTools.length})`,
    ...lastTools,
    '',
    '# system prompt of the last request',
    ...lastSystem.map(section => `## [${section.id}]\n${section.text}`),
    '',
    `# conversation as the API reads it (${messages.length} messages)`,
    JSON.stringify(messages, null, 2),
  ].join('\n')
  await $.fs.write(path, text)
  return path
}

/** What the persona took out of the last values the engine sent: the skill listing, and the rest is MCP. */
function removed(): Removed {
  const cut = (seen: Seen) => Math.max(0, seen.before - seen.after)
  let skills = 0
  let mcp = 0
  for (const [type, seen] of attachments) {
    if (type === 'skill_listing') skills += cut(seen)
    else mcp += cut(seen)
  }
  for (const seen of sections.values()) mcp += cut(seen)
  return { skills, mcp }
}

function see(map: Map<string, Seen>, key: string, before: string | null, after: string | null): void {
  const held = map.get(key)
  map.set(key, { before: before?.length ?? 0, after: after?.length ?? 0, count: (held?.count ?? 0) + 1 })
}

function describeSeen(name: string | null): string {
  const rows = (map: Map<string, Seen>) =>
    [...map].map(([key, s]) => `  ${key}: ${approxTokens(s.before)} -> ${approxTokens(s.after)} tokens${s.count > 1 ? ` (${s.count}x)` : ''}`)
  const total = (map: Map<string, Seen>) => [...map.values()].reduce((sum, s) => sum + s.before - s.after, 0)
  return [
    `Active: ${name ?? 'none'}. Last values the engine sent since this mod loaded:`,
    'System prompt sections:',
    ...rows(sections),
    'Attachments:',
    ...rows(attachments),
    `MCP tools this mod moved behind ToolSearch: ${deferredTools}`,
    `Removed: ${approxTokens(total(sections))} tokens of system prompt, ${approxTokens(total(attachments))} of attachments.`,
  ].join('\n')
}

// Read once per load; a hot reload or `/persona reload` reads it again.
let loading: Promise<Loaded> | undefined

/** The config folder's personas.json, else the one in ~/.claude, so a work folder may keep its own. */
async function readConfig($: EngineInterface): Promise<Loaded> {
  const shared = `${await $.env.get('HOME')}/.claude/personas.json`
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  const own = configDir ? `${configDir.replace(/\/+$/, '')}/personas.json` : shared
  const path = (await $.fs.exists(own)) ? own : shared
  if (!(await $.fs.exists(path))) return { config: EMPTY, path }
  try {
    return { config: parseConfig(await $.fs.read(path)), path }
  } catch (error) {
    return { config: EMPTY, path, error: error instanceof Error ? error.message : String(error) }
  }
}

function loaded($: EngineInterface): Promise<Loaded> {
  loading ??= readConfig($)
  return loading
}

/** The active persona: the session's choice, else CLAUDE_PERSONA, else the file's default. */
async function active($: EngineInterface): Promise<{ name: string | null; persona?: Persona }> {
  const { config } = await loaded($)
  const held = await $.state.get(ACTIVE)
  const name =
    held.version > 0
      ? (held.value ?? null)
      : ((await $.env.get('CLAUDE_PERSONA')) ?? config.default ?? null)
  const persona = name === null ? undefined : config.personas[name]
  return persona === undefined ? { name: null } : { name, persona }
}

/** The named login this session's requests use, as its environment stands. */
async function currentLogin($: EngineInterface): Promise<string | undefined> {
  const { config } = await loaded($)
  const home = (await $.env.get('HOME')) ?? ''
  return loginOf(
    config.logins,
    home,
    await $.env.get('CLAUDE_SECURESTORAGE_CONFIG_DIR'),
    await $.env.get('CLAUDE_CONFIG_DIR'),
  )
}

async function storageOf($: EngineInterface, folder: string): Promise<string> {
  return loginStorage(folder, (await $.env.get('HOME')) ?? '')
}

async function useLogin($: EngineInterface, folder: string): Promise<void> {
  await $.env.set('CLAUDE_SECURESTORAGE_CONFIG_DIR', await storageOf($, folder))
}

/**
 * Claude Code's guard for Team and Enterprise accounts (sec-default) refuses a
 * plugin's change to the login variables, once a session runs on such an account.
 */
const GUARD_NOTE = 'On a Team or Enterprise login, Claude Code does not let a plugin change the login. Start a new session for the other login.'

/** Whether the login switch went through; false when Claude Code refused it. */
async function tryUseLogin($: EngineInterface, folder: string): Promise<boolean> {
  try {
    await useLogin($, folder)
    return true
  } catch {
    return false
  }
}

/** Asks Claude Code whether a login's sign-in is there, without switching to it. */
async function checkLogin($: EngineInterface, storage: string): Promise<{ isSignedIn: boolean; plan?: string } | undefined> {
  try {
    const { exitCode, stdout } = await $.process.run(['claude', 'auth', 'status', '--json'], {
      env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: storage },
      timeoutMs: LOGIN_CHECK_MS,
    })
    return parseAuthStatus(stdout) ?? (exitCode === 0 ? undefined : { isSignedIn: false })
  } catch {
    return undefined
  }
}

/** Puts the persona and login in the band above the prompt; a change redraws it. */
async function showStatus($: EngineInterface): Promise<void> {
  const { name, persona } = await active($)
  const { config } = await loaded($)
  const login = config.logins === undefined ? undefined : ((await currentLogin($)) ?? 'unknown')
  const view: PersonaView | null =
    name === null && login === undefined
      ? null
      : { persona: name, personaColor: persona?.color, login, loginColor: login && config.loginColors?.[login] }
  await update($, VIEW, () => view)
}

async function compactFor($: EngineInterface, name: string, persona: Persona): Promise<void> {
  try {
    const { skip } = await $.session.compact({ instructions: compactInstructions(name, persona) })
    $.ui.toast(skip ? `${name}: compaction skipped (${skip}).` : `${name}: conversation compacted.`)
  } catch (failure) {
    const why = failure instanceof Error ? failure.message : String(failure)
    $.ui.toast(`${name}: could not compact (${why}). The conversation is kept.`)
  }
}

/** Asks the engine again for everything a persona changes. */
function refresh($: EngineInterface): void {
  $.ui.invalidate('tool.describe')
  $.ui.invalidate('prompt.attachment')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'persona',
      description: 'List personas, or switch to one (compacts unless --keep)',
      argumentHint: '[name|off|login <name>|check|reload|debug|dump] [--keep]',
    })
    // A resumed session runs in a new process: put back the login it had switched to.
    const held = await $.state.get(LOGIN)
    const folder = held.value ? (await loaded($)).config.logins?.[held.value] : undefined
    if (folder !== undefined && !(await tryUseLogin($, folder))) {
      await $.state.set(LOGIN, null)
      $.ui.toast(`persona: could not put back the ${held.value} login. ${GUARD_NOTE}`)
    }
    $.ui.status(undefined) // the band replaced the status line this mod pinned before
    await showStatus($)
    refresh($)
    return next(e)
  })

  on('command.run', { command: 'persona' }, async ($, e) => {
    const request = parseArgs(e.args)

    if (request.kind === 'reload') {
      loading = undefined
      const { path, error } = await loaded($)
      refresh($)
      await showStatus($)
      return { text: error === undefined ? `Read ${path}.` : `${path}: ${error}` }
    }

    if (request.kind === 'debug') return { text: describeSeen((await active($)).name) }
    if (request.kind === 'check') {
      const [{ config, path, error }, { name }, lists] = await Promise.all([loaded($), active($), contextLists($)])
      const seen = known(lists.mcpTools)
      const text = describeCheck(config, seen, path, error)
      const view = checkView(config, name, lists, seen, path, error)
      await update($, CHECK, () => view)
      const { isPlaced } = await $.ui.open({ id: CHECK_PANE, title: 'Persona check' })
      // The model reads the names too, so it can help write personas.json.
      return { text: isPlaced ? 'Persona check pane opened.' : `${describeCheckTokens(view)}\n\n${text}`, context: [text] }
    }
    if (request.kind === 'dump') {
      const written = await dump($, (await active($)).name, request.path ?? (await dumpPath($)))
      return { text: `Wrote what the last request carried to ${written}.` }
    }

    const { config, path, error } = await loaded($)
    if (request.kind === 'login') {
      const logins = config.logins ?? {}
      const names = Object.keys(logins)
      if (names.length === 0) return { text: `No logins in ${path}. Add "logins": ${LOGINS_SHAPE}.` }
      const now = await currentLogin($)
      if (request.name === undefined) {
        const rows = names.map(n => `${n === now ? '*' : ' '} ${n} - ${logins[n]}`)
        return { text: [`Logins in ${path}:`, ...rows, '', '/persona login <name> moves the next request to that login.'].join('\n') }
      }
      const folder = logins[request.name]
      if (folder === undefined) return { text: `No login "${request.name}". Logins: ${names.join(', ')}.` }
      if (request.name === now) return { text: `${request.name} login already in use.` }
      const storage = await storageOf($, folder)
      const checked = await checkLogin($, storage)
      const staying = `The session stays on the ${now ?? 'current'} login.`
      if (checked === undefined) return { text: `Could not check the ${request.name} login. ${staying}` }
      if (!checked.isSignedIn) {
        return { text: `${folder} has no sign-in. ${staying}\nSign it in once with: ${signInCommand(storage)}` }
      }
      if (!(await tryUseLogin($, folder))) return { text: `Could not switch to the ${request.name} login. ${GUARD_NOTE}` }
      await $.state.set(LOGIN, request.name)
      await showStatus($)
      const plan = checked.plan ? ` (${checked.plan})` : ''
      return { text: `${request.name} login${plan}: the next request uses ${folder}'s sign-in.` }
    }
    if (request.kind === 'list') {
      return { text: describeList(config, (await active($)).name, path, error) }
    }

    const { name } = request
    const persona = name === null ? undefined : config.personas[name]
    if (name !== null && persona === undefined) {
      return { text: `No persona "${name}" in ${path}.\n\n${describeList(config, (await active($)).name, path, error)}` }
    }

    switches += 1
    const switchId = switches
    await $.state.set(ACTIVE, name)
    refresh($)
    await showStatus($)

    const label = name ?? 'off'
    const context = [
      name === null
        ? 'The persona was turned off: every tool, skill and agent is available again.'
        : `The session now uses the "${name}" persona.${persona?.instructions ? ` ${persona.instructions}` : ''}`,
    ]
    if (request.isKeeping || name === null || persona === undefined) {
      return { text: `${label} (conversation kept).`, context }
    }

    if ((await $.session.messages()).length < 2) {
      return { text: `${label}. Nothing to compact yet.`, context }
    }
    // The engine refuses a compaction under the command that asks for it, so it runs just after.
    // A later switch (another persona, off, --keep) cancels it.
    $.clock.after(COMPACT_DELAY_MS, () => void (switchId === switches && compactFor($, name, persona)))
    return { text: `${label}. Compacting the conversation for it...`, context }
  })

  // /context counts what the engine sent, so the persona adds what it took out.
  on('command.run', { command: 'context' }, async ($, e, next) => {
    const [ran, { name, persona }] = await Promise.all([next(e), active($)])
    if (name === null || persona === undefined || ran.text === undefined) return ran
    const { mcpTools } = await contextLists($)
    const section = describeContext(name, persona, known(mcpTools), mcpTools, removed())
    return { ...ran, text: `${ran.text.trimEnd()}\n\n${section}`, context: [...(ran.context ?? []), section] }
  }).catch(($, e, next) => next(e))

  // MCP tools of a hidden server go behind ToolSearch...
  on('tool.describe', { tool: /^mcp__/ }, async ($, e, next) => {
    if (e.provider.plugin.startsWith('mcp:')) mcpServers.set(e.tool, e.provider.plugin.slice('mcp:'.length))
    const described = await next(e)
    const { persona } = await active($)
    if (isToolVisible(persona, e.tool)) return described
    deferredTools += 1
    return { ...described, isDeferred: true }
  })

  // ...and out of the deferred-tool list, so the model does not see their names. Skills
  // leave the skill listing, and hidden servers their part of any MCP instructions.
  on('prompt.attachment', async ($, e, next) => {
    const { text } = await next(e)
    if (e.type === 'skill_listing' && text !== null) {
      listingNames(text).forEach(skill => knownSkills.add(skill))
      for (const [full, name] of listingAliases(text)) skillNames.set(full, name)
    }
    const { persona } = await active($)
    let after = text
    if (after !== null && persona !== undefined) {
      if (e.type === 'deferred_tools_delta' && persona.mcp !== undefined) {
        after = filterToolNames(after, tool => isToolVisible(persona, tool))
      }
      if (e.type === 'skill_listing' && persona.skills !== undefined) {
        after = filterListing(after, skill => isListed(persona.skills, skill))
      }
      after = filterMcpInstructions(after, persona.mcp)
    }
    see(attachments, e.type, text, after)
    return { text: after }
  })

  on('agent.offer', async ($, e, next) => {
    knownAgents.add(e.agent)
    const { persona } = await active($)
    return isAllowed(persona?.agents, e.agent) ? next(e) : { isOffered: false }
  }).catch(($, e, next) => next(e))

  // A hidden MCP tool or skill the model still asks for is refused.
  on('tool.call', { tool: /^mcp__/ }, async ($, e, next) => {
    const { name, persona } = await active($)
    return isToolVisible(persona, e.tool)
      ? next(e)
      : { deny: `The "${name}" persona does not use ${e.tool}. /persona off makes it available.` }
  }).catch(($, e, next) => next(e))

  // ToolSearch searches every deferred tool, hidden ones too: hidden names are
  // taken out of a select, and out of the matches with more asked for to fill the gap.
  on('tool.call', { tool: 'ToolSearch' }, async ($, e, next) => {
    const { name, persona } = await active($)
    if (persona?.mcp === undefined) return next(e)
    const isVisible = (tool: string) => isToolVisible(persona, tool)
    const query = visibleSelect(e.query, isVisible)
    if (query === null) return { deny: `The "${name}" persona does not use those tools. /persona off makes them available.` }
    const wanted = e.max_results ?? 5
    // Hidden tools can fill a whole window, so a window that came back full and
    // short of visible matches is searched again, wider, up to a bound.
    let window = wanted + HIDDEN_SEARCH_SLACK
    for (;;) {
      const ran = await next({ ...e, query, max_results: window })
      if (ran.deny !== undefined || ran.isError === true) return ran
      const matches = ran.result.matches.filter(isVisible)
      const isFull = ran.result.matches.length >= window
      if (matches.length < wanted && isFull && window < SEARCH_WINDOW_MAX) {
        window = Math.min(window * 4, SEARCH_WINDOW_MAX)
        continue
      }
      if (matches.length === ran.result.matches.length && matches.length <= wanted) return ran
      return { result: { ...ran.result, matches: matches.slice(0, wanted) } }
    }
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    const { name, persona } = await active($)
    return isCallable(persona?.skills, e.skill)
      ? next(e)
      : { deny: `The "${name}" persona does not use the ${e.skill} skill. /persona off makes it available.` }
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const view = await read($, VIEW)
    if (e.props.hasSurvey || view === null) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    // A dim rule with the label in it, like the prompt's own border, so the row
    // does not read as part of the last reply.
    const label = [
      view.persona === null ? '' : `${view.persona} persona`,
      view.login === undefined ? '' : `${view.login} login`,
    ].filter(Boolean).join(' · ')
    const fill = Math.max(0, e.props.bodyColumns - label.length - 4)
    return (
      <Box marginTop={1}>
        <Text>
          <Text dimColor>── </Text>
          {view.persona === null ? null : (
            <Text>
              <Text color={view.personaColor ?? PERSONA_COLOR} bold>
                {view.persona}
              </Text>
              <Text dimColor> persona</Text>
            </Text>
          )}
          {view.login === undefined ? null : (
            <Text>
              {view.persona === null ? null : <Text dimColor> · </Text>}
              <Text color={view.loginColor ?? LOGIN_COLOR} bold>
                {view.login}
              </Text>
              <Text dimColor> login</Text>
            </Text>
          )}
          <Text dimColor> {'─'.repeat(fill)}</Text>
        </Text>
      </Box>
    )
  }).catch(($, e, next) => next(e))

  // /persona check as /context draws it: a bar of kept and hidden tokens, then each kind by tokens.
  on('ui.render', { component: 'Pane', requestId: CHECK_PANE }, async ($, e, next) => {
    const view = await read($, CHECK)
    if (view === null) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const [title, detail] = checkHeadline(view)
    const bar = Math.max(10, Math.min(40, e.props.bodyColumns - 2))
    const hiddenCells = view.total === 0 ? 0 : Math.round((bar * view.hidden) / view.total)
    const nameWidth = Math.max(10, e.props.bodyColumns - 12)
    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>{title}</Text>
          <Text dimColor>{` · ${detail}`}</Text>
        </Text>
        <Text>
          <Text color={MARKS.kept.color}>{'█'.repeat(bar - hiddenCells)}</Text>
          <Text color={MARKS.hidden.color}>{'░'.repeat(hiddenCells)}</Text>
        </Text>
        <Text dimColor>
          {MARKS.kept.glyph} kept {MARKS.quiet.glyph} quiet {MARKS.hidden.glyph} hidden · estimated tokens
        </Text>
        {view.error === undefined ? null : <Text color="error">{`${view.path}: ${view.error}`}</Text>}
        {view.groups.map(group => (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>{`${group.title} (${group.rows.length})`}</Text>
            {group.rows.length === 0 ? <Text dimColor>  none in the context</Text> : null}
            {group.rows.map(row => (
              <Text dimColor={row.mark !== 'kept'}>
                <Text color={MARKS[row.mark].color}>{`  ${MARKS[row.mark].glyph} `}</Text>
                {`${tokenCount(row.tokens).padStart(6)}  ${row.name.length > nameWidth ? `${row.name.slice(0, nameWidth - 1)}…` : row.name}`}
              </Text>
            ))}
          </Box>
        ))}
        <Box flexDirection="column" marginTop={1}>
          {checkFooter(view.unchecked, view.unmatched, view.path).map(line =>
            // The footer indents the filter names that match nothing.
            line.startsWith('  ') ? <Text color="warning">{line}</Text> : <Text dimColor>{line}</Text>,
          )}
        </Box>
      </Box>
    )
  }).catch(($, e, next) => next(e))

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const { name, persona } = await active($)

    const kept = composed.sections.flatMap(section => {
      const text = persona === undefined ? section.text : filterMcpInstructions(section.text, persona.mcp)
      see(sections, section.id, section.text, text)
      return text === null ? [] : [{ ...section, text }]
    })
    lastTools = e.tools
    lastSystem = kept
    if (persona?.instructions) {
      kept.push({
        id: 'persona:instructions',
        text: `# Persona: ${name}\n\n${persona.instructions}`,
        scope: 'session',
      })
    }
    return { sections: kept }
  })
}
