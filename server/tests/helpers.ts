import { spawn, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'

export const SERVER_DIR = path.join(__dirname, '..')

export interface TestServer {
  baseUrl: string
  adminBase: string
  /** Creates the admin (first call only) and returns the CSRF token + cookie header. */
  setupAdmin(username?: string, password?: string): Promise<{ cookie: string; csrf: string }>
  login(username: string, password: string): Promise<{ cookie: string; csrf: string }>
  createDeviceToken(name: string, cookie: string, csrf: string): Promise<string>
  stop(): Promise<void>
}

let serverCount = 0

/**
 * Start an isolated server instance: temp data dir, temp SQLite DB (schema via
 * prisma db push), fixed master key, private upstreams allowed (mocks).
 */
export const startTestServer = async (options: { staticPath?: string; masterKey?: string } = {}): Promise<TestServer> => {
  serverCount += 1
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pordo-svc-test-${serverCount}-`))
  const dbPath = path.join(dir, 'test.db')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    PORDO_DATA_DIR: dir,
    PORDO_MASTER_KEY: options.masterKey ?? 'test-master-key-0123456789abcdef-test',
    PORDO_IMAGE_CACHE_DIR: path.join(dir, 'image-cache'),
    DATABASE_URL: `file:${dbPath}`,
    PORDO_ALLOW_PRIVATE_UPSTREAMS: '1',
    STATIC_PATH: options.staticPath ?? path.join(dir, 'no-web'),
    PORT: '0',
  }
  execSync('npx prisma db push --skip-generate', {
    cwd: SERVER_DIR,
    env: { ...env, DATABASE_URL: `file:${dbPath}` },
    stdio: 'pipe',
  })

  const child = spawn('npx', ['tsx', 'src/app.ts'], {
    cwd: SERVER_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  const ready = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server start timeout\n${stdout}`)), 30_000)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      const match = /listening on http:\/\/([^ ]+)/.exec(stdout)
      if (match?.[1]) {
        clearTimeout(timer)
        resolve(match[1])
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (process.env.PORDO_TEST_DEBUG === '1') process.stderr.write(chunk)
    })
    child.on('exit', (code) => reject(new Error(`server exited (${code})\n${stdout}`)))
  })
  const address = await ready
  const baseUrl = `http://${address}`

  const stop = async (): Promise<void> => {
    child.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 3000)
      child.on('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    fs.rmSync(dir, { recursive: true, force: true })
  }

  const extractCookie = (response: Response): string => {
    const raw = response.headers.getSetCookie?.() ?? []
    return raw
      .map((c) => c.split(';')[0])
      .filter(Boolean)
      .join('; ')
  }

  const setupAdmin = async (
    username = 'admin',
    password = 'test-password-123',
  ): Promise<{ cookie: string; csrf: string }> => {
    const response = await fetch(`${baseUrl}/api/admin/v1/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    if (!response.ok) throw new Error(`setup failed: ${response.status} ${await response.text()}`)
    const body = (await response.json()) as { data: { session: { csrfToken: string } } }
    return { cookie: extractCookie(response), csrf: body.data.session.csrfToken }
  }

  const login = async (
    username: string,
    password: string,
  ): Promise<{ cookie: string; csrf: string }> => {
    const response = await fetch(`${baseUrl}/api/admin/v1/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    if (!response.ok) throw new Error(`login failed: ${response.status}`)
    const body = (await response.json()) as { data: { session: { csrfToken: string } } }
    return { cookie: extractCookie(response), csrf: body.data.session.csrfToken }
  }

  const createDeviceToken = async (
    name: string,
    cookie: string,
    csrf: string,
  ): Promise<string> => {
    const response = await fetch(`${baseUrl}/api/admin/v1/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
      body: JSON.stringify({ name }),
    })
    if (!response.ok) throw new Error(`token create failed: ${response.status}`)
    const body = (await response.json()) as { data: { token: string } }
    return body.data.token
  }

  return { baseUrl, adminBase: `${baseUrl}/api/admin/v1`, setupAdmin, login, createDeviceToken, stop }
}

export interface MockHandle {
  base: string
  close(): Promise<void>
}

export const startMock = (
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<MockHandle> =>
  new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address === 'object' && address) {
        resolve({
          base: `http://127.0.0.1:${address.port}`,
          close: () =>
            new Promise<void>((done) => {
              server.closeAllConnections?.()
              server.close(() => done())
            }),
        })
      }
    })
  })

export const readBody = (req: http.IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })

export const sendJson = (res: http.ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void => {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(body)
}

/** 1x1 red JPEG-ish placeholder bytes; mocks only need stable binary content. */
export const imageBytes = (tag: number): Buffer => {
  const payload = Buffer.alloc(64, tag % 251)
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), payload, Buffer.from([0xff, 0xd9])])
}

export const sha256 = (value: string): string =>
  crypto.createHash('sha256').update(value).digest('hex')

/** Wait until a condition holds, polling quickly (test-timeout friendly). */
export const waitFor = async (
  condition: () => Promise<boolean> | boolean,
  timeoutMs = 10_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await condition()) return
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
