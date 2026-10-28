// Reading a session's state out of the tail of its transcript.
//
// Claude Code appends one JSON object per line to
// `~/.claude/projects/<encoded cwd>/<session id>.jsonl`. The last conversational
// entry says what the session is doing, and `stop_reason` on an assistant entry
// is the whole discriminator:
//
//   stop_reason: 'tool_use'   a tool is out; the agent is busy
//   stop_reason: 'end_turn'   the agent has finished; your move
//   stop_reason: null         a reply is still being written
//
// A `user` entry last means either a tool result came back or a prompt just
// landed, and both mean the agent is about to be busy.
//
// This file is deliberately pure: it takes text, not a path, so the parsing can
// be reasoned about and tested without a filesystem.

/** What the transcript says, before any staleness rule is applied. */
export interface TranscriptState {
  /** `busy` while the agent is working, `turn-ended` when it is your move. */
  phase: 'busy' | 'turn-ended'
  /** The tool currently running, when the agent stopped to call one. */
  tool?: string
  /**
   * How a turn ended when it did not end normally: an API error Claude Code
   * wrote as the turn's reply, or you interrupting it (Escape). Both leave the
   * session waiting on you, and neither is a finished answer.
   */
  ending?: 'error' | 'interrupted'
  /** Claude's last words when the turn ended, cut to LAST_TEXT_MAX: a question in them is a question for you. */
  lastText?: string
}

/**
 * Enough of the last message to find what it asks of you: a "Next:" line at
 * the end, a question a few paragraphs up, or numbered steps that start above
 * a code block (nextStep.ts). An answer with commands to run is often past
 * 1,500 characters, and the steps are at its start.
 */
export const LAST_TEXT_MAX = 4_000

// Only these two entry types say anything about what the agent is doing.
//
// An allowlist rather than a list of things to skip, because the transcript is
// full of bookkeeping — `attachment`, `last-prompt`, `ai-title`, `atis-latch`,
// `bridge-session`, `summary` — written at moments unrelated to the agent's
// state. Treating an unrecognised type as conversation reported hour-old
// finished sessions as busy, and Claude Code keeps adding types, so the
// unknown case has to be "skip" rather than "guess".
const CONVERSATIONAL = new Set(['user', 'assistant'])

// Reasons that mean the agent handed control back rather than paused mid-task.
const TURN_ENDING = new Set(['end_turn', 'stop_sequence', 'max_tokens'])

interface TranscriptEntry {
  type?: string
  isMeta?: boolean
  isSidechain?: boolean
  /** Set on the reply Claude Code writes when the API call failed ("API Error: …"). */
  isApiErrorMessage?: boolean
  message?: {
    role?: string
    stop_reason?: string | null
    content?: unknown
  }
}

/** The text blocks of a message, joined. A plain string is its own text. */
function textOf(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .map(block => (typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text' ? (block as { text?: string }).text ?? '' : ''))
    .join('\n')
    .trim()
}

/** The last `LAST_TEXT_MAX` characters: a question is at the end of a message, not the start. */
function lastWords(text: string): string | undefined {
  const flat = text.trim()
  if (!flat) {
    return undefined
  }
  return flat.length > LAST_TEXT_MAX ? `…${flat.slice(-(LAST_TEXT_MAX - 1))}` : flat
}

/** What Claude Code writes as a user turn when you press Escape mid-turn. */
const INTERRUPTED = /^\[Request interrupted by user/

function toolNameOf(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined
  }
  // Last one wins: a single assistant entry may hold several tool calls, and
  // the last is the one the transcript ends on.
  const calls = content.filter(
    (block): block is { type: 'tool_use', name?: string } =>
      typeof block === 'object' && block !== null && (block as { type?: string }).type === 'tool_use',
  )
  return calls.at(-1)?.name
}

/**
 * Read the state out of the end of a transcript.
 *
 * `tail` may start mid-line — it comes from a byte-offset read — so unparseable
 * lines are skipped rather than treated as an error.
 *
 * Returns null when the tail holds no conversation at all, which happens for a
 * session that has started but not yet exchanged a message.
 */
export function readTranscriptState(tail: string): TranscriptState | null {
  const lines = tail.split('\n')

  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]?.trim()
    if (!line) {
      continue
    }

    let entry: TranscriptEntry
    try {
      entry = JSON.parse(line) as TranscriptEntry
    }
    catch {
      continue
    }

    // `isMeta` marks context injected alongside a prompt rather than something
    // either side said.
    if (!entry.type || !CONVERSATIONAL.has(entry.type) || entry.isMeta) {
      continue
    }

    // A subagent's turn. Its parent is blocked on the tool call that spawned
    // it, so the session is busy no matter how the subagent's own turn ended.
    if (entry.isSidechain) {
      return { phase: 'busy' }
    }

    if (entry.type === 'assistant') {
      const stop = entry.message?.stop_reason
      if (stop === 'tool_use') {
        return { phase: 'busy', tool: toolNameOf(entry.message?.content) }
      }
      if (!stop || !TURN_ENDING.has(stop)) {
        return { phase: 'busy' }
      }
      const said = lastWords(textOf(entry.message?.content))
      return {
        phase: 'turn-ended',
        ...(entry.isApiErrorMessage ? { ending: 'error' as const } : {}),
        ...(said ? { lastText: said } : {}),
      }
    }

    // You pressed Escape. Claude Code records it as a user turn, which on its
    // own reads as "handed something, not replied yet": an interrupted
    // session looked busy forever.
    if (INTERRUPTED.test(textOf(entry.message?.content))) {
      return { phase: 'turn-ended', ending: 'interrupted' }
    }

    // A user turn with no answer after it: the agent has been handed something
    // and has not replied yet.
    return { phase: 'busy' }
  }

  return null
}

/**
 * The titles a transcript carries. Claude Code writes them as bookkeeping
 * entries, re-appended every few turns: `custom-title` from a rename, which
 * wins, and `ai-title` from its own summary of the conversation.
 */
export interface TranscriptTitles {
  custom?: string
  ai?: string
}

/**
 * Read the most recent titles out of a transcript tail.
 *
 * Fields are absent when the tail holds no entry of that kind, so the caller
 * can merge the result over what an earlier read found.
 */
export function readTranscriptTitles(tail: string): TranscriptTitles {
  const titles: TranscriptTitles = {}

  for (const line of tail.split('\n')) {
    // Cheap filter first: every line is JSON, most are large, and only a
    // handful are titles.
    if (!line.includes('-title"')) {
      continue
    }
    let entry: { type?: string, customTitle?: unknown, aiTitle?: unknown }
    try {
      entry = JSON.parse(line)
    }
    catch {
      continue
    }
    if (entry.type === 'custom-title' && typeof entry.customTitle === 'string' && entry.customTitle.trim()) {
      titles.custom = entry.customTitle.trim()
    }
    else if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string' && entry.aiTitle.trim()) {
      titles.ai = entry.aiTitle.trim()
    }
  }

  return titles
}

