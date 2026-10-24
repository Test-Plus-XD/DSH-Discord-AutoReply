/**
 * dsh-discord-autoreply: answers Discord messages with DeepSeek through DSH.
 *
 * Discord side: talks to the Discord desktop client over its local DevTools port
 * (start Discord with start-discord-ptb.cmd). New messages arrive through Discord's
 * own message events; answers are put into that chat's message box for you to send
 * (delivery: 'draft'), or posted directly as you (delivery: 'send').
 * DSH side: one DSH session per Discord channel, using the tool-less `discord`
 * preset, so every message, image and answer is visible in DSH. Nothing is sent
 * anywhere but DeepSeek. A localhost HTTP API (apiPort) lets local tools drive it.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { badRequest, HttpError, startApi } from './api.ts'
import { DiscordPage } from './discord-page.ts'
import type { Agent, BridgeEvent, Chat, Config, DiscordImage, DiscordMessage, HostContext, Log, PromptPart, RecentMessage } from './types.ts'

export const name = 'dsh-discord-autoreply'
export const inject = ['sessionController', 'tools']

const HERE = dirname(fileURLToPath(import.meta.url))
const STATE_FILE = join(HERE, 'state.json')
const MAX_IMAGE_BYTES = 15 * 1024 * 1024

const DEFAULTS: Config = {
  enabled: true,
  devtoolsUrl: 'http://127.0.0.1:9230',
  channels: [],
  provider: 'deepseek-account',
  model: 'deepseek-flash',
  reasoningEffort: 'off',
  agentPreset: 'discord',
  sessionDirectory: join(HERE, 'sessions'),
  replyPrefix: '',
  delivery: 'draft',
  apiPort: 18790,
  archiveRetentionHours: 24,
  sessionsRoot: join(homedir(), '.dsh', 'sessions'),
  stripLinks: true,
  contextMessages: 10,
}

/** http(s) URLs, with or without Discord's <...> embed suppression, and bare www. hosts. */
const LINK = /<?\b(?:https?:\/\/|www\.)[^\s<>]+>?/gi

/**
 * Drop links so URLs never reach DSH/DeepSeek (many sites, e.g. YouTube, are
 * unreachable from there). A message that was only a link ends up empty and is ignored.
 */
export function stripLinks(text: string): string {
  return text
    // Sentence punctuation right after a link belongs to the text, not the URL.
    .replace(LINK, match => /[.,!?;:)\]]+$/.exec(match)?.[0] ?? '')
    .replace(/[ \t]+([.,!?;:])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
    .replace(/^[.,;:]\s*/, '')
}

/**
 * sessions: channelId -> current session; owned: every session this plugin made;
 * archivedAt: sessionId -> when the plugin first saw it archived (0 = delete asap).
 */
interface State {
  /** lastMessageId: newest Discord message the session has already been shown. */
  sessions: Record<string, { sessionId: string; channelName: string; lastMessageId?: string }>
  owned: string[]
  archivedAt: Record<string, number>
}

/** The answer being collected for one session's current turn. */
interface Turn {
  channelId: string
  text: string
}

function sniffImageType(b: Uint8Array): string | undefined {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  return undefined
}

async function loadImage(image: DiscordImage): Promise<PromptPart | undefined> {
  // Discord's media proxy can shrink big uploads; fall back to the original file.
  const urls = image.size > MAX_IMAGE_BYTES && image.proxyUrl
    ? [`${image.proxyUrl}${image.proxyUrl.includes('?') ? '&' : '?'}format=jpeg&width=2048`]
    : [image.url, image.proxyUrl].filter((u): u is string => Boolean(u))
  for (const url of urls) {
    try {
      const res = await fetch(url)
      if (!res.ok) continue
      const bytes = new Uint8Array(await res.arrayBuffer())
      // DSH rejects images whose declared type does not match their bytes, and
      // Discord's content_type is not reliable, so detect it here.
      const mediaType = sniffImageType(bytes)
      if (!mediaType || bytes.byteLength > MAX_IMAGE_BYTES) continue
      return { type: 'image', data: Buffer.from(bytes).toString('base64'), mediaType, name: image.filename }
    } catch {}
  }
  return undefined
}

export function apply(ctx: HostContext, rawConfig: Partial<Config> = {}): void {
  const config: Config = { ...DEFAULTS, ...rawConfig }
  const log: Log = {
    info: m => ctx.logger?.info?.(m) ?? console.log(m),
    warn: m => ctx.logger?.warn?.(m) ?? console.warn(m),
    error: m => ctx.logger?.error?.(m) ?? console.error(m),
  }
  if (!config.enabled) return
  const watched = new Set((config.channels ?? []).map(String))
  const selection = { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort }

  let state: State
  try { state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State } catch { state = {} as State }
  state.sessions ??= {}
  state.owned ??= Object.values(state.sessions).map(s => s.sessionId)
  state.archivedAt ??= {}
  const saveState = (): void => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  mkdirSync(config.sessionDirectory, { recursive: true })

  const live = new Map<string, Turn>()
  const creating = new Map<string, Promise<string>>()
  const controller = () => ctx.sessionController

  async function liveAgent(sessionId: string): Promise<Agent> {
    const result = await controller().resolveAgent(sessionId)
    if ('error' in result) throw result.error
    return result.agent
  }

  const registry = () => ctx.get('workspaceRegistry')
  const isArchived = (id: string): boolean => registry()?.archivedSessionIds.includes(id) ?? false
  const titleFor = (chat: Chat): string => `Discord · ${chat.channelName || chat.channelId}`.slice(0, 80)

  /** The chat's session; a new one when it has none or you archived it. */
  async function sessionFor(chat: Chat): Promise<string> {
    const known = state.sessions[chat.channelId]
    if (known && !isArchived(known.sessionId)) {
      try {
        await liveAgent(known.sessionId)
        if (chat.channelName && !known.channelName) {
          known.channelName = chat.channelName
          saveState()
          await controller().rename({ sessionId: known.sessionId, title: titleFor(chat) }).catch(() => {})
        }
        return known.sessionId
      } catch (error) {
        log.warn(`discord-autoreply: session ${known.sessionId} unusable (${(error as Error).message}); creating a new one`)
      }
    }
    let pending = creating.get(chat.channelId)
    if (!pending) {
      pending = (async () => {
        const { sessionId } = await controller().create({ cwd: config.sessionDirectory, agentPreset: config.agentPreset })
        state.sessions[chat.channelId] = { sessionId, channelName: chat.channelName ?? '' }
        state.owned.push(sessionId)
        saveState()
        live.set(sessionId, { channelId: chat.channelId, text: '' })
        await controller().rename({ sessionId, title: titleFor(chat) }).catch(() => {})
        log.info(`discord-autoreply: new session ${sessionId} for ${chat.channelName || chat.channelId}`)
        return sessionId
      })().finally(() => creating.delete(chat.channelId))
      creating.set(chat.channelId, pending)
    }
    return pending
  }

  // Sessions you archive are deleted for good after archiveRetentionHours. DSH has
  // no delete API, so the session folder is removed once DSH no longer has it loaded
  // (loaded ones go on the next DSH start).
  function findSessionDir(sessionId: string): string | undefined {
    try {
      for (const group of readdirSync(config.sessionsRoot)) {
        const dir = join(config.sessionsRoot, group, sessionId)
        if (existsSync(dir)) return dir
      }
    } catch {}
    return undefined
  }

  async function sweepArchived(): Promise<void> {
    const workspaces = registry()
    if (!workspaces) return
    const now = Date.now()
    const retention = config.archiveRetentionHours * 3_600_000
    for (const id of [...state.owned]) {
      if (!isArchived(id)) {
        delete state.archivedAt[id]
        continue
      }
      state.archivedAt[id] ??= now
      if (now - state.archivedAt[id] < retention || ctx.get('agents')?.get(id)) continue
      const dir = findSessionDir(id)
      try {
        if (dir) await rm(dir, { recursive: true, force: true })
      } catch (error) {
        log.warn(`discord-autoreply: could not delete ${id} yet: ${(error as Error).message}`)
        continue
      }
      await workspaces.unarchiveSession(id).catch(() => {})
      state.owned = state.owned.filter(x => x !== id)
      delete state.archivedAt[id]
      for (const [channelId, s] of Object.entries(state.sessions)) if (s.sessionId === id) delete state.sessions[channelId]
      live.delete(id)
      log.info(`discord-autoreply: deleted archived session ${id}`)
    }
    saveState()
  }

  /** Archive now and delete as soon as DSH lets go of it, skipping the waiting period. */
  async function deleteSession(sessionId: string): Promise<string> {
    if (!state.owned.includes(sessionId)) throw badRequest(`${sessionId} is not a Discord auto-reply session`)
    const workspaces = registry()
    if (!workspaces) throw new HttpError(503, 'workspace registry unavailable')
    await workspaces.archiveSession(sessionId, { stopActivity: true })
    state.archivedAt[sessionId] = 0
    saveState()
    await sweepArchived()
    return state.owned.includes(sessionId) ? 'archived; files deleted when DSH next starts' : 'deleted'
  }

  // Friends' messages must never drive tools (shell, files, memory, teammates...).
  // The guard is the hard stop; hiding the tools also keeps prompts small.
  const isDiscordSession = (id: string): boolean => {
    if (state.owned.includes(id)) return true
    try {
      const session = ctx.get('sessions')?.get(id)
      const preset = session ? controller().agents.presetForSession(session) : undefined
      return (typeof preset === 'object' ? preset.id : preset) === config.agentPreset
    } catch { return false }
  }
  ctx.effect(() => ctx.tools.guard(exec => exec.agent !== undefined && isDiscordSession(exec.agent.id)
    ? 'Tools are disabled in Discord auto-reply sessions.' : undefined), 'discord-autoreply: tool guard')
  const stripped = new WeakSet<Agent>()
  function stripTools(agent: Agent): void {
    if (stripped.has(agent)) return
    stripped.add(agent)
    for (const { name: tool } of ctx.tools.schemas(agent)) {
      // Agent-scoped tools cannot be restricted; the guard above still blocks them.
      try { agent.ctx.tools.restrict({ deny: [tool] }) } catch {}
    }
  }

  async function ensureModel(sessionId: string): Promise<void> {
    const agent = await liveAgent(sessionId)
    stripTools(agent)
    // Per-session selection; selectModel() would also overwrite your global default.
    const agents = controller().agents
    const current = agents.selectionFor(agent).current
    if (current.provider !== selection.provider || current.model !== selection.model
      || current.reasoningEffort !== selection.reasoningEffort) {
      agents.selectForNextRequest(agent, { ...selection })
    }
  }

  async function handleMessage(msg: DiscordMessage, force = false): Promise<void> {
    if (!force && (watched.size ? !watched.has(msg.channelId) : !msg.isOpenChannel)) return
    const images = (await Promise.all((msg.images ?? []).slice(0, 4).map(loadImage)))
      .filter((part): part is PromptPart => part !== undefined)
    const missing = (msg.images?.length ?? 0) - images.length
    const content = config.stripLinks ? stripLinks(msg.content) : msg.content
    if (!content.trim() && !images.length) return
    const text = `${msg.author}: ${content || '(sent an image)'}`
      + (missing > 0 ? `\n(${missing} image(s) could not be loaded)` : '')

    const sessionId = await sessionFor(msg)
    await ensureModel(sessionId)
    if (!live.has(sessionId)) live.set(sessionId, { channelId: msg.channelId, text: '' })
    const context = await chatContext(msg)
    await controller().prompt({
      sessionId,
      requestId: randomUUID(),
      content: [{ type: 'text', text: context ? `${context}\n\n[New message, reply to this]\n${text}` : text }, ...images],
      mode: 'followup',
    }, AbortSignal.timeout(60_000))
    markSeen(msg)
    log.info(`discord-autoreply: queued message ${msg.id} from ${msg.author} in ${msg.channelName || msg.channelId}`)
  }

  // Chat context: the messages before this one that the session hasn't seen yet (at
  // most contextMessages), including your own replies, so the model follows the
  // conversation and copies your voice from real lines.
  const isSnowflake = (id: string): boolean => /^\d+$/.test(id)
  const newer = (a: string, b: string): boolean => BigInt(a) > BigInt(b)

  function contextLine(m: RecentMessage): string {
    const text = config.stripLinks ? stripLinks(m.content) : m.content
    const extras = [
      m.images ? `[${m.images} image${m.images > 1 ? 's' : ''}]` : '',
      ...m.stickers.map(s => `[sticker: ${s}]`),
    ].filter(Boolean).join(' ')
    const body = [text, extras].filter(Boolean).join(' ')
    return body ? `${m.mine ? 'Me' : m.author}: ${body}` : ''
  }

  async function chatContext(msg: DiscordMessage): Promise<string> {
    if (config.contextMessages <= 0 || !isSnowflake(msg.id)) return ''
    const seen = state.sessions[msg.channelId]?.lastMessageId
    let recent: RecentMessage[]
    try {
      recent = (await discord.recent(msg.channelId, config.contextMessages + 5)).messages
    } catch {
      return ''
    }
    const lines = recent
      .filter(m => isSnowflake(m.id) && newer(msg.id, m.id) && (!seen || newer(m.id, seen)))
      .slice(-config.contextMessages)
      .map(contextLine)
      .filter(Boolean)
    return lines.length
      ? `[Earlier in the chat, for context only; "Me" is the user you write as. Don't answer these]\n${lines.join('\n')}`
      : ''
  }

  function markSeen(msg: DiscordMessage): void {
    const entry = state.sessions[msg.channelId]
    if (!entry || !isSnowflake(msg.id)) return
    if (!entry.lastMessageId || newer(msg.id, entry.lastMessageId)) {
      entry.lastMessageId = msg.id
      saveState()
    }
  }

  // Keep each channel's messages in order.
  const queue = new Map<string, Promise<void>>()
  function enqueue(msg: DiscordMessage, force = false): Promise<void> {
    const next = (queue.get(msg.channelId) ?? Promise.resolve()).then(() => handleMessage(msg, force))
    queue.set(msg.channelId, next.catch(() => {}))
    return next
  }

  const discord = new DiscordPage(config, log, (event: BridgeEvent) => {
    if (event.type === 'channel-open') {
      // Have a session ready for every chat you open (or every listed chat).
      if (watched.size && !watched.has(event.channelId)) return
      sessionFor(event).catch(error => log.error(`discord-autoreply: session for ${event.channelId} failed: ${(error as Error).message}`))
      return
    }
    enqueue(event).catch(error => {
      log.error(`discord-autoreply: failed to forward message ${event.id}: ${(error as Error).stack ?? String(error)}`)
    })
  })

  async function deliver(channelId: string, text: string): Promise<string> {
    if (config.delivery === 'send') {
      await discord.send(channelId, text)
      return 'sent'
    }
    return discord.draft(channelId, text)
  }

  ctx.on('session/event', (session, event) => {
    const turn = live.get(session.id)
    if (!turn) return
    if (event.type === 'assistant/message') {
      const text = (event.data.message?.content ?? [])
        .filter(part => part.type === 'text').map(part => part.text ?? '').join('').trim()
      if (text) turn.text = text
    } else if (event.type === 'turn/end') {
      const reply = turn.text
      turn.text = ''
      if (event.data.reason?.kind !== 'completed' || !reply) {
        log.warn(`discord-autoreply: turn in ${session.id} ended (${event.data.reason?.kind}) without a reply`)
        return
      }
      deliver(turn.channelId, config.replyPrefix + reply)
        .then(how => log.info(`discord-autoreply: answer ${how} in channel ${turn.channelId}`))
        .catch(error => log.error(`discord-autoreply: delivering to Discord failed: ${(error as Error).message}`))
    }
  })

  // Rebuild the channel lookup for sessions that already exist.
  for (const [channelId, { sessionId }] of Object.entries(state.sessions)) {
    live.set(sessionId, { channelId, text: '' })
  }

  discord.start()
  ctx.effect(() => () => discord.stop(), 'discord-autoreply: Discord connection')

  const sweep = (): void => {
    sweepArchived().catch(error => log.error(`discord-autoreply: archive sweep failed: ${(error as Error).message}`))
  }
  const firstSweep = setTimeout(sweep, 30_000)
  const sweepTimer = setInterval(sweep, 10 * 60_000)
  ctx.effect(() => () => { clearTimeout(firstSweep); clearInterval(sweepTimer) }, 'discord-autoreply: archive sweep')

  if (!config.apiPort) return
  const requireString = (input: Record<string, any>, ...fields: string[]): void => {
    for (const field of fields) {
      if (typeof input[field] !== 'string' || !input[field].trim()) throw badRequest(`${field} (string) is required`)
    }
  }
  const server = startApi(config.apiPort, {
    'GET /status': () => ({
      discordConnected: discord.connected,
      delivery: config.delivery,
      watching: watched.size ? [...watched] : 'open channel',
      sessions: state.sessions,
      archivedAt: state.archivedAt,
    }),
    // Latest loaded messages of a chat (default: the open one, 30 messages), for style.local.md.
    'GET /recent': async (input) => {
      const limit = Math.min(Math.max(Number(input.limit ?? 30) || 30, 1), 100)
      return discord.recent(input.channelId || undefined, limit)
    },
    // Put text into a chat's message box, exactly like an answer.
    'POST /draft': async (input) => {
      requireString(input, 'channelId', 'text')
      return { result: await discord.draft(input.channelId, input.text) }
    },
    // Post directly as you; only when delivery is 'send'.
    'POST /send': async (input) => {
      requireString(input, 'channelId', 'text')
      if (config.delivery !== 'send') throw new HttpError(403, "sending is off (set delivery: 'send')")
      await discord.send(input.channelId, input.text)
      return { result: 'sent' }
    },
    // Treat text (and optional image URLs) as a message in a chat; the answer is delivered as usual.
    'POST /ask': async (input) => {
      requireString(input, 'channelId', 'text')
      await enqueue({
        type: 'message',
        id: `api-${randomUUID()}`,
        channelId: input.channelId,
        channelName: input.channelName ?? state.sessions[input.channelId]?.channelName ?? '',
        author: input.author ?? 'API',
        content: input.text,
        images: ((input.imageUrls ?? []) as string[]).map(url => ({ url, filename: 'image', size: 0 })),
      }, true)
      return { result: 'queued' }
    },
    // Answer one existing Discord message (it must be loaded in Discord, e.g. recently viewed).
    'POST /answer': async (input) => {
      requireString(input, 'channelId', 'messageId')
      const msg = await discord.getMessage(input.channelId, input.messageId)
      if (!msg) throw new HttpError(404, 'message not loaded in Discord; open that chat first')
      await enqueue(msg, true)
      return { result: 'queued', author: msg.author, images: msg.images.length }
    },
    // Archive a plugin session now and delete it as soon as DSH releases it.
    'POST /delete-session': async (input) => {
      requireString(input, 'sessionId')
      return { result: await deleteSession(input.sessionId) }
    },
  }, log)
  ctx.effect(() => () => { server.close() }, 'discord-autoreply: API server')
}
