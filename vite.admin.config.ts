import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// The admin console is a second single-page app in this repository (see docs/admin-console.md). It shares
// src/, public/ and the .env files with the customer app, but has its own document, admin/index.html,
// served at "/" in development and emitted as dist-admin/index.html by `npm run build:admin`.
const ADMIN_HTML = 'admin/index.html'

function adminConsoleDocument(): Plugin {
  return {
    name: 'arco-admin-console-document',
    // After Vite's own HTML plugin has emitted the document (generateBundle below).
    enforce: 'post',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const pathname = (req.url ?? '/').split('?')[0]
        const wantsDocument = (req.method === 'GET' || req.method === 'HEAD') && String(req.headers.accept ?? '').includes('text/html')
        // Page navigations (not modules or files) get the console document; the router takes the path.
        if (wantsDocument && !path.extname(pathname)) req.url = `/${ADMIN_HTML}`
        next()
      })
    },
    generateBundle(_options, bundle) {
      const emitted = bundle[ADMIN_HTML]
      if (!emitted) return
      delete bundle[ADMIN_HTML]
      emitted.fileName = 'index.html'
      bundle['index.html'] = emitted
    },
  }
}

export default defineConfig({
  plugins: [react(), adminConsoleDocument()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: 'dist-admin',
    emptyOutDir: true,
    rollupOptions: {
      input: { admin: path.resolve(__dirname, ADMIN_HTML) },
    },
  },
  server: {
    // Fixed port that CORS_ALLOWED_ORIGINS must list (http://localhost:5174); the customer app keeps 5173.
    port: 5174,
    strictPort: true,
  },
  preview: {
    port: 4174,
    strictPort: true,
  },
})
