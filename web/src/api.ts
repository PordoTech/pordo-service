/**
 * Minimal API client for the admin envelope protocol:
 * success { data, meta?, requestId } / error { error: { code, message, retryable, retryAfter? }, requestId }.
 * CSRF is double-submit: the token from the session view is sent as x-csrf-token.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly retryAfter?: number,
  ) {
    super(message)
  }
}

let csrfToken = ''

export const setCsrf = (token: string): void => {
  csrfToken = token
}

export const clearCsrf = (): void => {
  csrfToken = ''
}

export const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const method = (init.method ?? 'GET').toUpperCase()
  const headers = new Headers(init.headers)
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  if (csrfToken && method !== 'GET' && method !== 'HEAD') {
    headers.set('x-csrf-token', csrfToken)
  }
  const response = await fetch(path, { ...init, method, headers, credentials: 'include' })
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    if (!response.ok) {
      throw new ApiError(response.status, `HTTP_${response.status}`, response.statusText, false)
    }
    return undefined as T
  }
  const body = (await response.json()) as {
    data?: T
    error?: { code: string; message: string; retryable: boolean; retryAfter?: number }
  }
  if (!response.ok || body.error) {
    const error = body.error ?? {
      code: `HTTP_${response.status}`,
      message: response.statusText,
      retryable: false,
    }
    throw new ApiError(response.status, error.code, error.message, error.retryable, error.retryAfter)
  }
  return body.data as T
}

/** Admin-session image stream (works in <img> because the cookie is sent). */
export const assetUrl = (assetId: string): string =>
  `/api/admin/v1/assets/${encodeURIComponent(assetId)}`

export const errorText = (error: unknown): string =>
  error instanceof ApiError ? `${error.code} · ${error.message}` : String(error)
