import { describe, expect, it, vi } from 'vitest'
import type { OpencodeSession } from './status.js'
import { fetchOpencodeSessions, replyOpencodePermission, watchOpencode } from './client.js'

/** A fake server: canned JSON per path (query ignored), and an event stream the test writes to. */
function fakeServer(routes: Record<string, unknown>) {
  let push: ((text: string) => void) | undefined
  const seen: string[] = []
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input))
    seen.push(`${url.pathname}${url.search}`)
    if (url.pathname === '/global/event') {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          push = text => controller.enqueue(new TextEncoder().encode(text))
        },
      })
      return new Response(body, { status: 200 })
    }
    return Response.json(routes[url.pathname] ?? [])
  }) as unknown as typeof fetch
  return { fetcher, seen, push: (text: string) => push?.(text) }
}

const ROUTES = {
  '/project': [{ worktree: '/p' }],
  '/session': [{ id: 'a', directory: '/p', title: 'A', time: { created: 1, updated: 2 } }],
  '/session/status': { a: { type: 'busy' } },
}

describe('fetchOpencodeSessions', () => {
  it('asks every directory once and merges the answers', async () => {
    const server = fakeServer(ROUTES)
    const sessions = await fetchOpencodeSessions({ baseUrl: 'http://x:4096/', fetch: server.fetcher })

    expect(sessions.map(s => [s.sessionId, s.activity])).toEqual([['a', 'working']])
    expect(server.seen).toContain('/session/status?directory=%2Fp')
    expect(server.seen).toContain('/session/status')
  })
})

describe('watchOpencode', () => {
  it('starts from a snapshot and applies events on top', async () => {
    const server = fakeServer(ROUTES)
    const updates: OpencodeSession[][] = []
    const watch = watchOpencode({ baseUrl: 'http://x:4096', fetch: server.fetcher }, { onSessions: s => updates.push(s) })

    await vi.waitFor(() => expect(updates.length).toBe(1))
    expect(updates[0]?.[0]?.activity).toBe('working')

    server.push(`data: ${JSON.stringify({ directory: '/p', payload: { type: 'session.status', properties: { sessionID: 'a', status: { type: 'idle' } } } })}\n\n`)
    await vi.waitFor(() => expect(updates.length).toBe(2))
    expect(updates[1]?.[0]?.activity).toBe('idle')

    watch.stop()
  })

  it('reports a server that cannot be reached and retries', async () => {
    const fetcher = vi.fn(async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    const errors: string[] = []
    const watch = watchOpencode({ baseUrl: 'http://x:4096', fetch: fetcher }, { onSessions: () => {}, onError: e => errors.push(e) }, 10)

    await vi.waitFor(() => expect(errors.length).toBeGreaterThanOrEqual(2))
    expect(errors[0]).toContain('ECONNREFUSED')
    watch.stop()
  })
})

describe('replyOpencodePermission', () => {
  it('posts the reply to the instance the request came from', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch
    await replyOpencodePermission({ baseUrl: 'http://x:4096', fetch: fetcher }, { requestId: 'p1', directory: '/p' }, 'once')

    expect(fetcher).toHaveBeenCalledWith('http://x:4096/permission/p1/reply?directory=%2Fp', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ reply: 'once' }),
    }))
  })

  it('throws on a refusal', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 404 })) as unknown as typeof fetch
    await expect(replyOpencodePermission({ baseUrl: 'http://x:4096', fetch: fetcher }, { requestId: 'p1' }, 'reject'))
      .rejects.toThrow('404')
  })
})
