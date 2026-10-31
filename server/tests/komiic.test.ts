/**
 * Komiic behavior migration tests. Mirrors the assertions of the client's
 * crates/pordo-core/src/comics/source/komiic/tests.rs and auth_tests.rs
 * against a local mock upstream, fully offline.
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, type TestServer } from './helpers'
import { KOMIIC_DETAIL_URL, KID, startKomiicMock, type KomiicMock } from './mocks/komiic'

interface Harness {
  server: TestServer
  token: string
  cookie: string
  csrf: string
}

const startHarness = async (mode: number): Promise<{ harness: Harness; mock: KomiicMock; comicId: string }> => {
  const mock = await startKomiicMock(mode)
  const server = await startTestServer()
  const { cookie, csrf } = await server.setupAdmin()
  // Point the komiic source at the mock upstream.
  const updateResponse = await fetch(`${server.adminBase}/sources/komiic`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
    body: JSON.stringify({ config: { baseUrl: mock.base } }),
  })
  assert.equal(updateResponse.status, 200)
  const token = await server.createDeviceToken('test-device', cookie, csrf)
  // Resolve the identity used across tests.
  const resolveResponse = await fetch(`${server.baseUrl}/api/v1/comics/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      comics: [
        {
          provider: 'komiic',
          siteId: 'komiic',
          detailUrl: KOMIIC_DETAIL_URL,
        },
      ],
    }),
  })
  const resolved = (await resolveResponse.json()) as { data: { comics: Array<{ comicId: string }> } }
  return { harness: { server, token, cookie, csrf }, mock, comicId: resolved.data.comics[0]!.comicId }
}

describe('komiic provider (offline mock)', () => {
  test('search, detail and lazy image-only tickets; service never fetches images', async () => {
    const { harness, mock, comicId } = await startHarness(0)
    const { server, token } = harness
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    try {
      const search = await fetch(`${server.baseUrl}/api/v1/comics/search?q=%E8%91%AC%E9%80%81&sourceId=komiic`, { headers: auth })
      assert.equal(search.status, 200)
      const detail = await fetch(`${server.baseUrl}/api/v1/comics/${comicId}`, { headers: auth })
      const data = (await detail.json()) as { data: { chapters: Array<{ id: string; kind: string }> } }
      assert.deepEqual(data.data.chapters.map(c => c.id), ['1','2','3','4','5'])
      assert.equal(data.data.chapters[4]!.kind, 'volume')
      const pages = await fetch(`${server.baseUrl}/api/v1/comics/${comicId}/chapters/1/pages`, { headers: auth })
      const page = (await pages.json() as { data: { pages: Array<{ url: string }> } }).data.pages[0]!
      assert.ok(page.url.endsWith(`/api/image/${KID}`))
      assert.equal(mock.tickets(), 0)
      const resolve = () => fetch(`${server.baseUrl}/api/v1/images/resolve`, { method: 'POST', headers: auth,
        body: JSON.stringify({ provider: 'komiic', siteId: 'komiic', url: page.url }) })
      const response = await resolve()
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      const access = (await response.json() as { data: { url: string; headers: Record<string,string>; expiresAt: number } }).data
      assert.ok(access.url.startsWith(mock.base))
      assert.ok(access.expiresAt > Date.now())
      assert.deepEqual(Object.keys(access.headers), ['x-image-ticket'])
      assert.equal(mock.images(), 0)
      // The device handles 403 by obtaining a new ticket; the server still reads no image bytes.
      const first = await fetch(access.url, { headers: access.headers }); assert.equal(first.status, 403); await first.arrayBuffer()
      const refreshed = (await (await resolve()).json() as { data: typeof access }).data
      const second = await fetch(refreshed.url, { headers: refreshed.headers }); assert.equal(second.status, 200); await second.arrayBuffer()
      assert.equal(mock.tickets(), 2)
      const evil = await fetch(`${server.baseUrl}/api/v1/images/resolve`, { method: 'POST', headers: auth,
        body: JSON.stringify({ provider: 'komiic', siteId: 'komiic', url: 'https://evil.example/api/image/123' }) })
      assert.equal(evil.status, 400)
    } finally { await mock.close(); await server.stop() }
  })

  test('ticket quota blocks resolution but leaves metadata available', async () => {
    const { harness, mock, comicId } = await startHarness(3)
    const { server, token } = harness
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    try {
      const pages = await fetch(`${server.baseUrl}/api/v1/comics/${comicId}/chapters/1/pages`, { headers: auth })
      assert.equal(pages.status, 200)
      const url = (await pages.json() as { data: { pages: Array<{ url: string }> } }).data.pages[0]!.url
      for (let i = 0; i < 2; i++) {
        const response = await fetch(`${server.baseUrl}/api/v1/images/resolve`, { method: 'POST', headers: auth,
          body: JSON.stringify({ provider: 'komiic', siteId: 'komiic', url }) })
        assert.equal(response.status, 429)
        assert.equal((await response.json() as { error: { code: string } }).error.code, 'UPSTREAM_QUOTA')
      }
      assert.equal(mock.tickets(), 1)
      assert.equal(mock.images(), 0)
      const search = await fetch(`${server.baseUrl}/api/v1/comics/search?q=%E8%91%AC%E9%80%81&sourceId=komiic`, { headers: auth })
      assert.equal(search.status, 200)
    } finally { await mock.close(); await server.stop() }
  })

  test('account login, single-flight, refresh fallback and logout', async () => {
    const { harness, mock } = await startHarness(0)
    const { server, cookie, csrf } = harness
    const admin = {
      'content-type': 'application/json',
      cookie,
      'x-csrf-token': csrf,
    }
    try {
      // Save account with wrong password first: manual login fails, terminal
      const save = await fetch(`${server.adminBase}/sources/komiic/account`, {
        method: 'PUT',
        headers: admin,
        body: JSON.stringify({ username: 'user@example.com', password: 'bad', autoLogin: true }),
      })
      assert.equal(save.status, 200)
      const saved = (await save.json()) as {
        data: { account: { hasPassword: boolean; username: string }; state: { phase: string; message: string } }
      }
      assert.equal(saved.data.account.hasPassword, true)
      assert.ok(!JSON.stringify(saved).includes('bad'), 'password must never be echoed')
      assert.ok(saved.data.account.username.includes('***'), 'username is masked')
      assert.equal(saved.data.state.phase, 'error')
      assert.ok(saved.data.state.message.includes('邮箱或密码错误'))

      // Correct password: auto-login after save
      const save2 = await fetch(`${server.adminBase}/sources/komiic/account`, {
        method: 'PUT',
        headers: admin,
        body: JSON.stringify({ username: 'user@example.com', password: 'test-password', autoLogin: true }),
      })
      const saved2 = (await save2.json()) as { data: { state: { phase: string; nickname: string; limit: number; usage: number } } }
      assert.equal(saved2.data.state.phase, 'signed_in')
      assert.equal(saved2.data.state.nickname, '测试账号')
      assert.equal(saved2.data.state.limit, 300)
      assert.equal(saved2.data.state.usage, 2)
      // One failed upstream login (wrong password) plus one successful login,
      // matching the client's "explicit retry after editing credentials".
      assert.equal(mock.logins(), 2)

      // Single-flight: concurrent manual logins do not loop
      const logins = await Promise.all(
        [1, 2, 3].map(() =>
          fetch(`${server.adminBase}/sources/komiic/login`, { method: 'POST', headers: admin }),
        ),
      )
      // Single-flight: concurrent manual logins while signed in never loop
      for (const response of logins) assert.equal(response.status, 200)
      assert.equal(mock.logins(), 2, `no login loops (logins=${mock.logins()})`)

      // Empty password keeps the stored one
      const save3 = await fetch(`${server.adminBase}/sources/komiic/account`, {
        method: 'PUT',
        headers: admin,
        body: JSON.stringify({ username: 'user@example.com', autoLogin: true }),
      })
      const saved3 = (await save3.json()) as { data: { account: { hasPassword: boolean } } }
      assert.equal(saved3.data.account.hasPassword, true)

      // Explicit clear removes it
      const save4 = await fetch(`${server.adminBase}/sources/komiic/account`, {
        method: 'PUT',
        headers: admin,
        body: JSON.stringify({ username: 'user@example.com', autoLogin: false, clearPassword: true }),
      })
      const saved4 = (await save4.json()) as { data: { account: { hasPassword: boolean } } }
      assert.equal(saved4.data.account.hasPassword, false)

      // Logout clears the upstream session and drops back to guest; the
      // stored account row loses its password and auto-login flag.
      const logout = await fetch(`${server.adminBase}/sources/komiic/logout`, {
        method: 'POST',
        headers: admin,
      })
      assert.equal(logout.status, 200)
      const status = await fetch(`${server.adminBase}/sources/komiic/account`, { headers: admin })
      const statusBody = (await status.json()) as {
        data: {
          account: { hasPassword: boolean; autoLogin: boolean } | null
          state: { phase: string } | null
        }
      }
      assert.equal(statusBody.data.account?.hasPassword, false)
      assert.equal(statusBody.data.account?.autoLogin, false)
      assert.equal(statusBody.data.state?.phase, 'guest')
    } finally {
      await mock.close()
      await server.stop()
    }
  })

  test('refresh acknowledged but guest falls back to password login once', async () => {
    const { harness, mock } = await startHarness(0)
    const { server, cookie, csrf, token } = harness
    const admin = { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }
    try {
      // Establish a signed-in session with a stored cookie first.
      const save = await fetch(`${server.adminBase}/sources/komiic/account`, {
        method: 'PUT',
        headers: admin,
        body: JSON.stringify({ username: 'user@example.com', password: 'test-password', autoLogin: true }),
      })
      const saved = (await save.json()) as { data: { state: { phase: string } } }
      assert.equal(saved.data.state.phase, 'signed_in')
      assert.equal(mock.logins(), 1)

      // The server now acknowledges refresh but reports a guest account; a
      // protected query fails with UNAUTHENTICATED and must trigger recover():
      // refresh once → guest → exactly one password-login fallback.
      mock.setLoginBehavior('refresh-then-guest')
      mock.setProtectedUnauthorized(true)
      const search = await fetch(
        `${server.baseUrl}/api/v1/comics/search?q=${encodeURIComponent('葬送')}&sourceId=komiic`,
        { headers: { authorization: `Bearer ${token}` } },
      )
      assert.equal(search.status, 200)
      const searchBody = (await search.json()) as {
        data: { groups: Array<{ site: { siteId: string }; books: unknown[]; error: string | null }> }
      }
      const group = searchBody.data.groups[0]!
      assert.equal(group.error, null)
      assert.equal(group.books.length, 1, 'the retried query succeeds after recovery')
      assert.equal(mock.refreshes(), 1, 'refresh attempted exactly once')
      assert.equal(mock.logins(), 2, 'password fallback runs exactly once')
      assert.ok(mock.accountQueries() >= 2)

      // The recovered session stays signed in.
      const status = await fetch(`${server.adminBase}/sources/komiic/account`, { headers: admin })
      const statusBody = (await status.json()) as { data: { state: { phase: string } | null } }
      assert.equal(statusBody.data.state?.phase, 'signed_in')
    } finally {
      await mock.close()
      await server.stop()
    }
  })

  test('rate-limited login is retryable and does not loop', async () => {
    const { harness, mock } = await startHarness(0)
    const { server, cookie, csrf, token } = harness
    const admin = { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }
    try {
      mock.setLoginBehavior('rate-limited')
      const save = await fetch(`${server.adminBase}/sources/komiic/account`, {
        method: 'PUT',
        headers: admin,
        body: JSON.stringify({ username: 'user@example.com', password: 'test-password', autoLogin: true }),
      })
      const body = (await save.json()) as { data: { state: { phase: string; message: string } } }
      assert.equal(body.data.state.phase, 'error')
      assert.ok(body.data.state.message.includes('过于频繁'))
      assert.equal(mock.logins(), 1)

      // Automatic requests honor the backoff: the search becomes an error
      // group without a new upstream login attempt.
      const search = await fetch(
        `${server.baseUrl}/api/v1/comics/search?q=${encodeURIComponent('葬送')}&sourceId=komiic`,
        { headers: { authorization: `Bearer ${token}` } },
      )
      assert.equal(search.status, 200)
      const searchBody = (await search.json()) as {
        data: { groups: Array<{ books: unknown[]; error: string | null }> }
      }
      assert.equal(searchBody.data.groups[0]!.books.length, 0)
      assert.ok(searchBody.data.groups[0]!.error?.includes('过于频繁'))
      assert.equal(mock.logins(), 1, 'backoff prevents automatic upstream hammering')

      // An explicit manual login is allowed (matches the client) but hits the
      // rate limit again; it must not loop either.
      const login = await fetch(`${server.adminBase}/sources/komiic/login`, {
        method: 'POST',
        headers: admin,
      })
      const loginBody = (await login.json()) as { error?: { code: string; retryable: boolean } }
      assert.equal(loginBody.error?.code, 'ACCOUNT_LOGIN_FAILED')
      assert.equal(loginBody.error?.retryable, true)
      assert.equal(mock.logins(), 2, 'explicit retry reaches upstream exactly once')
    } finally {
      await mock.close()
      await server.stop()
    }
  })

})
