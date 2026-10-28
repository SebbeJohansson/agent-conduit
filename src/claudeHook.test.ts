import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CLAUDE_HOOK_EVENTS, installClaudeHook, readClaudeHookStatus, uninstallClaudeHook } from './claudeHook.js'

let claudeDir: string

beforeEach(async () => {
  claudeDir = await mkdtemp(join(tmpdir(), 'agent-conduit-hook-'))
})

afterEach(async () => {
  await rm(claudeDir, { recursive: true, force: true })
})

async function settings() {
  return JSON.parse(await readFile(join(claudeDir, 'settings.json'), 'utf8'))
}

describe('the Claude Code hook installer', () => {
  it('reports a fresh directory as not installed', async () => {
    expect(await readClaudeHookStatus({ claudeDir })).toMatchObject({ installed: false, current: false })
  })

  it('installs, keeps other settings and hooks, and reports itself current', async () => {
    const other = { hooks: [{ type: 'command', command: 'notify-send done' }] }
    await writeFile(join(claudeDir, 'settings.json'), JSON.stringify({ model: 'opus', hooks: { Stop: [other] } }))

    expect(await installClaudeHook({ claudeDir })).toMatchObject({ installed: true, current: true })

    const after = await settings()
    expect(after.model).toBe('opus')
    expect(after.hooks.Stop[0]).toEqual(other)
    expect(Object.keys(after.hooks).sort()).toEqual([...CLAUDE_HOOK_EVENTS].sort())
    expect(after.hooks.Notification).toEqual([{
      matcher: 'permission_prompt',
      hooks: [{ type: 'command', command: join(claudeDir, 'agent-conduit', 'claude-permission.sh'), timeout: 5 }],
    }])
  })

  it('does not register twice', async () => {
    await installClaudeHook({ claudeDir })
    await installClaudeHook({ claudeDir })
    expect((await settings()).hooks.PermissionRequest).toHaveLength(1)
  })

  it('calls an outdated script installed but not current', async () => {
    await installClaudeHook({ claudeDir })
    await writeFile(join(claudeDir, 'agent-conduit', 'claude-permission.sh'), '#!/bin/sh\n# old\n')
    expect(await readClaudeHookStatus({ claudeDir })).toMatchObject({ installed: true, current: false })
  })

  it('uninstalls back to the settings it found', async () => {
    const before = { model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] } }
    await writeFile(join(claudeDir, 'settings.json'), JSON.stringify(before))
    await installClaudeHook({ claudeDir })

    expect(await uninstallClaudeHook({ claudeDir })).toMatchObject({ installed: false })
    expect(await settings()).toEqual(before)
  })

  it('refuses a settings file that is not JSON, and writes nothing', async () => {
    await writeFile(join(claudeDir, 'settings.json'), '{ nope')
    await expect(installClaudeHook({ claudeDir })).rejects.toThrow('not valid JSON')
    expect(await readFile(join(claudeDir, 'settings.json'), 'utf8')).toBe('{ nope')
    expect(await readClaudeHookStatus({ claudeDir })).toMatchObject({ installed: false })
  })
})
