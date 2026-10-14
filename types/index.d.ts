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

declare module 'claude-code' {
  interface PluginState {
    persona: { active: ActivePersona; login: ActiveLogin; view: PersonaView | null }
  }
}
