// "Show me everything": every Claude Code session on disk, and the whole of
// any one transcript.
//
// Sessions are found by walking `projects/`, one folder per working directory
// and one `<session id>.jsonl` per session in it, rather than through the
// registry, because the registry only knows sessions started since it was
// introduced and says nothing about what they were about.

import type { FileReader } from '../fs.js'
import { joinPath } from '../fs.js'
import { decodeProjectDir, encodeProjectDir } from './paths.js'
import { readTranscriptTitles } from './status.js'

// ---------------------------------------------------------------------------
// Stored transcript entry shapes
// ---------------------------------------------------------------------------

export interface StoredUserEntry {
  type: 'user'
  uuid: string
  parentUuid: string | null
  timestamp: string
  sessionId: string
  cwd: string
  gitBranch?: string
  isMeta?: boolean
  isSidechain?: boolean
  message: {
    role: 'user'
    content:
      | string
      | Array<{ type: string, text?: string, tool_use_id?: string, content?: unknown }>
  }
}

export interface StoredAssistantEntry {
  type: 'assistant'
  uuid: string
  parentUuid: string | null
  timestamp: string
  sessionId: string
  cwd: string
  gitBranch?: string
  isSidechain?: boolean
  isApiErrorMessage?: boolean
  message: {
    role: 'assistant'
    content: Array<{
      type: string
      text?: string
      thinking?: string
      id?: string
      name?: string
      input?: Record<string, unknown>
    }>
    model?: string
    stop_reason?: string | null
    usage?: { input_tokens: number, output_tokens: number }
  }
}

export interface StoredSummaryEntry {
  type: 'summary'
  summary: string
  leafUuid: string
  timestamp?: string
  sessionId?: string
}

/**
 * One line of a transcript. Claude Code writes many more kinds than the three
 * spelled out here — titles, attachments, queue operations — and keeps adding
 * them, so anything else is kept as an open record rather than dropped.
 */
export type StoredEntry =
  | StoredUserEntry
  | StoredAssistantEntry
  | StoredSummaryEntry
  | { type: string, [key: string]: unknown }

/** Parse a transcript, skipping lines that are not JSON (a partial last line, for one). */
export function parseEntries(text: string): StoredEntry[] {
  const entries: StoredEntry[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      continue
    }
    try {
      entries.push(JSON.parse(line) as StoredEntry)
    }
    catch {
      // A tail read can start mid-line, and a session being written to can
      // end mid-line.
    }
  }
  return entries
}

/** Every entry of one transcript. */
export async function readEntries(fs: FileReader, transcriptPath: string): Promise<StoredEntry[]> {
  return parseEntries(await fs.readText(transcriptPath))
}

// ---------------------------------------------------------------------------
// Session listing
// ---------------------------------------------------------------------------

export interface ClaudeSessionMeta {
  id: string
  transcriptPath: string
  directory: string
  /** The project folder's name under `projects/`, stable for a directory. */
  projectID: string
  title: string
  gitBranch?: string
  timeCreated: number
  timeUpdated: number
}

export interface ClaudeProject {
  /** The project folder's name under `projects/`. */
  id: string
  /** Absolute path, from the transcripts themselves rather than the lossy folder name. */
  directory: string
  /** Most recently updated first. */
  sessions: ClaudeSessionMeta[]
}

const TITLE_MAX = 80

function hasCwd(entry: StoredEntry): entry is StoredUserEntry | StoredAssistantEntry {
  return typeof (entry as { cwd?: unknown }).cwd === 'string'
}

function timestampOf(entry: StoredEntry | undefined): number {
  const raw = (entry as { timestamp?: unknown } | undefined)?.timestamp
  return typeof raw === 'string' ? new Date(raw).getTime() || 0 : 0
}

/**
 * A session's title: a name you gave it, else Claude Code's own title for it,
 * else an old-style summary entry, else the start of the first prompt.
 */
export function sessionTitle(text: string, entries: StoredEntry[]): string {
  const titles = readTranscriptTitles(text)
  if (titles.custom || titles.ai) {
    return (titles.custom ?? titles.ai)!.slice(0, TITLE_MAX)
  }

  const summary = entries.find((e): e is StoredSummaryEntry => e.type === 'summary')
  if (summary?.summary) {
    return summary.summary.slice(0, TITLE_MAX)
  }

  const firstUser = entries.find((e): e is StoredUserEntry => e.type === 'user' && !(e as StoredUserEntry).isMeta)
  const content = firstUser?.message?.content
  if (typeof content === 'string' && content.trim()) {
    return content.trim().slice(0, TITLE_MAX)
  }
  if (Array.isArray(content)) {
    const text = content.find(block => block.type === 'text' && block.text)?.text
    // Strip the IDE's selection and open-file wrappers, which come first and
    // say nothing about the session.
    const clean = text
      ?.replace(/<ide_selection>[\s\S]*?<\/ide_selection>/g, '')
      .replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/g, '')
      .replace(/<[^>]+>/g, '')
      .trim()
    if (clean) {
      return clean.slice(0, TITLE_MAX)
    }
  }

  return 'Untitled session'
}

/**
 * One session's metadata, from its transcript. Null for an empty or unreadable
 * file.
 *
 * `directoryHint` is used only when no entry records a working directory.
 */
export async function readSessionMeta(
  fs: FileReader,
  transcriptPath: string,
  projectID: string,
  directoryHint = `/${decodeProjectDir(projectID).replace(/^\/+/, '')}`,
): Promise<ClaudeSessionMeta | null> {
  const text = await fs.readText(transcriptPath)
  const entries = parseEntries(text)
  if (!entries.length) {
    return null
  }

  // The first entry with a cwd; queue operations and the like come before it.
  const first = entries.find(hasCwd)
  const fileId = transcriptPath.split(/[/\\]/).at(-1)!.replace(/\.jsonl$/, '')
  const created = timestampOf(entries.find(e => timestampOf(e) > 0))
  const updated = timestampOf(entries.findLast(e => timestampOf(e) > 0)) || created
  const fallback = (await fs.stat(transcriptPath))?.modified || Date.now()

  return {
    id: first?.sessionId ?? fileId,
    transcriptPath,
    directory: first?.cwd ?? directoryHint,
    projectID,
    title: sessionTitle(text, entries),
    ...(first?.gitBranch ? { gitBranch: first.gitBranch } : {}),
    timeCreated: created || fallback,
    timeUpdated: updated || fallback,
  }
}

/**
 * Every project and session under one `.claude` directory, most recently
 * active first.
 *
 * Grouped by the directory the transcripts record rather than by folder name,
 * because the folder name cannot be decoded reliably.
 */
export async function listClaudeProjects(fs: FileReader, claudeDir: string): Promise<ClaudeProject[]> {
  const projectsDir = joinPath(claudeDir, 'projects')
  const sessionsByDir = new Map<string, ClaudeSessionMeta[]>()
  const projectIdByDir = new Map<string, string>()

  for (const folder of await fs.listDir(projectsDir)) {
    const folderPath = joinPath(projectsDir, folder)
    for (const file of await fs.listDir(folderPath)) {
      if (!file.endsWith('.jsonl')) {
        continue
      }
      const meta = await readSessionMeta(fs, joinPath(folderPath, file), folder)
      if (!meta) {
        continue
      }
      const list = sessionsByDir.get(meta.directory) ?? []
      list.push(meta)
      sessionsByDir.set(meta.directory, list)
      if (!projectIdByDir.has(meta.directory)) {
        projectIdByDir.set(meta.directory, folder)
      }
    }
  }

  const projects: ClaudeProject[] = [...sessionsByDir].map(([directory, sessions]) => ({
    id: projectIdByDir.get(directory) ?? encodeProjectDir(directory),
    directory,
    sessions: sessions.sort((a, b) => b.timeUpdated - a.timeUpdated),
  }))

  return projects.sort((a, b) => (b.sessions[0]?.timeUpdated ?? 0) - (a.sessions[0]?.timeUpdated ?? 0))
}
