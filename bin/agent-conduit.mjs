#!/usr/bin/env node
// agent-conduit's command line: sets up the Claude Code hook that tells apps
// when a session is waiting on a permission prompt.
//
//   npx agent-conduit install-claude-hook     copy the hook into ~/.claude and register it
//   npx agent-conduit uninstall-claude-hook   take both back out
//
// Both leave every other setting and hook in settings.json alone, and running
// either twice is the same as running it once.

import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const settingsPath = join(claudeDir, 'settings.json')
const hookPath = join(claudeDir, 'agent-conduit', 'claude-permission.sh')
const bundledHook = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'claude-permission.sh')

// Where the marker is written, and every way a session moves past the prompt.
// Notification is matched on its type; the tool events on every tool.
const EVENTS = [
  ['PermissionRequest'],
  ['Notification', 'permission_prompt'],
  ['PostToolUse'],
  ['PostToolUseFailure'],
  ['UserPromptSubmit'],
  ['Stop'],
  ['SubagentStop'],
  ['SessionEnd'],
]

async function readSettings() {
  try {
    return JSON.parse(await readFile(settingsPath, 'utf8'))
  }
  catch (error) {
    if (error.code === 'ENOENT') return {}
    throw new Error(`${settingsPath} is not valid JSON; fix it first (${error.message})`)
  }
}

async function writeSettings(settings) {
  // Through a temporary file, so a crash cannot leave Claude Code a half-written settings file.
  await writeFile(`${settingsPath}.agent-conduit.tmp`, `${JSON.stringify(settings, null, 2)}\n`)
  await rename(`${settingsPath}.agent-conduit.tmp`, settingsPath)
}

function isOurs(hook) {
  return typeof hook?.command === 'string' && hook.command.includes('agent-conduit/claude-permission.sh')
}

/** Every hook group with ours taken out, and groups left empty by that dropped. */
function withoutOurs(groups) {
  return (groups ?? [])
    .map(group => ({ ...group, hooks: (group.hooks ?? []).filter(hook => !isOurs(hook)) }))
    .filter(group => group.hooks.length > 0)
}

async function install() {
  await mkdir(dirname(hookPath), { recursive: true })
  await copyFile(bundledHook, hookPath)
  await chmod(hookPath, 0o755)

  const settings = await readSettings()
  settings.hooks ??= {}
  for (const [event, matcher] of EVENTS) {
    const ours = { type: 'command', command: hookPath, timeout: 5 }
    settings.hooks[event] = [
      ...withoutOurs(settings.hooks[event]),
      { ...(matcher ? { matcher } : {}), hooks: [ours] },
    ]
  }
  await writeSettings(settings)

  console.log(`installed ${hookPath}`)
  console.log(`registered it in ${settingsPath} for ${EVENTS.map(([event]) => event).join(', ')}`)
  console.log('sessions started from now on report permission prompts; running ones pick it up on their next settings reload')
}

async function uninstall() {
  const settings = await readSettings()
  for (const event of Object.keys(settings.hooks ?? {})) {
    const groups = withoutOurs(settings.hooks[event])
    if (groups.length) settings.hooks[event] = groups
    else delete settings.hooks[event]
  }
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks
  await writeSettings(settings)
  await rm(join(claudeDir, 'agent-conduit'), { recursive: true, force: true })
  console.log(`removed the hook from ${settingsPath} and deleted ${join(claudeDir, 'agent-conduit')}`)
}

const commands = { 'install-claude-hook': install, 'uninstall-claude-hook': uninstall }
const command = commands[process.argv[2]]
if (!command) {
  console.log('usage: agent-conduit install-claude-hook | uninstall-claude-hook')
  process.exit(process.argv[2] ? 1 : 0)
}
await command().catch((error) => {
  console.error(String(error.message ?? error))
  process.exit(1)
})
