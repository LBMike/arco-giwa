import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    // Fixed dev port that MUST match the server's CORS_ALLOWED_ORIGINS (http://localhost:5173).
    // The API server owns PORT (default 8080); Vite must NOT read the same PORT or it collides
    // with the API and drifts to 8081/8082 — an origin the API's CORS then blocks ("Failed to
    // fetch"). strictPort makes a busy 5173 fail loudly instead of silently drifting off-allowlist.
    port: 5173,
    strictPort: true,
  },
})
