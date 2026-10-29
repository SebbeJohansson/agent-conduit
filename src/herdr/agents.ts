// The coding agents running in herdr's panes, and what an app can do with
// them: list and watch them, send a prompt, press keys (answering a permission
// dialog), read the screen, and start a new one.
//
// A target is an agent's name or the id of the pane hosting it (`w1:p2`).

import type { HerdrOptions } from './client.js'
import type { HerdrAgent, HerdrAgentStatus, HerdrDialog } from './types.js'
import { HerdrError, herdrRequest } from './client.js'

export type { HerdrAgent, HerdrAgentStatus, HerdrDialog } from './types.js'

const STATUSES = new Set<HerdrAgentStatus>(['idle', 'working', 'blocked', 'done', 'unknown'])

interface AgentInfo {
  pane_id: string
  workspace_id: string
  tab_id: string
  name?: string | null
  agent?: string | null
  agent_status?: string
  cwd?: string | null
  foreground_cwd?: string | null
  terminal_title_stripped?: string | null
  title?: string | null
  focused?: boolean
  agent_session?: { agent: string, kind: 'id' | 'path', source: string, value: string } | null
}

function toAgent(info: AgentInfo): HerdrAgent {
  const status = STATUSES.has(info.agent_status as HerdrAgentStatus) ? info.agent_status as HerdrAgentStatus : 'unknown'
  const cwd = info.foreground_cwd || info.cwd || undefined
  const title = info.terminal_title_stripped || info.title || undefined
  return {
    paneId: info.pane_id,
    workspaceId: info.workspace_id,
    tabId: info.tab_id,
    status,
    focused: Boolean(info.focused),
    ...(info.name ? { name: info.name } : {}),
    ...(info.agent ? { kind: info.agent } : {}),
    ...(cwd ? { cwd } : {}),
    ...(title ? { title } : {}),
    ...(info.agent_session?.kind === 'id' && info.agent_session.value ? { sessionId: info.agent_session.value } : {}),
  }
}

/** The pane's foreground process ids, or undefined when herdr cannot say. */
async function foregroundPids(paneId: string, options?: HerdrOptions): Promise<number[] | undefined> {
  try {
    const info = await herdrRequest<{ process_info?: { foreground_processes?: Array<{ pid?: unknown }> } }>('pane.process_info', { pane_id: paneId }, options)
    const pids = (info.process_info?.foreground_processes ?? []).map(process => process.pid).filter((pid): pid is number => typeof pid === 'number')
    return pids.length ? pids : undefined
  }
  catch {
    // Older servers, or a pane that closed between the two calls.
    return undefined
  }
}

/**
 * Which dialog a blocked agent is showing, from the bottom of its screen.
 *
 * `blocked` covers every dialog, and they do not all mean the same keys: a
 * Claude Code permission prompt is "1. Yes / 2. Yes, and don't ask again /
 * 3. No", but its folder-trust screen highlights "No, exit", so a key that
 * allows a tool on one quits the session on the other. Only the permission
 * prompt is recognised, by its own wording; everything else is `other`, for
 * a person to answer in herdr.
 */
export function dialogOf(kind: string | undefined, screen: string): HerdrDialog {
  if (kind === 'claude'
    && /Do you want to (proceed|make this edit|create|allow|delete|run|fetch)/i.test(screen)
    && /\b1\.\s+Yes\b/.test(screen)
    && /\bNo\b/.test(screen)
    && !/trust this folder/i.test(screen)) {
    return 'permission'
  }
  return 'other'
}

async function readDialog(agent: HerdrAgent, options?: HerdrOptions): Promise<HerdrDialog> {
  try {
    const result = await herdrRequest<{ read?: { text?: string } }>(
      'agent.read',
      { target: agent.paneId, source: 'detection', strip_ansi: true },
      options,
    )
    return dialogOf(agent.kind, result.read?.text ?? '')
  }
  catch {
    return 'other'
  }
}

/** Every pane herdr recognises a coding agent in, with its foreground processes and, when blocked, its dialog. */
export async function listHerdrAgents(options?: HerdrOptions): Promise<HerdrAgent[]> {
  const result = await herdrRequest<{ agents?: AgentInfo[] }>('agent.list', {}, options)
  return Promise.all((result.agents ?? []).map(async (info) => {
    let agent = toAgent(info)
    const pids = await foregroundPids(agent.paneId, options)
    if (pids) agent = { ...agent, pids }
    if (agent.status === 'blocked') agent = { ...agent, dialog: await readDialog(agent, options) }
    return agent
  }))
}

export interface HerdrWatchHandlers {
  /** The agents, on the first read and whenever anything about them changes. */
  onAgents: (agents: HerdrAgent[]) => void
  /** herdr is not answering (not running, or not installed); reads keep being retried. */
  onError?: (message: string) => void
}

export interface HerdrWatch {
  stop: () => void
}

/**
 * Keep a live list of herdr's agents.
 *
 * Polled rather than subscribed: herdr only streams status changes for panes
 * named one by one, so a list of every agent would need a subscription per
 * pane, renewed as panes come and go. A local `agent.list` every couple of
 * seconds is simpler and just as current for a status display.
 */
export function watchHerdr(handlers: HerdrWatchHandlers, options: HerdrOptions & { intervalMs?: number } = {}): HerdrWatch {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let last: string | undefined

  async function read() {
    try {
      const agents = await listHerdrAgents(options)
      const snapshot = JSON.stringify(agents)
      if (snapshot !== last) {
        last = snapshot
        handlers.onAgents(agents)
      }
    }
    catch (error) {
      // Forget the last list, so the agents are reported again once herdr is back.
      last = undefined
      handlers.onError?.(error instanceof Error ? error.message : String(error))
    }
    finally {
      if (!stopped) {
        timer = setTimeout(() => void read(), options.intervalMs ?? 2_000)
      }
    }
  }

  void read()
  return {
    stop() {
      stopped = true
      clearTimeout(timer)
    },
  }
}

/**
 * Type a prompt into the agent's pane and press Enter, as you would.
 *
 * herdr refuses (HerdrError `agent_blocked`) while the agent shows an approval
 * or question dialog, so a prompt can never land in one by accident.
 */
export async function promptHerdrAgent(target: string, text: string, options?: HerdrOptions): Promise<HerdrAgent> {
  const result = await herdrRequest<{ agent: AgentInfo }>('agent.prompt', { target, text }, options)
  return toAgent(result.agent)
}

/**
 * Press keys in the agent's pane: `enter`, `esc`, `1`, `ctrl+c`, ... herdr
 * checks every key before writing any of them.
 */
export async function sendHerdrKeys(target: string, keys: string[], options?: HerdrOptions): Promise<void> {
  await herdrRequest('agent.send_keys', { target, keys }, options)
}

/** The agent's recent output as plain text, soft wraps joined. */
export async function readHerdrAgent(target: string, lines = 120, options?: HerdrOptions): Promise<string> {
  const result = await herdrRequest<{ read?: { text?: string } }>(
    'agent.read',
    { target, source: 'recent_unwrapped', lines, strip_ansi: true },
    options,
  )
  return result.read?.text ?? ''
}

/** A herdr agent name: lowercase, starting with a letter, at most 32 characters. */
export function herdrAgentName(directory: string, suffix = Math.random().toString(36).slice(2, 6)): string {
  const base = (directory.split(/[/\\]/).filter(Boolean).at(-1) ?? 'agent')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .slice(0, 26) || 'agent'
  return `${base}-${suffix}`
}

export interface StartHerdrAgentOptions {
  /** Which agent: `claude`, `opencode`, `codex`, ... (herdr's `agent start --kind`). */
  kind: string
  /** The directory to start it in. */
  cwd: string
  /** Its herdr name; derived from the directory when left out. Must be unique among live agents. */
  name?: string
  /** Arguments for the agent itself. */
  args?: string[]
}

/** How long a new workspace's shell gets to reach its prompt before the start is given up. */
const SHELL_READY_MS = 15_000
const SHELL_RETRY_MS = 300

/**
 * Start an agent in a new herdr workspace, without taking focus from whatever
 * you are looking at. Returns once herdr sees the agent ready for input.
 *
 * herdr only starts an agent in a pane whose shell sits idle at its prompt,
 * and a new workspace's shell is still running its startup files at first (a
 * zsh loading nvm, say), which herdr reports as `agent_pane_busy`. So the start
 * is retried until the shell is ready. If it never is, or anything else fails,
 * the workspace made for it is closed again rather than left behind.
 */
export async function startHerdrAgent(start: StartHerdrAgentOptions, options?: HerdrOptions): Promise<HerdrAgent> {
  const name = start.name ?? herdrAgentName(start.cwd)
  const created = await herdrRequest<{ workspace?: { workspace_id?: string }, root_pane: { pane_id: string } }>(
    'workspace.create',
    { cwd: start.cwd, label: name, focus: false },
    options,
  )
  const params = { name, kind: start.kind, pane_id: created.root_pane.pane_id, args: start.args ?? [], timeout_ms: 30_000 }
  const startOptions = { ...options, timeoutMs: Math.max(options?.timeoutMs ?? 0, 35_000) }
  const deadline = Date.now() + SHELL_READY_MS

  try {
    while (true) {
      try {
        const result = await herdrRequest<{ agent: AgentInfo }>('agent.start', params, startOptions)
        return toAgent(result.agent)
      }
      catch (error) {
        if (!(error instanceof HerdrError) || error.code !== 'agent_pane_busy' || Date.now() >= deadline) {
          throw error
        }
        await new Promise(resolve => setTimeout(resolve, SHELL_RETRY_MS))
      }
    }
  }
  catch (error) {
    const workspaceId = created.workspace?.workspace_id ?? created.root_pane.pane_id.split(':')[0]
    if (workspaceId) {
      await herdrRequest('workspace.close', { workspace_id: workspaceId }, options).catch(() => {})
    }
    throw error
  }
}
