import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/app': {
        target: 'http://127.0.0.1:31415',
        changeOrigin: true,
      },
    },
  },
})
