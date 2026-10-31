/**
 * MangaYun provider behavior tests, migrated from the MangaYun implementation
 * in crates/pordo-core/src/comics/source.rs. Covers the public web-client
 * signing protocol (GET and POST), multi-site search grouping, detail
 * dedupe/sort, chapter-image page identity, direct vs relay image fetching,
 * and the DM5 fallback delegation — all offline against a local mock.
 */
import 'reflect-metadata'
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { sha256, startTestServer, type TestServer } from './helpers'
import { MangaYunProvider } from '../src/modules/providers/mangayun'
import {
  DETAIL_URL,
  SITE_A,
  startMangayunMock,
  type MangaYunMock,
} from './mocks/mangayun'

const bookKey = (provider: string, siteId: string, detailUrl: string): string =>
  sha256(`${provider}\u0000${siteId}\u0000${detailUrl}`)

interface Harness {
  server: TestServer
  mock: MangaYunMock
  token: string
  cookie: string
  csrf: string
}

const startHarness = async (
  opts: { directMode?: 'ok' | 'missing' } = {},
): Promise<Harness> => {
  const mock = await startMangayunMock(opts)
  const server = await startTestServer()
  const { cookie, csrf } = await server.setupAdmin()
  const update = await fetch(`${server.adminBase}/sources/mangayun`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
    body: JSON.stringify({ config: { baseUrl: mock.base } }),
  })
  assert.equal(update.status, 200)
  const token = await server.createDeviceToken('test-device', cookie, csrf)
  return { server, mock, token, cookie, csrf }
}

const resolveComic = async (
  server: TestServer,
  token: string,
  siteId: string,
  detailUrl: string,
): Promise<string> => {
  const response = await fetch(`${server.baseUrl}/api/v1/comics/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      comics: [{ provider: 'mangayun', siteId, detailUrl, title: 'T' }],
    }),
  })
  assert.equal(response.status, 200)
  const body = (await response.json()) as { data: { comics: Array<{ comicId: string }> } }
  return body.data.comics[0]!.comicId
}

describe('mangayun provider (offline mock)', () => {
  test('sites() uses the signed GET protocol and parses the site list', async () => {
    const mock = await startMangayunMock()
    try {
      const provider = new MangaYunProvider()
      const sites = await provider.sites({
        sourceId: 'mangayun',
        contextId: '',
        timeoutMs: 65000,
        proxy: null,
        config: { baseUrl: mock.base },
      })
      assert.deepEqual(sites, [
        { siteId: SITE_A, siteName: 'Site A' },
        { siteId: 'dm5', siteName: 'DM5' },
      ])
      assert.equal(mock.signFailures(), 0, 'GET signature accepted')
    } finally {
      await mock.close()
    }
  })

  test('search signs POST, groups by qualified site id, and preserves identity', async () => {
    const { server, mock, token } = await startHarness()
    const auth = { authorization: `Bearer ${token}` }
    try {
      const response = await fetch(
        `${server.baseUrl}/api/v1/comics/search?q=${encodeURIComponent('漫画')}&sourceId=mangayun`,
        { headers: auth },
      )
      assert.equal(response.status, 200)
      const search = (await response.json()) as {
        data: {
          groups: Array<{
            site: { siteId: string; siteName: string; provider: string }
            books: Array<{ comicId: string; title: string; detailUrl: string }>
          }>
        }
      }
      const group = search.data.groups[0]!
      // Qualified like the client: provider:siteId.
      assert.equal(group.site.siteId, `mangayun:${SITE_A}`)
      assert.equal(group.site.provider, 'mangayun')
      const book = group.books[0]!
      assert.equal(book.title, '漫画A')
      // detailUrl is upstream-original identity, never a proxy address.
      assert.equal(book.detailUrl, DETAIL_URL)
      assert.equal(book.comicId, bookKey('mangayun', SITE_A, DETAIL_URL))
      assert.ok(book.coverUrl, 'cover remains a third-party URL')
      assert.equal(mock.signFailures(), 0, 'POST signature accepted')
      assert.equal(mock.searches(), 1)
    } finally {
      await mock.close()
      await server.stop()
    }
  })

  test('detail dedupes/sorts chapters; pages keep upstream identity; images resolve to direct URLs', async () => {
    const { server, mock, token } = await startHarness()
    const auth = { authorization: `Bearer ${token}` }
    try {
      const comicId = await resolveComic(server, token, SITE_A, DETAIL_URL)
      assert.equal(comicId, bookKey('mangayun', SITE_A, DETAIL_URL))

      // Detail: duplicate id removed, natural order restored.
      const detailResponse = await fetch(`${server.baseUrl}/api/v1/comics/${comicId}`, {
        headers: auth,
      })
      assert.equal(detailResponse.status, 200)
      const detail = (await detailResponse.json()) as {
        data: { comic: { title: string }; chapters: Array<{ id: string; order: number }> }
      }
      assert.equal(detail.data.comic.title, '漫画A 详情')
      assert.deepEqual(
        detail.data.chapters.map((c) => c.id),
        ['c1', 'c2'],
      )

      // Pages: identity URLs are the upstream-original image addresses.
      const pagesResponse = await fetch(
        `${server.baseUrl}/api/v1/comics/${comicId}/chapters/c1/pages`,
        { headers: auth },
      )
      assert.equal(pagesResponse.status, 200)
      const pages = (await pagesResponse.json()) as {
        data: { pages: Array<{ index: number; url: string }> }
      }
      assert.equal(pages.data.pages.length, 2)
      assert.equal(pages.data.pages[0]!.url, `${mock.base}/direct/p1.jpg`)
      assert.ok(!pages.data.pages[0]!.url.includes('/api/image'), 'not a proxy url')

      const response = await fetch(`${server.baseUrl}/api/v1/images/resolve`, {
        method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'mangayun', siteId: SITE_A, url: pages.data.pages[0]!.url }),
      })
      assert.equal(response.status, 200)
      const access = (await response.json() as { data: { url: string; headers: Record<string,string> } }).data
      assert.equal(access.url, `${mock.base}/direct/p1.jpg`)
      assert.equal(mock.directHits(), 0, 'service does not download or probe images')
      const downloaded = await fetch(access.url, { headers: access.headers })
      assert.equal(downloaded.status, 200)
      assert.ok((await downloaded.arrayBuffer()).byteLength > 0)
      assert.equal(mock.relayHits(), 0)
      assert.equal(mock.signFailures(), 0)
    } finally {
      await mock.close()
      await server.stop()
    }
  })

  test('unavailable image URLs are returned without server probing or relay fallback', async () => {
    const { server, mock, token } = await startHarness({ directMode: 'missing' })
    try {
      const url = `${mock.base}/missing/p1.jpg`
      const response = await fetch(`${server.baseUrl}/api/v1/images/resolve`, { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'mangayun', siteId: SITE_A, url }) })
      assert.equal(response.status, 200)
      assert.equal((await response.json() as { data: { url: string } }).data.url, url)
      assert.equal(mock.directHits(), 0)
      assert.equal(mock.relayHits(), 0)
    } finally { await mock.close(); await server.stop() }
  })

  test('comicbox pages are refused; dm5 site delegates to the DM5 fallback', async () => {
    const { server, mock, token } = await startHarness()
    const auth = { authorization: `Bearer ${token}` }
    try {
      // comicbox: reading not supported yet.
      const comicboxId = await resolveComic(
        server,
        token,
        'comicbox',
        'https://comicbox.example/b/1',
      )
      const comicboxPages = await fetch(
        `${server.baseUrl}/api/v1/comics/${comicboxId}/chapters/c1/pages`,
        { headers: auth },
      )
      assert.equal(comicboxPages.status, 400)
      const comicboxBody = (await comicboxPages.json()) as { error: { message: string } }
      assert.ok(comicboxBody.error.message.includes('暂不支持'))

      // dm5: chapter-images fails → fallback validates the chapter URL as DM5.
      const dm5Id = await resolveComic(server, token, 'dm5', 'https://dm5.example/b/1')
      const dm5Pages = await fetch(
        `${server.baseUrl}/api/v1/comics/${dm5Id}/chapters/c1/pages`,
        { headers: auth },
      )
      assert.equal(dm5Pages.status, 400)
      const dm5Body = (await dm5Pages.json()) as { error: { message: string } }
      assert.ok(
        dm5Body.error.message.includes('动漫屋'),
        `dm5 fallback reached: ${dm5Body.error.message}`,
      )
      assert.equal(mock.signFailures(), 0)
    } finally {
      await mock.close()
      await server.stop()
    }
  })
})
