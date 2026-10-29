import type { Server } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HerdrError } from './client.js'
import { dialogOf, herdrAgentName, listHerdrAgents, promptHerdrAgent, readHerdrAgent, sendHerdrKeys, startHerdrAgent, watchHerdr } from './agents.js'

type Handler = (method: string, params: Record<string, unknown>) => { result?: unknown, error?: { code: string, message: string } }

let dir: string
let socketPath: string
let server: Server
const calls: Array<{ method: string, params: Record<string, unknown> }> = []

/** A herdr stand-in: one JSON request per line in, one response per line out. */
async function serve(handler: Handler) {
  server = createServer((socket) => {
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const request = JSON.parse(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        calls.push({ method: request.method, params: request.params })
        socket.write(`${JSON.stringify({ id: request.id, ...handler(request.method, request.params) })}\n`)
      }
    })
  })
  await new Promise<void>(resolve => server.listen(socketPath, resolve))
}

const CLAUDE_PANE = {
  pane_id: 'w1:p2',
  workspace_id: 'w1',
  tab_id: 'w1:t1',
  name: 'reviewer',
  agent: 'claude',
  agent_status: 'blocked',
  cwd: '/home/me',
  foreground_cwd: '/home/me/proj',
  terminal_title_stripped: 'Fix the login',
  focused: false,
  agent_session: { agent: 'claude', kind: 'id', source: 'herdr:claude', value: 'c4cc048e' },
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-conduit-herdr-'))
  socketPath = join(dir, 'herdr.sock')
  calls.length = 0
})

afterEach(async () => {
  await new Promise(resolve => server?.close(resolve))
  await rm(dir, { recursive: true, force: true })
})

describe('herdr agents', () => {
  it('lists agents, with the session id and process ids that match Claude Code\'s', async () => {
    await serve((method, params) => {
      if (method === 'pane.process_info') {
        return params.pane_id === 'w1:p2'
          ? { result: { type: 'pane_process_info', process_info: { pane_id: 'w1:p2', foreground_processes: [{ pid: 4242, name: 'claude' }] } } }
          : { error: { code: 'not_found', message: 'pane closed' } }
      }
      if (method === 'agent.read') {
        return { result: { type: 'pane_read', read: { text: 'Do you want to proceed?\n❯ 1. Yes\n  2. Yes, and don\'t ask again\n  3. No' } } }
      }
      return { result: { type: 'agent_list', agents: [CLAUDE_PANE, { pane_id: 'w2:p1', workspace_id: 'w2', tab_id: 'w2:t1', agent: 'opencode', agent_status: 'working', agent_session: null }] } }
    })

    expect(await listHerdrAgents({ socketPath })).toEqual([
      { paneId: 'w1:p2', workspaceId: 'w1', tabId: 'w1:t1', name: 'reviewer', kind: 'claude', status: 'blocked', cwd: '/home/me/proj', title: 'Fix the login', sessionId: 'c4cc048e', focused: false, pids: [4242], dialog: 'permission' },
      { paneId: 'w2:p1', workspaceId: 'w2', tabId: 'w2:t1', kind: 'opencode', status: 'working', focused: false },
    ])
  })

  it('turns herdr\'s error responses into HerdrErrors with the code', async () => {
    await serve(() => ({ error: { code: 'agent_blocked', message: 'agent is waiting on a dialog' } }))

    const failure = await promptHerdrAgent('reviewer', 'hi', { socketPath }).catch(error => error)
    expect(failure).toBeInstanceOf(HerdrError)
    expect(failure.code).toBe('agent_blocked')
  })

  it('sends prompts, keys and reads with herdr\'s parameter names', async () => {
    await serve((method) => {
      if (method === 'agent.prompt') return { result: { type: 'agent_prompted', agent: { ...CLAUDE_PANE, agent_status: 'working' } } }
      if (method === 'agent.read') return { result: { type: 'pane_read', read: { text: 'hello' } } }
      return { result: { type: 'ok' } }
    })

    expect((await promptHerdrAgent('reviewer', 'go on', { socketPath })).status).toBe('working')
    await sendHerdrKeys('w1:p2', ['esc'], { socketPath })
    expect(await readHerdrAgent('reviewer', 50, { socketPath })).toBe('hello')

    expect(calls).toEqual([
      { method: 'agent.prompt', params: { target: 'reviewer', text: 'go on' } },
      { method: 'agent.send_keys', params: { target: 'w1:p2', keys: ['esc'] } },
      { method: 'agent.read', params: { target: 'reviewer', source: 'recent_unwrapped', lines: 50, strip_ansi: true } },
    ])
  })

  it('starts an agent in a new, unfocused workspace', async () => {
    await serve((method) => {
      if (method === 'workspace.create') return { result: { type: 'workspace_created', root_pane: { pane_id: 'w3:p1' } } }
      return { result: { type: 'agent_started', agent: { ...CLAUDE_PANE, pane_id: 'w3:p1', name: 'proj-ab12', agent_status: 'idle' }, argv: [] } }
    })

    const agent = await startHerdrAgent({ kind: 'claude', cwd: '/home/me/proj', name: 'proj-ab12' }, { socketPath })

    expect(agent).toMatchObject({ paneId: 'w3:p1', name: 'proj-ab12', status: 'idle' })
    expect(calls[0]).toEqual({ method: 'workspace.create', params: { cwd: '/home/me/proj', label: 'proj-ab12', focus: false } })
    expect(calls[1]).toMatchObject({ method: 'agent.start', params: { name: 'proj-ab12', kind: 'claude', pane_id: 'w3:p1' } })
  })

  it('waits for a new workspace\'s shell to reach its prompt before starting', async () => {
    let busy = 2
    await serve((method) => {
      if (method === 'workspace.create') return { result: { type: 'workspace_created', workspace: { workspace_id: 'w3' }, root_pane: { pane_id: 'w3:p1' } } }
      if (method === 'agent.start' && busy-- > 0) return { error: { code: 'agent_pane_busy', message: 'agent target pane w3:p1 is not an available shell' } }
      return { result: { type: 'agent_started', agent: { ...CLAUDE_PANE, pane_id: 'w3:p1', agent_status: 'idle' }, argv: [] } }
    })

    expect((await startHerdrAgent({ kind: 'claude', cwd: '/p', name: 'p-ab12' }, { socketPath })).paneId).toBe('w3:p1')
    expect(calls.map(call => call.method)).toEqual(['workspace.create', 'agent.start', 'agent.start', 'agent.start'])
  })

  it('closes the workspace it made when the agent cannot start', async () => {
    await serve((method) => {
      if (method === 'workspace.create') return { result: { type: 'workspace_created', workspace: { workspace_id: 'w3' }, root_pane: { pane_id: 'w3:p1' } } }
      if (method === 'agent.start') return { error: { code: 'unsupported_agent_kind', message: 'unsupported interactive agent kind nope' } }
      return { result: { type: 'ok' } }
    })

    const failure = await startHerdrAgent({ kind: 'nope', cwd: '/p' }, { socketPath }).catch(error => error)

    expect(failure.code).toBe('unsupported_agent_kind')
    expect(calls.at(-1)).toEqual({ method: 'workspace.close', params: { workspace_id: 'w3' } })
  })

  it('reports a herdr that is not running', async () => {
    const failure = await listHerdrAgents({ socketPath: join(dir, 'nothing.sock') }).catch(error => error)
    expect(String(failure)).toMatch(/ENOENT|ECONNREFUSED/)
  })

  it('watches: reports changes once each, and keeps going after herdr goes away', async () => {
    let status = 'working'
    await serve(() => ({ result: { type: 'agent_list', agents: [{ ...CLAUDE_PANE, agent_status: status }] } }))
    const seen: string[] = []
    const errors: string[] = []
    const watch = watchHerdr({ onAgents: agents => seen.push(agents[0]?.status ?? 'none'), onError: e => errors.push(e) }, { socketPath, intervalMs: 10 })

    await vi.waitFor(() => expect(seen).toEqual(['working']))
    status = 'blocked'
    await vi.waitFor(() => expect(seen).toEqual(['working', 'blocked']))
    await new Promise(resolve => server.close(resolve))
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0))
    watch.stop()
    expect(seen).toEqual(['working', 'blocked'])
  })
})

describe('herdrAgentName', () => {
  it('makes a valid herdr name from a directory', () => {
    expect(herdrAgentName('/home/me/My Widget', 'ab12')).toBe('my-widget-ab12')
    expect(herdrAgentName('/home/me/3d-models', 'ab12')).toBe('d-models-ab12')
    expect(herdrAgentName('/', 'ab12')).toBe('agent-ab12')
  })
})

describe('dialogOf', () => {
  it('recognises a Claude Code permission prompt', () => {
    expect(dialogOf('claude', ' Bash command\n  npm test\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don\'t ask again for npm test\n   3. No, and tell Claude what to do differently (esc)')).toBe('permission')
  })

  // Seen in the wild: answering this with Enter quits the session.
  it('does not take the folder-trust screen for one', () => {
    expect(dialogOf('claude', ' Quick safety check: Is this a project you created or one you trust?\n ❯ No, exit\n   Yes, I trust this folder\n Enter to confirm · Esc to cancel')).toBe('other')
  })

  it('knows no other agent\'s dialogs', () => {
    expect(dialogOf('opencode', 'Do you want to proceed?\n 1. Yes\n 3. No')).toBe('other')
  })
})

