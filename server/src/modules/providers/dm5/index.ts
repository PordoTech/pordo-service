/**
 * DM5's public reader protocol, migrated from
 * crates/pordo-core/src/comics/source/dm5.rs. Extract data from its packed
 * image response; never execute downloaded JavaScript. Page endpoints are
 * resolved on demand.
 */
import { ApiError, badRequest } from '../../../shared/errors'
import { headerValue, httpUrl, readTextLimited, sendUpstream } from '../../../shared/http'
import type { ProviderContext } from '../types'

const DM5_HOSTS = new Set(['www.dm5.com', 'dm5.com'])

const onDm5 = (url: URL): boolean => DM5_HOSTS.has(url.hostname)

const chapterId = (pathname: string): string | null => {
  const match = /^\/m(\d+)\/$/.exec(pathname)
  return match?.[1] ?? null
}

export const isChapter = (url: URL): boolean => onDm5(url) && chapterId(url.pathname) !== null

export const isPage = (url: URL): boolean => {
  if (!onDm5(url)) return false
  const withoutSuffix = url.pathname.replace(/chapterfun\.ashx$/, '')
  return withoutSuffix !== url.pathname && chapterId(withoutSuffix) !== null
}

interface TextFetchOptions {
  proxy?: string | null
  timeoutMs: number
  signal?: AbortSignal
}

const fetchText = async (url: URL, referer: string, opts: TextFetchOptions): Promise<string> => {
  const response = await sendUpstream({
    url: url.toString(),
    headers: { 'user-agent': 'Mozilla/5.0', referer },
    timeoutMs: Math.min(opts.timeoutMs, 15_000),
    proxy: opts.proxy,
    signal: opts.signal,
  })
  if (response.status < 200 || response.status >= 300) {
    response.body.destroy()
    throw new ApiError(
      502,
      'UPSTREAM_HTTP',
      `动漫屋 HTTP ${response.status} / DM5 unavailable`,
      response.status >= 500,
    )
  }
  try {
    return await readTextLimited(response, 1024 * 1024)
  } catch {
    throw new ApiError(502, 'UPSTREAM_PROTOCOL', '动漫屋返回了无效文本 / Invalid DM5 response')
  }
}

/** Lazy per-page endpoints built from chapter metadata, matching the client. */
export const pageEndpoints = (html: string, chapter: URL): string[] => {
  const count = Number(variable(html, 'DM5_IMAGE_COUNT'))
  if (!Number.isInteger(count) || count < 1 || count > 2000) {
    throw new ApiError(404, 'NO_RESULTS', '动漫屋未返回章节图片 / DM5 chapter has no images')
  }
  const cid = variable(html, 'DM5_CID')
  const mid = variable(html, 'DM5_MID')
  const dt = variable(html, 'DM5_VIEWSIGN_DT')
  const sign = variable(html, 'DM5_VIEWSIGN')
  if (chapterId(chapter.pathname) !== cid) {
    throw new ApiError(502, 'UPSTREAM_PROTOCOL', '动漫屋章节信息不匹配 / DM5 chapter mismatch')
  }
  const endpoint = new URL('chapterfun.ashx', chapter)
  endpoint.search = ''
  const base = new URLSearchParams({
    cid,
    key: '',
    language: '1',
    gtk: '6',
    _cid: cid,
    _mid: mid,
    _dt: dt,
    _sign: sign,
  })
  const urls: string[] = []
  for (let index = 1; index <= count; index += 1) {
    const params = new URLSearchParams(base)
    params.append('page', String(index))
    endpoint.search = params.toString()
    urls.push(endpoint.toString())
  }
  return urls
}

export const pages = async (
  chapter: URL,
  opts: TextFetchOptions,
): Promise<string[]> =>
  pageEndpoints(await fetchText(chapter, chapter.toString(), opts), chapter)

/**
 * Resolve a lazy page endpoint to the real image URL plus referer. Expired
 * reader signatures refresh the public chapter metadata once, preserving the
 * requested page.
 */
export const resolve = async (
  endpoint: URL,
  opts: TextFetchOptions,
): Promise<{ image: URL; referer: URL }> => {
  const referer = new URL('./', endpoint)
  const pageParam = endpoint.searchParams.get('page')
  const page = pageParam === null ? NaN : Number(pageParam)
  if (!Number.isInteger(page) || page < 1 || page > 2000) {
    throw badRequest('无效动漫屋页码 / Invalid DM5 page')
  }
  let image: URL
  try {
    const script = await fetchText(endpoint, referer.toString(), opts)
    image = imageUrl(script, referer)
  } catch {
    const urls = await pages(referer, opts)
    const refreshed = urls[page - 1]
    if (!refreshed) {
      throw new ApiError(
        404,
        'CHAPTER_NOT_FOUND',
        '动漫屋页码已变化，请刷新章节 / DM5 page no longer exists',
      )
    }
    const script = await fetchText(httpUrl(refreshed), referer.toString(), opts)
    image = imageUrl(script, referer)
  }
  return { image, referer }
}

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const variable = (script: string, name: string): string => {
  const re = new RegExp(
    `\\bvar\\s+${escapeRegex(name)}\\s*=\\s*("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\\d+)`,
  )
  const match = re.exec(script)
  if (!match?.[1]) {
    throw new ApiError(
      502,
      'UPSTREAM_PROTOCOL',
      `动漫屋阅读数据不完整 / Missing DM5 reader data: ${name}`,
    )
  }
  const value = match[1]
  if (value.startsWith("'") || value.startsWith('"')) {
    return unescapeJs(value.slice(1, -1))
  }
  return value
}

export const unescapeJs = (value: string): string => {
  let result = ''
  for (let i = 0; i < value.length; i += 1) {
    const c = value[i]
    if (c !== '\\') {
      result += c
      continue
    }
    const escaped = value[i + 1]
    if (escaped === undefined) throw badRequest('Invalid DM5 string escape')
    i += 1
    switch (escaped) {
      case 'n':
        result += '\n'
        break
      case 'r':
        result += '\r'
        break
      case 't':
        result += '\t'
        break
      case 'x':
      case 'u': {
        const digits = escaped === 'x' ? 2 : 4
        const hex = value.slice(i + 1, i + 1 + digits)
        if (hex.length !== digits) throw badRequest('Invalid DM5 character escape')
        i += digits
        const code = Number.parseInt(hex, 16)
        if (!Number.isFinite(code)) throw badRequest('Invalid DM5 character escape')
        const char = String.fromCodePoint(code)
        result += char
        break
      }
      default:
        result += escaped
    }
  }
  return result
}

const PACKER =
  /\}\s*\(\s*'([\s\S]*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'([^']*)'\.split\('\|'\)\s*,\s*0\s*,\s*\{\}\s*\)\s*\)/
const WORD = /\b[0-9A-Za-z_]+\b/g

/** Decode the p.a.c.k.e.r. symbol substitution without executing code. */
export const unpack = (script: string): string => {
  const caps = PACKER.exec(script)
  if (!caps) {
    if (script.includes('eval(')) {
      throw new ApiError(
        502,
        'UPSTREAM_PROTOCOL',
        '动漫屋图片脚本格式已变化 / Unsupported DM5 image script',
      )
    }
    return script
  }
  const rawPayload = caps[1] ?? ''
  const radixStr = caps[2] ?? ''
  const countStr = caps[3] ?? ''
  const symbolList = caps[4] ?? ''
  const radix = Number(radixStr)
  const count = Number(countStr)
  if (!Number.isInteger(radix) || radix < 2 || radix > 62 || !Number.isInteger(count) || count > 10000) {
    throw badRequest('Invalid DM5 symbol table')
  }
  const words = symbolList.split('|')
  if (words.length !== count) throw badRequest('Invalid DM5 symbol count')
  // Some responses escape backslashes twice, including the quoted key.
  const normalized = rawPayload.includes("\\\\'")
    ? rawPayload.replaceAll('\\\\', '\\')
    : rawPayload
  const payload = unescapeJs(normalized)
  let output = ''
  let end = 0
  WORD.lastIndex = 0
  for (const token of payload.matchAll(WORD)) {
    const start = token.index ?? 0
    const text = token[0]
    const number = digitValue(text, radix)
    const word =
      number !== null && number < words.length && words[number] !== '' ? words[number]! : text
    if (output.length + start - end + word.length > 2 * 1024 * 1024) {
      throw badRequest('DM5 image script is too large')
    }
    output += payload.slice(end, start)
    output += word
    end = start + text.length
  }
  output += payload.slice(end)
  return output
}

const digitValue = (token: string, radix: number): number | null => {
  let value = 0
  for (const char of token) {
    const code = char.charCodeAt(0)
    let digit: number
    if (code >= 48 && code <= 57) digit = code - 48
    else if (code >= 97 && code <= 122) digit = code - 97 + 10
    else if (code >= 65 && code <= 90) digit = code - 65 + 36
    else return null
    if (digit >= radix) return null
    value = value * radix + digit
    if (value > Number.MAX_SAFE_INTEGER) return null
  }
  return value
}

const PVALUE = /\bvar\s+pvalue\s*=\s*(\[[\s\S]*?\])/

export const imageUrl = (script: string, referer: URL): URL => {
  const decoded = unpack(script)
  const match = PVALUE.exec(decoded)
  if (!match?.[1]) {
    throw new ApiError(
      502,
      'UPSTREAM_PROTOCOL',
      '动漫屋未返回图片地址 / DM5 returned no image URL',
    )
  }
  let values: unknown
  try {
    values = JSON.parse(match[1])
  } catch {
    throw new ApiError(502, 'UPSTREAM_PROTOCOL', '动漫屋图片列表无效 / Invalid DM5 image list')
  }
  if (!Array.isArray(values)) {
    throw new ApiError(502, 'UPSTREAM_PROTOCOL', '动漫屋图片列表无效 / Invalid DM5 image list')
  }
  const first = values[0]
  if (typeof first !== 'string' || first === '') {
    throw new ApiError(502, 'UPSTREAM_PROTOCOL', '动漫屋图片列表为空 / Empty DM5 image list')
  }
  let url: URL
  if (first.startsWith('https://') || first.startsWith('http://') || first.startsWith('//')) {
    url = new URL(first, referer)
  } else {
    const pix = variable(decoded, 'pix')
    url = httpUrl(`${pix}${first}`)
    url.searchParams.append('cid', variable(decoded, 'cid'))
    url.searchParams.append('key', variable(decoded, 'key'))
  }
  return httpUrl(url.toString())
}

/** Fetch DM5 image bytes with the mandatory chapter referer. */
export const fetchImage = async (
  image: URL,
  referer: URL,
  ctx: ProviderContext,
): Promise<{ status: number; contentType: string; body: NodeJS.ReadableStream }> => {
  const response = await sendUpstream({
    url: image.toString(),
    headers: { referer: referer.toString(), 'user-agent': 'Mozilla/5.0' },
    proxy: ctx.proxy ?? null,
    timeoutMs: ctx.timeoutMs,
    signal: ctx.signal,
  })
  return {
    status: response.status,
    contentType: headerValue(response.headers, 'content-type') || 'image/jpeg',
    body: response.body,
  }
}
