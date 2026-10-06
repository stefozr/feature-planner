import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // listen on all interfaces so other devices on the LAN can connect
    port: 5174,
    proxy: {
      // target follows the storage server; `just dev` sets this to the server's random free port
      '/api': process.env.API_URL || 'http://localhost:3179',
    },
  },
})
