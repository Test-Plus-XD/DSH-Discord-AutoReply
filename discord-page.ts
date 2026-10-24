/**
 * Minimal DevTools Protocol client for the Discord PTB window. Installs
 * page-bridge.ts in the page (types stripped first) and talks to it.
 */
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BridgeEvent, Config, DiscordMessage, Log, RecentMessage } from './types.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const DISCORD_LIMIT = 2000

/** Read fresh on every injection so bridge edits apply on the next reconnect. */
function pageBridge(): string {
  return stripTypeScriptTypes(readFileSync(join(HERE, 'page-bridge.ts'), 'utf8'))
}

export function splitForDiscord(text: string): string[] {
  const parts: string[] = []
  let rest = text
  while (rest.length > DISCORD_LIMIT) {
    let cut = rest.lastIndexOf('\n', DISCORD_LIMIT)
    if (cut < DISCORD_LIMIT / 2) cut = rest.lastIndexOf(' ', DISCORD_LIMIT)
    if (cut < DISCORD_LIMIT / 2) cut = DISCORD_LIMIT
    parts.push(rest.slice(0, cut))
    rest = rest.slice(cut).trimStart()
  }
  if (rest) parts.push(rest)
  return parts
}

interface Waiter {
  resolve(value: any): void
  reject(error: Error): void
}

interface CdpMessage {
  id?: number
  method?: string
  params?: any
  result?: any
  error?: { message: string }
}

export class DiscordPage {
  config: Config
  log: Log
  onEvent: (event: BridgeEvent) => void
  ws: WebSocket | undefined = undefined
  nextId = 1
  pending = new Map<number, Waiter>()
  stopped = false
  warnedOffline = false
  retryTimer: ReturnType<typeof setTimeout> | undefined = undefined

  constructor(config: Config, log: Log, onEvent: (event: BridgeEvent) => void) {
    this.config = config
    this.log = log
    this.onEvent = onEvent
  }

  get connected(): boolean { return this.ws?.readyState === WebSocket.OPEN }

  start(): void { void this.connect() }

  stop(): void {
    this.stopped = true
    clearTimeout(this.retryTimer)
    if (this.connected) {
      void this.evaluate('window.__dshDiscordBridge?.stop?.(); delete window.__dshDiscordBridge').catch(() => {})
      setTimeout(() => this.ws?.close(), 200)
    }
  }

  retry(reason?: string): void {
    if (this.stopped) return
    if (reason) this.log.warn(`discord-autoreply: ${reason}; retrying in 5s`)
    clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => void this.connect(), 5000)
  }

  async connect(): Promise<void> {
    if (this.stopped) return
    let target: { type: string; url: string; webSocketDebuggerUrl: string } | undefined
    try {
      const targets = await (await fetch(`${this.config.devtoolsUrl}/json/list`)).json() as typeof target[]
      target = targets.find(t => t?.type === 'page' && /discord\.com\/(app|channels)/.test(t.url))
    } catch {
      if (this.warnedOffline) return this.retry()
      this.warnedOffline = true
      return this.retry('Discord DevTools port not reachable (start Discord with start-discord-ptb.cmd)')
    }
    if (!target) return this.retry('Discord window not found on the DevTools port')
    this.warnedOffline = false
    const ws = this.ws = new WebSocket(target.webSocketDebuggerUrl)
    ws.addEventListener('message', ev => this.handle(JSON.parse(String(ev.data)) as CdpMessage))
    ws.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('Discord DevTools connection closed'))
      this.pending.clear()
      if (this.ws === ws) this.retry('Discord connection closed')
    })
    ws.addEventListener('error', () => {})
    ws.addEventListener('open', async () => {
      try {
        await this.call('Runtime.addBinding', { name: '__dshDiscordEmit' })
        await this.call('Runtime.enable')
        this.log.info(`discord-autoreply: connected to Discord (${String(await this.evaluate(pageBridge()))})`)
      } catch (error) {
        this.log.error(`discord-autoreply: Discord setup failed: ${(error as Error).message}`)
      }
    })
  }

  handle(msg: CdpMessage): void {
    if (msg.id !== undefined) {
      const waiter = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) waiter?.reject(new Error(msg.error.message))
      else waiter?.resolve(msg.result)
      return
    }
    if (msg.method === 'Runtime.bindingCalled' && msg.params.name === '__dshDiscordEmit') {
      try { this.onEvent(JSON.parse(msg.params.payload) as BridgeEvent) } catch (error) {
        this.log.error(`discord-autoreply: ${(error as Error).stack ?? String(error)}`)
      }
    } else if (msg.method === 'Runtime.executionContextCreated' && msg.params.context.auxData?.isDefault) {
      // Discord reloaded: reinstall the page bridge.
      void this.evaluate(pageBridge()).catch(() => {})
    }
  }

  call(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Discord is not connected'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression: string): Promise<unknown> {
    const result = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result?.value
  }

  /** Run one bridge method in the page with JSON-encoded arguments. */
  bridge(method: string, ...args: unknown[]): Promise<unknown> {
    return this.evaluate(`(async () => {
      if (!window.__dshDiscordBridge?.ready) throw new Error('bridge not ready');
      return await window.__dshDiscordBridge.${method}(${args.map(a => JSON.stringify(a)).join(', ')});
    })()`)
  }

  async send(channelId: string, text: string): Promise<void> {
    for (const part of splitForDiscord(text)) await this.bridge('send', channelId, part)
  }

  /** Put text into the chat's message box; returns 'inserted' (open chat) or 'drafted'. */
  async draft(channelId: string, text: string): Promise<string> {
    return String(await this.bridge('draft', channelId, text))
  }

  async getMessage(channelId: string, messageId: string): Promise<DiscordMessage | null> {
    return await this.bridge('getMessage', channelId, messageId) as DiscordMessage | null
  }

  /** Recent loaded messages of a chat (the open chat when channelId is omitted). */
  async recent(channelId: string | undefined, limit: number): Promise<{ channelId: string; channelName: string; messages: RecentMessage[] }> {
    return await this.bridge('recent', channelId ?? null, limit) as { channelId: string; channelName: string; messages: RecentMessage[] }
  }
}
