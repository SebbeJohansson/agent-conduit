import { describe, expect, it } from 'vitest'
import type { OpencodePacket } from './events.js'
import { applyPacket, applySnapshot, createOpencodeState, readOpencodeSessions } from './status.js'

function session(id: string, parentID?: string) {
  return { id, parentID, directory: '/p', title: `t-${id}`, time: { created: 1, updated: 2 } }
}

function packet(type: string, properties: Record<string, unknown>): OpencodePacket {
  return { directory: '/p', payload: { type, properties } }
}

function activities(state: ReturnType<typeof createOpencodeState>) {
  return Object.fromEntries(readOpencodeSessions(state).map(s => [s.sessionId, s.activity]))
}

describe('opencode status', () => {
  it('reads busy and retry as working, anything else as idle', () => {
    const state = createOpencodeState()
    applySnapshot(state, {
      sessions: [session('a'), session('b'), session('c')],
      statuses: { a: { type: 'busy' }, b: { type: 'retry', attempt: 1 } },
      permissions: [],
      questions: [],
    })

    expect(activities(state)).toEqual({ a: 'working', b: 'working', c: 'idle' })
  })

  it('credits a subagent\'s work and prompts to its root, and lists only roots', () => {
    const state = createOpencodeState()
    applySnapshot(state, {
      sessions: [session('root'), session('child', 'root'), session('grandchild', 'child')],
      statuses: { grandchild: { type: 'busy' } },
      permissions: [],
      questions: [],
    })
    expect(activities(state)).toEqual({ root: 'working' })

    applyPacket(state, packet('permission.asked', { id: 'perm1', sessionID: 'grandchild', permission: 'bash', patterns: ['git push'] }))
    const [root] = readOpencodeSessions(state)
    expect(root?.activity).toBe('approval')
    expect(root?.pending).toEqual([{ requestId: 'perm1', kind: 'permission', sessionId: 'grandchild', summary: 'bash git push', directory: '/p' }])

    applyPacket(state, packet('permission.replied', { sessionID: 'grandchild', requestID: 'perm1', reply: 'once' }))
    expect(activities(state)).toEqual({ root: 'working' })
  })

  it('tracks a session through a turn from events alone', () => {
    const state = createOpencodeState()
    expect(applyPacket(state, packet('session.created', { info: session('a') }))).toBe(true)
    applyPacket(state, packet('session.status', { sessionID: 'a', status: { type: 'busy' } }))
    expect(activities(state)).toEqual({ a: 'working' })

    applyPacket(state, packet('question.asked', { id: 'q1', sessionID: 'a', questions: [{ question: 'Which branch?', header: 'Branch' }] }))
    expect(readOpencodeSessions(state)[0]?.pending[0]?.summary).toBe('Which branch?')

    applyPacket(state, packet('question.rejected', { sessionID: 'a', requestID: 'q1' }))
    applyPacket(state, packet('session.status', { sessionID: 'a', status: { type: 'idle' } }))
    expect(activities(state)).toEqual({ a: 'idle' })
  })

  it('treats the older session.idle event as the end of a turn', () => {
    const state = createOpencodeState()
    applySnapshot(state, { sessions: [session('a')], statuses: { a: 'busy' }, permissions: [], questions: [] })
    applyPacket(state, packet('session.idle', { sessionID: 'a' }))
    expect(activities(state)).toEqual({ a: 'idle' })
  })

  it('forgets a deleted session and its open requests', () => {
    const state = createOpencodeState()
    applySnapshot(state, {
      sessions: [session('a')],
      statuses: {},
      permissions: [{ id: 'p', sessionID: 'a', permission: 'edit', patterns: [] }],
      questions: [],
    })
    applyPacket(state, packet('session.deleted', { info: session('a') }))
    expect(readOpencodeSessions(state)).toEqual([])
    expect(state.pending.size).toBe(0)
  })

  it('reports whether an event changed anything', () => {
    const state = createOpencodeState()
    applySnapshot(state, { sessions: [session('a')], statuses: {}, permissions: [], questions: [] })
    expect(applyPacket(state, packet('session.status', { sessionID: 'a', status: { type: 'idle' } }))).toBe(false)
    expect(applyPacket(state, packet('file.edited', { file: 'x' }))).toBe(false)
  })
})
