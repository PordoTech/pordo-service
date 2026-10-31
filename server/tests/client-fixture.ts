/** Opt-in real service + mock upstream for desktop/JNI/browser integration. */
import fs from 'node:fs'
import path from 'node:path'
import { startTestServer } from './helpers'
import { startMangayunMock, DETAIL_URL, SITE_A } from './mocks/mangayun'

async function main(): Promise<void> {
  const output = process.argv[2]
  const imagePath = process.argv[3]
  if (!output || !imagePath) throw new Error('Usage: node --import tsx tests/client-fixture.ts OUTPUT.json IMAGE.png')
  const mock = await startMangayunMock({ image: fs.readFileSync(imagePath) })
  const server = await startTestServer({ staticPath: path.resolve(__dirname, '../../web/dist') })
  const { cookie, csrf } = await server.setupAdmin()
  for (const [source, body] of [['mangayun', { config: { baseUrl: mock.base } }], ['komiic', { enabled: false }]] as const) {
    const response = await fetch(`${server.adminBase}/sources/${source}`, { method: 'PUT', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (!response.ok) throw new Error(`Source configuration failed: ${response.status}`)
  }
  const token = await server.createDeviceToken('client-fixture', cookie, csrf)
  const fixture = { url: server.baseUrl, token,
    book: { provider: 'mangayun', siteId: SITE_A, siteName: 'Site A', detailUrl: DETAIL_URL, title: 'Existing favorite', coverUrl: `${mock.base}/direct/cover.jpg` } }
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true })
  fs.writeFileSync(output, JSON.stringify(fixture), { mode: 0o600 })
  console.log(`Client fixture ready: ${server.baseUrl}`)
  const stop = async (): Promise<void> => {
    await server.stop(); await mock.close(); fs.rmSync(output, { force: true }); process.exit(0)
  }
  process.on('SIGTERM', () => { void stop() }); process.on('SIGINT', () => { void stop() })
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'Fixture failed'); process.exit(1) })
