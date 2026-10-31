/**
 * API behavior tests that go deeper than the OpenAPI contract checks: the
 * directory update-check job result payload (chapter counts + new-chapter
 * deltas) and bounded-cache eviction under a size cap. Offline against the
 * shared komiic mock.
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, waitFor, type TestServer } from './helpers'
import { KOMIIC_DETAIL_URL, startKomiicMock, type KomiicMock } from './mocks/komiic'

interface Harness {
  server: TestServer
  mock: KomiicMock
  token: string
  cookie: string
  csrf: string
  comicId: string
}

const startHarness = async (mode = 0): Promise<Harness> => {
  const mock = await startKomiicMock(mode)
  const server = await startTestServer()
  const { cookie, csrf } = await server.setupAdmin()
  const update = await fetch(`${server.adminBase}/sources/komiic`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
    body: JSON.stringify({ config: { baseUrl: mock.base } }),
  })
  assert.equal(update.status, 200)
  const token = await server.createDeviceToken('api-device', cookie, csrf)
  const resolveResponse = await fetch(`${server.baseUrl}/api/v1/comics/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      comics: [{ provider: 'komiic', siteId: 'komiic', detailUrl: KOMIIC_DETAIL_URL }],
    }),
  })
  const resolved = (await resolveResponse.json()) as { data: { comics: Array<{ comicId: string }> } }
  return { server, mock, token, cookie, csrf, comicId: resolved.data.comics[0]!.comicId }
}

describe('api behavior (offline mock)', () => {
  test('updates/check reports chapter counts and new-chapter deltas', async () => {
    const { server, mock, token } = await startHarness(0)
    const auth = { authorization: `Bearer ${token}` }
    try {
      const accepted = await fetch(`${server.baseUrl}/api/v1/comics/updates/check`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({
          entries: [
            // Delta from a known chapter count: 5 - 2 = 3 new.
            { provider: 'komiic', siteId: 'komiic', detailUrl: KOMIIC_DETAIL_URL, knownChapterCount: 2 },
            // Delta from a known last chapter key: 5 - index('3') - 1 = 2 new.
            {
              provider: 'komiic',
              siteId: 'komiic',
              detailUrl: KOMIIC_DETAIL_URL,
              knownLastChapterKey: '3',
            },
          ],
        }),
      })
      assert.equal(accepted.status, 202)
      const acceptedBody = (await accepted.json()) as { data: { jobId: string } }
      const jobId = acceptedBody.data.jobId

      let job: {
        status: string
        total: number
        completed: number
        results?: Array<{
          comicId: string
          status: string
          chapterCount?: number
          newChapters?: number
          latestChapterKey?: string
        }>
      } = { status: '', total: 0, completed: 0 }
      await waitFor(async () => {
        const response = await fetch(`${server.baseUrl}/api/v1/jobs/${jobId}`, { headers: auth })
        job = ((await response.json()) as { data: typeof job }).data
        return ['done', 'partial', 'failed'].includes(job.status)
      }, 15_000)

      assert.equal(job.status, 'done')
      assert.equal(job.total, 2)
      assert.equal(job.completed, 2)
      const results = job.results ?? []
      assert.equal(results.length, 2)
      for (const result of results) {
        assert.equal(result.status, 'ok')
        assert.equal(result.chapterCount, 5, 'komiic mock dedupes to 5 chapters')
        assert.equal(result.latestChapterKey, '5')
      }
      const deltas = results.map((r) => r.newChapters).sort()
      assert.deepEqual(deltas, [2, 3], 'both delta strategies computed')
    } finally {
      await mock.close()
      await server.stop()
    }
  })

  test('cache cap evicts entries and forces a refetch', async () => {
    const { server, mock, token, cookie, csrf, comicId } = await startHarness(0)
    const auth = { authorization: `Bearer ${token}` }
    const admin = { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf }
    try {
      // Warm the cache with one page image.
      const pages = await fetch(
        `${server.baseUrl}/api/v1/comics/${comicId}/chapters/1/pages`,
        { headers: auth },
      )
      const pageData = (await pages.json()) as { data: { pages: Array<{ assetId: string }> } }
      const assetId = pageData.data.pages[0]!.assetId

      const warm = await fetch(`${server.baseUrl}/api/v1/assets/${assetId}`, { headers: auth })
      assert.equal(warm.status, 200)
      await warm.arrayBuffer()

      const beforeResponse = await fetch(`${server.adminBase}/cache`, { headers: { cookie } })
      const before = (await beforeResponse.json()) as {
        data: { stats: { entries: number; bytes: number } }
      }
      assert.ok(before.data.stats.entries >= 1, 'cache warmed')
      assert.ok(before.data.stats.bytes > 0)

      // Shrink the cap; updateSettings awaits enforceCap so eviction is done
      // by the time the PUT returns.
      const shrink = await fetch(`${server.adminBase}/cache`, {
        method: 'PUT',
        headers: admin,
        body: JSON.stringify({ maxBytes: 10 }),
      })
      assert.equal(shrink.status, 200)

      const afterResponse = await fetch(`${server.adminBase}/cache`, { headers: { cookie } })
      const after = (await afterResponse.json()) as {
        data: { stats: { entries: number; bytes: number } }
      }
      assert.equal(after.data.stats.entries, 0, 'entries evicted under the cap')
      assert.ok(after.data.stats.bytes <= 10)

      // The evicted asset must be fetched from upstream again.
      const refetch = await fetch(`${server.baseUrl}/api/v1/assets/${assetId}`, { headers: auth })
      assert.equal(refetch.status, 200)
      assert.equal(refetch.headers.get('x-cache'), 'MISS')
      await refetch.arrayBuffer()
    } finally {
      await mock.close()
      await server.stop()
    }
  })
})
