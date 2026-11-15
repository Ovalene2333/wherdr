import { expect, test } from './test'
import { createServer } from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import { CODEX_UPDATE_PANE, CODEX_UPDATE_SESSION, SOCK_FILE, fakeHerdr } from './scenario.mjs'

test('a paginated Codex conversation is read from the shared daemon without terminal input', async ({ page }) => {
  // The launcher supplies an invented HOME, never a user's existing daemon.
  const home = path.join(path.dirname(fs.readFileSync(SOCK_FILE, 'utf8')), 'home')
  const socket = path.join(home, '.codex/app-server-control/app-server-control.sock')
  fs.mkdirSync(path.dirname(socket), { recursive: true })
  const cwd = (await fakeHerdr('e2e.pane_field', { pane_id: CODEX_UPDATE_PANE, field: 'cwd' })).value
  const methods: string[] = []
  const server = createServer()
  const ws = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => ws.handleUpgrade(request, socket, head, client => ws.emit('connection', client)))
  ws.on('connection', client => client.on('message', bytes => {
    const message = JSON.parse(bytes.toString())
    methods.push(message.method)
    let result: object = {}
    if (message.method === 'thread/read') result = { thread: {
      id: CODEX_UPDATE_SESSION, name: 'Build review', cwd,
      historyMode: 'paginated', model: 'test-model',
    } }
    if (message.method === 'thread/items/list') result = { data: [
      { startedAtMs: 2000, item: { id: 'reply', type: 'agentMessage', text: 'This reply is stored in the shared daemon.' } },
      { startedAtMs: 1000, item: { id: 'question', type: 'userMessage', content: [{ type: 'text', text: 'Read the current history.' }] } },
    ], nextCursor: null }
    if (message.id !== undefined) client.send(JSON.stringify({ id: message.id, result }))
  }))
  await new Promise<void>(resolve => server.listen(socket, resolve))
  try {
    await fakeHerdr('e2e.update_session', { pane_id: CODEX_UPDATE_PANE, session: CODEX_UPDATE_SESSION })
    const before = await fakeHerdr('e2e.terminal_screen', { pane_id: CODEX_UPDATE_PANE })
    await page.goto(`/#/a/${CODEX_UPDATE_PANE}`)
    await expect(page.locator('.chat').getByText('This reply is stored in the shared daemon.')).toBeVisible()
    await expect(page.locator('.chat').getByText('Read the current history.')).toBeVisible()
    await expect(page.locator('.chat').getByText('No conversation for this agent yet.')).toHaveCount(0)
    const after = await fakeHerdr('e2e.terminal_screen', { pane_id: CODEX_UPDATE_PANE })
    expect(after.keys).toEqual(before.keys)
    expect(methods).toContain('thread/items/list')
    expect(methods.every(method => ['initialize', 'initialized', 'thread/read', 'thread/items/list'].includes(method))).toBe(true)
  } finally {
    for (const client of ws.clients) client.terminate()
    await new Promise<void>(resolve => server.close(() => resolve()))
    ws.close()
  }
})
