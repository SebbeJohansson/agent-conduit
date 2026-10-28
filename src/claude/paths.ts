// Where Claude Code keeps things under `~/.claude`.
//
//   sessions/<pid>.json                       one per session ever started
//   projects/<encoded cwd>/<session id>.jsonl one transcript per session
//
// and, outside it, `/run/user/<uid>/cc-socks/<pid>.sock`: one socket per
// session running right now.

/**
 * Guess Claude Code's project folder name for a working directory.
 *
 * Every character that is not a letter or a digit becomes a dash, so
 * `/home/me/.agent-worktrees` is `-home-me--agent-worktrees`. That is lossy: a
 * dash, a dot and a separator all encode the same. So this is a fast guess to
 * try first, never an answer to rely on; a caller that needs certainty searches
 * the project folders when the guess does not resolve to a file.
 */
export function encodeProjectDir(directory: string): string {
  return directory.replace(/[^a-zA-Z0-9]/g, '-')
}

/**
 * Best-effort reverse of `encodeProjectDir`, for a project whose transcripts
 * say nothing about their directory. Every dash becomes a slash, so a
 * directory with a dash or a dot in its name comes back wrong.
 */
export function decodeProjectDir(encoded: string): string {
  return encoded.replace(/-/g, '/')
}
