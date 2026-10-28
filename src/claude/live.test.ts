import { describe, expect, it } from 'vitest'
import { memoryFs } from '../testing/memoryFs.js'
import { createLiveClaudeCache, readLiveClaudeSessions } from './live.js'

const NOW = 1_700_000_000_000
const ROOT = { claudeDir: '/home/me/.claude', socketDir: '/run/user/1000/cc-socks' }

function registry(pid: number, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ pid, sessionId: `s${pid}`, cwd: '/home/me/proj', startedAt: NOW - 1000, ...extra })
}

const BUSY = JSON.stringify({ type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash' }] } })
const DONE = JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } })
const TITLE = JSON.stringify({ type: 'ai-title', aiTitle: 'Fix the login' })

describe('readLiveClaudeSessions', () => {
  it('lists only sessions with a live socket, with their transcript state', async () => {
    const fs = memoryFs({
      '/home/me/.claude/sessions/1.json': registry(1),
      '/home/me/.claude/sessions/2.json': registry(2),
      '/run/user/1000/cc-socks/1.sock': '',
      '/home/me/.claude/projects/-home-me-proj/s1.jsonl': `${TITLE}\n${BUSY}\n`,
    }, { '/home/me/.claude/projects/-home-me-proj/s1.jsonl': NOW - 500 })

    const { sessions, degraded } = await readLiveClaudeSessions(fs, ROOT, createLiveClaudeCache(), NOW)

    expect(degraded).toBe(false)
    expect(sessions).toEqual([{
      sessionId: 's1',
      pid: 1,
      directory: '/home/me/proj',
      name: 'Fix the login',
      startedAt: NOW - 1000,
      transcriptPath: '/home/me/.claude/projects/-home-me-proj/s1.jsonl',
      lastActivity: NOW - 500,
      state: { phase: 'busy', tool: 'Bash' },
    }])
  })

  it('finds a transcript the encoded guess misses by sweeping the project folders', async () => {
    const fs = memoryFs({
      '/home/me/.claude/sessions/1.json': registry(1),
      '/run/user/1000/cc-socks/1.sock': '',
      '/home/me/.claude/projects/somewhere-else/s1.jsonl': `${DONE}\n`,
    })

    const { sessions } = await readLiveClaudeSessions(fs, ROOT, createLiveClaudeCache(), NOW)

    expect(sessions[0]?.transcriptPath).toBe('/home/me/.claude/projects/somewhere-else/s1.jsonl')
    expect(sessions[0]?.state).toMatchObject({ phase: 'turn-ended', lastText: 'done' })
  })

  it('does not re-read an unchanged transcript', async () => {
    const path = '/home/me/.claude/projects/-home-me-proj/s1.jsonl'
    const fs = memoryFs({
      '/home/me/.claude/sessions/1.json': registry(1),
      '/run/user/1000/cc-socks/1.sock': '',
      [path]: `${TITLE}\n${DONE}\n`,
    }, { [path]: NOW - 500 })
    const cache = createLiveClaudeCache()

    await readLiveClaudeSessions(fs, ROOT, cache, NOW)
    const before = fs.reads.filter(p => p === path).length
    await readLiveClaudeSessions(fs, ROOT, cache, NOW + 1000)

    expect(fs.reads.filter(p => p === path).length).toBe(before)
  })

  it('without a socket directory, lists only recently active sessions and says so', async () => {
    const fs = memoryFs({
      '/home/me/.claude/sessions/1.json': registry(1),
      '/home/me/.claude/sessions/2.json': registry(2, { startedAt: NOW - 24 * 60 * 60_000 }),
    })

    const { sessions, degraded } = await readLiveClaudeSessions(fs, { claudeDir: ROOT.claudeDir }, createLiveClaudeCache(), NOW)

    expect(degraded).toBe(true)
    expect(sessions.map(s => s.pid)).toEqual([1])
  })

  it('prefers a name you gave the session over its title', async () => {
    const fs = memoryFs({
      '/home/me/.claude/sessions/1.json': registry(1, { name: 'mine', nameSource: 'user' }),
      '/run/user/1000/cc-socks/1.sock': '',
      '/home/me/.claude/projects/-home-me-proj/s1.jsonl': `${TITLE}\n${DONE}\n`,
    })

    const { sessions } = await readLiveClaudeSessions(fs, ROOT, createLiveClaudeCache(), NOW)

    expect(sessions[0]?.name).toBe('mine')
  })
})

describe('permission prompts', () => {
  const transcript = '/home/me/.claude/projects/-home-me-proj/s1.jsonl'
  const marker = '/home/me/.claude/agent-conduit/permissions/s1.json'
  const toolCall = (timestamp: string) => JSON.stringify({ type: 'assistant', timestamp, message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash' }] } })
  const toolResult = (timestamp: string) => JSON.stringify({ type: 'user', timestamp, message: { content: [{ type: 'tool_result' }] } })

  function files(extra: Record<string, string>) {
    return memoryFs({
      '/home/me/.claude/sessions/1.json': registry(1),
      '/run/user/1000/cc-socks/1.sock': '',
      ...extra,
    })
  }

  it('reports a prompt opened after the tool call', async () => {
    const fs = files({
      [transcript]: `${toolCall('2026-10-28T10:00:00.000Z')}\n`,
      [marker]: JSON.stringify({ at: Date.parse('2026-10-28T10:00:01.000Z'), tool: 'Bash', toolUseId: 't' }),
    })
    const { sessions } = await readLiveClaudeSessions(fs, ROOT, createLiveClaudeCache(), NOW)
    expect(sessions[0]?.permission).toEqual({ since: Date.parse('2026-10-28T10:00:01.000Z'), tool: 'Bash' })
  })

  it('ignores a marker the transcript has moved past', async () => {
    const fs = files({
      [transcript]: `${toolCall('2026-10-28T10:00:00.000Z')}\n${toolResult('2026-10-28T10:00:05.000Z')}\n`,
      [marker]: JSON.stringify({ at: Date.parse('2026-10-28T10:00:01.000Z') }),
    })
    const { sessions } = await readLiveClaudeSessions(fs, ROOT, createLiveClaudeCache(), NOW)
    expect(sessions[0]?.permission).toBeUndefined()
  })

  it('ignores a marker once the turn has ended', async () => {
    const fs = files({
      [transcript]: `${DONE}\n`,
      [marker]: JSON.stringify({ at: NOW }),
    })
    const { sessions } = await readLiveClaudeSessions(fs, ROOT, createLiveClaudeCache(), NOW)
    expect(sessions[0]?.permission).toBeUndefined()
  })
})
