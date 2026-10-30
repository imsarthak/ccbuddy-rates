// Test doubles shared by the WhatsApp poster tests (wa-post.test.mjs, from
// GitHub Actions, and wa-phone.test.mjs, from the watcher phone). Not a test
// file itself: `node --test scraper/*.test.mjs` does not pick it up.
//
// Nothing here reaches the internet. Whapi is a local fake on 127.0.0.1.

import { createServer } from 'node:http'

// The fake session's own number, as /health reports it. It must never be printed.
export const LINKED_NUMBER = '919800000000'

/**
 * A local Whapi. `routes` maps 'METHOD /path' (ids collapsed to :id) to one
 * answer or a list served in order, the last repeating. An answer is
 * { status, body }, a function of the request, or { hang: true }; any answer
 * may also carry `delay` (ms before it is sent). Every request is recorded,
 * with the time it arrived (`at`).
 */
export async function fakeWhapi(routes = {}) {
  const requests = []
  let sent = 0
  const defaults = {
    'GET /health': { body: { status: { code: 4, text: 'AUTH' }, user: { id: LINKED_NUMBER, name: 'Spare' }, uptime: 9, start_at: 1 } },
    'GET /newsletters/:id': (req) => ({ body: { id: req.url.split('/')[2], name: 'CCBuddy Deals', user_role: 'admin' } }),
    'GET /newsletters': { body: { newsletters: [], count: 0, total: 0 } },
    'POST /messages/text': (req) => ({
      body: { sent: true, message: { id: req.body.edit ?? `PsqXn5SAD5v7HRA-wHN2ziQ${String(++sent).padStart(4, '0')}`, chat_id: req.body.to, from_me: true } },
    }),
    'GET /messages/:id': { body: { id: 'x', status: 'sent' } },
  }
  const server = createServer(async (req, res) => {
    const at = Date.now()
    let raw = ''
    for await (const c of req) raw += c
    const path = req.url.split('?')[0].replace(/^\/newsletters\/[^/]+$/, '/newsletters/:id').replace(/^\/messages\/(?!text$)[^/]+$/, '/messages/:id')
    const rec = { route: `${req.method} ${path}`, url: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null, at }
    requests.push(rec)
    let r = routes[rec.route] ?? defaults[rec.route]
    if (Array.isArray(r)) r = r.length > 1 ? r.shift() : r[0]
    if (typeof r === 'function') r = r(rec)
    if (r?.hang) return
    if (r?.delay) await new Promise((ok) => setTimeout(ok, r.delay))
    if (res.destroyed) return
    res.writeHead(r ? r.status ?? 200 : 404, { 'content-type': 'application/json' })
    res.end(JSON.stringify(r ? r.body ?? {} : { error: { code: 404, message: 'no such route' } }))
  })
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    requests,
    posts: () => requests.filter((r) => r.route === 'POST /messages/text'),
    close: () => new Promise((ok) => (server.closeAllConnections(), server.close(ok))),
  }
}
