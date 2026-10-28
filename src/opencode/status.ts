// What each OpenCode session is doing, kept up to date from a snapshot of the
// server's state plus the events that follow it.
//
// OpenCode says it outright, unlike Claude Code, whose state has to be read out
// of a transcript:
//
//   session.status { type: 'busy' | 'retry' }   working
//   session.status { type: 'idle' }             finished; your move
//   permission.asked / question.asked           waiting on you to answer
//
// The one subtlety is subagents. A subagent runs as a child session with a
// `parentID`, and its permission prompt blocks the whole task, so everything a
// child is doing is credited to the root session the person started.
//
// This file is pure: it takes parsed JSON, never a connection, so it can be
// tested and reasoned about without a server. `client.ts` feeds it.

import type { OpencodePacket } from './events.js'

/**
 * - `approval` a permission or a question is waiting on you
 * - `working`  the session, or a subagent of it, is running
 * - `idle`     nothing is running; how long ago it finished is up to the caller
 */
export type OpencodeActivity = 'approval' | 'working' | 'idle'

export interface OpencodePending {
  requestId: string
  kind: 'permission' | 'question'
  /** The session that asked: the root itself or one of its subagents. */
  sessionId: string
  /** What it wants, in one line: `bash git push`, or the question's text. */
  summary: string
  /** The instance it was asked in, which a reply has to name. Empty when unknown. */
  directory: string
}

/** One root session, with what it and its subagents are doing folded in. */
export interface OpencodeSession {
  sessionId: string
  directory: string
  title: string
  activity: OpencodeActivity
  /** Oldest first. */
  pending: OpencodePending[]
  /** Epoch milliseconds. */
  timeCreated: number
  /** Epoch milliseconds of the last change OpenCode recorded on the session. */
  timeUpdated: number
}

interface SessionRecord {
  id: string
  parentID?: string
  directory: string
  title: string
  timeCreated: number
  timeUpdated: number
}

export interface OpencodeState {
  sessions: Map<string, SessionRecord>
  /** Sessions whose last status was busy or retry. */
  running: Set<string>
  /** Open requests by request id. */
  pending: Map<string, OpencodePending>
}

export function createOpencodeState(): OpencodeState {
  return { sessions: new Map(), running: new Set(), pending: new Map() }
}

/** What `client.ts` reads at connect time, as the server returned it. */
export interface OpencodeSnapshot {
  /** `GET /session`, from every directory. */
  sessions: unknown[]
  /** `GET /session/status`, from every directory: session id to status. */
  statuses: Record<string, unknown>
  /** `GET /permission`, from every directory. */
  permissions: unknown[]
  /** `GET /question`, from every directory. */
  questions: unknown[]
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function sessionRecord(value: unknown): SessionRecord | undefined {
  const info = asRecord(value)
  const id = asString(info?.id)
  if (!info || !id) {
    return undefined
  }
  const time = asRecord(info.time)
  const parentID = asString(info.parentID)
  return {
    id,
    ...(parentID ? { parentID } : {}),
    directory: asString(info.directory) ?? '',
    title: asString(info.title) ?? '',
    timeCreated: typeof time?.created === 'number' ? time.created : 0,
    timeUpdated: typeof time?.updated === 'number' ? time.updated : 0,
  }
}

function statusKind(value: unknown): string | undefined {
  return asString(typeof value === 'string' ? value : asRecord(value)?.type)?.toLowerCase()
}

/** busy and retry are both "still going": a retry is the model call being tried again. */
function isRunning(status: unknown): boolean {
  const kind = statusKind(status)
  return kind === 'busy' || kind === 'retry'
}

function permissionRequest(value: unknown, directory = ''): OpencodePending | undefined {
  const request = asRecord(value)
  const requestId = asString(request?.id)
  const sessionId = asString(request?.sessionID)
  if (!request || !requestId || !sessionId) {
    return undefined
  }
  const patterns = Array.isArray(request.patterns) ? request.patterns.filter(p => typeof p === 'string') : []
  return {
    requestId,
    kind: 'permission',
    sessionId,
    summary: [asString(request.permission) ?? 'permission', ...patterns].join(' '),
    directory,
  }
}

function questionRequest(value: unknown, directory = ''): OpencodePending | undefined {
  const request = asRecord(value)
  const requestId = asString(request?.id)
  const sessionId = asString(request?.sessionID)
  if (!request || !requestId || !sessionId) {
    return undefined
  }
  const first = Array.isArray(request.questions) ? asRecord(request.questions[0]) : undefined
  return {
    requestId,
    kind: 'question',
    sessionId,
    summary: asString(first?.question) ?? asString(first?.header) ?? 'question',
    directory,
  }
}

/** Replace everything known with a fresh snapshot. */
export function applySnapshot(state: OpencodeState, snapshot: OpencodeSnapshot): void {
  state.sessions.clear()
  state.running.clear()
  state.pending.clear()

  for (const raw of snapshot.sessions) {
    const record = sessionRecord(raw)
    if (record) {
      state.sessions.set(record.id, record)
    }
  }
  for (const [sessionId, status] of Object.entries(snapshot.statuses)) {
    if (isRunning(status)) {
      state.running.add(sessionId)
    }
  }
  for (const raw of snapshot.permissions) {
    const request = permissionRequest(raw)
    if (request) {
      state.pending.set(request.requestId, request)
    }
  }
  for (const raw of snapshot.questions) {
    const request = questionRequest(raw)
    if (request) {
      state.pending.set(request.requestId, request)
    }
  }
}

/**
 * Apply one event. Returns true when it changed anything worth redrawing.
 *
 * Event types this does not know are ignored, so a newer server is safe.
 */
export function applyPacket(state: OpencodeState, packet: OpencodePacket): boolean {
  const { type, properties } = packet.payload
  const sessionId = asString(properties.sessionID)

  switch (type) {
    case 'session.created':
    case 'session.updated': {
      const record = sessionRecord(properties.info)
      if (!record) return false
      state.sessions.set(record.id, record)
      return true
    }
    case 'session.deleted': {
      const id = asString(asRecord(properties.info)?.id)
      if (!id) return false
      state.sessions.delete(id)
      state.running.delete(id)
      for (const [requestId, request] of state.pending) {
        if (request.sessionId === id) state.pending.delete(requestId)
      }
      return true
    }
    case 'session.status': {
      if (!sessionId) return false
      const running = isRunning(properties.status)
      if (running === state.running.has(sessionId)) return false
      if (running) state.running.add(sessionId)
      else state.running.delete(sessionId)
      return true
    }
    // Older servers announce the end of a turn this way instead of a status.
    case 'session.idle':
      return sessionId ? state.running.delete(sessionId) : false
    case 'permission.asked': {
      const request = permissionRequest(properties, packet.directory)
      if (!request) return false
      state.pending.set(request.requestId, request)
      return true
    }
    case 'question.asked': {
      const request = questionRequest(properties, packet.directory)
      if (!request) return false
      state.pending.set(request.requestId, request)
      return true
    }
    case 'permission.replied':
    case 'question.replied':
    case 'question.rejected': {
      const requestId = asString(properties.requestID)
      return requestId ? state.pending.delete(requestId) : false
    }
    default:
      return false
  }
}

/**
 * The root a session belongs to: itself, or the top of its parent chain.
 *
 * A parent the state has never seen ends the walk there, so a subagent whose
 * root was not loaded stands in for it rather than vanishing.
 */
export function rootOf(state: OpencodeState, sessionId: string): string {
  let current = sessionId
  const seen = new Set<string>()
  while (!seen.has(current)) {
    seen.add(current)
    const parent = state.sessions.get(current)?.parentID
    if (!parent || !state.sessions.has(parent)) {
      return current
    }
    current = parent
  }
  return current
}

/** Every root session the state knows, with its subagents' activity folded in. */
export function readOpencodeSessions(state: OpencodeState): OpencodeSession[] {
  const running = new Set([...state.running].map(id => rootOf(state, id)))
  const pendingByRoot = new Map<string, OpencodePending[]>()
  for (const request of state.pending.values()) {
    const root = rootOf(state, request.sessionId)
    // A snapshot's requests do not say which instance they came from; the
    // session that asked does.
    const directory = request.directory || state.sessions.get(request.sessionId)?.directory || ''
    pendingByRoot.set(root, [...(pendingByRoot.get(root) ?? []), { ...request, directory }])
  }

  const sessions: OpencodeSession[] = []
  for (const record of state.sessions.values()) {
    if (rootOf(state, record.id) !== record.id) {
      continue
    }
    const pending = pendingByRoot.get(record.id) ?? []
    sessions.push({
      sessionId: record.id,
      directory: record.directory,
      title: record.title,
      activity: pending.length ? 'approval' : running.has(record.id) ? 'working' : 'idle',
      pending,
      timeCreated: record.timeCreated,
      timeUpdated: record.timeUpdated,
    })
  }
  return sessions
}
