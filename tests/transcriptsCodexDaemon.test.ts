import { describe, expect, it, vi } from 'vitest'
import { createTranscripts } from '../server/utils/transcripts'

describe('Codex shared-daemon conversation history', () => {
  it('reads paginated history without a JSONL file or inherited Herdr hook context', async () => {
    const daemon = {
      chat: vi.fn().mockResolvedValue({
        available: true, session: 'thread-a', file: 'codex-daemon-thread-a.jsonl',
        items: [{ role: 'assistant', text: 'The current daemon reply.', ts: null }], start: 0,
      }),
    }
    const reader = createTranscripts({
      home: '/home/user', herdr: vi.fn(), codexHistory: daemon,
      fs: { readdir: async () => [], statMany: async () => [] },
    } as unknown as Parameters<typeof createTranscripts>[0])
    const reply = await reader.chat({ id: 'w1:p1', agent: 'codex', cwd: '/work/demo', title: 'A task | demo' })
    expect(reply.available).toBe(true)
    expect(reply.session).toBe('thread-a')
    expect(reply.items).toEqual([{ role: 'assistant', text: 'The current daemon reply.', ts: null }])
  })
})
