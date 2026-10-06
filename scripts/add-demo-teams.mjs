#!/usr/bin/env node
// Loads the extra demo teams (server/seed-teams.json, built by `just seed`) into a running server:
// for each team whose name is not taken yet, POST /api/teams creates it, then an import
// (PUT /api/teams/<id>/data?reason=import) fills its plan. Teams that already exist are skipped, so
// running it twice changes nothing — except the built-in Program, which every server has: its seed
// (roadmap and notes) is imported only while the Program is still empty.
//
//   node scripts/add-demo-teams.mjs http://localhost:3179     (or: just demo-teams http://localhost:3179)
//
// The URL is the storage server's (or the Vite app's, which proxies /api). With auth on, pass an
// editor's access token in FP_TOKEN.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const base = (process.argv[2] || process.env.API_URL || 'http://localhost:3179').replace(/\/$/, '')
const headers = { 'Content-Type': 'application/json', ...(process.env.FP_TOKEN ? { Authorization: `Bearer ${process.env.FP_TOKEN}` } : {}) }

const call = async (method, url, body) => {
  const res = await fetch(`${base}${url}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`${method} ${url} → HTTP ${res.status}${data?.error ? `: ${data.error}` : ''}`)
  return data
}

try {
  const teams = JSON.parse(fs.readFileSync(path.join(ROOT, 'server/seed-teams.json'), 'utf8'))
  const existing = await call('GET', '/api/teams')
  const taken = new Set(existing.map((t) => t.name.toLowerCase()))
  for (const t of teams) {
    const builtin = existing.find((x) => x.builtin && x.id === t.id)
    if (builtin) {
      const current = await call('GET', `/api/teams/${encodeURIComponent(t.id)}/data`)
      if (current.workstreams?.length || Object.keys(current.program?.tracking ?? {}).length) {
        console.log(`skip "${builtin.name}" — the Program already has a roadmap or notes`)
        continue
      }
      await call('PUT', `/api/teams/${encodeURIComponent(t.id)}/data?reason=import`, t.doc)
      console.log(`filled "${builtin.name}" (#/${t.id}): ${t.doc.workstreams.length} roadmap rows, ${Object.keys(t.doc.program?.tracking ?? {}).length} notes`)
      continue
    }
    if (taken.has(t.name.toLowerCase())) {
      console.log(`skip "${t.name}" — a team with that name already exists`)
      continue
    }
    const created = await call('POST', '/api/teams', { name: t.name })
    await call('PUT', `/api/teams/${encodeURIComponent(created.id)}/data?reason=import`, t.doc)
    console.log(`added "${created.name}" as #/${created.id}: ${t.doc.people.length} people, ${t.doc.features.length} features`)
  }
} catch (e) {
  console.error(`add-demo-teams: ${e instanceof Error ? (e.cause ? `${e.message} (${e.cause.code ?? e.cause}) — is the server at ${base} running?` : e.message) : e}`)
  process.exit(1)
}
