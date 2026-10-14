/** The persona this session uses; null when no persona filters anything. */
export type ActivePersona = string | null

/** The login this session switched to with `/persona login`; null for the one it started with. */
export type ActiveLogin = string | null

/** What the band above the prompt shows: the persona and the login, each with its color. */
export type PersonaView = {
  persona: string | null
  personaColor?: string
  login?: string
  loginColor?: string
}

/** How a persona treats a name: kept, left out of the listing but callable (quiet), or hidden. */
export type CheckMark = 'kept' | 'quiet' | 'hidden'

/** One MCP server, skill or agent type in the check pane, with the tokens the context gives it. */
export type CheckRow = { name: string; tokens: number; mark: CheckMark }

/** What the /persona check pane draws: each kind's rows by tokens, and the filter names that match nothing. */
export type CheckView = {
  persona: string | null
  /** The tokens the context lists, and how many of them the persona hides or quiets. */
  total: number
  hidden: number
  groups: { title: string; rows: CheckRow[] }[]
  unmatched: string[]
  /** The kinds with no name seen yet, so not checked. */
  unchecked: string[]
  path: string
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    persona: { active: ActivePersona; login: ActiveLogin; view: PersonaView | null; check: CheckView | null }
  }
}
