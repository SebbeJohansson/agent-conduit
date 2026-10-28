import { describe, expect, it } from 'vitest'
import { LAST_TEXT_MAX, readTranscriptState, readTranscriptTitles } from './status.js'

/** One transcript line, with only the fields the reader looks at. */
function line(entry: Record<string, unknown>): string {
  return JSON.stringify(entry)
}

function assistant(stopReason: string | null, content: unknown[] = [{ type: 'text', text: 'hi' }]) {
  return line({ type: 'assistant', message: { role: 'assistant', stop_reason: stopReason, content } })
}

const TOOL_CALL = [{ type: 'tool_use', name: 'Bash', input: {} }]

describe('readTranscriptState', () => {
  it('reads a finished turn as the user\'s move', () => {
    expect(readTranscriptState(assistant('end_turn'))).toEqual({ phase: 'turn-ended', lastText: 'hi' })
  })

  it('reads a running tool as busy, and names it', () => {
    expect(readTranscriptState(assistant('tool_use', TOOL_CALL)))
      .toEqual({ phase: 'busy', tool: 'Bash' })
  })

  it('takes the last tool of an entry that calls several', () => {
    const content = [
      { type: 'tool_use', name: 'Read' },
      { type: 'tool_use', name: 'Grep' },
    ]
    expect(readTranscriptState(assistant('tool_use', content)))
      .toEqual({ phase: 'busy', tool: 'Grep' })
  })

  it('reads a reply still being written as busy', () => {
    expect(readTranscriptState(assistant(null))).toEqual({ phase: 'busy' })
  })

  it('reads an unanswered user turn as busy', () => {
    const tail = [assistant('end_turn'), line({ type: 'user', message: { role: 'user', content: 'go' } })]
    expect(readTranscriptState(tail.join('\n'))).toEqual({ phase: 'busy' })
  })

  // The bug this rule exists for: Claude Code appends bookkeeping entries after
  // a turn ends, and reading one of those as conversation reported hour-old
  // finished sessions as busy.
  it.each(['attachment', 'last-prompt', 'ai-title', 'atis-latch', 'bridge-session', 'summary'])(
    'looks past a %s entry',
    (type) => {
      const tail = [assistant('end_turn'), line({ type, sessionId: 's' })]
      expect(readTranscriptState(tail.join('\n'))).toEqual({ phase: 'turn-ended', lastText: 'hi' })
    },
  )

  it('looks past an entry type it has never seen', () => {
    const tail = [assistant('end_turn'), line({ type: 'something-new-in-a-later-release' })]
    expect(readTranscriptState(tail.join('\n'))).toEqual({ phase: 'turn-ended', lastText: 'hi' })
  })

  it('looks past injected context', () => {
    const tail = [assistant('end_turn'), line({ type: 'user', isMeta: true, message: { role: 'user', content: 'reminder' } })]
    expect(readTranscriptState(tail.join('\n'))).toEqual({ phase: 'turn-ended', lastText: 'hi' })
  })

  // A subagent finishing does not free the parent: the parent is still blocked
  // on the tool call that started it.
  it('reads a finished subagent turn as busy', () => {
    const tail = [
      assistant('tool_use', TOOL_CALL),
      line({ type: 'assistant', isSidechain: true, message: { role: 'assistant', stop_reason: 'end_turn', content: [] } }),
    ]
    expect(readTranscriptState(tail.join('\n'))).toEqual({ phase: 'busy' })
  })

  it('skips the truncated first line of a byte-offset read', () => {
    const tail = `{"type":"assis${'\n'}${assistant('end_turn')}`
    expect(readTranscriptState(tail)).toEqual({ phase: 'turn-ended', lastText: 'hi' })
  })

  it('keeps the end of the last message of a finished turn', () => {
    const state = readTranscriptState(assistant('end_turn', [{ type: 'text', text: `${'x'.repeat(LAST_TEXT_MAX)} Which one do you want?` }]))
    expect(state?.phase).toBe('turn-ended')
    expect(state?.lastText?.endsWith('Which one do you want?')).toBe(true)
    expect(state?.lastText?.length).toBe(LAST_TEXT_MAX)
  })

  it('reads an API error as a turn that ended in an error', () => {
    const tail = line({ type: 'assistant', isApiErrorMessage: true, message: { role: 'assistant', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'API Error: Connection lost' }] } })
    expect(readTranscriptState(tail)).toEqual({ phase: 'turn-ended', ending: 'error', lastText: 'API Error: Connection lost' })
  })

  it('reads an interrupt as your move, not as busy forever', () => {
    for (const content of ['[Request interrupted by user]', [{ type: 'text', text: '[Request interrupted by user for tool use]' }]]) {
      const tail = [assistant('tool_use', TOOL_CALL), line({ type: 'user', message: { role: 'user', content } })].join('\n')
      expect(readTranscriptState(tail)).toEqual({ phase: 'turn-ended', ending: 'interrupted' })
    }
  })

  it('returns null for a transcript with no conversation yet', () => {
    expect(readTranscriptState('')).toBeNull()
    expect(readTranscriptState(line({ type: 'bridge-session' }))).toBeNull()
  })
})

describe('readTranscriptTitles', () => {
  it('takes the latest AI title', () => {
    const tail = [
      line({ type: 'ai-title', aiTitle: 'First guess' }),
      assistant('end_turn'),
      line({ type: 'ai-title', aiTitle: 'Better guess' }),
    ].join('\n')
    expect(readTranscriptTitles(tail)).toEqual({ ai: 'Better guess' })
  })

  it('keeps a rename apart from the AI title', () => {
    const tail = [
      line({ type: 'custom-title', customTitle: 'My rename' }),
      line({ type: 'ai-title', aiTitle: 'Later guess' }),
    ].join('\n')
    expect(readTranscriptTitles(tail)).toEqual({ custom: 'My rename', ai: 'Later guess' })
  })

  it('finds nothing in a tail with no titles, or one cut mid-line', () => {
    expect(readTranscriptTitles(`le":"ai-title","aiTitle":"cut"}\n${assistant('end_turn')}`)).toEqual({})
  })
})
