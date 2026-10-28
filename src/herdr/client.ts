// Talking to herdr (https://herdr.dev), the terminal multiplexer that owns the
// terminals coding agents run in.
//
// Because herdr owns the terminal, it can do what nothing reading files can:
// say what the agent in a pane is doing (it watches the screen, so a
// permission dialog shows as `blocked`), and type into the pane exactly as
// you would. That is what lets an app answer a prompt or send a follow-up to a
// session it did not start, without taking the session over.
//
// The API is newline-delimited JSON over a local unix socket:
//
//   → {"id":"1","method":"agent.list","params":{}}
//   ← {"id":"1","result":{"type":"agent_list","agents":[...]}}
//
// One connection per request: they are local and cheap, and it keeps a slow
// call from holding up the next. Node only (exported from agent-conduit/node).

import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface HerdrOptions {
  /** The server's socket. Defaults to `$HERDR_SOCKET_PATH`, then herdr's own default for `$HERDR_SESSION`. */
  socketPath?: string
  /** Give up on a request after this long. Default 5 s; a prompt that waits passes its own. */
  timeoutMs?: number
}

/** A request herdr answered with an error: `not_found`, `agent_blocked`, `timeout`, ... */
export class HerdrError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'HerdrError'
  }
}

/** Where herdr's socket is, by the same rules its CLI uses. */
export function defaultHerdrSocketPath(): string {
  if (process.env.HERDR_SOCKET_PATH) {
    return process.env.HERDR_SOCKET_PATH
  }
  const configDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'herdr')
  const session = process.env.HERDR_SESSION
  return session ? join(configDir, 'sessions', session, 'herdr.sock') : join(configDir, 'herdr.sock')
}

let nextId = 0

/** Send one request and return its `result`, or throw. */
export function herdrRequest<T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown> = {},
  options: HerdrOptions = {},
): Promise<T> {
  const socketPath = options.socketPath ?? defaultHerdrSocketPath()
  const id = `agent-conduit:${process.pid}:${++nextId}`

  return new Promise<T>((resolve, reject) => {
    const socket = createConnection(socketPath)
    let buffer = ''
    let settled = false

    const finish = (error: Error | undefined, result?: T) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error) reject(error)
      else resolve(result as T)
    }

    socket.setTimeout(options.timeoutMs ?? 5_000, () => finish(new HerdrError('timeout', `herdr did not answer ${method} in time`)))
    socket.on('error', error => finish(error))
    socket.on('close', () => finish(new HerdrError('closed', `herdr closed the connection before answering ${method}`)))
    socket.on('connect', () => socket.write(`${JSON.stringify({ id, method, params })}\n`))
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!line) continue
        let message: { id?: string, result?: T, error?: { code?: string, message?: string } }
        try {
          message = JSON.parse(line)
        }
        catch {
          continue
        }
        // Errors for unparseable requests come back with an empty id.
        if (message.id !== id && message.id !== '') continue
        if (message.error) {
          finish(new HerdrError(message.error.code ?? 'error', message.error.message ?? `${method} failed`))
        }
        else {
          finish(undefined, message.result)
        }
      }
    })
  })
}
