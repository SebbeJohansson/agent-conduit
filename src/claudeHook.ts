// Installing agent-conduit's Claude Code hook (hooks/claude-permission.sh),
// which tells readLiveClaudeSessions when a session is waiting on a permission
// prompt.
//
// Install copies the script into `~/.claude/agent-conduit/` and registers it in
// `~/.claude/settings.json` for every event it listens to. Both install and
// uninstall leave every other setting and hook alone, and running either twice
// is the same as running it once. Node only: exported from `agent-conduit/node`.

import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Where the marker is written, and every way a session moves past the prompt.
// Notification is matched on its type; the tool events on every tool.
const EVENTS: ReadonlyArray<readonly [event: string, matcher?: string]> = [
  ['PermissionRequest'],
  ['Notification', 'permission_prompt'],
  ['PostToolUse'],
  ['PostToolUseFailure'],
  ['UserPromptSubmit'],
  ['Stop'],
  ['SubagentStop'],
  ['SessionEnd'],
]

/** Every Claude Code event the hook is registered for. */
export const CLAUDE_HOOK_EVENTS: readonly string[] = EVENTS.map(([event]) => event)

// The script ships beside dist/ (and beside src/ when run from source).
const BUNDLED_HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'claude-permission.sh')

export interface ClaudeHookOptions {
  /** The `.claude` directory. Defaults to `$CLAUDE_CONFIG_DIR`, then `~/.claude`. */
  claudeDir?: string
}

export interface ClaudeHookStatus {
  /** The script is in place and registered for every event. */
  installed: boolean
  /** Installed, and the same version as this package's; false means install again to update. */
  current: boolean
  settingsPath: string
  hookPath: string
}

interface HookGroup {
  matcher?: string
  hooks?: Array<{ type?: string, command?: string, timeout?: number }>
}

type Settings = Record<string, unknown> & { hooks?: Record<string, HookGroup[]> }

function pathsFor(options: ClaudeHookOptions = {}) {
  const claudeDir = options.claudeDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  return {
    claudeDir,
    settingsPath: join(claudeDir, 'settings.json'),
    ownDir: join(claudeDir, 'agent-conduit'),
    hookPath: join(claudeDir, 'agent-conduit', 'claude-permission.sh'),
  }
}

async function readSettings(settingsPath: string): Promise<Settings> {
  let raw: string
  try {
    raw = await readFile(settingsPath, 'utf8')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  try {
    return JSON.parse(raw) as Settings
  }
  catch (error) {
    throw new Error(`${settingsPath} is not valid JSON; fix it first (${(error as Error).message})`)
  }
}

async function writeSettings(settingsPath: string, settings: Settings): Promise<void> {
  // Through a temporary file, so a crash cannot leave Claude Code a half-written settings file.
  const temporary = `${settingsPath}.agent-conduit.tmp`
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`)
  await rename(temporary, settingsPath)
}

function isOurs(hook: { command?: string }): boolean {
  return typeof hook.command === 'string' && hook.command.includes('agent-conduit/claude-permission.sh')
}

/** Every hook group with ours taken out, and groups left empty by that dropped. */
function withoutOurs(groups: HookGroup[] | undefined): HookGroup[] {
  return (groups ?? [])
    .map(group => ({ ...group, hooks: (group.hooks ?? []).filter(hook => !isOurs(hook)) }))
    .filter(group => group.hooks.length > 0)
}

async function readOrEmpty(path: string): Promise<string> {
  return readFile(path, 'utf8').catch(() => '')
}

/** Whether the hook is installed, and whether it is this package's version of it. */
export async function readClaudeHookStatus(options?: ClaudeHookOptions): Promise<ClaudeHookStatus> {
  const { settingsPath, hookPath } = pathsFor(options)
  const [settings, installedScript, bundledScript] = await Promise.all([
    readSettings(settingsPath).catch(() => ({}) as Settings),
    readOrEmpty(hookPath),
    readOrEmpty(BUNDLED_HOOK),
  ])
  const registered = EVENTS.every(([event]) =>
    (settings.hooks?.[event] ?? []).some(group => (group.hooks ?? []).some(isOurs)))
  const installed = registered && installedScript !== ''
  return { installed, current: installed && installedScript === bundledScript, settingsPath, hookPath }
}

/** Copy the hook into place and register it. Safe to run again, which also updates it. */
export async function installClaudeHook(options?: ClaudeHookOptions): Promise<ClaudeHookStatus> {
  const { settingsPath, hookPath } = pathsFor(options)
  // Read first: a settings file that is not JSON stops the install before anything is written.
  const settings = await readSettings(settingsPath)

  await mkdir(dirname(hookPath), { recursive: true })
  await copyFile(BUNDLED_HOOK, hookPath)
  await chmod(hookPath, 0o755)

  settings.hooks ??= {}
  for (const [event, matcher] of EVENTS) {
    settings.hooks[event] = [
      ...withoutOurs(settings.hooks[event]),
      { ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: hookPath, timeout: 5 }] },
    ]
  }
  await writeSettings(settingsPath, settings)
  return readClaudeHookStatus(options)
}

/** Take the hook back out of the settings and delete its directory, markers included. */
export async function uninstallClaudeHook(options?: ClaudeHookOptions): Promise<ClaudeHookStatus> {
  const { settingsPath, ownDir } = pathsFor(options)
  const settings = await readSettings(settingsPath)
  for (const event of Object.keys(settings.hooks ?? {})) {
    const groups = withoutOurs(settings.hooks![event])
    if (groups.length) settings.hooks![event] = groups
    else delete settings.hooks![event]
  }
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks
  await writeSettings(settingsPath, settings)
  await rm(ownDir, { recursive: true, force: true })
  return readClaudeHookStatus(options)
}
