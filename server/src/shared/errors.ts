/**
 * Stable, machine-readable error model shared by every endpoint.
 * HTTP status follows the error kind; `code` never leaks upstream secrets.
 */
export type ErrorCode =
  // request level
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'TOO_MANY_REQUESTS'
  | 'INTERNAL'
  // service token / access
  | 'TOKEN_INVALID'
  | 'TOKEN_REVOKED'
  | 'CSRF_INVALID'
  | 'SESSION_EXPIRED'
  | 'ADMIN_NOT_INITIALIZED'
  | 'ADMIN_ALREADY_INITIALIZED'
  | 'ADMIN_CREDENTIALS_INVALID'
  // sources / upstream
  | 'SOURCE_DISABLED'
  | 'SOURCE_NOT_FOUND'
  | 'SOURCE_UNAVAILABLE'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_HTTP'
  | 'UPSTREAM_PROTOCOL'
  | 'UPSTREAM_UNAUTHORIZED'
  | 'UPSTREAM_QUOTA'
  | 'UPSTREAM_FORBIDDEN'
  | 'ACCOUNT_NOT_CONFIGURED'
  | 'ACCOUNT_LOGIN_FAILED'
  | 'ACCOUNT_SWITCHED'
  // content
  | 'COMIC_NOT_RESOLVED'
  | 'CHAPTER_NOT_FOUND'
  | 'IMAGE_UNSUPPORTED'
  | 'NO_RESULTS'
  | 'JOB_NOT_FOUND'
  | 'REQUEST_CANCELLED'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly retryable: boolean = false,
    readonly retryAfter?: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }

  toJSON(): {
    code: ErrorCode
    message: string
    retryable: boolean
    retryAfter?: number
  } {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.retryAfter !== undefined ? { retryAfter: this.retryAfter } : {}),
    }
  }
}

export const badRequest = (message: string, code: ErrorCode = 'BAD_REQUEST'): ApiError =>
  new ApiError(400, code, message)
export const unauthorized = (message: string, code: ErrorCode = 'UNAUTHORIZED'): ApiError =>
  new ApiError(401, code, message)
export const forbidden = (message: string, code: ErrorCode = 'FORBIDDEN'): ApiError =>
  new ApiError(403, code, message)
export const notFound = (message: string, code: ErrorCode = 'NOT_FOUND'): ApiError =>
  new ApiError(404, code, message)
export const conflict = (message: string, code: ErrorCode = 'CONFLICT'): ApiError =>
  new ApiError(409, code, message)
export const tooManyRequests = (message: string, retryAfter?: number): ApiError =>
  new ApiError(429, 'TOO_MANY_REQUESTS', message, true, retryAfter)
export const internal = (message: string): ApiError =>
  new ApiError(500, 'INTERNAL', message)

/** Errors whose message is safe to forward to clients verbatim. */
export const asApiError = (error: unknown): ApiError => {
  if (error instanceof ApiError) return error
  if (error instanceof Error) {
    const message = error.message
    if (error.name === 'AbortError') {
      return new ApiError(504, 'UPSTREAM_TIMEOUT', 'Upstream request timed out', true)
    }
    return new ApiError(500, 'INTERNAL', redactMessage(message))
  }
  return internal('Internal error')
}

const SECRET_PATTERNS = [
  /ticket-[A-Za-z0-9_-]+/g,
  /Bearer\s+[A-Za-z0-9_.-]+/g,
  /pt_[A-Za-z0-9_-]+/g,
  /komiic-access-token=[^;\s]+/gi,
  /Cookie:\s*[^\r\n]+/gi,
  /password["']?\s*[:=]\s*["']?[^"',\s}]+/gi,
]

/** Defense in depth: never let credentials, cookies or tickets reach clients/logs. */
export const redactMessage = (message: string): string => {
  let out = message
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]')
  return out
}
