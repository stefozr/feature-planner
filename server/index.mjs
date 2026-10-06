import express from 'express'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import Database from 'better-sqlite3'
import { applyCalendar, parseIcs, resolveCalendarUrl } from './vacations.mjs'
import { migrate } from './schema.mjs'
import { payloadProblem } from '../shared/db.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, '../data')
const DB_FILE = path.join(DATA_DIR, 'db.sqlite')
const LEGACY_JSON = path.join(DATA_DIR, 'db.json') // pre-SQLite storage; seeded from once
const BACKUP_DIR = path.join(DATA_DIR, 'backups')
const SEED_FILE = path.join(__dirname, 'seed.json')
const PORT = process.env.PORT || 3179
const BACKUP_KEEP = Number(process.env.BACKUP_KEEP || 30)

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true })

// ----- SQLite store -----
// Phase 1 keeps the whole-document model: the entire database lives as one JSON blob in a single
// row. The API (GET/PUT /api/data) and the migrate()/normalize() logic below are unchanged; only
// the container swapped from a file to SQLite, for atomic crash-safe writes and a real version
// counter behind optimistic concurrency (the X-Data-Version header). Phase 2 can reshape the blob
// into relational tables without re-platforming, since the doc sits intact in the cell.
const sqlite = new Database(DB_FILE)
sqlite.pragma('journal_mode = WAL') // concurrent readers don't block the writer
sqlite.pragma('busy_timeout = 5000') // wait on a lock rather than throwing SQLITE_BUSY
sqlite.exec(`CREATE TABLE IF NOT EXISTS store (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  doc        TEXT    NOT NULL,
  version    INTEGER NOT NULL,
  updated_at TEXT    NOT NULL
)`)

// First boot: seed the single row. Prefer an existing pre-SQLite db.json so upgrades keep their
// data (this is the Phase-1 data move); otherwise fall back to the shipped seed. The raw file text
// is stored verbatim — migrate() runs afterwards and rewrites it if the schema needs it.
if (!sqlite.prepare('SELECT 1 FROM store WHERE id = 1').get()) {
  const source = fs.existsSync(LEGACY_JSON) ? LEGACY_JSON : SEED_FILE
  sqlite
    .prepare('INSERT INTO store (id, doc, version, updated_at) VALUES (1, ?, 1, ?)')
    .run(fs.readFileSync(source, 'utf8'), new Date().toISOString())
  console.log(`seeded sqlite store from ${path.basename(source)}`)
}

const readRow = () => sqlite.prepare('SELECT doc, version FROM store WHERE id = 1').get()
const currentVersion = () => sqlite.prepare('SELECT version FROM store WHERE id = 1').get().version

/** Persist a document blob. When `expected` is a number the write is guarded: it only lands if the
 *  stored version still equals it, otherwise nothing changes and { ok:false } is returned (a stale
 *  write from another editor). `expected === null` writes unconditionally (startup migration and
 *  whole-database imports, which intentionally replace everything). Returns the resulting version. */
function writeDoc(docObj, expected = null) {
  const now = new Date().toISOString()
  const json = JSON.stringify(docObj, null, 2)
  const info =
    expected == null
      ? sqlite.prepare('UPDATE store SET doc = ?, version = version + 1, updated_at = ? WHERE id = 1').run(json, now)
      : sqlite
          .prepare('UPDATE store SET doc = ?, version = version + 1, updated_at = ? WHERE id = 1 AND version = ?')
          .run(json, now, expected)
  return { ok: info.changes > 0, version: currentVersion() }
}

// ----- backups: snapshot db.json into data/backups, prune to last BACKUP_KEEP -----
// Runs on startup (covers upgrades/restarts), before an import, and once a day while up.
// reason='daily' snapshots at most one file per calendar day (idempotent across restarts).
// Names are `db-<ISO stamp>-<reason>.json`; the reasons are startup, daily and import.

/** Backup files oldest-first. Sorted by mtime, not by name: an older filename format
 *  (`db-<day>-<reason>-<time>`) may still sit next to the current one, and only mtime orders
 *  them all correctly — lexical order pruned the newest daily snapshot first. */
function backupFiles() {
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((name) => ({ name, mtime: fs.statSync(path.join(BACKUP_DIR, name)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime)
}

function backup(reason = 'startup') {
  const row = readRow()
  if (!row) return
  const now = new Date()
  const day = now.toISOString().slice(0, 10)
  const files = backupFiles()
  if (reason === 'daily' && files.some((f) => f.name.startsWith(`db-${day}`) && f.name.includes('daily'))) return
  // pretty-print so snapshots stay diffable
  const current = Buffer.from(JSON.stringify(JSON.parse(row.doc), null, 2))
  const newest = files[files.length - 1]
  // a restart that changed nothing shouldn't push real history out of the ring
  if (reason === 'startup' && newest && fs.readFileSync(path.join(BACKUP_DIR, newest.name)).equals(current)) return
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  fs.writeFileSync(path.join(BACKUP_DIR, `db-${stamp}-${reason}.json`), current)
  const all = backupFiles()
  for (const f of all.slice(0, Math.max(0, all.length - BACKUP_KEEP))) {
    fs.rmSync(path.join(BACKUP_DIR, f.name))
  }
}

// ----- schema: normalize() + migrate() live in schema.mjs, so the ladder is unit-tested -----
backup('startup') // snapshot before any migration touches the store
{
  const db = JSON.parse(readRow().doc)
  if (migrate(db)) {
    writeDoc(db) // unconditional: no clients are connected yet
    console.log('migrated sqlite store to the current schema')
  }
}

// ----- optional OIDC auth (Keycloak) -----
// Enabled when OIDC_ISSUER is set at server start, e.g.:
//   OIDC_ISSUER=https://keycloak.example.com/realms/myrealm OIDC_CLIENT_ID=feature-planner node server/index.mjs
// Roles (realm or client roles on the access token):
// 'feature-planner-viewer' (read) and 'feature-planner-editor' (read + write).
const OIDC_ISSUER = process.env.OIDC_ISSUER?.replace(/\/$/, '')
const OIDC_CLIENT_ID = process.env.OIDC_CLIENT_ID || 'feature-planner'
const OIDC_AUDIENCE = process.env.OIDC_AUDIENCE // optional extra check
const ROLE_VIEWER = 'feature-planner-viewer'
const ROLE_EDITOR = 'feature-planner-editor'

let requireRole = () => (_req, _res, next) => next()
if (OIDC_ISSUER) {
  const jwks = createRemoteJWKSet(new URL(`${OIDC_ISSUER}/protocol/openid-connect/certs`))
  const rolesOf = (payload) => {
    const roles = new Set(payload.realm_access?.roles ?? [])
    for (const client of Object.values(payload.resource_access ?? {})) {
      for (const r of client.roles ?? []) roles.add(r)
    }
    return roles
  }
  requireRole = (role) => async (req, res, next) => {
    const m = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')
    if (!m) return res.status(401).json({ error: 'missing bearer token' })
    try {
      const { payload } = await jwtVerify(m[1], jwks, {
        issuer: OIDC_ISSUER,
        ...(OIDC_AUDIENCE ? { audience: OIDC_AUDIENCE } : {}),
      })
      const roles = rolesOf(payload)
      // editor implies viewer
      const ok = role === ROLE_VIEWER ? roles.has(ROLE_VIEWER) || roles.has(ROLE_EDITOR) : roles.has(role)
      if (!ok) return res.status(403).json({ error: `role '${role}' required` })
      req.user = { sub: payload.sub, name: payload.preferred_username, roles: [...roles] }
      next()
    } catch {
      res.status(401).json({ error: 'invalid token' })
    }
  }
  console.log(`OIDC auth enabled (issuer: ${OIDC_ISSUER}, client: ${OIDC_CLIENT_ID})`)
}

const app = express()
app.use(express.json({ limit: '10mb' }))

app.get('/api/auth/config', (_req, res) => {
  res.json({ enabled: !!OIDC_ISSUER, issuer: OIDC_ISSUER ?? null, clientId: OIDC_CLIENT_ID })
})

app.get('/api/data', requireRole(ROLE_VIEWER), (_req, res) => {
  const row = readRow()
  // send the stored bytes verbatim (no reparse) and hand the client the version to echo on PUT
  res.set('X-Data-Version', String(row.version))
  res.type('application/json').send(row.doc)
})

app.put('/api/data', requireRole(ROLE_EDITOR), (req, res) => {
  const body = req.body
  // shared/db.mjs — an import is checked in full (the client ran the same check before uploading);
  // an autosave skips the reference checks so a database that already carries a stale id keeps saving
  const importing = req.query.reason === 'import'
  const problem = payloadProblem(body, { references: importing })
  if (problem) return res.status(400).json({ error: problem })
  try {
    migrate(body) // fill defaults and apply schema upgrades, so an older export lands current
  } catch (e) {
    // anything the structural check let through but the repair could not read is the file's
    // fault, not a server error
    return res.status(400).json({ error: `could not read the database: ${e instanceof Error ? e.message : String(e)}` })
  }
  // Optimistic concurrency: a normal autosave echoes the version it last saw in X-Data-Version and
  // the write only lands if the store is still at that version. A whole-database import omits the
  // header and writes unconditionally (the user has confirmed replacing everything).
  const header = req.headers['x-data-version']
  const expected = header != null && header !== '' ? Number(header) : null
  // An import replaces the whole database, so it always snapshots what it overwrites — the
  // once-a-day rule would skip it on a day that already has a snapshot.
  backup(importing ? 'import' : 'daily')
  const { ok, version } = writeDoc(body, expected)
  res.set('X-Data-Version', String(version))
  if (!ok) return res.status(409).json({ error: 'stale version — the database changed since you loaded it', currentVersion: version })
  res.json({ ok: true, version })
})

app.get('/api/backups', requireRole(ROLE_VIEWER), (_req, res) => {
  const files = backupFiles() // oldest-first by mtime
    .reverse()
    .map(({ name }) => ({ name, size: fs.statSync(path.join(BACKUP_DIR, name)).size }))
  res.json(files)
})

app.get('/api/backups/:name', requireRole(ROLE_VIEWER), (req, res) => {
  const name = path.basename(req.params.name) // strip any path traversal
  const file = path.join(BACKUP_DIR, name)
  if (!name.endsWith('.json') || !fs.existsSync(file)) return res.status(404).json({ error: 'not found' })
  res.download(file, name)
})

// ----- shared vacation calendar -----
// The team's absences (vacation, public holidays, parental leave, …) come from a calendar with a
// public ICS export — typically a Google Calendar fed by an HR tool. The server pulls it (the feed
// sends no CORS headers, so the browser could not) and writes the matching people's away periods
// itself, on boot and every VACATION_SYNC_HOURS, so the plan is fresh for viewers who never click
// anything. Editors can also trigger it from ⚙ Settings. Matching and merge rules live in
// vacations.mjs.
//   settings.calendarUrl     the .ics link, set in ⚙ Settings → Settings… (stored in the database)
//   VACATION_CALENDAR_URL    a fallback link for deployments that configure it by environment
//   VACATION_SYNC_HOURS      interval for the automatic pull (default 6; 0 = manual only)
const VACATION_SYNC_HOURS = Math.max(0, Number(process.env.VACATION_SYNC_HOURS ?? 6) || 0)

/** the link to pull right now: the database's setting, else the environment, else nothing */
const calendarUrl = () => resolveCalendarUrl(JSON.parse(readRow().doc).settings?.calendarUrl, process.env.VACATION_CALENDAR_URL)

/** what the last pull did — served to the client so the People dialog can say who is not in the calendar */
let lastVacationSync = null
let vacationSyncInFlight = null

/**
 * One pull: fetch, parse, merge, write. The write is guarded by the store version exactly like an
 * editor's PUT, and retried on a fresh read when it loses the race — an unconditional write here
 * could silently drop an edit that landed between our read and our write. Nothing is written when
 * the feed changes nothing, so idle pulls do not advance the version. Concurrent callers (the timer
 * and a click) share one run. With no link configured nothing runs and nothing is recorded.
 */
function syncVacations(reason) {
  if (vacationSyncInFlight) return vacationSyncInFlight
  const url = calendarUrl()
  if (!url) return Promise.resolve({ at: new Date().toISOString(), reason, ok: false, error: 'no vacation calendar link configured' })
  vacationSyncInFlight = (async () => {
    const at = new Date().toISOString()
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { accept: 'text/calendar' } })
      if (!res.ok) throw new Error(`calendar answered HTTP ${res.status}`)
      const events = parseIcs(await res.text())
      if (events.length === 0) throw new Error('calendar feed has no events')
      let result
      for (let attempt = 1; ; attempt++) {
        const row = readRow()
        const db = JSON.parse(row.doc)
        result = applyCalendar(db, events)
        if (!result.changed) break
        backup('daily')
        if (writeDoc(db, row.version).ok) break
        if (attempt >= 3) throw new Error('database kept changing under the sync')
      }
      const { changed, ...summary } = result
      lastVacationSync = { at, reason, ok: true, changed, ...summary }
      console.log(
        `vacation calendar (${reason}): ${summary.matched} people matched, ${summary.imported} periods` +
          (summary.approxPeople?.length ? `, ${summary.approxPeople.length} by near-miss name` : '') +
          (summary.holidayOnly ? `, ${summary.holidayOnly} not in the calendar given the shared holidays` : '') +
          (summary.replacedManual ? `, ${summary.replacedManual} manual replaced` : '') +
          (changed ? '' : ' — nothing changed'),
      )
    } catch (e) {
      const error = e instanceof Error ? (e.name === 'TimeoutError' ? 'calendar did not answer in time' : e.message) : String(e)
      lastVacationSync = { at, reason, ok: false, error }
      console.warn(`vacation calendar (${reason}) failed: ${error}`)
    }
    return lastVacationSync
  })().finally(() => {
    vacationSyncInFlight = null
  })
  return vacationSyncInFlight
}

app.get('/api/vacations/status', requireRole(ROLE_VIEWER), (_req, res) => {
  const url = calendarUrl()
  res.json({ enabled: !!url, url: url || null, intervalHours: VACATION_SYNC_HOURS, lastSync: lastVacationSync })
})

app.post('/api/vacations/sync', requireRole(ROLE_EDITOR), async (_req, res) => {
  if (!calendarUrl()) return res.status(404).json({ error: 'vacation calendar not configured — add the link under ⚙ Settings → Settings…' })
  const result = await syncVacations('manual')
  res.set('X-Data-Version', String(currentVersion()))
  if (!result.ok) return res.status(502).json({ error: result.error })
  res.json(result)
})

{
  const url = calendarUrl()
  console.log(`vacation calendar: ${url || 'not configured (set the link in ⚙ Settings)'} (auto-sync ${VACATION_SYNC_HOURS ? `every ${VACATION_SYNC_HOURS}h` : 'off'})`)
  if (url) void syncVacations('startup')
  // the timer is always armed: a link added later in Settings is picked up on the next tick
  if (VACATION_SYNC_HOURS) setInterval(() => void syncVacations('timer'), VACATION_SYNC_HOURS * 60 * 60 * 1000).unref()
}

// ----- serve the built frontend (production single-container mode) -----
// In dev the SPA is served by Vite (npm run dev); dist only exists in the image.
const DIST_DIR = path.resolve(__dirname, '../dist')
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR))
  // SPA fallback for everything that isn't an /api/ route or a real asset.
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(DIST_DIR, 'index.html')))
}

setInterval(() => backup('daily'), 6 * 60 * 60 * 1000).unref() // idle days still get a snapshot

app.listen(PORT, () => console.log(`feature-planner storage server on http://localhost:${PORT} (db: ${DB_FILE})`))
