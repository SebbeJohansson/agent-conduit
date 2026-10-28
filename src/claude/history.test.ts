import { describe, expect, it } from 'vitest'
import { memoryFs } from '../testing/memoryFs.js'
import { listClaudeProjects, parseEntries, readSessionMeta } from './history.js'

function user(text: unknown, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ type: 'user', sessionId: 'abc', cwd: '/home/me/my-proj', timestamp: '2026-01-01T10:00:00Z', message: { role: 'user', content: text }, ...extra })
}

function assistant(timestamp: string) {
  return JSON.stringify({ type: 'assistant', sessionId: 'abc', cwd: '/home/me/my-proj', timestamp, message: { role: 'assistant', content: [] } })
}

describe('parseEntries', () => {
  it('skips blank and partial lines', () => {
    expect(parseEntries(`{"type":"a"}\n\n{"type":"b"}\n{"type":`)).toEqual([{ type: 'a' }, { type: 'b' }])
  })
})

describe('readSessionMeta', () => {
  const path = '/c/projects/-home-me-my-proj/abc.jsonl'

  it('reads id, directory, branch and times from the transcript', async () => {
    const fs = memoryFs({ [path]: [
      JSON.stringify({ type: 'queue-operation' }),
      user('hello there', { gitBranch: 'main' }),
      assistant('2026-01-01T10:05:00Z'),
    ].join('\n') })

    expect(await readSessionMeta(fs, path, '-home-me-my-proj')).toEqual({
      id: 'abc',
      transcriptPath: path,
      directory: '/home/me/my-proj',
      projectID: '-home-me-my-proj',
      title: 'hello there',
      gitBranch: 'main',
      timeCreated: Date.parse('2026-01-01T10:00:00Z'),
      timeUpdated: Date.parse('2026-01-01T10:05:00Z'),
    })
  })

  it('prefers a custom title, then the ai title, over the first prompt', async () => {
    const ai = JSON.stringify({ type: 'ai-title', aiTitle: 'AI said' })
    const custom = JSON.stringify({ type: 'custom-title', customTitle: 'I said' })

    expect((await readSessionMeta(memoryFs({ [path]: `${user('hi')}\n${ai}` }), path, 'p'))?.title).toBe('AI said')
    expect((await readSessionMeta(memoryFs({ [path]: `${user('hi')}\n${ai}\n${custom}` }), path, 'p'))?.title).toBe('I said')
  })

  it('strips IDE wrappers from a first prompt used as the title', async () => {
    const content = [{ type: 'text', text: '<ide_opened_file>a.ts</ide_opened_file>fix it' }]
    expect((await readSessionMeta(memoryFs({ [path]: user(content) }), path, 'p'))?.title).toBe('fix it')
  })

  it('returns null for an empty transcript', async () => {
    expect(await readSessionMeta(memoryFs({ [path]: '' }), path, 'p')).toBeNull()
  })
})

describe('listClaudeProjects', () => {
  it('groups by recorded directory, most recent first', async () => {
    const fs = memoryFs({
      '/c/projects/-home-me-my-proj/abc.jsonl': `${user('old')}\n${assistant('2026-01-01T10:00:00Z')}`,
      '/c/projects/-home-me-my-proj/def.jsonl': `${user('new', { sessionId: 'def' })}\n${assistant('2026-01-02T10:00:00Z')}`,
      '/c/projects/-home-me-other/ghi.jsonl': user('x', { sessionId: 'ghi', cwd: '/home/me/other', timestamp: '2025-12-01T00:00:00Z' }),
    })

    const projects = await listClaudeProjects(fs, '/c')

    expect(projects.map(p => p.directory)).toEqual(['/home/me/my-proj', '/home/me/other'])
    expect(projects[0]?.sessions.map(s => s.id)).toEqual(['def', 'abc'])
  })
})
