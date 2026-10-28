// The shell command that picks a session up again in a terminal, for an app
// to copy or run.
//
// Each tool resumes from its own store by session id, so the command only has
// to land in the session's directory first: Claude Code looks a session up
// under the directory it was started in, and OpenCode starts its project there.

export type ResumableAgent = 'claude' | 'opencode'

/** A POSIX shell word: single quotes, with any single quote inside closed, escaped and reopened. */
function shellQuote(value: string): string {
  return /^[\w./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * `cd <directory> && claude --resume <id>`, or the OpenCode equivalent.
 *
 * For a POSIX shell; a Windows directory comes out quoted but is still a
 * Windows path, so it is for a shell on the machine the session ran on.
 */
export function resumeCommand(agent: ResumableAgent, session: { sessionId: string, directory: string }): string {
  const resume = agent === 'claude'
    ? `claude --resume ${shellQuote(session.sessionId)}`
    : `opencode --session ${shellQuote(session.sessionId)}`
  return session.directory ? `cd ${shellQuote(session.directory)} && ${resume}` : resume
}
