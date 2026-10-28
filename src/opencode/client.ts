// Talking to a running OpenCode server (`opencode serve`, port 4096 by default).
//
// Two calls cover it:
//
//   fetchOpencodeSessions  one read of every session, status and open request
//   watchOpencode          a snapshot, then the event stream on top of it,
//                          reconnecting when the server goes away
//
// `fetch` is passed in rather than taken from the global, because a Tauri
// webview cannot use its own: the server does not send CORS headers for the
// webview's origin, so the request has to go out through tauri-plugin-http.

import type { OpencodePacket } from './events.js'
import type { OpencodeSession, OpencodeSnapshot } from './status.js'
import { parseSseBlock, splitSseBlocks } from './events.js'
import { applyPacket, applySnapshot, createOpencodeState, readOpencodeSessions } from './status.js'

export interface OpencodeConnection {
  /** `http://127.0.0.1:4096`. A trailing slash is fine. */
  baseUrl: string
  /** Sent as the `Authorization` header, for a server started with a password. */
  authorization?: string
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch
}

function urlOf(connection: OpencodeConnection, path: string, directory?: string): string {
  const query = directory ? `?${new URLSearchParams({ directory })}` : ''
  return `${connection.baseUrl.replace(/\/+$/, '')}${path}${query}`
}

function headersOf(connection: OpencodeConnection, accept = 'application/json'): Record<string, string> {
  return {
    Accept: accept,
    ...(connection.authorization ? { Authorization: connection.authorization } : {}),
  }
}

async function getJson(connection: OpencodeConnection, path: string, directory?: string): Promise<unknown> {
  const fetcher = connection.fetch ?? globalThis.fetch
  const response = await fetcher(urlOf(connection, path, directory), { headers: headersOf(connection) })
  if (!response.ok) {
    throw new Error(`${path} failed (${response.status})`)
  }
  return response.json()
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function idOf(value: unknown): string | undefined {
  const id = (value as { id?: unknown } | null)?.id
  return typeof id === 'string' ? id : undefined
}

/** Keep the first of each id: every directory can return the same request. */
function uniqueById(values: unknown[]): unknown[] {
  const seen = new Set<string>()
  return values.filter((value) => {
    const id = idOf(value)
    if (!id || seen.has(id)) return false
    seen.add(id)
    return true
  })
}

/**
 * The directories a server has instances for: the default one, plus every
 * project's worktree and sandboxes. Sessions, statuses and requests are kept
 * per instance, so each has to be asked.
 */
async function directoriesOf(connection: OpencodeConnection): Promise<Array<string | undefined>> {
  const directories = new Set<string>()
  for (const project of asArray(await getJson(connection, '/project'))) {
    const record = project as { worktree?: unknown, sandboxes?: unknown }
    if (typeof record.worktree === 'string' && record.worktree && record.worktree !== '/') {
      directories.add(record.worktree)
    }
    for (const sandbox of asArray(record.sandboxes)) {
      if (typeof sandbox === 'string' && sandbox) directories.add(sandbox)
    }
  }
  return [undefined, ...directories]
}

/** Everything the server knows right now, raw, from every directory. */
export async function readOpencodeSnapshot(connection: OpencodeConnection): Promise<OpencodeSnapshot> {
  const perDirectory = await Promise.all((await directoriesOf(connection)).map(async directory => {
    const [sessions, statuses, permissions, questions] = await Promise.all([
      getJson(connection, '/session', directory),
      getJson(connection, '/session/status', directory),
      getJson(connection, '/permission', directory).catch(() => []),
      // Older servers have no question endpoint.
      getJson(connection, '/question', directory).catch(() => []),
    ])
    return { sessions: asArray(sessions), statuses, permissions: asArray(permissions), questions: asArray(questions) }
  }))

  return {
    sessions: uniqueById(perDirectory.flatMap(d => d.sessions)),
    statuses: Object.assign({}, ...perDirectory.map(d => (d.statuses && typeof d.statuses === 'object' ? d.statuses : {}))),
    permissions: uniqueById(perDirectory.flatMap(d => d.permissions)),
    questions: uniqueById(perDirectory.flatMap(d => d.questions)),
  }
}

/** One read of every root session and what it is doing, for a caller that polls. */
export async function fetchOpencodeSessions(connection: OpencodeConnection): Promise<OpencodeSession[]> {
  const state = createOpencodeState()
  applySnapshot(state, await readOpencodeSnapshot(connection))
  return readOpencodeSessions(state)
}

/**
 * Answer a permission request: `once` allows this call, `always` allows calls
 * like it for the rest of the session, `reject` refuses it.
 */
export async function replyOpencodePermission(
  connection: OpencodeConnection,
  request: { requestId: string, directory?: string },
  reply: 'once' | 'always' | 'reject',
): Promise<void> {
  const fetcher = connection.fetch ?? globalThis.fetch
  const path = `/permission/${encodeURIComponent(request.requestId)}/reply`
  const response = await fetcher(urlOf(connection, path, request.directory || undefined), {
    method: 'POST',
    headers: { ...headersOf(connection), 'Content-Type': 'application/json' },
    body: JSON.stringify({ reply }),
  })
  if (!response.ok) {
    throw new Error(`${path} failed (${response.status})`)
  }
}

export interface OpencodeWatchHandlers {
  /** Every root session, after the first snapshot and after each change. */
  onSessions: (sessions: OpencodeSession[]) => void
  /** The server could not be reached or the stream broke; a retry follows. */
  onError?: (message: string) => void
}

export interface OpencodeWatch {
  stop: () => void
}

/**
 * Keep a live view of a server: a snapshot, then every event on top of it.
 *
 * The stream is opened first and the snapshot read second, with events that
 * arrive in between held back and replayed onto it, so a change made while
 * the snapshot was in flight is not lost. Whenever the stream ends, the whole
 * thing starts over after `retryMs`.
 */
export function watchOpencode(
  connection: OpencodeConnection,
  handlers: OpencodeWatchHandlers,
  retryMs = 3_000,
): OpencodeWatch {
  const fetcher = connection.fetch ?? globalThis.fetch
  let stopped = false
  let abort: AbortController | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  const retry = (message: string) => {
    if (stopped) return
    handlers.onError?.(message)
    retryTimer = setTimeout(() => void connect(), retryMs)
  }

  async function connect(): Promise<void> {
    abort = new AbortController()
    const state = createOpencodeState()
    let held: OpencodePacket[] | undefined = []

    let response: Response
    try {
      response = await fetcher(urlOf(connection, '/global/event'), {
        headers: headersOf(connection, 'text/event-stream'),
        signal: abort.signal,
      })
    }
    catch (error) {
      return retry(String(error))
    }
    if (!response.ok || !response.body) {
      return retry(`/global/event failed (${response.status})`)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()

    const snapshot = readOpencodeSnapshot(connection).then((raw) => {
      applySnapshot(state, raw)
      for (const packet of held ?? []) applyPacket(state, packet)
      held = undefined
      handlers.onSessions(readOpencodeSessions(state))
    })

    try {
      let buffer = ''
      // Read the stream and the snapshot side by side; a snapshot failure is a
      // failed connection like any other.
      const stream = (async () => {
        while (true) {
          const { done, value } = await reader.read()
          if (done) return
          const split = splitSseBlocks(buffer + decoder.decode(value, { stream: true }))
          buffer = split.rest
          let changed = false
          for (const block of split.blocks) {
            const packet = parseSseBlock(block.trim())
            if (!packet) continue
            if (held) held.push(packet)
            else changed = applyPacket(state, packet) || changed
          }
          if (changed) handlers.onSessions(readOpencodeSessions(state))
        }
      })()
      await Promise.all([snapshot, stream])
      retry('event stream closed')
    }
    catch (error) {
      if (!stopped) {
        abort.abort()
        retry(String(error))
      }
    }
  }

  void connect()

  return {
    stop() {
      stopped = true
      clearTimeout(retryTimer)
      abort?.abort()
    },
  }
}
