import 'reflect-metadata'
import { createServer } from './configs/application'
import { HOST, PORT, ENV_LABEL, DATABASE_URL } from './configs/constants'

const main = async (): Promise<void> => {
  try {
    const { app, stop } = await createServer()
    const server = app.listen(PORT, HOST, () => {
      const address = server.address()
      const shown =
        typeof address === 'object' && address
          ? `${address.address}:${address.port}`
          : `${HOST}:${PORT}`
      console.log(`pordo-service listening on http://${shown} (${ENV_LABEL}, db=${DATABASE_URL})`)
    })
    const shutdown = async (signal: string): Promise<void> => {
      console.log(`[shutdown] ${signal}`)
      server.close()
      await stop()
      process.exit(0)
    }
    process.on('SIGINT', () => void shutdown('SIGINT'))
    process.on('SIGTERM', () => void shutdown('SIGTERM'))
  } catch (error) {
    console.error('[startup] failed to start server', error)
    process.exit(1)
  }
}

void main()
