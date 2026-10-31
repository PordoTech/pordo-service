/**
 * MangaYun mock upstream for offline behavior tests. Verifies the public
 * web-client signing protocol (x-ym-ts / x-ym-nonce / x-ym-sign over
 * `path|body|ts|nonce|salt`) on every JSON API call, and serves direct images
 * plus the /api/image relay so we can assert which path fetchImage chose.
 *
 * directMode:
 * - 'ok'      chapter images point at /direct/* (200) → fetchImage goes direct
 * - 'missing' chapter images point at /missing/* (404) → direct fails, relay used
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { imageBytes, readBody, sendJson, sha256, startMock, type MockHandle } from '../helpers'

// Protocol constant mirrored from the provider; a change there breaks the sign
// check here, which is exactly what we want the test to catch.
const YM_SALT = 'ym-salt-883a0f7e-29f1-4b72-9ad2'

export const SITE_A = 'site-a'
export const DETAIL_URL = 'https://site-a.example/book/1'

const SIGNED_PATHS = new Set(['/api/sites', '/api/search', '/api/details', '/api/chapter-images'])

export interface MangaYunMock extends MockHandle {
  relayHits: () => number
  directHits: () => number
  signFailures: () => number
  searches: () => number
  details: () => number
  chapterImages: () => number
}

export const startMangayunMock = (
  opts: { directMode?: 'ok' | 'missing'; image?: Buffer } = {},
): Promise<MangaYunMock> => {
  const directMode = opts.directMode ?? 'ok'
  let relayHits = 0
  let directHits = 0
  let signFailures = 0
  let searches = 0
  let details = 0
  let chapterImages = 0

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const host = req.headers.host ?? 'localhost'
    const origin = `http://${host}`
    const cover = `${origin}/direct/cover.jpg`

    // Unsigned binary endpoints (relay + direct CDN images).
    if (url.pathname === '/api/image') {
      relayHits += 1
      res.writeHead(200, { 'content-type': 'image/jpeg' })
      res.end(opts.image ?? imageBytes(relayHits))
      return
    }
    if (url.pathname.startsWith('/direct/')) {
      directHits += 1
      res.writeHead(200, { 'content-type': 'image/jpeg' })
      res.end(opts.image ?? imageBytes(directHits))
      return
    }
    if (url.pathname.startsWith('/missing/')) {
      res.writeHead(404)
      res.end()
      return
    }

    // Signed JSON API endpoints.
    if (SIGNED_PATHS.has(url.pathname)) {
      const ts = String(req.headers['x-ym-ts'] ?? '')
      const nonce = String(req.headers['x-ym-nonce'] ?? '')
      const gotSign = String(req.headers['x-ym-sign'] ?? '')
      const body = req.method === 'POST' ? await readBody(req) : ''
      // The provider signs `path|body|ts|nonce|salt` where path includes query.
      const expected = sha256(`${req.url ?? ''}|${body}|${ts}|${nonce}|${YM_SALT}`)
      if (gotSign !== expected || !ts || !nonce) {
        signFailures += 1
        sendJson(res, 401, { error: 'bad signature' })
        return
      }

      if (url.pathname === '/api/sites') {
        sendJson(res, 200, {
          data: [
            { siteId: SITE_A, siteName: 'Site A' },
            { siteId: 'dm5', siteName: 'DM5' },
          ],
        })
        return
      }
      if (url.pathname === '/api/search') {
        searches += 1
        const parsed = JSON.parse(body) as { keyword?: string }
        sendJson(res, 200, {
          data: [
            {
              siteId: SITE_A,
              siteName: 'Site A',
              results: [
                {
                  title: '漫画A',
                  detailUrl: DETAIL_URL,
                  author: '作者A',
                  description: '简介',
                  status: '连载中',
                  coverUrl: cover,
                  _kw: parsed.keyword,
                },
              ],
            },
          ],
        })
        return
      }
      if (url.pathname === '/api/details') {
        details += 1
        // Out of order + a duplicate id to exercise dedupe + natural sort.
        sendJson(res, 200, {
          data: {
            title: '漫画A 详情',
            author: '作者A',
            description: '简介',
            status: '连载中',
            coverUrl: cover,
            chapters: [
              { id: 'c2', name: '第2话', url: 'https://site-a.example/ch/2', order: 2, kind: 'chapter' },
              { id: 'c1', name: '第1话', url: 'https://site-a.example/ch/1', order: 1, kind: 'chapter' },
              { id: 'c1', name: '第1话 重复', url: 'https://site-a.example/ch/1', order: 9, kind: 'chapter' },
            ],
          },
        })
        return
      }
      if (url.pathname === '/api/chapter-images') {
        chapterImages += 1
        const parsed = JSON.parse(body) as { siteId?: string }
        if (parsed.siteId === 'dm5') {
          // Force the MangaYun DM5 fallback branch.
          sendJson(res, 500, { error: 'dm5 upstream down' })
          return
        }
        const images =
          directMode === 'missing'
            ? [`${origin}/missing/p1.jpg`]
            : [`${origin}/direct/p1.jpg`, `${origin}/direct/p2.jpg`]
        sendJson(res, 200, { data: { images } })
        return
      }
    }

    res.writeHead(404)
    res.end()
  }

  return startMock((req, res) => {
    void handler(req, res)
  }).then((handle) => ({
    ...handle,
    relayHits: () => relayHits,
    directHits: () => directHits,
    signFailures: () => signFailures,
    searches: () => searches,
    details: () => details,
    chapterImages: () => chapterImages,
  }))
}
