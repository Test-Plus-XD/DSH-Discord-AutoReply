/**
 * Local control API on 127.0.0.1 for future tools (a Discord bot, scripts...).
 * JSON bodies only and no browser origins, so web pages cannot drive it.
 */
import { createServer, type Server } from 'node:http'
import type { Log } from './types.ts'

/** GET handlers receive the query string as an object; POST handlers the JSON body. */
export type Handler = (input: Record<string, any>) => unknown
export type Routes = Record<string, Handler>

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export const badRequest = (message: string): HttpError => new HttpError(400, message)

export function startApi(port: number, routes: Routes, log: Log): Server {
  const server = createServer(async (req, res) => {
    const reply = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    try {
      const host = (req.headers.host ?? '').replace(/:\d+$/, '')
      if (req.headers.origin || !['127.0.0.1', 'localhost'].includes(host)) return reply(403, { error: 'local clients only' })
      const url = new URL(req.url ?? '/', 'http://x')
      const route = `${req.method} ${url.pathname}`
      const handler = routes[route]
      if (!handler) return reply(404, { error: `unknown route ${route}`, routes: Object.keys(routes) })
      let input: Record<string, any> = Object.fromEntries(url.searchParams)
      if (req.method === 'POST') {
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return reply(415, { error: 'send application/json' })
        let raw = ''
        for await (const chunk of req) raw += chunk
        input = raw ? JSON.parse(raw) : {}
      }
      reply(200, await handler(input))
    } catch (error) {
      reply(error instanceof HttpError ? error.status : 500, { error: (error as Error).message })
    }
  })
  server.on('error', error => log.error(`discord-autoreply: API port ${port} unavailable: ${error.message}`))
  server.listen(port, '127.0.0.1', () => log.info(`discord-autoreply: API on http://127.0.0.1:${port}`))
  return server
}
