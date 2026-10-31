import test from 'node:test'
import assert from 'node:assert/strict'
import { startMock, startTestServer, sha256 } from './helpers'
import { startKomiicMock, KOMIIC_DETAIL_URL } from './mocks/komiic'
import { startMangayunMock, DETAIL_URL, SITE_A } from './mocks/mangayun'

test('multiple devices resolve metadata without fetching or caching any image bytes', async () => {
  let calls = 0
  const upstream = await startMock((_req, res) => { calls += 1; res.end('image') })
  const server = await startTestServer()
  try {
    const { cookie, csrf } = await server.setupAdmin()
    const tokens = await Promise.all(['device-a', 'device-b'].map(name => server.createDeviceToken(name, cookie, csrf)))
    const url = `${upstream.base}/image.png`
    for (const token of tokens) {
      const response = await fetch(`${server.baseUrl}/api/v1/images/resolve`, { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'mangayun', siteId: 'site-a', url }) })
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.deepEqual((await response.json() as { data: unknown }).data, { url, headers: {}, expiresAt: null })
    }
    assert.equal(calls, 0, 'service never requests an image body')
    const fs = await import('node:fs')
    assert.equal(fs.existsSync(`${server.dataDir}/image-cache`), false)
    const removed = await fetch(`${server.baseUrl}/api/v1/assets/old-id`, { headers: { authorization: `Bearer ${tokens[0]}` } })
    assert.equal(removed.status, 404)
  } finally { await upstream.close(); await server.stop() }
})

test('empty-provider legacy favorites retain their hash and original chapter URLs', async () => {
  const mock = await startMangayunMock()
  const server = await startTestServer()
  try {
    const { cookie, csrf } = await server.setupAdmin()
    await fetch(`${server.adminBase}/sources/mangayun`, { method: 'PUT', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ config: { baseUrl: mock.base } }) })
    const token = await server.createDeviceToken('legacy-device', cookie, csrf)
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const sites = await fetch(`${server.baseUrl}/api/v1/sources/mangayun/sites`, { headers: auth })
    assert.equal(sites.status, 200)
    assert.ok(((await sites.json()) as { data: { sites: unknown[] } }).data.sites.length >= 1)
    const resolved = await fetch(`${server.baseUrl}/api/v1/comics/resolve`, { method: 'POST', headers: auth, body: JSON.stringify({ comics: [{ provider: '', siteId: SITE_A, detailUrl: DETAIL_URL }] }) })
    assert.equal(resolved.status, 200)
    const id = ((await resolved.json()) as { data: { comics: Array<{ comicId: string }> } }).data.comics[0]!.comicId
    assert.equal(id, sha256(`\0${SITE_A}\0${DETAIL_URL}`))
    const response = await fetch(`${server.baseUrl}/api/v1/comics/${id}`, { headers: auth })
    assert.equal(response.status, 200)
    const detail = (await response.json()) as { data: { comic: { comicId: string; provider: string }; chapters: Array<{ url: string; key: string }> } }
    assert.equal(detail.data.comic.comicId, id)
    assert.equal(detail.data.comic.provider, '')
    assert.equal(detail.data.chapters[0]!.url, 'https://site-a.example/ch/1')
  } finally { await mock.close(); await server.stop() }
})

test('Komiic baseUrl overrides never change an existing comic identity', async () => {
  const mock = await startKomiicMock(0)
  const server = await startTestServer()
  try {
    const { cookie, csrf } = await server.setupAdmin()
    await fetch(`${server.adminBase}/sources/komiic`, { method: 'PUT', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ config: { baseUrl: mock.base } }) })
    const token = await server.createDeviceToken('legacy-komiic', cookie, csrf)
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const id = sha256(`komiic\0komiic\0${KOMIIC_DETAIL_URL}`)
    const resolved = await fetch(`${server.baseUrl}/api/v1/comics/resolve`, { method: 'POST', headers: auth, body: JSON.stringify({ comics: [{ provider: 'komiic', siteId: 'komiic', detailUrl: KOMIIC_DETAIL_URL }] }) })
    assert.equal(resolved.status, 200)
    const response = await fetch(`${server.baseUrl}/api/v1/comics/${id}`, { headers: auth })
    assert.equal(response.status, 200)
    const detail = (await response.json()) as { data: { comic: { comicId: string; detailUrl: string } } }
    assert.equal(detail.data.comic.comicId, id)
    assert.equal(detail.data.comic.detailUrl, KOMIIC_DETAIL_URL)
  } finally { await mock.close(); await server.stop() }
})
