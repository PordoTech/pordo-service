/**
 * Komiic mock upstream, extracted from the behavior tests so contract tests
 * can reuse it. Mirrors the Rust test server: modes control image failures.
 * - mode 0: first image request 403, then OK (ticket refresh path)
 * - mode 1: images always 403 (single refresh then give up)
 * - mode 2: images 402 (quota)
 * - mode 3: ImageTicket GraphQL returns QUOTA_EXCEEDED error
 */
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { imageBytes, readBody, sendJson, startMock, type MockHandle } from '../helpers'

export const KID = '6eb1e407-fad3-4891-a6fb-0489d8af89c1'

export const KOMIIC_DETAIL_URL = 'https://komiic.com/comic/217'

const comic = (): Record<string, unknown> => ({
  id: '217',
  title: '葬送的芙莉莲',
  status: 'ONGOING',
  description: '简介',
  imageUrl: 'https://public.komiic.com/cover.jpg',
  authors: [{ name: '作者' }],
})

export interface KomiicMock extends MockHandle {
  tickets: () => number
  images: () => number
  logins: () => number
  refreshes: () => number
  accountQueries: () => number
  setLoginBehavior(b: 'password' | 'refresh-then-guest' | 'wrong-password' | 'rate-limited'): void
  setSignedIn(v: boolean): void
  setProtectedUnauthorized(v: boolean): void
}

export const startKomiicMock = (mode: number): Promise<KomiicMock> => {
  let tickets = 0
  let images = 0
  let logins = 0
  let refreshes = 0
  let accountQueries = 0
  let loginBehavior: 'password' | 'refresh-then-guest' | 'wrong-password' | 'rate-limited' =
    'password'
  let signedIn = false
  let refreshAcknowledgedButGuest = false
  let protectedUnauthorized = false

  return startMock(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method === 'POST' && url.pathname === '/api/login') {
      logins += 1
      const body = JSON.parse(await readBody(req)) as { email: string; password: string }
      if (loginBehavior === 'wrong-password') {
        sendJson(res, 401, { error: 'invalid_credentials' })
        return
      }
      if (loginBehavior === 'rate-limited') {
        sendJson(res, 429, { error: 'rate_limited' }, { 'retry-after': '30' })
        return
      }
      if (loginBehavior === 'refresh-then-guest' && !refreshAcknowledgedButGuest) {
        // The refresh above succeeded but the account is still a guest; this
        // login must run to complete authentication.
      }
      if (body.password !== 'test-password') {
        sendJson(res, 401, { error: 'invalid_credentials' })
        return
      }
      signedIn = true
      // JWT-like cookie with exp hint (payload not verified by the service).
      const exp = Math.floor(Date.now() / 1000) + 3600
      const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url')
      res.setHeader(
        'set-cookie',
        `komiic-access-token=header.${payload}.sig; Path=/; HttpOnly`,
      )
      sendJson(res, 200, { ok: true })
      return
    }
    if (req.method === 'POST' && url.pathname === '/auth/refresh') {
      refreshes += 1
      if (!signedIn) {
        sendJson(res, 401, { error: 'no_session' })
        return
      }
      if (loginBehavior === 'refresh-then-guest' && !refreshAcknowledgedButGuest) {
        refreshAcknowledgedButGuest = true
        signedIn = false
        sendJson(res, 200, { ok: true })
        return
      }
      sendJson(res, 200, { ok: true })
      return
    }
    if (req.method === 'POST' && url.pathname === '/auth/logout') {
      signedIn = false
      sendJson(res, 200, { ok: true })
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/query') {
      const body = JSON.parse(await readBody(req)) as {
        operationName: string
        variables: Record<string, unknown>
      }
      const op = body.operationName
      if (op === 'PordoAccount') {
        accountQueries += 1
        const address = (req.socket.address() as AddressInfo)
        void address
        sendJson(
          res,
          200,
          signedIn
            ? {
                data: {
                  account: { id: '42', nickname: '测试账号' },
                  getImageLimit: { limit: 300, usage: 2, resetInSeconds: '6200' },
                },
              }
            : { data: { account: { id: '0', nickname: '' } } },
        )
        return
      }
      if (!signedIn && op !== 'Search' && op !== 'Detail' && op !== 'Pages') {
        // Guest allowed for metadata ops; tickets require nothing special here.
      }
      if (protectedUnauthorized && op !== 'PordoAccount') {
        // One-shot: forces the service through recover() → refresh → fallback.
        protectedUnauthorized = false
        sendJson(res, 200, {
          errors: [{ message: 'session expired', extensions: { code: 'UNAUTHENTICATED' } }],
        })
        return
      }
      if (op === 'Search') {
        assert.equal(body.variables.keyword, '葬送')
        sendJson(res, 200, {
          data: { searchComicsAndAuthors: { comics: [comic()] } },
        })
        return
      }
      if (op === 'Detail') {
        assert.equal(body.variables.comicId, '217')
        sendJson(res, 200, {
          data: {
            comicById: comic(),
            chaptersByComicId: [
              { id: '4', serial: '10', type: 'chapter' },
              { id: '5', serial: '01', type: 'book' },
              { id: '3', serial: '2.5', type: 'chapter' },
              { id: '2', serial: '02', type: 'chapter' },
              { id: '1', serial: '01', type: 'chapter' },
              { id: '1', serial: '01', type: 'chapter' },
            ],
          },
        })
        return
      }
      if (op === 'Pages') {
        sendJson(res, 200, {
          data: {
            imagesByChapterId: [{ kid: KID }],
            getImageLimit: { limit: 300, usage: 2, resetInSeconds: '6200' },
          },
        })
        return
      }
      if (op === 'ImageTicket') {
        const n = tickets
        tickets += 1
        if (mode === 3) {
          sendJson(res, 200, {
            errors: [
              {
                message: 'private info must not escape',
                extensions: { code: 'QUOTA_EXCEEDED' },
              },
            ],
          })
          return
        }
        const kids = body.variables.kids as string[]
        assert.equal(kids[0], KID)
        const host = req.headers.host
        sendJson(res, 200, {
          data: {
            getImageTickets: [
              {
                kid: KID,
                url: `http://${host}/image`,
                ticket: `ticket-${n}`,
                expiresAt: Math.floor(Date.now() / 1000) + 600,
              },
            ],
          },
        })
        return
      }
      sendJson(res, 400, { errors: [{ message: 'unexpected operation' }] })
      return
    }
    if (req.method === 'GET' && url.pathname === '/image') {
      const n = images
      images += 1
      const ticket = String(req.headers['x-image-ticket'] ?? '')
      assert.ok(ticket.startsWith('ticket-'), `missing ticket header: ${ticket}`)
      let status = 200
      if (mode === 0 && n === 0) status = 403
      if (mode === 1) status = 403
      if (mode === 2) status = 402
      if (status !== 200) {
        res.writeHead(status, { 'content-type': 'application/octet-stream' })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'image/jpeg' })
      res.end(imageBytes(n))
      return
    }
    res.writeHead(404)
    res.end()
  }).then((handle) => ({
    ...handle,
    tickets: () => tickets,
    images: () => images,
    logins: () => logins,
    refreshes: () => refreshes,
    accountQueries: () => accountQueries,
    setLoginBehavior: (b) => {
      loginBehavior = b
    },
    setSignedIn: (v) => {
      signedIn = v
    },
    setProtectedUnauthorized: (v) => {
      protectedUnauthorized = v
    },
  }))
}
