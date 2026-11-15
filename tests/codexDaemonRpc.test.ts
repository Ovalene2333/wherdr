import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import { createCodexDaemonRpc } from '../server/utils/codexDaemonRpc'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
async function fakeDaemon() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'codex-history-'))
  const socket = path.join(home, 'app-server-control', 'app-server-control.sock')
  mkdirSync(path.dirname(socket))
  const server = createServer()
  const ws = new WebSocketServer({ noServer: true })
  const methods: string[] = []
  server.on('upgrade', (request, socket, head) => ws.handleUpgrade(request, socket, head, client => ws.emit('connection', client)))
  ws.on('connection', client => client.on('message', bytes => {
    const message = JSON.parse(bytes.toString())
    methods.push(message.method)
    if (message.id !== undefined) client.send(JSON.stringify({ id: message.id, result: message.method === 'initialize' ? {} : { data: [], nextCursor: null } }))
  }))
  await new Promise<void>(resolve => server.listen(socket, resolve))
  cleanups.push(async () => {
    for (const client of ws.clients) client.terminate()
    await new Promise<void>(resolve => server.close(() => resolve()))
    ws.close()
    rmSync(home, { recursive: true, force: true })
  })
  return { home, methods }
}
describe('read-only local Codex daemon transport', () => {
  it('handshakes once before concurrent history requests over the UNIX WebSocket', async () => {
    const { home, methods } = await fakeDaemon()
    const rpc = createCodexDaemonRpc(home)
    const results = await Promise.all([rpc('thread/list', {}), rpc('thread/items/list', { threadId: 'thread-a' })])
    expect(results).toEqual([{ data: [], nextCursor: null }, { data: [], nextCursor: null }])
    expect(methods).toEqual(['initialize', 'initialized', 'thread/list', 'thread/items/list'])
  })
  it('refuses mutating methods before connecting to any endpoint', async () => {
    const rpc = createCodexDaemonRpc('/unused')
    await expect(rpc('turn/start' as never, {})).rejects.toThrow('read-only')
    await expect(rpc('thread/resume' as never, {})).rejects.toThrow('read-only')
  })
})
