// "What is it doing right now": the Claude Code sessions running at this
// moment, each with the state its transcript ends in.
//
// Two directories carry everything needed:
//
//   sessions/<pid>.json           one per session ever started, with its id,
//                                 working directory and derived name
//   run/user/<uid>/cc-socks/      one <pid>.sock per session running right now
//
// The registry is never pruned — a third of it is typically dead processes — so
// the socket listing is what makes it useful: intersecting the two gives the
// live sessions exactly, with no process inspection and no shelling out. That
// matters when the reader runs on a Windows host while the agents run in WSL,
// where Windows can read the files but cannot see the process table.
//
// State then comes from each session's transcript; see `status.ts`.

import type { FileReader } from '../fs.js'
import type { TranscriptState, TranscriptTitles } from './status.js'
import { joinPath } from '../fs.js'
import { encodeProjectDir } from './paths.js'
import { readTranscriptState, readTranscriptTitles } from './status.js'

/** One located Claude Code state directory. */
export interface ClaudeRoot {
  /** Absolute path of the `.claude` directory. */
  claudeDir: string
  /**
   * Absolute path of the per-process socket directory, when there is one.
   *
   * Claude Code drops a `<pid>.sock` here for every live session and removes it
   * on exit, which makes the directory listing an exact roster of what is
   * running. Without it, liveness cannot be established at all — a Windows
   * host has no such directory, and the registry alone cannot say which of its
   * entries are still alive.
   */
  socketDir?: string
}

// Enough to cover the last few transcript entries. A single entry holding a
// large tool result can exceed it, so a miss retries with the wider window
// before giving up.
const TAIL_BYTES = 32 * 1024
const WIDE_TAIL_BYTES = 512 * 1024

// The registry file is written when a session starts and rewritten when it is
// renamed, so re-reading it constantly is waste. Renames are cosmetic; picking
// them up within a minute is enough.
const REGISTRY_TTL_MS = 60 * 1000

// A full sweep of the project folders is only needed to find a transcript the
// encoded guess missed. Doing it at most this often keeps a session that has
// genuinely never written a transcript from causing a sweep every poll.
const INDEX_TTL_MS = 30 * 1000

/**
 * How recently a session must have been active to be listed when liveness
 * cannot be proven.
 *
 * The registry is never pruned, so without the socket directory there is
 * nothing separating a session running now from one that exited last week.
 * Listing all of them would bury the real sessions under dead ones, so the
 * cutoff stands in for the socket check: a session being worked in has written
 * to its transcript recently, and a dead one has not.
 */
export const DEGRADED_MAX_AGE_MS = 15 * 60 * 1000

interface RegistryEntry {
  pid: number
  sessionId: string
  cwd: string
  startedAt?: number
  name?: string
  /** `derived` means `name` is a placeholder built from the directory. */
  nameSource?: string
  /** What started the session: `claude-vscode`, `cli`, ... */
  entrypoint?: string
  /** Set while Remote Control is on; the session's id on claude.ai. */
  bridgeSessionId?: string
}

/** One running Claude Code session. */
export interface LiveClaudeSession {
  /** Claude Code's session id. */
  sessionId: string
  pid: number
  /** The session's working directory. */
  directory: string
  /** A name you gave the session, else its title, else the registry's placeholder, else the directory's last segment. */
  name: string
  /** Epoch milliseconds the process started. */
  startedAt?: number
  /** What started the session: `claude-vscode`, `cli`, ... */
  entrypoint?: string
  /** Set while Remote Control is on; the session's id on claude.ai. */
  bridgeSessionId?: string
  /** The transcript, once the session has written one. */
  transcriptPath?: string
  /** Epoch milliseconds of the last transcript write, or the start time when there is none. */
  lastActivity: number
  /** What the transcript ends in, or null before anything has been said. */
  state: TranscriptState | null
}

/**
 * What is worth remembering between reads.
 *
 * Every field here exists to avoid re-reading a file, which over a WSL share is
 * the slow part by a wide margin. The caller owns the object and passes the
 * same one each read, one per root.
 */
export interface LiveClaudeCache {
  registry: Map<number, { entry: RegistryEntry | null, readAt: number }>
  /** Session id to transcript path, for ids the encoded guess could not resolve. */
  transcriptPaths: Map<string, string>
  /** Parsed transcript state, keyed by path and only reused while mtime matches. */
  states: Map<string, { modified: number, state: TranscriptState | null }>
  /**
   * Latest titles seen per session id. Kept apart from `states` because a
   * title entry soon scrolls out of the tail window, and the name should not
   * fall back to the placeholder when it does. `seeded` marks a session whose
   * wide tail has already been searched once.
   */
  titles: Map<string, TranscriptTitles & { seeded?: boolean }>
  indexedAt: number
}

export function createLiveClaudeCache(): LiveClaudeCache {
  return { registry: new Map(), transcriptPaths: new Map(), states: new Map(), titles: new Map(), indexedAt: 0 }
}

export interface LiveClaudeResult {
  sessions: LiveClaudeSession[]
  /**
   * True when liveness could not be established from the socket directory, so
   * the list may include sessions that have already exited.
   */
  degraded: boolean
}

/** Process ids with a live socket. */
async function livePids(fs: FileReader, socketDir: string): Promise<number[]> {
  return (await fs.listDir(socketDir))
    .map(name => /^(\d+)\.sock$/.exec(name)?.[1])
    .filter((pid): pid is string => pid !== undefined)
    .map(Number)
}

async function readRegistryEntry(
  fs: FileReader,
  root: ClaudeRoot,
  pid: number,
  cache: LiveClaudeCache,
  now: number,
): Promise<RegistryEntry | null> {
  const cached = cache.registry.get(pid)
  if (cached && now - cached.readAt < REGISTRY_TTL_MS) {
    return cached.entry
  }

  const raw = await fs.readText(joinPath(root.claudeDir, 'sessions', `${pid}.json`))
  let entry: RegistryEntry | null = null
  try {
    const parsed = JSON.parse(raw) as RegistryEntry
    entry = parsed.sessionId && parsed.cwd ? parsed : null
  }
  catch {
    // A socket with no readable registry file: either a session mid-startup or
    // one from a Claude Code version that writes something else. Skipping it is
    // better than inventing a session with no directory to show.
    entry = null
  }

  cache.registry.set(pid, { entry, readAt: now })
  return entry
}

/**
 * Sweep every project folder and record which transcript belongs to which
 * session id.
 *
 * Only reached when the encoded guess misses, because it costs one directory
 * read per project.
 */
async function indexTranscripts(fs: FileReader, root: ClaudeRoot, cache: LiveClaudeCache, now: number): Promise<void> {
  if (now - cache.indexedAt < INDEX_TTL_MS) {
    return
  }
  cache.indexedAt = now

  const projectsDir = joinPath(root.claudeDir, 'projects')
  for (const project of await fs.listDir(projectsDir)) {
    for (const file of await fs.listDir(joinPath(projectsDir, project))) {
      if (file.endsWith('.jsonl')) {
        cache.transcriptPaths.set(file.slice(0, -'.jsonl'.length), joinPath(projectsDir, project, file))
      }
    }
  }
}

/** Locate a session's transcript, or null when it has not written one yet. */
async function findTranscript(
  fs: FileReader,
  root: ClaudeRoot,
  entry: RegistryEntry,
  cache: LiveClaudeCache,
  now: number,
): Promise<{ path: string, modified: number } | null> {
  const candidates = [
    cache.transcriptPaths.get(entry.sessionId),
    joinPath(root.claudeDir, 'projects', encodeProjectDir(entry.cwd), `${entry.sessionId}.jsonl`),
  ]

  for (const candidate of candidates) {
    if (!candidate) {
      continue
    }
    const info = await fs.stat(candidate)
    if (info) {
      cache.transcriptPaths.set(entry.sessionId, candidate)
      return { path: candidate, modified: info.modified }
    }
  }

  // Neither the remembered path nor the guess resolved. Sweep, then retry the
  // remembered path once — the sweep is what fills it in.
  cache.transcriptPaths.delete(entry.sessionId)
  await indexTranscripts(fs, root, cache, now)

  const found = cache.transcriptPaths.get(entry.sessionId)
  if (!found) {
    return null
  }
  const info = await fs.stat(found)
  return info ? { path: found, modified: info.modified } : null
}

async function transcriptState(
  fs: FileReader,
  sessionId: string,
  path: string,
  modified: number,
  cache: LiveClaudeCache,
): Promise<TranscriptState | null> {
  const cached = cache.states.get(path)
  if (cached && cached.modified === modified) {
    return cached.state
  }

  const titles = cache.titles.get(sessionId) ?? {}
  cache.titles.set(sessionId, titles)

  let tail = await fs.readTail(path, TAIL_BYTES)
  let state = readTranscriptState(tail)
  Object.assign(titles, readTranscriptTitles(tail))

  // The window may have landed inside one very large entry, or a long tool
  // result may have pushed the last title out of it. The second case only
  // needs searching once per session: after that the cache remembers.
  if (!state || (!titles.seeded && !titles.custom && !titles.ai)) {
    tail = await fs.readTail(path, WIDE_TAIL_BYTES)
    state ??= readTranscriptState(tail)
    Object.assign(titles, readTranscriptTitles(tail))
  }
  titles.seeded = true

  cache.states.set(path, { modified, state })
  return state
}

/**
 * The label to show for a session.
 *
 * The registry's name is usually a placeholder (`my-widget-3f`) that Claude
 * Code derives from the directory; the transcript's titles say what the
 * session is actually about. A name the user set in the registry still wins.
 */
function sessionName(entry: RegistryEntry, titles: TranscriptTitles | undefined): string {
  const derived = !entry.nameSource || entry.nameSource === 'derived'
  if (entry.name && !derived) {
    return entry.name
  }
  return titles?.custom || titles?.ai || entry.name || directoryName(entry.cwd)
}

/** Last path segment, for a session with no name of its own. */
export function directoryName(directory: string): string {
  return directory.split(/[/\\]/).filter(Boolean).at(-1) ?? directory
}

/**
 * The sessions running in one root right now.
 *
 * Reads are cached in `cache` between calls, so polling this every couple of
 * seconds only touches files that changed.
 */
export async function readLiveClaudeSessions(
  fs: FileReader,
  root: ClaudeRoot,
  cache: LiveClaudeCache,
  now = Date.now(),
): Promise<LiveClaudeResult> {
  // Without the socket directory there is nothing to prove liveness with, so
  // fall back to the whole registry and say so. Better a list with stale
  // sessions and a warning than nothing.
  const degraded = root.socketDir === undefined
  const pids = degraded
    ? (await fs.listDir(joinPath(root.claudeDir, 'sessions')))
        .map(name => /^(\d+)\.json$/.exec(name)?.[1])
        .filter((pid): pid is string => pid !== undefined)
        .map(Number)
    : await livePids(fs, root.socketDir!)

  const sessions: LiveClaudeSession[] = []

  for (const pid of pids) {
    const entry = await readRegistryEntry(fs, root, pid, cache, now)
    if (!entry) {
      continue
    }

    const transcript = await findTranscript(fs, root, entry, cache, now)
    const state = transcript ? await transcriptState(fs, entry.sessionId, transcript.path, transcript.modified, cache) : null
    const lastActivity = transcript?.modified || entry.startedAt || now

    // See DEGRADED_MAX_AGE_MS: with no socket to check, staleness is the only
    // signal left for whether this process is still there.
    if (degraded && now - lastActivity > DEGRADED_MAX_AGE_MS) {
      continue
    }

    sessions.push({
      sessionId: entry.sessionId,
      pid,
      directory: entry.cwd,
      name: sessionName(entry, cache.titles.get(entry.sessionId)),
      lastActivity,
      state,
      ...(entry.startedAt !== undefined ? { startedAt: entry.startedAt } : {}),
      ...(entry.entrypoint ? { entrypoint: entry.entrypoint } : {}),
      ...(entry.bridgeSessionId ? { bridgeSessionId: entry.bridgeSessionId } : {}),
      ...(transcript ? { transcriptPath: transcript.path } : {}),
    })
  }

  return { sessions, degraded }
}
