import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Dev server on 5199 proxying to the service on 8790. The proxy keeps the
// original Host header (no changeOrigin) so the server's same-origin CSRF
// check matches the browser's Origin (http://localhost:5199).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5199,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8790' },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
