import { describe, expect, it, vi } from 'vitest'
import { createCodexDaemonHistory, codexHistoryItems } from '../server/utils/codexDaemon'
import type { CodexRpc } from '../server/utils/codexDaemonRpc'

const thread = { id: 'thread-a', name: 'A task', cwd: '/work/demo', historyMode: 'paginated', model: 'test-model' }
const pane = { id: 'w1:p1', agent: 'codex', cwd: '/work/demo', title: 'A task | demo' }
type Entry = Parameters<typeof codexHistoryItems>[0][number]
const entry = (i: number): Entry => ({ startedAtMs: 1000 + i, item: {
  id: `item-${i}`, type: i % 2 ? 'agentMessage' : 'userMessage', text: `reply ${i}`,
  content: [{ type: 'text', text: `question ${i}` }],
} })
function fixture({ matches = [thread], total = 150 } = {}) {
  const history = Array.from({ length: total }, (_, i) => entry(i))
  const rpc = vi.fn<CodexRpc>(async (method, params) => {
    if (method === 'thread/list') return { data: matches, nextCursor: null }
    if (method === 'thread/read') return { thread }
    if (method === 'thread/items/list') {
      const end = params.cursor == null ? history.length : Number(params.cursor)
      const start = Math.max(0, end - Number(params.limit))
      return { data: history.slice(start, end).reverse(), nextCursor: start ? String(start) : null }
    }
    throw new Error('Unexpected method')
  })
  return { adapter: createCodexDaemonHistory({ rpc }), rpc, append: (i: number) => history.push(entry(i)) }
}
describe('Codex daemon history', () => {
  it('resolves an exact unique name and cwd without comparing pane and thread creation times', async () => {
    const { adapter } = fixture({ total: 24 })
    const r = await adapter.chat(pane)
    expect(r?.session).toBe('thread-a')
    expect(r?.items).toHaveLength(24)
    expect(r?.start).toBe(0)
  })
  it('refuses duplicate titles, another cwd, generic titles, and subagents', async () => {
    for (const matches of [[thread, { ...thread, id: 'thread-b' }], [{ ...thread, cwd: '/other' }], [{ ...thread, parentThreadId: 'parent' }]]) {
      const { adapter, rpc } = fixture({ matches })
      expect((await adapter.chat(pane))?.available).toBe(false)
      expect(rpc.mock.calls.some(([method]) => method === 'thread/items/list')).toBe(false)
    }
    expect(await fixture().adapter.chat({ ...pane, title: 'codex' })).toBeNull()
  })
  it('uses an explicit session ID even after the title changes', async () => {
    const { adapter, rpc } = fixture({ total: 2 })
    const r = await adapter.chat({ ...pane, agentSession: thread.id, title: 'Renamed' })
    expect(r?.session).toBe(thread.id)
    expect(r?.guessed).toBe(false)
    expect(rpc.mock.calls[0]?.[0]).toBe('thread/read')
  })
  it('keeps the tail anchor stable while new items arrive and pages older history separately', async () => {
    const { adapter, append } = fixture()
    const first = (await adapter.chat(pane))!
    expect(first.items).toHaveLength(100)
    expect(first.start).toBeGreaterThan(0)
    const older = (await adapter.chat(pane, { before: first.start }))!
    expect(older.older).toBe(true)
    expect(older.items).toHaveLength(50)
    expect(older.start).toBe(0)
    append(150)
    const next = (await adapter.chat(pane, { from: first.start, since: first.token }))!
    expect(next.start).toBe(first.start)
    expect(next.items).toHaveLength(101)
    expect(next.items![0]).toEqual(first.items![0])
    expect(next.items!.at(-1)?.text).toBe('question 150')
    expect((await adapter.chat(pane, { from: next.start, since: next.token }))?.unchanged).toBe(true)
  })
  it('rejects an unknown cursor and an already aborted read', async () => {
    const { adapter, rpc } = fixture()
    await expect(adapter.chat(pane, { before: 1234 })).rejects.toThrow('cursor expired')
    rpc.mockClear()
    await expect(adapter.chat(pane, { signal: AbortSignal.abort() })).rejects.toThrow()
    expect(rpc).not.toHaveBeenCalled()
  })
  it('uses the legacy reader when there is no socket or the matched thread is not paginated', async () => {
    const { adapter } = fixture({ matches: [{ ...thread, historyMode: 'legacy' }] })
    expect(await adapter.chat(pane)).toBeNull()
    const missing = createCodexDaemonHistory({ rpc: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) } })
    expect(await missing.chat(pane)).toBeNull()
  })
  it('propagates failures instead of replacing an existing conversation with an empty result', async () => {
    const adapter = createCodexDaemonHistory({ rpc: async () => { throw new Error('connection lost') } })
    await expect(adapter.chat(pane)).rejects.toThrow('connection lost')
  })
  it('does not choose from an incomplete thread inventory', async () => {
    const rpc = vi.fn<CodexRpc>(async () => ({ data: Array.from({ length: 100 }, () => thread), nextCursor: 'more' }))
    expect((await createCodexDaemonHistory({ rpc }).chat(pane))?.available).toBe(false)
    expect(rpc).toHaveBeenCalledTimes(10)
  })
})
