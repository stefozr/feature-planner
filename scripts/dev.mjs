#!/usr/bin/env node
// Dev launcher (`npm run dev` / `just dev`): starts the stack on random free ports so several
// branches/worktrees run in parallel without port collisions. Picks a free port for the storage
// server, points Vite's /api proxy at it (API_URL), and starts Vite on its own free port. Each
// worktree has its own data/db.sqlite, so the branches don't share state either.
import net from 'node:net'
import { spawn } from 'node:child_process'

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })

// Grab two distinct free ports up front — Vite ignores `--port 0`, so we must hand it a real one.
const apiPort = await freePort()
let vitePort = await freePort()
if (vitePort === apiPort) vitePort = await freePort()
console.log(`\n  storage server → http://localhost:${apiPort}`)
console.log(`  vite (app)     → http://localhost:${vitePort}\n`)

const opts = { stdio: 'inherit', env: { ...process.env, PORT: String(apiPort), API_URL: `http://localhost:${apiPort}` } }
// --strictPort: fail loudly if the port got taken in the race window rather than silently drifting
const children = [
  spawn('node', ['server/index.mjs'], opts),
  spawn('npx', ['vite', '--port', String(vitePort), '--strictPort'], opts),
]

const shutdown = () => {
  for (const c of children) c.kill('SIGTERM')
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
// if either child dies, tear the other down too
for (const c of children) c.on('exit', shutdown)
