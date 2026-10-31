/**
 * Contract tests: every live JSON response is validated against
 * contracts/openapi.yaml (OpenAPI 3.1 / JSON Schema 2020-12) with Ajv.
 * Offline: komiic points at the local mock upstream.
 */
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import Ajv2020 from 'ajv/dist/2020'
import type { ValidateFunction } from 'ajv'
import addFormats from 'ajv-formats'
import { parse as parseYaml } from 'yaml'
import { SERVER_DIR, startTestServer, waitFor, type TestServer } from './helpers'
import { KOMIIC_DETAIL_URL, startKomiicMock, type KomiicMock } from './mocks/komiic'

// ---------------------------------------------------------------------------
// Spec loading + validation helpers
// ---------------------------------------------------------------------------

const spec = parseYaml(
  fs.readFileSync(path.join(SERVER_DIR, '..', 'contracts', 'openapi.yaml'), 'utf8'),
) as Record<string, unknown>

const ajv = new Ajv2020({ strict: false, allErrors: true })
addFormats(ajv)
ajv.addSchema(spec, 'spec')

const esc = (segment: string): string => segment.replaceAll('~', '~0').replaceAll('/', '~1')

/** Resolve a raw (unescaped) JSON pointer inside the parsed spec document. */
const resolveRaw = (root: unknown, pointer: string): unknown => {
  let node: unknown = root
  for (const segment of pointer.split('/').filter(Boolean)) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[segment]
    if (node === undefined) return undefined
  }
  return node
}

const toFragment = (pointer: string): string =>
  pointer
    .split('/')
    .filter(Boolean)
    .map(esc)
    .join('/')

/**
 * Build the Ajv reference for a response's JSON schema, following OpenAPI
 * response-level `$ref`s (e.g. `#/components/responses/ErrorEnvelope`).
 */
const schemaRef = (method: string, routePath: string, status: number | string): string => {
  const paths = resolveRaw(spec, '/paths') as
    | Record<string, Record<string, { responses?: Record<string, unknown> }>>
    | undefined
  const response = paths?.[routePath]?.[method.toLowerCase()]?.responses?.[String(status)] as
    | Record<string, unknown>
    | undefined
  assert.ok(response, `openapi.yaml has no response for ${method} ${routePath} ${status}`)
  if (typeof response.$ref === 'string' && response.$ref.startsWith('#')) {
    return `spec#/${toFragment(response.$ref.slice(1))}/content/application~1json/schema`
  }
  return `spec#/paths/${esc(routePath)}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`
}

const validate = (
  method: string,
  routePath: string,
  status: number | string,
  body: unknown,
): void => {
  const ref = schemaRef(method, routePath, status)
  const fn: ValidateFunction | undefined = ajv.getSchema(ref)
  assert.ok(fn, `openapi.yaml has no JSON response schema for ${method} ${routePath} ${status}`)
  assert.ok(fn(body), `${method} ${routePath} ${status} violates the contract: ${ajv.errorsText(fn.errors)}`)
}

/** Fetch + status assert + contract validation; returns the parsed envelope. */
const expectJson = async (
  url: string,
  status: number,
  method: string,
  routePath: string,
  init?: RequestInit,
): Promise<Record<string, unknown>> => {
  const response = await fetch(url, init)
  const body = (await response.json()) as Record<string, unknown>
  assert.equal(
    response.status,
    status,
    `${method} ${url} → ${response.status}: ${JSON.stringify(body)}`,
  )
  validate(method, routePath, status, body)
  return body
}

// ---------------------------------------------------------------------------
// Shared state (tests run sequentially inside the describe block)
// ---------------------------------------------------------------------------

let server: TestServer
let mock: KomiicMock

let cookie = ''
let csrf = ''
let token = ''
const auth = (): Record<string, string> => ({ authorization: `Bearer ${token}` })
const admin = (): Record<string, string> => ({
  'content-type': 'application/json',
  cookie,
  'x-csrf-token': csrf,
})

let comicId = ''
let assetId = ''
let pageUrl = ''

const extractCookie = (response: Response): string =>
  (response.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0])
    .filter(Boolean)
    .join('; ')

describe('openapi contract', () => {
  before(async () => {
    mock = await startKomiicMock(0)
    server = await startTestServer()
  })

  after(async () => {
    await mock.close()
    await server.stop()
  })

  test('healthz and anonymous session', async () => {
    await expectJson(`${server.adminBase}/healthz`, 200, 'GET', '/api/admin/v1/healthz')
    const session = await expectJson(
      `${server.adminBase}/session`,
      200,
      'GET',
      '/api/admin/v1/session',
    )
    const data = session.data as { initialized: boolean; session: unknown }
    assert.equal(data.initialized, false)
    assert.equal(data.session, null)
  })

  test('setup, duplicate setup conflict and login', async () => {
    const setupResponse = await fetch(`${server.adminBase}/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'contract-password-1' }),
    })
    const setupBody = (await setupResponse.json()) as {
      data: { session: { csrfToken: string } }
    }
    assert.equal(setupResponse.status, 200)
    validate('POST', '/api/admin/v1/setup', 200, setupBody)
    cookie = extractCookie(setupResponse)
    csrf = setupBody.data.session.csrfToken
    assert.ok(cookie.includes('pordo_admin='))

    // One-time initialization: a second setup must conflict.
    await expectJson(
      `${server.adminBase}/setup`,
      409,
      'POST',
      '/api/admin/v1/setup',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin2', password: 'contract-password-2' }),
      },
    )

    const login = await expectJson(
      `${server.adminBase}/login`,
      200,
      'POST',
      '/api/admin/v1/login',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'contract-password-1' }),
      },
    )
    const session = login.data as { session: { csrfToken: string } }
    assert.ok(session.session.csrfToken)

    // Wrong password → 401 error envelope.
    await expectJson(
      `${server.adminBase}/login`,
      401,
      'POST',
      '/api/admin/v1/login',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'wrong-password' }),
      },
    )
  })

  test('admin source config: list, update and device token creation', async () => {
    await expectJson(`${server.adminBase}/sources`, 200, 'GET', '/api/admin/v1/sources', {
      headers: { cookie },
    })

    const updated = await expectJson(
      `${server.adminBase}/sources/komiic`,
      200,
      'PUT',
      '/api/admin/v1/sources/{id}',
      {
        method: 'PUT',
        headers: admin(),
        body: JSON.stringify({ config: { baseUrl: mock.base } }),
      },
    )
    const source = updated.data as { source: { config: { baseUrl?: string } } }
    assert.equal(source.source.config.baseUrl, mock.base)

    const created = await expectJson(
      `${server.adminBase}/tokens`,
      200,
      'POST',
      '/api/admin/v1/tokens',
      {
        method: 'POST',
        headers: admin(),
        body: JSON.stringify({ name: 'contract-device' }),
      },
    )
    const createdToken = created.data as { token: string }
    assert.match(createdToken.token, /^pt_/)
    token = createdToken.token
  })

  test('content: sources, resolve, search, detail, chapters, pages', async () => {
    const sources = await expectJson(
      `${server.baseUrl}/api/v1/sources`,
      200,
      'GET',
      '/api/v1/sources',
      { headers: auth() },
    )
    const list = sources.data as { sources: Array<{ id: string }> }
    assert.ok(list.sources.some((s) => s.id === 'komiic'))

    const resolved = await expectJson(
      `${server.baseUrl}/api/v1/comics/resolve`,
      200,
      'POST',
      '/api/v1/comics/resolve',
      {
        method: 'POST',
        headers: { ...auth(), 'content-type': 'application/json' },
        body: JSON.stringify({
          comics: [{ provider: 'komiic', siteId: 'komiic', detailUrl: KOMIIC_DETAIL_URL }],
        }),
      },
    )
    const comics = resolved.data as { comics: Array<{ comicId: string; coverUrl: string }> }
    comicId = comics.comics[0]!.comicId
    assert.match(comicId, /^[0-9a-f]{64}$/)

    const search = await expectJson(
      `${server.baseUrl}/api/v1/comics/search?q=${encodeURIComponent('葬送')}&sourceId=komiic`,
      200,
      'GET',
      '/api/v1/comics/search',
      { headers: auth() },
    )
    const groups = search.data as {
      groups: Array<{ books: Array<{ comicId: string }> }>
    }
    assert.equal(groups.groups[0]!.books[0]!.comicId, comicId)

    await expectJson(
      `${server.baseUrl}/api/v1/comics/${comicId}`,
      200,
      'GET',
      '/api/v1/comics/{comicId}',
      { headers: auth() },
    )
    await expectJson(
      `${server.baseUrl}/api/v1/comics/${comicId}/chapters`,
      200,
      'GET',
      '/api/v1/comics/{comicId}/chapters',
      { headers: auth() },
    )

    const pages = await expectJson(
      `${server.baseUrl}/api/v1/comics/${comicId}/chapters/1/pages`,
      200,
      'GET',
      '/api/v1/comics/{comicId}/chapters/{chapterKey}/pages',
      { headers: auth() },
    )
    const pageData = pages.data as {
      pages: Array<{ url: string; assetId: string }>
    }
    pageUrl = pageData.pages[0]!.url
    assetId = pageData.pages[0]!.assetId
    // Identity urls stay upstream-original (never /api/v1/assets proxy URLs);
    // with the mocked baseUrl they point at the mock's /api/image/{kid}.
    assert.ok(pageUrl.includes('/api/image/'), `unexpected page url: ${pageUrl}`)
    assert.ok(!pageUrl.includes('/api/v1/assets/'), 'page urls must not be proxy urls')
    assert.ok(!pageUrl.includes(server.baseUrl), 'page urls must not point at this service')
  })

  test('assets: prepare, binary streaming and X-Cache', async () => {
    const prepared = await expectJson(
      `${server.baseUrl}/api/v1/assets/prepare`,
      200,
      'POST',
      '/api/v1/assets/prepare',
      {
        method: 'POST',
        headers: { ...auth(), 'content-type': 'application/json' },
        body: JSON.stringify({
          items: [{ provider: 'komiic', siteId: 'komiic', url: pageUrl }],
        }),
      },
    )
    const assets = prepared.data as { assets: Array<{ assetId: string }> }
    assert.equal(assets.assets[0]!.assetId, assetId, 'asset ids are deterministic')

    const first = await fetch(`${server.baseUrl}/api/v1/assets/${assetId}`, {
      headers: auth(),
    })
    assert.equal(first.status, 200)
    assert.ok(!first.headers.get('content-type')?.includes('application/json'))
    assert.ok(['HIT', 'MISS'].includes(first.headers.get('x-cache') ?? ''))
    const bytes = Buffer.from(await first.arrayBuffer())
    assert.ok(bytes.length > 0)

    const second = await fetch(`${server.baseUrl}/api/v1/assets/${assetId}`, {
      headers: auth(),
    })
    assert.equal(second.status, 200)
    assert.equal(second.headers.get('x-cache'), 'HIT')
    await second.arrayBuffer()
  })

  test('updates: job accepted (202) and job view', async () => {
    const accepted = await expectJson(
      `${server.baseUrl}/api/v1/comics/updates/check`,
      202,
      'POST',
      '/api/v1/comics/updates/check',
      {
        method: 'POST',
        headers: { ...auth(), 'content-type': 'application/json' },
        body: JSON.stringify({
          entries: [
            {
              provider: 'komiic',
              siteId: 'komiic',
              detailUrl: KOMIIC_DETAIL_URL,
              knownChapterCount: 0,
            },
          ],
        }),
      },
    )
    const { jobId } = accepted.data as { jobId: string }
    let lastStatus = ''
    await waitFor(async () => {
      const response = await fetch(`${server.baseUrl}/api/v1/jobs/${jobId}`, {
        headers: auth(),
      })
      const body = (await response.json()) as { data: { status: string } }
      lastStatus = body.data.status
      return ['done', 'partial', 'failed'].includes(lastStatus)
    }, 15_000)
    await expectJson(
      `${server.baseUrl}/api/v1/jobs/${jobId}`,
      200,
      'GET',
      '/api/v1/jobs/{jobId}',
      { headers: auth() },
    )
    assert.notEqual(lastStatus, 'failed')
  })

  test('admin account views and login probe', async () => {
    await expectJson(
      `${server.adminBase}/sources/komiic/account`,
      200,
      'GET',
      '/api/admin/v1/sources/{id}/account',
      { headers: admin() },
    )

    const saved = await expectJson(
      `${server.adminBase}/sources/komiic/account`,
      200,
      'PUT',
      '/api/admin/v1/sources/{id}/account',
      {
        method: 'PUT',
        headers: admin(),
        body: JSON.stringify({
          username: 'user@example.com',
          password: 'test-password',
          autoLogin: true,
        }),
      },
    )
    assert.ok(!JSON.stringify(saved).includes('test-password'), 'passwords never echoed')

    await expectJson(
      `${server.adminBase}/sources/komiic/login`,
      200,
      'POST',
      '/api/admin/v1/sources/{id}/login',
      { method: 'POST', headers: admin() },
    )
  })

  test('admin probes: search, detail, pages and admin asset stream', async () => {
    await expectJson(
      `${server.adminBase}/test/search`,
      200,
      'POST',
      '/api/admin/v1/test/search',
      {
        method: 'POST',
        headers: admin(),
        body: JSON.stringify({ sourceId: 'komiic', q: '葬送' }),
      },
    )
    await expectJson(
      `${server.adminBase}/test/detail`,
      200,
      'POST',
      '/api/admin/v1/test/detail',
      {
        method: 'POST',
        headers: admin(),
        body: JSON.stringify({
          provider: 'komiic',
          siteId: 'komiic',
          detailUrl: KOMIIC_DETAIL_URL,
        }),
      },
    )
    await expectJson(
      `${server.adminBase}/test/pages`,
      200,
      'POST',
      '/api/admin/v1/test/pages',
      {
        method: 'POST',
        headers: admin(),
        body: JSON.stringify({ comicId, chapterKey: '1' }),
      },
    )

    const stream = await fetch(`${server.adminBase}/assets/${assetId}`, {
      headers: { cookie },
    })
    assert.equal(stream.status, 200)
    assert.ok(['HIT', 'MISS'].includes(stream.headers.get('x-cache') ?? ''))
    await stream.arrayBuffer()
  })

  test('admin ops: overview, jobs, logs and cache', async () => {
    await expectJson(`${server.adminBase}/overview`, 200, 'GET', '/api/admin/v1/overview', {
      headers: { cookie },
    })
    await expectJson(`${server.adminBase}/jobs?limit=10`, 200, 'GET', '/api/admin/v1/jobs', {
      headers: { cookie },
    })
    await expectJson(`${server.adminBase}/logs?limit=20`, 200, 'GET', '/api/admin/v1/logs', {
      headers: { cookie },
    })
    await expectJson(
      `${server.adminBase}/logs?kind=upstream&limit=20`,
      200,
      'GET',
      '/api/admin/v1/logs',
      { headers: { cookie } },
    )
    await expectJson(`${server.adminBase}/cache`, 200, 'GET', '/api/admin/v1/cache', {
      headers: { cookie },
    })
    await expectJson(`${server.adminBase}/cache`, 200, 'PUT', '/api/admin/v1/cache', {
      method: 'PUT',
      headers: admin(),
      body: JSON.stringify({ ttlSeconds: 120 }),
    })
    await expectJson(
      `${server.adminBase}/cache/clear`,
      200,
      'POST',
      '/api/admin/v1/cache/clear',
      {
        method: 'POST',
        headers: admin(),
        body: JSON.stringify({}),
      },
    )
  })

  test('token lifecycle: list, revoke, delete', async () => {
    const listed = await expectJson(
      `${server.adminBase}/tokens`,
      200,
      'GET',
      '/api/admin/v1/tokens',
      { headers: { cookie } },
    )
    const tokens = listed.data as { tokens: Array<{ id: string }> }
    assert.ok(tokens.tokens.length >= 1)

    const second = await expectJson(
      `${server.adminBase}/tokens`,
      200,
      'POST',
      '/api/admin/v1/tokens',
      {
        method: 'POST',
        headers: admin(),
        body: JSON.stringify({ name: 'contract-temp' }),
      },
    )
    const secondToken = second.data as { id: string; token: string }

    await expectJson(
      `${server.adminBase}/tokens/${secondToken.id}/revoke`,
      200,
      'POST',
      '/api/admin/v1/tokens/{id}/revoke',
      { method: 'POST', headers: admin() },
    )
    // Revoked tokens are rejected immediately.
    const revokedUse = await fetch(`${server.baseUrl}/api/v1/sources`, {
      headers: { authorization: `Bearer ${secondToken.token}` },
    })
    assert.equal(revokedUse.status, 401)
    validate('GET', '/api/v1/sources', 401, await revokedUse.json())

    await expectJson(
      `${server.adminBase}/tokens/${secondToken.id}`,
      200,
      'DELETE',
      '/api/admin/v1/tokens/{id}',
      { method: 'DELETE', headers: admin() },
    )
  })

  test('error envelopes: auth, CSRF, not-found, bad-request, asset-invalid', async () => {
    // Missing bearer token.
    await expectJson(
      `${server.baseUrl}/api/v1/comics/search?q=x`,
      401,
      'GET',
      '/api/v1/comics/search',
    )
    // Bad request: empty query.
    await expectJson(
      `${server.baseUrl}/api/v1/comics/search?q=`,
      400,
      'GET',
      '/api/v1/comics/search',
      { headers: auth() },
    )
    // Unknown comic identity.
    await expectJson(
      `${server.baseUrl}/api/v1/comics/${'0'.repeat(64)}`,
      404,
      'GET',
      '/api/v1/comics/{comicId}',
      { headers: auth() },
    )
    // Tampered asset id.
    await expectJson(
      `${server.baseUrl}/api/v1/assets/eyJwIjoia29taWljIn0.bogus`,
      403,
      'GET',
      '/api/v1/assets/{assetId}',
      { headers: auth() },
    )
    // Admin API without CSRF header.
    await expectJson(`${server.adminBase}/cache`, 403, 'PUT', '/api/admin/v1/cache', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ ttlSeconds: 120 }),
    })
    // Device tokens cannot call admin APIs.
    await expectJson(`${server.adminBase}/overview`, 401, 'GET', '/api/admin/v1/overview', {
      headers: auth(),
    })
  })

  test('password change, logout and signed-out session', async () => {
    await expectJson(
      `${server.adminBase}/password`,
      200,
      'POST',
      '/api/admin/v1/password',
      {
        method: 'POST',
        headers: admin(),
        body: JSON.stringify({
          currentPassword: 'contract-password-1',
          newPassword: 'contract-password-3',
        }),
      },
    )
    // Old password no longer works.
    await expectJson(
      `${server.adminBase}/login`,
      401,
      'POST',
      '/api/admin/v1/login',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'contract-password-1' }),
      },
    )
    // The password change invalidated every session; log in again with the
    // new password and use the fresh session for logout.
    const loginResponse = await fetch(`${server.adminBase}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'contract-password-3' }),
    })
    const loginBody = (await loginResponse.json()) as {
      data: { session: { csrfToken: string } }
    }
    assert.equal(loginResponse.status, 200)
    validate('POST', '/api/admin/v1/login', 200, loginBody)
    const freshCookie = extractCookie(loginResponse)
    const freshCsrf = loginBody.data.session.csrfToken

    await expectJson(
      `${server.adminBase}/logout`,
      200,
      'POST',
      '/api/admin/v1/logout',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: freshCookie, 'x-csrf-token': freshCsrf },
      },
    )
    const session = await expectJson(
      `${server.adminBase}/session`,
      200,
      'GET',
      '/api/admin/v1/session',
    )
    assert.equal((session.data as { session: unknown }).session, null)
  })
})
