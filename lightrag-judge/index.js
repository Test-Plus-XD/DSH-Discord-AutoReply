/// dsh-lightrag-judge: the LightRAG project's RAGAS judge, run inside the DeepSeek Harness desktop app.
///
/// judge_setup.py (transport "desktop") posts every RAGAS prompt to this plugin's localhost API. The plugin creates a
/// fresh DSH session for it with the tool-less `lightrag-judge` preset, in the working folder the caller names (the
/// LightRAG repository), so the session appears in that repository's DSH workspace and streams live, thinking
/// included, while DeepSeek answers. When the turn ends, the reply text goes back to Python as the HTTP response.
/// One session per prompt, as with the headless transport, so no judgement sees another one's conversation.
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

export const name = 'dsh-lightrag-judge'
export const inject = ['sessionController', 'tools']
// Reported by GET /status, so callers can tell which plugin build DSH has loaded.
const VERSION = '0.2.0'

const DEFAULTS = {
  enabled: true,
  apiPort: 18791,
  agentPreset: 'lightrag-judge',
  provider: 'deepseek-account',
  timeoutMs: 900_000,
}

// An error carrying the HTTP status the API should answer with, and DSH's error code when there is one.
class HttpError extends Error {
  constructor(status, message, code) {
    super(message)
    this.status = status
    this.code = code
  }
}

// Wires the preset's tool guard, the turn collector and the localhost API into the desktop host.
export function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULTS, ...rawConfig }
  const log = {
    info: message => ctx.logger?.info?.(message) ?? console.log(message),
    warn: message => ctx.logger?.warn?.(message) ?? console.warn(message),
  }
  if (!config.enabled || !config.apiPort) return
  const controller = () => ctx.sessionController
  // Sessions this plugin created, and the judgement each running one is waiting for.
  const owned = new Set()
  const waiting = new Map()

  // Judge sessions must never run tools: the guard is the hard stop, and hiding the tools keeps prompts small.
  const isJudgeSession = id => {
    if (owned.has(id)) return true
    try {
      const session = ctx.get('sessions')?.get(id)
      const preset = session ? controller().agents.presetForSession(session) : undefined
      return (typeof preset === 'object' ? preset?.id : preset) === config.agentPreset
    } catch { return false }
  }
  ctx.effect(() => ctx.tools.guard(exec => exec.agent !== undefined && isJudgeSession(exec.agent.id)
    ? 'Tools are disabled in LightRAG judge sessions.' : undefined), 'lightrag-judge: tool guard')

  // Returns the live agent of a session, hiding every tool it could otherwise see.
  async function judgeAgent(sessionId) {
    const result = await controller().resolveAgent(sessionId)
    if ('error' in result) throw result.error
    for (const { name: tool } of ctx.tools.schemas(result.agent)) {
      // Agent-scoped tools cannot be restricted; the guard above still blocks them.
      try { result.agent.ctx.tools.restrict({ deny: [tool] }) } catch {}
    }
    return result.agent
  }

  // Collects each judge turn's final text and reasoning; the turn's end settles the waiting request.
  ctx.on('session/event', (session, event) => {
    const turn = waiting.get(session.id)
    if (!turn) return
    if (event.type === 'assistant/message') {
      const parts = event.data.message?.content ?? []
      const text = parts.filter(part => part.type === 'text').map(part => part.text ?? '').join('').trim()
      if (text) turn.text = text
    } else if (event.type === 'turn/end') {
      waiting.delete(session.id)
      const reason = event.data.reason ?? {}
      if (reason.kind === 'completed' && turn.text) turn.resolve(turn.text)
      else turn.reject(new HttpError(502, reason.error?.message ?? `turn ended (${reason.kind}) without a reply`,
        reason.error?.code))
    }
  })

  // Files a session under the DSH workspace whose folder is `cwd`. A session created through the controller only
  // carries the cwd; the sidebar lists it under a workspace once it is attached to that workspace's session list
  // (what the app's own "New Session" button does), otherwise it shows as Ungrouped. Returns the workspace title,
  // or undefined when no workspace owns that folder (the session then stays Ungrouped).
  async function attachToWorkspace(sessionId, cwd) {
    const registry = ctx.get('workspaceRegistry')
    const workspace = await registry?.resolveByPath(cwd)
    if (!workspace) return undefined
    await workspace.attachSession(sessionId)
    return workspace.title ?? workspace.record?.title
  }

  // Runs one judgement: new session in `cwd`, filed under that folder's workspace, titled, on the requested model,
  // then waits for its reply.
  async function judge(input) {
    for (const field of ['cwd', 'prompt', 'model']) {
      if (typeof input[field] !== 'string' || !input[field].trim()) throw new HttpError(400, `${field} (string) is required`)
    }
    let isDirectory = false
    try { isDirectory = isAbsolute(input.cwd) && statSync(input.cwd).isDirectory() } catch {}
    if (!isDirectory) throw new HttpError(400, `cwd must be an existing absolute folder: ${input.cwd}`)
    const { sessionId } = await controller().create({ cwd: input.cwd, agentPreset: config.agentPreset })
    owned.add(sessionId)
    await attachToWorkspace(sessionId, input.cwd)
      .catch(error => log.warn(`lightrag-judge: could not file ${sessionId} under its workspace: ${error.message}`))
    const title = String(input.title || 'LightRAG judge').slice(0, 80)
    await controller().rename({ sessionId, title }).catch(() => {})
    const agent = await judgeAgent(sessionId)
    // Per-session selection only; selectModel() would also overwrite the app's global default model.
    const selection = { provider: config.provider, model: input.model, reasoningEffort: input.reasoningEffort || 'high' }
    controller().agents.selectForNextRequest(agent, selection)
    const reply = new Promise((resolve, reject) => waiting.set(sessionId, { resolve, reject, text: '' }))
    const accepted = await controller().prompt({
      sessionId, requestId: randomUUID(), content: [{ type: 'text', text: input.prompt }], mode: 'followup',
    }, AbortSignal.timeout(60_000))
    if (accepted && accepted.accepted === false) {
      waiting.delete(sessionId)
      throw new HttpError(503, `DSH did not accept the prompt for ${sessionId}`)
    }
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new HttpError(504, `no reply within ${config.timeoutMs} ms`)), config.timeoutMs)
    })
    try {
      return { text: await Promise.race([reply, timeout]), sessionId }
    } finally {
      clearTimeout(timer)
      if (waiting.has(sessionId)) {
        waiting.delete(sessionId)
        log.warn(`lightrag-judge: gave up waiting for ${sessionId} (${title})`)
      }
    }
  }

  const routes = {
    'GET /status': () => ({ ok: true, plugin: name, version: VERSION, agentPreset: config.agentPreset,
      provider: config.provider, running: waiting.size }),
    'POST /judge': judge,
    // Files an existing session under the workspace of its own folder, e.g. one made before this was automatic.
    'POST /attach': async input => {
      if (typeof input.sessionId !== 'string' || typeof input.cwd !== 'string') {
        throw new HttpError(400, 'sessionId and cwd (strings) are required')
      }
      const workspace = await attachToWorkspace(input.sessionId, input.cwd)
      if (!workspace) throw new HttpError(404, `no DSH workspace owns ${input.cwd}`)
      return { result: 'attached', workspace }
    },
  }

  // Localhost-only JSON API: requests with an Origin header (browsers) or a non-local Host are refused.
  const server = createServer(async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    try {
      const host = (req.headers.host ?? '').replace(/:\d+$/, '')
      if (req.headers.origin || !['127.0.0.1', 'localhost'].includes(host)) return reply(403, { error: 'local clients only' })
      const url = new URL(req.url ?? '/', 'http://x')
      const handler = routes[`${req.method} ${url.pathname}`]
      if (!handler) return reply(404, { error: `unknown route ${req.method} ${url.pathname}`, routes: Object.keys(routes) })
      let input = Object.fromEntries(url.searchParams)
      if (req.method === 'POST') {
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return reply(415, { error: 'send application/json' })
        let raw = ''
        for await (const chunk of req) raw += chunk
        input = raw ? JSON.parse(raw) : {}
      }
      reply(200, await handler(input))
    } catch (error) {
      reply(error instanceof HttpError ? error.status : 500, { error: error.message, code: error.code })
    }
  })
  server.on('error', error => log.warn(`lightrag-judge: API port ${config.apiPort} unavailable: ${error.message}`))
  server.listen(config.apiPort, '127.0.0.1', () => log.info(`lightrag-judge: API on http://127.0.0.1:${config.apiPort}`))
  ctx.effect(() => () => { server.close() }, 'lightrag-judge: API server')
}
