import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { filterListing, filterMcpInstructions, filterToolNames, isMcpToolAllowed, parseArgs, parseConfig } from './model'

const HOME = '/Users/tester'
const PATH = `${HOME}/.claude/personas.json`

const CONFIG = {
  personas: {
    dev: {
      description: 'coding',
      instructions: 'Write code. No email.',
      mcp: { allow: ['context7'] },
      skills: { deny: ['ops:*', 'gideon:gideon'] },
      agents: { deny: ['claude-code-guide'] },
    },
    mail: { mcp: { allow: ['claude.ai Gmail'] } },
  },
}

const SKILLS = [
  'The following skills are available:',
  '',
  '- agent-browser: Browser automation.',
  '- ops:grafana: Query Grafana.',
  '- claude-api: Reference for the Claude API.',
  'TRIGGER - read BEFORE opening the file.',
  '- gideon:gideon: Second brain.',
  '- convex:db-access (convex:convex-db-access): Query Convex.',
].join('\n')

const TOOLS = ['ArtifactData', 'mcp__context7__query-docs', 'mcp__claude_ai_Gmail__create_draft', 'WebFetch'].join('\n')

type World = {
  /** Sign-ins by CLAUDE_SECURESTORAGE_CONFIG_DIR value ('' for ~/.claude): their plan. */
  signIns: Record<string, string>
  envSets: { name: string; value?: string }[]
  written: Record<string, string>
  compacted: (string | undefined)[]
  status: (string | undefined)[]
  toasts: string[]
  messages: number
  env: Record<string, string>
  clock?: MockClock
  /** Where the persona file is; ~/.claude/personas.json when not given. */
  configPath?: string
  /** Why Claude Code refuses an env change, as its guard for Team accounts does. */
  envRefusal?: string
}

/** Everything beneath the plugin: the persona file, the environment, the session. */
function world(on: On, config: unknown = CONFIG, overrides: Partial<World> = {}): World {
  const w: World = { signIns: { '': 'max', [`${HOME}/.claude-work`]: 'team' }, envSets: [], written: {}, compacted: [], status: [], toasts: [], messages: 4, env: {}, ...overrides }
  w.clock = mock.clock(on)
  const env: Record<string, string | undefined> = { HOME, ...w.env }
  on('env.get', (_$, e) => ({ value: env[e.name] }))
  on('env.set', (_$, e) => {
    if (w.envRefusal !== undefined) return { deny: w.envRefusal }
    env[e.name] = e.value
    w.envSets.push({ name: e.name, value: e.value })
    return { value: undefined }
  })
  const path = w.configPath ?? PATH
  on('fs.exists', (_$, e) => ({ value: e.path === path && config !== undefined }))
  on('fs.read', (_$, e) =>
    e.path === path && config !== undefined ? { value: JSON.stringify(config) } : { deny: `ENOENT: ${e.path}` },
  )
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('process.run', (_$, e) => {
    const storage = e.init?.env?.CLAUDE_SECURESTORAGE_CONFIG_DIR
    const status = w.signIns[storage ?? '']
    const stdout = JSON.stringify(status === undefined ? { loggedIn: false } : { loggedIn: true, subscriptionType: status })
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', (_$, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    w.status.push(e.text)
    return { value: undefined }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  // The engine draws nothing in the band of its own.
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }))
  on('fs.write', (_$, e) => {
    w.written[e.path] = e.text
    return { value: undefined }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({
    value: Array.from({ length: w.messages }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: 'hi', toolUses: [] })),
  }))
  on('session.compact', (_$, e) => {
    w.compacted.push(e.instructions)
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }] }
  })
  on('prompt.attachment', (_$, e) => ({ text: e.text }))
  on('tool.describe', (_$, e) => ({ description: e.description, isDeferred: e.isDeferred }))
  on('agent.offer', () => ({ isOffered: true }))
  on('command.run', () => ({ text: 'core ran it' }))
  on('prompt.compose', () => ({
    sections: [
      { id: 'intro', text: 'You are Claude Code.', scope: 'shared' },
      { id: 'mcp_instructions', text: '# MCP Server Instructions\n\n## claude.ai Gmail\nMail.\n\n## context7\nDocs.', scope: 'session' },
    ],
  }))
  return w
}

async function start($: Engine): Promise<void> {
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
}

const persona = ($: Engine, args: string) =>
  $.command.run({
    command: 'persona',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 9 }, view: {} },
} as const

/** The band above the prompt as one line, and the colors it is drawn in; undefined when the mod draws none. */
async function drawBand($: Engine) {
  const ui = await $.ui.mount({ plugin: 'persona', surface: 'terminal', ...BAND })
  const tree = await ui.drawn()
  await ui.unmount()
  const words: string[] = []
  const colors: unknown[] = []
  const walk = (node: unknown): void => {
    if (typeof node === 'string') return void words.push(node)
    if (typeof node !== 'object' || node === null) return
    const { props, children } = node as { props?: { color?: unknown }; children?: unknown[] }
    if (props?.color !== undefined) colors.push(props.color)
    children?.forEach(walk)
  }
  walk(tree)
  const text = words.join('').replace(/─/g, '').trim()
  return text === '' ? undefined : { text, colors }
}

const band = async ($: Engine) => (await drawBand($))?.text

const attachment = ($: Engine, type: string, text: string) =>
  $.prompt.attachment({ type, text, origin: { kind: 'engine' } })

test('the model reads the persona file and its filters', () => {
  expect(parseConfig(JSON.stringify(CONFIG)).personas.dev?.mcp).toEqual({ allow: ['context7'], deny: undefined })
  expect(() => parseConfig('{"personas":{"off":{}}}')).toThrow(/reserved/)
  expect(() => parseConfig('{"default":"x","personas":{}}')).toThrow(/not defined/)
  expect(isMcpToolAllowed({ allow: ['claude.ai Gmail'] }, 'mcp__claude_ai_Gmail__create_draft')).toBe(true)
  expect(isMcpToolAllowed({ allow: ['context7'] }, 'mcp__claude_ai_Gmail__create_draft')).toBe(false)
  expect(isMcpToolAllowed({ deny: ['plugin_*'] }, 'mcp__plugin_context7_context7__query-docs')).toBe(false)
  expect(parseArgs('')).toEqual({ kind: 'list' })
  expect(parseArgs('dev --keep')).toEqual({ kind: 'switch', name: 'dev', isKeeping: true })
  expect(parseArgs('off')).toEqual({ kind: 'switch', name: null, isKeeping: false })
})

test('a skill listing loses hidden skills, wrapped description lines with them', () => {
  const kept = filterListing(SKILLS, name => !['ops:grafana', 'claude-api', 'convex:db-access'].includes(name))
  expect(kept).toBe(['The following skills are available:', '', '- agent-browser: Browser automation.', '- gideon:gideon: Second brain.'].join('\n'))
})

test('the MCP instructions keep only the servers a persona allows', () => {
  const text = '# MCP Server Instructions\n\nIntro.\n\n## claude.ai Gmail\nMail.\n\n## plugin:context7:context7\nDocs.'
  expect(filterMcpInstructions(text, { allow: ['claude.ai Gmail'] })).toBe('# MCP Server Instructions\n\nIntro.\n\n## claude.ai Gmail\nMail.\n')
  expect(filterMcpInstructions(text, { allow: ['nothing'] })).toBe(null)
})

test('with no persona active nothing is filtered', async ($, on) => {
  world(on)
  await start($)
  expect((await attachment($, 'skill_listing', SKILLS)).text).toBe(SKILLS)
  expect((await attachment($, 'deferred_tools_delta', TOOLS)).text).toBe(TOOLS)
  expect((await persona($, '')).text).toMatch(/No persona is active/)
})

test('/persona dev filters skills, MCP tools and agents, and compacts', async ($, on) => {
  const w = world(on)
  await start($)
  const switched = await persona($, 'dev')
  expect(switched.text).toBe('dev. Compacting the conversation for it...')
  expect(w.compacted).toEqual([])
  await w.clock?.advance(200)
  expect(w.compacted).toHaveLength(1)
  expect(w.toasts).toEqual(['dev: conversation compacted.'])
  expect(w.compacted[0]).toMatch(/"dev" persona \(coding\)/)
  expect(await band($)).toBe('dev persona')

  const skills = (await attachment($, 'skill_listing', SKILLS)).text ?? ''
  expect(skills).toMatch(/agent-browser/)
  expect(skills).not.toMatch(/ops:grafana|gideon:gideon/)

  expect((await attachment($, 'deferred_tools_delta', TOOLS)).text).toBe(
    ['ArtifactData', 'mcp__context7__query-docs', 'WebFetch'].join('\n'),
  )

  const gmail = await $.tool.describe({
    tool: 'mcp__claude_ai_Gmail__create_draft',
    description: 'Drafts mail.',
    provider: { plugin: 'mcp:claude.ai Gmail', tier: 'user' },
  })
  expect(gmail.isDeferred).toBe(true)

  expect((await $.agent.offer({ agent: 'claude-code-guide', description: '', source: 'built-in', provider: { plugin: 'engine', tier: 'core' } })).isOffered).toBe(false)
  expect((await $.agent.offer({ agent: 'Explore', description: '', source: 'built-in', provider: { plugin: 'engine', tier: 'core' } })).isOffered).toBe(true)
})

test('--keep switches without compacting; off clears the filters', async ($, on) => {
  const w = world(on)
  await start($)
  expect((await persona($, 'mail --keep')).text).toBe('mail (conversation kept).')
  await w.clock?.advance(200)
  expect(w.compacted).toEqual([])
  expect((await attachment($, 'deferred_tools_delta', TOOLS)).text).toBe(
    ['ArtifactData', 'mcp__claude_ai_Gmail__create_draft', 'WebFetch'].join('\n'),
  )
  await persona($, 'off')
  expect((await attachment($, 'deferred_tools_delta', TOOLS)).text).toBe(TOOLS)
  expect(await band($)).toBe(undefined)
})

test('a short conversation is not compacted, and an unknown persona is refused', async ($, on) => {
  const w = world(on, CONFIG, { messages: 1 })
  await start($)
  expect((await persona($, 'dev')).text).toBe('dev. Nothing to compact yet.')
  expect(w.compacted).toEqual([])
  expect((await persona($, 'nope')).text).toMatch(/No persona "nope"/)
})

test('CLAUDE_PERSONA picks the persona a session starts with', async ($, on) => {
  const w = world(on, CONFIG, { env: { CLAUDE_PERSONA: 'mail' } })
  await start($)
  expect(await band($)).toBe('mail persona')
})

test('a broken persona file is reported, and filters nothing', async ($, on) => {
  world(on, { personas: [] })
  await start($)
  expect((await persona($, '')).text).toMatch(/personas\.json: expected/)
  expect((await attachment($, 'skill_listing', SKILLS)).text).toBe(SKILLS)
})

test('the system prompt gets the persona instructions and loses hidden MCP servers', async ($, on) => {
  world(on)
  await start($)
  await persona($, 'dev --keep')
  const { sections } = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
  expect(sections.map(section => section.id)).toEqual(['intro', 'mcp_instructions', 'persona:instructions'])
  expect(sections[1]?.text).toBe('# MCP Server Instructions\n\n## context7\nDocs.')
  expect(sections[2]).toEqual({ id: 'persona:instructions', text: '# Persona: dev\n\nWrite code. No email.', scope: 'session' })
})

test('MCP instructions inside a longer text lose hidden servers and keep what follows', () => {
  const text = 'Before.\n\n# MCP Server Instructions\n\n## claude.ai Gmail\nMail.\n\n## context7\nDocs.\n\n# Environment\nmacOS.'
  expect(filterMcpInstructions(text, { allow: ['context7'] })).toBe(
    'Before.\n\n# MCP Server Instructions\n\n## context7\nDocs.\n\n# Environment\nmacOS.',
  )
  expect(filterMcpInstructions(text, { allow: [] })).toBe('Before.\n\n# Environment\nmacOS.')
})

test('an MCP instructions attachment is filtered, and /persona debug counts what was removed', async ($, on) => {
  world(on)
  await start($)
  await persona($, 'dev --keep')
  const text = '# MCP Server Instructions\n\n## claude.ai Gmail\nMail mail mail.\n\n## context7\nDocs.'
  expect((await attachment($, 'mcp_instructions_delta', text)).text).toBe('# MCP Server Instructions\n\n## context7\nDocs.')
  const report = (await persona($, 'debug')).text ?? ''
  expect(report).toMatch(/Active: dev/)
  expect(report).toMatch(/mcp_instructions_delta: ~\d+ -> ~\d+ tokens/)
})

test('/persona dump writes the tools, system prompt and conversation the last request carried', async ($, on) => {
  const w = world(on)
  await start($)
  await persona($, 'dev --keep')
  await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: ['Bash', 'mcp__context7__query-docs'], outputStyle: null, traits: [] })
  expect((await persona($, 'dump')).text).toBe('Wrote what the last request carried to /Users/tester/.claude/persona-dump.txt.')
  const text = w.written['/Users/tester/.claude/persona-dump.txt'] ?? ''
  expect(text).toMatch(/# persona: dev/)
  expect(text).toMatch(/mcp__context7__query-docs/)
  expect(text).toMatch(/## \[persona:instructions\]/)
  expect(text).not.toMatch(/claude\.ai Gmail/)
})

test('a tool list loses its heading once no name is left under it', () => {
  const text = 'The following tools just became available and are ready to use:\nmcp__gmail__send\n\nThe following deferred tools are now available via ToolSearch:\nWebFetch\nmcp__gmail__draft'
  expect(filterToolNames(text, () => false)).toBe('\nThe following deferred tools are now available via ToolSearch:\nWebFetch')
})

test('ToolSearch never returns a hidden tool, and a select of one is refused', async ($, on) => {
  world(on)
  on('tool.call', { tool: 'ToolSearch' }, (_$, e) => ({
    result: {
      query: e.tool === 'ToolSearch' ? e.query : '',
      total_deferred_tools: 9,
      matches: ['mcp__plugin_context7_context7__query-docs', 'WebFetch', 'mcp__claude_ai_Gmail__send', 'WebSearch'],
    },
  }))
  await start($)
  await persona($, 'mail --keep')
  const found = await $.tool.call({ tool: 'ToolSearch', query: 'docs', max_results: 2 })
  expect(found.deny).toBe(undefined)
  expect((found.result as { matches: string[] }).matches).toEqual(['WebFetch', 'mcp__claude_ai_Gmail__send'])
  const selected = await $.tool.call({ tool: 'ToolSearch', query: 'select:mcp__plugin_context7_context7__query-docs', max_results: 5 })
  expect(selected.deny).toMatch(/does not use those tools/)
})

test('a quiet skill is left out of the listing but can still be called; a hidden one cannot', async ($, on) => {
  const config = {
    personas: {
      think: { skills: { allow: ['grilling'], quiet: ['gideon:mark-valuable-session'] } },
    },
  }
  world(on, config)
  on('tool.call', { tool: 'Skill' }, () => ({ result: { success: true, commandName: 'ran' } }))
  await start($)
  await persona($, 'think --keep')
  const listing = '- grilling: Grill.\n- gideon:mark-valuable-session: Mark.\n- agent-browser: Browse.'
  expect((await attachment($, 'skill_listing', listing)).text).toBe('- grilling: Grill.')
  expect((await $.tool.call({ tool: 'Skill', skill: 'gideon:mark-valuable-session' })).deny).toBe(undefined)
  expect((await $.tool.call({ tool: 'Skill', skill: 'grilling' })).deny).toBe(undefined)
  expect((await $.tool.call({ tool: 'Skill', skill: 'agent-browser' })).deny).toMatch(/does not use the agent-browser skill/)
})

const LOGINS = { ...CONFIG, logins: { personal: '~/.claude', work: '~/.claude-work' } }

test('/persona login moves the requests to another login and back', async ($, on) => {
  const w = world(on, LOGINS)
  await start($)
  expect(await band($)).toBe('personal login')
  expect((await persona($, 'login')).text).toMatch(/\* personal - ~\/.claude\n {2}work - ~\/.claude-work/)
  expect((await persona($, 'login work')).text).toBe("work login (team): the next request uses ~/.claude-work's sign-in.")
  expect(w.envSets.at(-1)).toEqual({ name: 'CLAUDE_SECURESTORAGE_CONFIG_DIR', value: `${HOME}/.claude-work` })
  expect(await band($)).toBe('work login')
  await persona($, 'dev --keep')
  expect(await band($)).toBe('dev persona · work login')
  await persona($, 'login personal')
  expect(w.envSets.at(-1)).toEqual({ name: 'CLAUDE_SECURESTORAGE_CONFIG_DIR', value: '' })
  expect((await persona($, 'login nope')).text).toMatch(/No login "nope"/)
})

test('a work session reads its own personas.json and starts on the work login', async ($, on) => {
  const w = world(on, LOGINS, { env: { CLAUDE_CONFIG_DIR: `${HOME}/.claude-work` }, configPath: `${HOME}/.claude-work/personas.json` })
  await start($)
  expect(await band($)).toBe('work login')
  expect((await persona($, '')).text).toMatch(/\.claude-work\/personas\.json/)
})

test('a login with no sign-in is refused, and the session stays where it was', async ($, on) => {
  const config = { ...LOGINS, logins: { ...LOGINS.logins, test: '~/.claude-test' } }
  const w = world(on, config)
  await start($)
  const reply = (await persona($, 'login test')).text ?? ''
  expect(reply).toMatch(/~\/.claude-test has no sign-in\. The session stays on the personal login\./)
  expect(reply).toMatch(/CLAUDE_CONFIG_DIR=~\/.claude-test claude auth login/)
  expect(w.envSets).toEqual([])
  expect(await band($)).toBe('personal login')
})

test('the band draws the persona and the login in the colors the file gives', async ($, on) => {
  const config = {
    ...LOGINS,
    personas: { ...LOGINS.personas, dev: { ...LOGINS.personas.dev, color: 'cyan' } },
    logins: { personal: '~/.claude', work: { folder: '~/.claude-work', color: '#ff8800' } },
  }
  world(on, config)
  await start($)
  expect(await drawBand($)).toEqual({ text: 'personal login', colors: ['suggestion'] })
  await persona($, 'dev --keep')
  await persona($, 'login work')
  expect(await drawBand($)).toEqual({ text: 'dev persona · work login', colors: ['cyan', '#ff8800'] })
  await persona($, 'mail --keep')
  expect((await drawBand($))?.colors[0]).toBe('claude')
  expect(() => parseConfig(JSON.stringify({ ...config, logins: { work: { color: 'red' } } }))).toThrow(/config folder/)
})

test('a login switch Claude Code refuses is reported, and the session stays where it was', async ($, on) => {
  const w = world(on, LOGINS, { envRefusal: 'env (managed): CLAUDE_SECURESTORAGE_CONFIG_DIR is not for plugins outside policy to change' })
  await start($)
  expect((await persona($, 'login work')).text).toMatch(/Could not switch to the work login\. On a Team or Enterprise login/)
  expect(await band($)).toBe('personal login')
  expect(w.envSets).toEqual([])
})
