import { describe, expect, it } from 'vitest'
import { resumeCommand } from './resume.js'

describe('resumeCommand', () => {
  it('resumes a Claude Code session from its directory', () => {
    expect(resumeCommand('claude', { sessionId: 'c4cc048e-842c', directory: '/home/me/my-widget' }))
      .toBe('cd /home/me/my-widget && claude --resume c4cc048e-842c')
  })

  it('resumes an OpenCode session', () => {
    expect(resumeCommand('opencode', { sessionId: 'ses_032c', directory: '/p' }))
      .toBe('cd /p && opencode --session ses_032c')
  })

  it('quotes a directory the shell would split or expand', () => {
    expect(resumeCommand('claude', { sessionId: 's', directory: "/home/me/FIGMA PLUGINS/it's $HOME" }))
      .toBe(`cd '/home/me/FIGMA PLUGINS/it'\\''s $HOME' && claude --resume s`)
  })

  it('leaves out the cd when there is no directory', () => {
    expect(resumeCommand('opencode', { sessionId: 's', directory: '' })).toBe('opencode --session s')
  })
})
