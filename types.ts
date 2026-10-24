/**
 * Shared shapes for the plugin. DSH ships no type declarations, so the host
 * services are described here only as far as this plugin uses them.
 * Types only: Node strips them at load time (erasable syntax, no enums).
 */

export type Delivery = 'draft' | 'send'

export interface Config {
  enabled: boolean
  devtoolsUrl: string
  /** Empty: answer in whichever chat is open in Discord. Otherwise only these channel IDs. */
  channels: string[]
  provider: string
  model: string
  reasoningEffort: string
  agentPreset: string
  sessionDirectory: string
  replyPrefix: string
  delivery: Delivery
  /** Local control API port on 127.0.0.1; 0 disables it. */
  apiPort: number
  archiveRetentionHours: number
  sessionsRoot: string
  /** Remove links from messages before they reach DSH; link-only messages are ignored. */
  stripLinks: boolean
  /** Earlier chat messages (yours marked "Me") sent with each answer request; 0 disables. */
  contextMessages: number
}

export interface Log {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

// ---- Discord side (produced by page-bridge.ts) ----

export interface DiscordImage {
  url: string
  proxyUrl?: string
  filename: string
  size: number
}

export interface DiscordMessage {
  type: 'message'
  id: string
  channelId: string
  channelName: string
  guildId?: string | null
  isOpenChannel?: boolean
  author: string
  content: string
  images: DiscordImage[]
}

export interface ChannelOpen {
  type: 'channel-open'
  channelId: string
  channelName: string
}

export type BridgeEvent = DiscordMessage | ChannelOpen

/** One message as returned by the bridge's `recent()` (for building style.local.md). */
export interface RecentMessage {
  id: string
  author: string
  mine: boolean
  content: string
  images: number
  stickers: string[]
  timestamp: string
}

/** A chat identity: enough to find or create its DSH session. */
export interface Chat {
  channelId: string
  channelName?: string
}

// ---- DSH side ----

export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export type PromptPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mediaType: string; name?: string }

export interface Agent {
  id: string
  session: unknown
  ctx: { tools: { restrict(filter: { allow?: string[]; deny?: string[] }): () => void } }
}

export interface SessionController {
  create(request: { cwd?: string; agentPreset?: string; sessionId?: string }): Promise<{ sessionId: string }>
  prompt(request: { sessionId: string; requestId: string; content: PromptPart[]; mode: 'followup' | 'steer' }, signal: AbortSignal): Promise<{ accepted: boolean }>
  rename(request: { sessionId: string; title: string }): Promise<unknown>
  resolveAgent(sessionId: string): Promise<{ agent: Agent } | { error: Error }>
  agents: {
    selectionFor(agent: Agent): { current: ModelSelection }
    selectForNextRequest(agent: Agent, selection: ModelSelection): void
    presetForSession(session: unknown): string | { id: string } | undefined
  }
}

export interface ToolExecution {
  name: string
  agent?: { id: string }
}

export interface ToolsService {
  guard(check: (exec: ToolExecution) => string | undefined): () => void
  schemas(scope?: Agent): { name: string }[]
}

export interface WorkspaceRegistry {
  archivedSessionIds: readonly string[]
  archiveSession(sessionId: string, options?: { stopActivity?: boolean }): Promise<void>
  unarchiveSession(sessionId: string): Promise<void>
}

export interface SessionEvent {
  type: string
  data: {
    message?: { content?: { type: string; text?: string }[] }
    reason?: { kind: string }
  }
}

export interface SystemPrompt {
  section(section: { name: string; order: number; text: string | ((context: unknown) => string); complete?: boolean }): () => void
  getSectionOrder(name: string): number
  suppressRuntimeContext(): void
}

/** The Cordis context DSH hands to `apply()`. */
export interface HostContext {
  sessionController: SessionController
  tools: ToolsService
  systemPrompt: SystemPrompt
  logger?: Partial<Log>
  get(name: 'workspaceRegistry'): WorkspaceRegistry | undefined
  get(name: 'agents'): { get(id: string): Agent | undefined } | undefined
  get(name: 'sessions'): { get(id: string): unknown } | undefined
  on(event: 'session/event', listener: (session: { id: string }, event: SessionEvent) => void): () => void
  effect(factory: () => () => void, label?: string): void
}
