import { Agent, ProxyAgent, request as undiciRequest } from 'undici'
import type { Readable } from 'node:stream'
import { ApiError, redactMessage } from './errors'
import { MAX_JSON_BODY_BYTES, UPSTREAM_USER_AGENT } from '../configs/constants'

/**
 * Shared upstream HTTP layer: per-request timeout, optional proxy, redirect
 * control, size limits and cancellation. Cookies are handled by callers
 * (account sessions), never logged.
 */
export interface UpstreamRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  url: string
  headers?: Record<string, string>
  /** JSON body; serialized exactly as sent for signature protocols. */
  jsonBody?: string
  timeoutMs?: number
  proxy?: string | null
  signal?: AbortSignal
  followRedirect?: boolean
}

export interface UpstreamResponse {
  status: number
  headers: Record<string, string | string[]>
  body: Readable & { dump?: () => Promise<void> }
  /** Raw undici body for streaming without buffering. */
  raw: unknown
}

const agents = new Map<string, Agent | ProxyAgent>()

const dispatcherFor = (proxy?: string | null): Agent | ProxyAgent => {
  if (!proxy) {
    let agent = agents.get('direct')
    if (!agent) {
      agent = new Agent({ connect: { timeout: 12_000 }, headersTimeout: 30_000, bodyTimeout: 65_000 })
      agents.set('direct', agent)
    }
    return agent
  }
  let agent = agents.get(proxy)
  if (!agent) {
    agent = new ProxyAgent(proxy)
    agents.set(proxy, agent)
  }
  return agent
}

export const sendUpstream = async (
  spec: UpstreamRequest,
): Promise<UpstreamResponse> => {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error('upstream timeout')),
    spec.timeoutMs ?? 25_000,
  )
  if (spec.signal) {
    if (spec.signal.aborted) controller.abort()
    else spec.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  try {
    const response = await undiciRequest(spec.url, {
      method: spec.method || 'GET',
      headers: {
        'user-agent': UPSTREAM_USER_AGENT,
        ...(spec.jsonBody !== undefined ? { 'content-type': 'application/json' } : {}),
        ...spec.headers,
      },
      body: spec.jsonBody,
      dispatcher: dispatcherFor(spec.proxy),
      signal: controller.signal,
      headersTimeout: Math.min(spec.timeoutMs ?? 25_000, 60_000),
      bodyTimeout: Math.max(spec.timeoutMs ?? 25_000, 65_000),
      // Redirects are never followed automatically (matches the client's
      // redirect::Policy::none); providers validate destinations themselves.
      maxRedirections: spec.followRedirect ? 5 : 0,
    } as Parameters<typeof undiciRequest>[1])
    const headers: Record<string, string | string[]> = {}
    const rawHeaders = response.headers as Record<string, string | string[] | undefined>
    for (const [key, value] of Object.entries(rawHeaders)) {
      if (value !== undefined) headers[key.toLowerCase()] = value
    }
    // undici emits an asynchronous 'error' (RequestAbortedError) when an
    // unconsumed body is destroyed; without a listener that crashes the
    // process. Consumers (for-await / pipe) attach their own handlers and
    // still observe real errors.
    response.body.on('error', () => {})
    return {
      status: response.statusCode,
      headers,
      // undici.request() already yields a Node Readable (BodyReadable with
      // .dump()); fromWeb() would reject it.
      body: response.body as UpstreamResponse['body'],
      raw: response.body,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (spec.signal?.aborted) {
      throw new ApiError(499, 'REQUEST_CANCELLED', 'Request cancelled by client')
    }
    if (/timeout|aborted/i.test(message)) {
      throw new ApiError(504, 'UPSTREAM_TIMEOUT', 'Upstream request timed out', true)
    }
    throw new ApiError(502, 'SOURCE_UNAVAILABLE', redactMessage(message), true)
  } finally {
    clearTimeout(timer)
  }
}

export const headerValue = (
  headers: Record<string, string | string[]>,
  name: string,
): string | undefined => {
  const value = headers[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}

/** Read a bounded body; aborts and errors when the limit is exceeded. */
export const readBodyLimited = async (
  response: UpstreamResponse,
  max: number = MAX_JSON_BODY_BYTES,
): Promise<Buffer> => {
  const declared = headerValue(response.headers, 'content-length')
  if (declared && Number(declared) > max) {
    await response.body.destroy()
    throw new ApiError(502, 'UPSTREAM_PROTOCOL', 'Upstream response too large')
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of response.body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > max) {
      await response.body.destroy()
      throw new ApiError(502, 'UPSTREAM_PROTOCOL', 'Upstream response too large')
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

export const readJsonLimited = async <T = unknown>(
  response: UpstreamResponse,
  max?: number,
): Promise<T> => {
  const bytes = await readBodyLimited(response, max)
  try {
    return JSON.parse(bytes.toString('utf8')) as T
  } catch {
    throw new ApiError(502, 'UPSTREAM_PROTOCOL', 'Upstream returned invalid JSON')
  }
}

export const readTextLimited = async (
  response: UpstreamResponse,
  max = 1024 * 1024,
): Promise<string> => {
  const bytes = await readBodyLimited(response, max)
  const text = bytes.toString('utf8')
  if (text.includes('\uFFFD') && bytes.length >= max) {
    throw new ApiError(502, 'UPSTREAM_PROTOCOL', 'Upstream returned invalid text')
  }
  return text
}

/** Validate http(s) URLs with no embedded credentials, like the client's http_url. */
export const httpUrl = (url: string): URL => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ApiError(400, 'IMAGE_UNSUPPORTED', 'Invalid image URL')
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    throw new ApiError(400, 'IMAGE_UNSUPPORTED', 'Unsupported image URL')
  }
  return parsed
}

export const hostMatches = (host: string, domains: readonly string[]): boolean =>
  domains.some((domain) => host === domain || host.endsWith(`.${domain}`))
