/**
 * dsh-discord-autoreply: answers Discord messages with DeepSeek through DSH.
 *
 * Discord side: talks to the Discord desktop client over its local DevTools port
 * (start Discord with start-discord-ptb.cmd). New messages arrive through Discord's
 * own message events; answers are put into that chat's message box for you to send
 * (delivery: 'draft'), or posted directly as you (delivery: 'send').
 * DSH side: one DSH session per Discord channel, using a tool-less preset, so every
 * message, image and answer is visible in DSH. Nothing is sent anywhere but DeepSeek.
 * A localhost HTTP API (apiPort) lets other local tools drive the bridge.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-discord-autoreply'
export const inject = ['sessionController', 'tools']

const HERE = dirname(fileURLToPath(import.meta.url))
const pageBridge = () => readFileSync(join(HERE, 'page-bridge.js'), 'utf8')
const STATE_FILE = join(HERE, 'state.json')
const DISCORD_LIMIT = 2000
const MAX_IMAGE_BYTES = 15 * 1024 * 1024

const DEFAULTS = {
  enabled: true,
  devtoolsUrl: 'http://127.0.0.1:9230',
  // Empty: answer in whichever channel is open in Discord. Otherwise: only these channel IDs.
  channels: [],
  provider: 'deepseek-account',
  model: 'deepseek-flash',
  reasoningEffort: 'off',
  agentPreset: 'discord',
  sessionDirectory: join(HERE, 'sessions'),
  replyPrefix: '',
  // 'draft': put the answer in the chat's message box, you press Enter. 'send': post it as you.
  delivery: 'draft',
  // Local control API on 127.0.0.1; 0 disables it.
  apiPort: 18790,
  // Sessions you archive in DSH are deleted for good after this many hours.
  archiveRetentionHours: 24,
  sessionsRoot: join(homedir(), '.dsh', 'sessions'),
}

function sniffImageType(bytes) {
  const b = bytes
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
}

function splitForDiscord(text) {
  const parts = []
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

/** Minimal DevTools Protocol client for the Discord page. */
class DiscordPage {
  constructor(config, log, onMessage) {
    this.config = config
    this.log = log
    this.onMessage = onMessage
    this.ws = undefined
    this.nextId = 1
    this.pending = new Map()
    this.stopped = false
    this.retryTimer = undefined
  }

  start() { void this.connect() }

  stop() {
    this.stopped = true
    clearTimeout(this.retryTimer)
    if (this.ws?.readyState === WebSocket.OPEN) {
      void this.evaluate('window.__dshDiscordBridge?.stop?.(); delete window.__dshDiscordBridge').catch(() => {})
      setTimeout(() => this.ws?.close(), 200)
    }
  }

  retry(reason) {
    if (this.stopped) return
    if (reason) this.log.warn(`discord-autoreply: ${reason}; retrying in 5s`)
    clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => void this.connect(), 5000)
  }

  async connect() {
    if (this.stopped) return
    let target
    try {
      const targets = await (await fetch(`${this.config.devtoolsUrl}/json/list`)).json()
      target = targets.find(t => t.type === 'page' && /discord\.com\/(app|channels)/.test(t.url))
    } catch {
      if (this.warnedOffline) return this.retry()
      this.warnedOffline = true
      return this.retry('Discord DevTools port not reachable (start Discord with start-discord-ptb.cmd)')
    }
    if (!target) return this.retry('Discord window not found on the DevTools port')
    this.warnedOffline = false
    const ws = this.ws = new WebSocket(target.webSocketDebuggerUrl)
    ws.addEventListener('message', ev => this.handle(JSON.parse(ev.data)))
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
        this.log.info(`discord-autoreply: connected to Discord (${await this.evaluate(pageBridge())})`)
      } catch (error) {
        this.log.error(`discord-autoreply: Discord setup failed: ${error.message}`)
      }
    })
  }

  handle(msg) {
    if (msg.id !== undefined) {
      const waiter = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) waiter?.reject(new Error(msg.error.message))
      else waiter?.resolve(msg.result)
      return
    }
    if (msg.method === 'Runtime.bindingCalled' && msg.params.name === '__dshDiscordEmit') {
      try { this.onMessage(JSON.parse(msg.params.payload)) } catch (error) {
        this.log.error(`discord-autoreply: ${error.stack ?? error}`)
      }
    } else if (msg.method === 'Runtime.executionContextCreated' && msg.params.context.auxData?.isDefault) {
      // Discord reloaded: reinstall the page bridge.
      void this.evaluate(pageBridge()).catch(() => {})
    }
  }

  call(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result?.value
  }

  async send(channelId, text) {
    for (const part of splitForDiscord(text)) {
      await this.evaluate(`(async () => {
        if (!window.__dshDiscordBridge?.ready) throw new Error('bridge not ready');
        await window.__dshDiscordBridge.send(${JSON.stringify(channelId)}, ${JSON.stringify(part)});
        return true;
      })()`)
    }
  }

  draft(channelId, text) {
    return this.evaluate(`(() => {
      if (!window.__dshDiscordBridge?.ready) throw new Error('bridge not ready');
      return window.__dshDiscordBridge.draft(${JSON.stringify(channelId)}, ${JSON.stringify(text)});
    })()`)
  }

  getMessage(channelId, messageId) {
    return this.evaluate(`window.__dshDiscordBridge?.getMessage?.(${JSON.stringify(channelId)}, ${JSON.stringify(messageId)}) ?? null`)
  }

  get connected() { return this.ws?.readyState === WebSocket.OPEN }
}

/**
 * Local control API on 127.0.0.1 for future tools (a Discord bot, scripts...).
 * JSON bodies only and no browser origins, so web pages cannot drive it.
 */
function startApi(port, handlers, log) {
  const server = createServer(async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    try {
      const host = (req.headers.host ?? '').replace(/:\d+$/, '')
      if (req.headers.origin || !['127.0.0.1', 'localhost'].includes(host)) return reply(403, { error: 'local clients only' })
      const route = `${req.method} ${new URL(req.url, 'http://x').pathname}`
      const handler = handlers[route]
      if (!handler) return reply(404, { error: `unknown route ${route}`, routes: Object.keys(handlers) })
      let body = {}
      if (req.method === 'POST') {
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return reply(415, { error: 'send application/json' })
        let raw = ''
        for await (const chunk of req) raw += chunk
        body = raw ? JSON.parse(raw) : {}
      }
      reply(200, await handler(body))
    } catch (error) {
      reply(error.status ?? 500, { error: error.message })
    }
  })
  server.on('error', error => log.error(`discord-autoreply: API port ${port} unavailable: ${error.message}`))
  server.listen(port, '127.0.0.1', () => log.info(`discord-autoreply: API on http://127.0.0.1:${port}`))
  return server
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 })
}

export function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULTS, ...rawConfig }
  const log = {
    info: m => ctx.logger?.info?.(m) ?? console.log(m),
    warn: m => ctx.logger?.warn?.(m) ?? console.warn(m),
    error: m => ctx.logger?.error?.(m) ?? console.error(m),
  }
  if (!config.enabled) return
  const watched = new Set((config.channels ?? []).map(String))
  const selection = { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort }

  // sessions: channelId -> current session; owned: every session this plugin made;
  // archivedAt: sessionId -> when the plugin first saw it archived.
  let state = {}
  try { state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch {}
  state.sessions ??= {}
  state.owned ??= Object.values(state.sessions).map(s => s.sessionId)
  state.archivedAt ??= {}
  const saveState = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  mkdirSync(config.sessionDirectory, { recursive: true })

  /** sessionId -> { channelId, text } for the turn being answered. */
  const live = new Map()
  const creating = new Map()

  const controller = () => ctx.sessionController

  async function liveAgent(sessionId) {
    const result = await controller().resolveAgent(sessionId)
    if ('error' in result) throw result.error
    return result.agent
  }

  const registry = () => ctx.get('workspaceRegistry')
  const isArchived = id => registry()?.archivedSessionIds?.includes(id) ?? false
  const titleFor = chat => `Discord · ${chat.channelName || chat.channelId}`.slice(0, 80)

  /** The chat's session; a new one when it has none or you archived it. */
  async function sessionFor(chat) {
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
        log.warn(`discord-autoreply: session ${known.sessionId} unusable (${error.message}); creating a new one`)
      }
    }
    if (!creating.has(chat.channelId)) {
      creating.set(chat.channelId, (async () => {
        const { sessionId } = await controller().create({ cwd: config.sessionDirectory, agentPreset: config.agentPreset })
        state.sessions[chat.channelId] = { sessionId, channelName: chat.channelName ?? '' }
        state.owned.push(sessionId)
        saveState()
        live.set(sessionId, { channelId: chat.channelId, text: '' })
        await controller().rename({ sessionId, title: titleFor(chat) }).catch(() => {})
        log.info(`discord-autoreply: new session ${sessionId} for ${chat.channelName || chat.channelId}`)
        return sessionId
      })().finally(() => creating.delete(chat.channelId)))
    }
    return creating.get(chat.channelId)
  }

  // Sessions you archive are deleted for good after archiveRetentionHours. DSH has
  // no delete API, so the session folder is removed once DSH no longer has it loaded
  // (loaded ones go on the next DSH start).
  function findSessionDir(sessionId) {
    try {
      for (const group of readdirSync(config.sessionsRoot)) {
        const dir = join(config.sessionsRoot, group, sessionId)
        if (existsSync(dir)) return dir
      }
    } catch {}
  }

  async function sweepArchived() {
    if (!registry()) return
    const now = Date.now()
    const retention = config.archiveRetentionHours * 3_600_000
    for (const id of state.owned) {
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
        log.warn(`discord-autoreply: could not delete ${id} yet: ${error.message}`)
        continue
      }
      await registry().unarchiveSession(id).catch(() => {})
      state.owned = state.owned.filter(x => x !== id)
      delete state.archivedAt[id]
      for (const [channelId, s] of Object.entries(state.sessions)) if (s.sessionId === id) delete state.sessions[channelId]
      live.delete(id)
      log.info(`discord-autoreply: deleted archived session ${id}`)
    }
    saveState()
  }

  /** Archive now and delete as soon as DSH lets go of it, skipping the waiting period. */
  async function deleteSession(sessionId) {
    if (!state.owned.includes(sessionId)) throw badRequest(`${sessionId} is not a Discord auto-reply session`)
    await registry().archiveSession(sessionId, { stopActivity: true })
    state.archivedAt[sessionId] = 0
    saveState()
    await sweepArchived()
    return state.owned.includes(sessionId) ? 'archived; files deleted when DSH next starts' : 'deleted'
  }

  // Friends' messages must never drive tools (shell, files, memory, teammates...).
  // The guard is the hard stop; hiding the tools also keeps prompts small.
  const isDiscordSession = (id) => {
    if (state.owned.includes(id)) return true
    try {
      const session = ctx.get('sessions')?.get(id)
      const preset = session && controller().agents.presetForSession(session)
      return (preset?.id ?? preset) === config.agentPreset
    } catch { return false }
  }
  ctx.effect(() => ctx.tools.guard(exec => exec.agent !== undefined && isDiscordSession(exec.agent.id)
    ? 'Tools are disabled in Discord auto-reply sessions.' : undefined), 'discord-autoreply: tool guard')
  const stripped = new WeakSet()
  function stripTools(agent) {
    if (stripped.has(agent)) return
    stripped.add(agent)
    for (const { name } of ctx.tools.schemas(agent)) {
      try { agent.ctx.tools.restrict({ deny: [name] }) } catch {}
    }
  }

  async function ensureModel(sessionId) {
    const agent = await liveAgent(sessionId)
    stripTools(agent)
    const agents = controller().agents
    const current = agents.selectionFor(agent).current
    if (current.provider !== selection.provider || current.model !== selection.model
      || current.reasoningEffort !== selection.reasoningEffort) {
      agents.selectForNextRequest(agent, { ...selection })
    }
  }

  async function loadImage(image) {
    // Discord's media proxy can shrink big uploads; fall back to the original file.
    const urls = image.size > MAX_IMAGE_BYTES && image.proxyUrl
      ? [`${image.proxyUrl}${image.proxyUrl.includes('?') ? '&' : '?'}format=jpeg&width=2048`]
      : [image.url, image.proxyUrl].filter(Boolean)
    for (const url of urls) {
      try {
        const res = await fetch(url)
        if (!res.ok) continue
        const bytes = new Uint8Array(await res.arrayBuffer())
        const mediaType = sniffImageType(bytes)
        if (!mediaType || bytes.byteLength > MAX_IMAGE_BYTES) continue
        return { type: 'image', data: Buffer.from(bytes).toString('base64'), mediaType, name: image.filename }
      } catch {}
    }
  }

  async function handleMessage(msg, { force = false } = {}) {
    if (!force && (watched.size ? !watched.has(msg.channelId) : !msg.isOpenChannel)) return
    const images = (await Promise.all((msg.images ?? []).slice(0, 4).map(loadImage))).filter(Boolean)
    const missing = (msg.images?.length ?? 0) - images.length
    const text = `${msg.author}: ${msg.content || (images.length ? '(sent an image)' : '(empty message)')}`
      + (missing > 0 ? `\n(${missing} image(s) could not be loaded)` : '')
    if (!msg.content.trim() && !images.length) return

    const sessionId = await sessionFor(msg)
    await ensureModel(sessionId)
    if (!live.has(sessionId)) live.set(sessionId, { channelId: msg.channelId, text: '' })
    await controller().prompt({
      sessionId,
      requestId: randomUUID(),
      content: [{ type: 'text', text }, ...images],
      mode: 'followup',
    }, AbortSignal.timeout(60_000))
    log.info(`discord-autoreply: queued message ${msg.id} from ${msg.author} in ${msg.channelName || msg.channelId}`)
  }

  const queue = new Map()
  // Keep each channel's messages in order.
  function enqueue(msg, options) {
    const prev = queue.get(msg.channelId) ?? Promise.resolve()
    const next = prev.then(() => handleMessage(msg, options))
    queue.set(msg.channelId, next.catch(() => {}))
    return next
  }
  const discord = new DiscordPage(config, log, (event) => {
    if (event.type === 'channel-open') {
      // Have a session ready for every chat you open (or every listed chat).
      if (watched.size && !watched.has(event.channelId)) return
      sessionFor(event).catch(error => log.error(`discord-autoreply: session for ${event.channelId} failed: ${error.message}`))
      return
    }
    enqueue(event).catch(error => {
      log.error(`discord-autoreply: failed to forward message ${event.id}: ${error.stack ?? error}`)
    })
  })

  async function deliver(channelId, text) {
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
        .filter(part => part.type === 'text').map(part => part.text).join('').trim()
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
        .catch(error => log.error(`discord-autoreply: delivering to Discord failed: ${error.message}`))
    }
  })

  // Rebuild the channel lookup for sessions that already exist.
  for (const [channelId, { sessionId }] of Object.entries(state.sessions)) {
    live.set(sessionId, { channelId, text: '' })
  }

  discord.start()
  ctx.effect(() => () => discord.stop(), 'discord-autoreply: Discord connection')

  const sweep = () => sweepArchived().catch(error => log.error(`discord-autoreply: archive sweep failed: ${error.message}`))
  const firstSweep = setTimeout(sweep, 30_000)
  const sweepTimer = setInterval(sweep, 10 * 60_000)
  ctx.effect(() => () => { clearTimeout(firstSweep); clearInterval(sweepTimer) }, 'discord-autoreply: archive sweep')

  if (config.apiPort) {
    const requireText = (body, field = 'text') => {
      if (typeof body.channelId !== 'string' || !body.channelId) throw badRequest('channelId (string) is required')
      if (typeof body[field] !== 'string' || !body[field].trim()) throw badRequest(`${field} (string) is required`)
    }
    const server = startApi(config.apiPort, {
      'GET /status': () => ({
        discordConnected: discord.connected,
        delivery: config.delivery,
        watching: watched.size ? [...watched] : 'open channel',
        sessions: state.sessions,
        archivedAt: state.archivedAt,
      }),
      // Put text into a chat's message box, exactly like an answer.
      'POST /draft': async (body) => {
        requireText(body)
        return { result: await discord.draft(body.channelId, body.text) }
      },
      // Post directly as you; only when delivery is 'send'.
      'POST /send': async (body) => {
        requireText(body)
        if (config.delivery !== 'send') throw Object.assign(new Error("sending is off (set delivery: 'send')"), { status: 403 })
        await discord.send(body.channelId, body.text)
        return { result: 'sent' }
      },
      // Treat text (and optional image URLs) as a message in a chat; the answer is delivered as usual.
      'POST /ask': async (body) => {
        requireText(body)
        await enqueue({
          id: `api-${randomUUID()}`,
          channelId: body.channelId,
          channelName: body.channelName ?? state.sessions[body.channelId]?.channelName ?? '',
          author: body.author ?? 'API',
          content: body.text,
          images: (body.imageUrls ?? []).map(url => ({ url, filename: 'image', size: 0 })),
        }, { force: true })
        return { result: 'queued' }
      },
      // Answer one existing Discord message (it must be loaded in Discord, e.g. recently viewed).
      'POST /answer': async (body) => {
        requireText(body, 'messageId')
        const msg = await discord.getMessage(body.channelId, body.messageId)
        if (!msg) throw Object.assign(new Error('message not loaded in Discord; open that chat first'), { status: 404 })
        await enqueue(msg, { force: true })
        return { result: 'queued', author: msg.author, images: msg.images.length }
      },
      // Archive a plugin session now and delete it as soon as DSH releases it.
      'POST /delete-session': async (body) => {
        if (typeof body.sessionId !== 'string') throw badRequest('sessionId (string) is required')
        return { result: await deleteSession(body.sessionId) }
      },
    }, log)
    ctx.effect(() => () => server.close(), 'discord-autoreply: API server')
  }
}
