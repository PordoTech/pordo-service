import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { startMock, startTestServer, sendJson, sha256 } from './helpers'
import { startKomiicMock, KOMIIC_DETAIL_URL } from './mocks/komiic'
import { startMangayunMock, DETAIL_URL, SITE_A } from './mocks/mangayun'

// A payload larger than stream highWaterMark catches accidental response-stream sharing.
test('concurrent devices receive complete independent image streams from one cache fill', async () => {
  let calls = 0
  const bytes = Buffer.alloc(256 * 1024, 57)
  const upstream = await startMock((_req, res) => {
    calls += 1
    res.writeHead(200, { 'content-type': 'image/png' })
    void (async () => {
      for (let i = 0; i < bytes.length; i += 8192) {
        if (res.destroyed) return
        res.write(bytes.subarray(i, i + 8192))
        await delay(2)
      }
      res.end()
    })()
  })
  const server = await startTestServer()
  try {
    const { cookie, csrf } = await server.setupAdmin()
    const tokens = await Promise.all(['device-a', 'device-b'].map(name => server.createDeviceToken(name, cookie, csrf)))
    const prepared = await fetch(`${server.baseUrl}/api/v1/assets/prepare`, { method: 'POST',
      headers: { authorization: `Bearer ${tokens[0]}`, 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ provider: 'mangayun', siteId: 'site-a', url: `${upstream.base}/image.png` }] }) })
    assert.equal(prepared.status, 200)
    const body = await prepared.json() as { data: { assets: Array<{ assetId: string }> } }
    const asset = body.data.assets[0]!.assetId
    const results = await Promise.all(Array.from({ length: 5 }, async (_, i) => {
      const response = await fetch(`${server.baseUrl}/api/v1/assets/${asset}`, { headers: { authorization: `Bearer ${tokens[i % 2]}` } })
      assert.equal(response.status, 200)
      return Buffer.from(await response.arrayBuffer())
    }))
    for (const result of results) assert.deepEqual(result, bytes)
    assert.equal(calls, 1, 'all consumers share the cache fill, not the response stream')
    // Closing the first response must not break another device's copy.
    const other = `${upstream.base}/cancelled-reader.png`
    const prepared2 = await fetch(`${server.baseUrl}/api/v1/assets/prepare`, { method: 'POST', headers: { authorization: `Bearer ${tokens[0]}`, 'content-type': 'application/json' }, body: JSON.stringify({ items: [{ provider: 'mangayun', siteId: 'site-a', url: other }] }) })
    const otherId = ((await prepared2.json()) as typeof body).data.assets[0]!.assetId
    const first = await fetch(`${server.baseUrl}/api/v1/assets/${otherId}`, { headers: { authorization: `Bearer ${tokens[0]}` } })
    await first.body!.cancel()
    const second = await fetch(`${server.baseUrl}/api/v1/assets/${otherId}`, { headers: { authorization: `Bearer ${tokens[1]}` } })
    assert.deepEqual(Buffer.from(await second.arrayBuffer()), bytes)
    assert.equal(calls, 2)
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
