#!/usr/bin/env node
// agent-conduit's command line: sets up the Claude Code hook that tells apps
// when a session is waiting on a permission prompt.
//
//   npx agent-conduit install-claude-hook     copy the hook into ~/.claude and register it
//   npx agent-conduit uninstall-claude-hook   take both back out
//   npx agent-conduit claude-hook-status      say whether it is installed and current
//
// The work is in src/claudeHook.ts, which the apps' own install buttons share.

import { CLAUDE_HOOK_EVENTS, installClaudeHook, readClaudeHookStatus, uninstallClaudeHook } from '../dist/node.js'

function describe(status) {
  if (!status.installed) return `not installed (${status.settingsPath})`
  return status.current ? `installed: ${status.hookPath}` : `installed, but older than this agent-conduit: install again to update`
}

const commands = {
  async 'install-claude-hook'() {
    const status = await installClaudeHook()
    console.log(describe(status))
    console.log(`registered in ${status.settingsPath} for ${CLAUDE_HOOK_EVENTS.join(', ')}`)
    console.log('sessions started from now on report permission prompts; restart a running one to include it')
  },
  async 'uninstall-claude-hook'() {
    const status = await uninstallClaudeHook()
    console.log(`removed from ${status.settingsPath}`)
  },
  async 'claude-hook-status'() {
    console.log(describe(await readClaudeHookStatus()))
  },
}

const command = commands[process.argv[2]]
if (!command) {
  console.log(`usage: agent-conduit ${Object.keys(commands).join(' | ')}`)
  process.exit(process.argv[2] ? 1 : 0)
}
await command().catch((error) => {
  console.error(String(error?.message ?? error))
  process.exit(1)
})
