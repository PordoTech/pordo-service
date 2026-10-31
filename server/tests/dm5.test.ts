/**
 * DM5 fallback parser behavior tests, migrated from the client's
 * crates/pordo-core/src/comics/source/dm5.rs. The pure parsing helpers are
 * unit-tested directly; pages()/resolve() run against a local mock upstream so
 * everything stays offline. We never execute downloaded JavaScript: the
 * p.a.c.k.e.r. payload is decoded by symbol substitution only.
 */
import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { startMock } from './helpers'
import * as dm5 from '../src/modules/providers/dm5'

/** Chapter HTML carrying the reader variables pageEndpoints() depends on. */
const chapterHtml = (cid: string, count: number): string =>
  `<html><script>var DM5_IMAGE_COUNT=${count};var DM5_CID=${cid};var DM5_MID=999;` +
  `var DM5_VIEWSIGN_DT='1700000000';var DM5_VIEWSIGN='sgn';</script></html>`

describe('dm5 parser (offline)', () => {
  test('variable() extracts numbers/strings and unescapes them', () => {
    assert.equal(dm5.variable('var n=42;', 'n'), '42')
    assert.equal(dm5.variable('var s="hello";', 's'), 'hello')
    assert.equal(dm5.variable("var s='a\\nb';", 's'), 'a\nb')
    assert.throws(
      () => dm5.variable('var other=1;', 'missing'),
      (error: unknown) => {
        const e = error as { code?: string }
        return e.code === 'UPSTREAM_PROTOCOL'
      },
    )
  })

  test('unescapeJs() decodes escape sequences', () => {
    assert.equal(dm5.unescapeJs('a\\nb'), 'a\nb')
    assert.equal(dm5.unescapeJs('\\t'), '\t')
    assert.equal(dm5.unescapeJs('\\x41'), 'A')
    assert.equal(dm5.unescapeJs('\\u0041'), 'A')
    assert.equal(dm5.unescapeJs('\\\\'), '\\')
    assert.equal(dm5.unescapeJs('\\"'), '"')
  })

  test('isChapter()/isPage() only match real dm5 reader urls', () => {
    assert.equal(dm5.isChapter(new URL('http://www.dm5.com/m12345/')), true)
    assert.equal(dm5.isChapter(new URL('https://dm5.com/m7/')), true)
    assert.equal(dm5.isChapter(new URL('http://www.dm5.com/comic/12345')), false)
    assert.equal(dm5.isChapter(new URL('http://example.com/m12345/')), false)
    assert.equal(dm5.isPage(new URL('http://www.dm5.com/m12345/chapterfun.ashx?page=1')), true)
    assert.equal(dm5.isPage(new URL('http://www.dm5.com/m12345/')), false)
    assert.equal(dm5.isPage(new URL('http://example.com/m1/chapterfun.ashx')), false)
  })

  test('pageEndpoints() builds lazy per-page urls from chapter metadata', () => {
    const chapter = new URL('http://www.dm5.com/m12345/')
    const urls = dm5.pageEndpoints(chapterHtml('12345', 3), chapter)
    assert.equal(urls.length, 3)
    for (const [index, url] of urls.entries()) {
      const parsed = new URL(url)
      assert.equal(parsed.pathname, '/m12345/chapterfun.ashx')
      assert.equal(parsed.searchParams.get('page'), String(index + 1))
      assert.equal(parsed.searchParams.get('cid'), '12345')
      assert.equal(parsed.searchParams.get('_mid'), '999')
      assert.equal(parsed.searchParams.get('_dt'), '1700000000')
      assert.equal(parsed.searchParams.get('_sign'), 'sgn')
    }
  })

  test('pageEndpoints() rejects bad counts and chapter mismatches', () => {
    const chapter = new URL('http://www.dm5.com/m12345/')
    assert.throws(
      () => dm5.pageEndpoints(chapterHtml('12345', 0), chapter),
      (e: unknown) => (e as { code?: string }).code === 'NO_RESULTS',
    )
    assert.throws(
      () => dm5.pageEndpoints(chapterHtml('99999', 2), chapter),
      (e: unknown) => (e as { code?: string }).code === 'UPSTREAM_PROTOCOL',
    )
  })

  test('unpack() decodes p.a.c.k.e.r. by substitution and refuses eval-only scripts', () => {
    // A minimal but real packer tail: payload `var 0=["1"]`, radix 10, 2 words.
    const packed = `x}('var 0=["1"]',10,2,'pvalue|https://e/x.jpg'.split('|'),0,{}))`
    assert.equal(dm5.unpack(packed), 'var pvalue=["https://e/x.jpg"]')
    // Non-packed scripts pass through untouched.
    assert.equal(dm5.unpack('var pvalue=[1]'), 'var pvalue=[1]')
    // Scripts that only eval() (unsupported packing) are rejected, never run.
    assert.throws(
      () => dm5.unpack('eval(function(){return 1})'),
      (e: unknown) => (e as { code?: string }).code === 'UPSTREAM_PROTOCOL',
    )
  })

  test('imageUrl() handles absolute, protocol-relative and pix-relative lists', () => {
    const referer = new URL('https://www.dm5.com/m12345/')
    assert.equal(
      dm5.imageUrl('var pvalue=["https://cdn.example/a.jpg"]', referer).toString(),
      'https://cdn.example/a.jpg',
    )
    assert.equal(
      dm5.imageUrl('var pvalue=["//cdn.example/b.jpg"]', referer).toString(),
      'https://cdn.example/b.jpg',
    )
    const relative =
      'var pvalue=["img.jpg"]\nvar pix="https://pix.example/"\nvar cid="77"\nvar key="kk"'
    assert.equal(
      dm5.imageUrl(relative, referer).toString(),
      'https://pix.example/img.jpg?cid=77&key=kk',
    )
    // Packed scripts are decoded before the pvalue list is read.
    const packed = `x}('var 0=["1"]',10,2,'pvalue|https://e/p.jpg'.split('|'),0,{}))`
    assert.equal(dm5.imageUrl(packed, referer).toString(), 'https://e/p.jpg')
    assert.throws(
      () => dm5.imageUrl('var nothing=1', referer),
      (e: unknown) => (e as { code?: string }).code === 'UPSTREAM_PROTOCOL',
    )
  })

  test('pages() fetches chapter html and builds lazy endpoints', async () => {
    const mock = await startMock((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname === '/m12345/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(chapterHtml('12345', 2))
        return
      }
      res.writeHead(404)
      res.end()
    })
    try {
      const urls = await dm5.pages(new URL(`${mock.base}/m12345/`), { timeoutMs: 5000 })
      assert.equal(urls.length, 2)
      assert.ok(urls[0]!.includes('/m12345/chapterfun.ashx'))
      assert.ok(urls[0]!.includes('page=1'))
      assert.ok(urls[1]!.includes('page=2'))
      assert.ok(urls[0]!.includes('cid=12345'))
    } finally {
      await mock.close()
    }
  })

  test('resolve() returns image + referer with a single fetch on success', async () => {
    let chapterfunHits = 0
    const mock = await startMock((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname === '/m12345/chapterfun.ashx') {
        chapterfunHits += 1
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('var pvalue=["https://img.example/p.jpg"]')
        return
      }
      res.writeHead(404)
      res.end()
    })
    try {
      const endpoint = new URL(`${mock.base}/m12345/chapterfun.ashx?page=1`)
      const resolved = await dm5.resolve(endpoint, { timeoutMs: 5000 })
      assert.equal(resolved.image.toString(), 'https://img.example/p.jpg')
      assert.equal(resolved.referer.toString(), `${mock.base}/m12345/`)
      assert.equal(chapterfunHits, 1, 'success needs no signature refresh')
    } finally {
      await mock.close()
    }
  })

  test('resolve() refreshes the chapter signature exactly once on failure', async () => {
    let staleHits = 0
    let refreshedHits = 0
    let htmlHits = 0
    const mock = await startMock((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname === '/m12345/') {
        htmlHits += 1
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(chapterHtml('12345', 1))
        return
      }
      if (url.pathname === '/m12345/chapterfun.ashx') {
        // The refreshed endpoint carries cid; the stale one does not.
        if (url.searchParams.get('cid')) {
          refreshedHits += 1
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('var pvalue=["https://img.example/r.jpg"]')
          return
        }
        staleHits += 1
        res.writeHead(500)
        res.end('expired signature')
        return
      }
      res.writeHead(404)
      res.end()
    })
    try {
      const endpoint = new URL(`${mock.base}/m12345/chapterfun.ashx?page=1`)
      const resolved = await dm5.resolve(endpoint, { timeoutMs: 5000 })
      assert.equal(resolved.image.toString(), 'https://img.example/r.jpg')
      assert.equal(staleHits, 1, 'stale endpoint attempted once')
      assert.equal(htmlHits, 1, 'chapter metadata refreshed exactly once')
      assert.equal(refreshedHits, 1, 'refreshed endpoint fetched once')
    } finally {
      await mock.close()
    }
  })
})
