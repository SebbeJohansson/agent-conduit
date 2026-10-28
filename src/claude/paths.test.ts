import { describe, expect, it } from 'vitest'
import { decodeProjectDir, encodeProjectDir } from './paths.js'

describe('encodeProjectDir', () => {
  it('replaces separators with dashes', () => {
    expect(encodeProjectDir('/home/you/projects/my-widget'))
      .toBe('-home-you-projects-my-widget')
  })

  it('handles windows separators and the drive colon', () => {
    expect(encodeProjectDir('C:\\dev\\thing')).toBe('C--dev-thing')
  })

  // Seen in a real ~/.claude/projects: a dot directory doubles the dash.
  it('turns every other character into a dash too', () => {
    expect(encodeProjectDir('/home/you/.agent-worktrees/a_b c'))
      .toBe('-home-you--agent-worktrees-a-b-c')
  })
})

describe('decodeProjectDir', () => {
  it('reverses a plain path', () => {
    expect(decodeProjectDir('-home-you-projects')).toBe('/home/you/projects')
  })
})
