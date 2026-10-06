import express from 'express'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import Database from 'better-sqlite3'
import { applyCalendar, parseIcs, resolveCalendarUrl } from './vacations.mjs'
import { migrate } from './schema.mjs'
import { StoreError, openStore } from './store.mjs'
import { PROGRAM_ID, payloadProblem } from '../shared/db.mjs'
import { FULL_ACCESS, accessOf, canEditTeam, editorRole, rolesOfToken } from '../shared/auth.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// DATA_DIR: where the database and its backups live (default ../data; the Docker image mounts /app/data)
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '../data'))
const DB_FILE = path.join(DATA_DIR, 'db.sqlite')
const LEGACY_JSON = path.join(DATA_DIR, 'db.json') // pre-SQLite storage; seeded from once
const BACKUP_DIR = path.join(DATA_DIR, 'backups')
const SEED_FILE = path.join(__dirname, 'seed.json')
const SEED_TEAMS_FILE = path.join(__dirname, 'seed-teams.json') // the other demo teams, [{ id, name, doc }]
const PORT = process.env.PORT || 3179
const BACKUP_KEEP = Number(process.env.BACKUP_KEEP || 30)

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

// ----- SQLite store -----
// One plan document per team, each the whole plan as one JSON blob in a row of `docs` (store.mjs).
// The API (GET/PUT /api/teams/:id/data) and the migrate()/normalize() logic are per document; the
// container gives atomic crash-safe writes and a real version counter behind optimistic concurrency
// (the X-Data-Version header).
const sqlite = new Database(DB_FILE)
sqlite.pragma('journal_mode = WAL') // concurrent readers don't block the writer
sqlite.pragma('busy_timeout = 5000') // wait on a lock rather than throwing SQLITE_BUSY
const store = openStore(sqlite, { backupDir: BACKUP_DIR, backupKeep: BACKUP_KEEP })

// The single-plan layout from before teams becomes team "default"; a database with no team at all
// is seeded — from a pre-SQLite db.json when it exists (an upgrade keeps its data, as team
// "Default"), else with the demo teams: "Demo team" from seed.json and the ones in seed-teams.json.
if (store.migrateLegacy()) console.log('moved the single plan into team "default"')
{
  const legacy = fs.existsSync(LEGACY_JSON)
  const extra = !legacy && fs.existsSync(SEED_TEAMS_FILE) ? JSON.parse(fs.readFileSync(SEED_TEAMS_FILE, 'utf8')) : []
  const seeded = store.seedIfEmpty(
    legacy
      ? [{ id: 'default', name: 'Default', doc: fs.readFileSync(LEGACY_JSON, 'utf8') }]
      : [{ id: 'demo', name: 'Demo team', doc: fs.readFileSync(SEED_FILE, 'utf8') }, ...extra.map((t) => ({ id: t.id, name: t.name, doc: JSON.stringify(t.doc, null, 2) }))],
  )
  if (seeded.length) console.log(`seeded ${seeded.map((t) => `"${t.name}"`).join(', ')} from ${legacy ? path.basename(LEGACY_JSON) : 'the demo seeds'}`)
}
// The built-in Program team reads every other team; a database from before it existed gets one now.
if (!store.getTeam(PROGRAM_ID)) console.log(`created the "${store.ensureProgram().name}" team`)

// ----- schema: normalize() + migrate() live in schema.mjs, so the ladder is unit-tested -----
for (const t of store.listTeams()) {
  store.backup(t.id, 'startup') // snapshot before any migration touches the document
  const db = JSON.parse(store.readRow(t.id).doc)
  if (migrate(db)) {
    store.writeDoc(t.id, db) // unconditional: no clients are connected yet
    console.log(`migrated team "${t.id}" to the current schema`)
  }
}

// ----- optional OIDC auth (Keycloak) -----
// Enabled when OIDC_ISSUER is set at server start, e.g.:
//   OIDC_ISSUER=https://keycloak.example.com/realms/myrealm OIDC_CLIENT_ID=feature-planner node server/index.mjs
// Roles (realm or client roles on the access token), see shared/auth.mjs:
//   feature-planner-admin             everything, every team, the Program, team management
//   feature-planner-editor:<team-id>  write that team's plan; read everything
//   feature-planner-viewer            read everything
// `authenticate` runs on every /api route but /api/auth/config and leaves `req.access` behind;
// the three guards below read it. With auth off everyone is an admin.
const OIDC_ISSUER = process.env.OIDC_ISSUER?.replace(/\/$/, '')
const OIDC_CLIENT_ID = process.env.OIDC_CLIENT_ID || 'feature-planner'
const OIDC_AUDIENCE = process.env.OIDC_AUDIENCE // optional extra check

let authenticate = (req, _res, next) => {
  req.access = FULL_ACCESS
  next()
}
if (OIDC_ISSUER) {
  const jwks = createRemoteJWKSet(new URL(`${OIDC_ISSUER}/protocol/openid-connect/certs`))
  authenticate = async (req, res, next) => {
    const m = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')
    if (!m) return res.status(401).json({ error: 'missing bearer token' })
    try {
      const { payload } = await jwtVerify(m[1], jwks, {
        issuer: OIDC_ISSUER,
        ...(OIDC_AUDIENCE ? { audience: OIDC_AUDIENCE } : {}),
      })
      const roles = rolesOfToken(payload)
      req.user = { sub: payload.sub, name: payload.preferred_username, roles: [...roles] }
      req.access = accessOf(roles)
      next()
    } catch {
      res.status(401).json({ error: 'invalid token' })
    }
  }
  console.log(`OIDC auth enabled (issuer: ${OIDC_ISSUER}, client: ${OIDC_CLIENT_ID})`)
}

/** any planner role: read everything */
const requireView = (req, res, next) => (req.access.canView ? next() : res.status(403).json({ error: 'no access — a feature-planner role is required' }))
/** team management and the Program: admins only */
const requireAdmin = (req, res, next) => (req.access.admin ? next() : res.status(403).json({ error: 'admin role required' }))
/** after withTeam: write this team's plan — admins, or the holder of its editor role */
const requireTeamEdit = (req, res, next) =>
  canEditTeam(req.access, req.team.id)
    ? next()
    : res.status(403).json({
        error: req.team.id === PROGRAM_ID ? 'only admins can edit the Program' : `you cannot edit team "${req.team.name}" — role '${editorRole(req.team.id)}' required`,
      })

const app = express()
app.use(express.json({ limit: '10mb' }))

app.get('/api/auth/config', (_req, res) => {
  res.json({ enabled: !!OIDC_ISSUER, issuer: OIDC_ISSUER ?? null, clientId: OIDC_CLIENT_ID })
})
app.use('/api', authenticate) // everything below carries req.access

// ----- teams -----
// A StoreError carries its HTTP status (400 bad name, 404 unknown team, 409 duplicate name / last team).
const storeErrors = (fn) => (req, res) => {
  try {
    fn(req, res)
  } catch (e) {
    if (e instanceof StoreError) return res.status(e.status).json({ error: e.message })
    throw e
  }
}

app.get('/api/teams', requireView, (_req, res) => res.json(store.listTeams()))

// The Program team's view of the others: every team but Program, in switcher order, each with its
// whole current document and version, in one round-trip. The client does the aggregation (the
// capacity, schedule and roadmap maths live in src/), so it needs the documents, not summaries.
app.get('/api/program/teams', requireView, (_req, res) => {
  const teams = store
    .listTeams()
    .filter((t) => t.id !== PROGRAM_ID)
    .map((t) => {
      const row = store.readRow(t.id)
      return { id: t.id, name: t.name, position: t.position, version: row.version, doc: JSON.parse(row.doc) }
    })
  res.json({ asOf: new Date().toISOString(), teams })
})

app.post(
  '/api/teams',
  requireAdmin,
  storeErrors((req, res) => {
    const { name, copySettingsFrom } = req.body ?? {}
    res.status(201).json(store.createTeam({ name, copySettingsFrom }))
  }),
)

/** every /api/teams/:id/… route: the team must exist */
const withTeam = (req, res, next) => {
  const team = store.getTeam(req.params.id)
  if (!team) return res.status(404).json({ error: 'no such team' })
  req.team = team
  next()
}

app.patch(
  '/api/teams/:id',
  requireAdmin,
  withTeam,
  storeErrors((req, res) => res.json(store.renameTeam(req.team.id, req.body?.name))),
)

app.delete(
  '/api/teams/:id',
  requireAdmin,
  withTeam,
  storeErrors((req, res) => {
    store.deleteTeam(req.team.id) // snapshots the plan to its backups first
    vacation.delete(req.team.id)
    res.status(204).end()
  }),
)

// ----- the plan document -----

app.get('/api/teams/:id/data', requireView, withTeam, (req, res) => {
  const row = store.readRow(req.team.id)
  // send the stored bytes verbatim (no reparse) and hand the client the version to echo on PUT
  res.set('X-Data-Version', String(row.version))
  res.type('application/json').send(row.doc)
})

app.put('/api/teams/:id/data', withTeam, requireTeamEdit, (req, res) => {
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
  // the write only lands if the store is still at that version. A whole-document import omits the
  // header and writes unconditionally (the user has confirmed replacing everything).
  const header = req.headers['x-data-version']
  const expected = header != null && header !== '' ? Number(header) : null
  // An import replaces the whole plan, so it always snapshots what it overwrites — the once-a-day
  // rule would skip it on a day that already has a snapshot.
  store.backup(req.team.id, importing ? 'import' : 'daily')
  const { ok, version } = store.writeDoc(req.team.id, body, expected)
  res.set('X-Data-Version', String(version))
  if (!ok) return res.status(409).json({ error: 'stale version — the database changed since you loaded it', currentVersion: version })
  res.json({ ok: true, version })
})

app.get('/api/teams/:id/backups', requireView, withTeam, (req, res) => {
  const files = store
    .backupFiles(req.team.id) // oldest-first by mtime
    .reverse()
    .map(({ name, size }) => ({ name, size }))
  res.json(files)
})

app.get('/api/teams/:id/backups/:name', requireView, withTeam, (req, res) => {
  const file = store.backupPath(req.team.id, req.params.name)
  if (!file) return res.status(404).json({ error: 'not found' })
  res.download(file, path.basename(file))
})

// ----- shared vacation calendar, per team -----
// A team's absences (vacation, public holidays, parental leave, …) come from a calendar with a
// public ICS export — typically a Google Calendar fed by an HR tool. The server pulls it (the feed
// sends no CORS headers, so the browser could not) and writes the matching people's away periods
// itself, on boot and every VACATION_SYNC_HOURS, so the plan is fresh for viewers who never click
// anything. Editors can also trigger it from ⚙ Settings. Matching and merge rules live in
// vacations.mjs.
//   settings.calendarUrl     the team's .ics link, set in ⚙ Settings → Settings… (stored in its document)
//   VACATION_CALENDAR_URL    a fallback link for every team without one of its own
//   VACATION_SYNC_HOURS      interval for the automatic pull (default 6; 0 = manual only)
const VACATION_SYNC_HOURS = Math.max(0, Number(process.env.VACATION_SYNC_HOURS ?? 6) || 0)

/** the link to pull for a team right now: its document's setting, else the environment, else nothing; the Program team has no roster to sync */
const calendarUrl = (teamId) => (teamId === PROGRAM_ID ? '' : resolveCalendarUrl(JSON.parse(store.readRow(teamId).doc).settings?.calendarUrl, process.env.VACATION_CALENDAR_URL))

/** per team: what the last pull did (served to the client so the People dialog can say who is not in the calendar) and the pull in flight */
const vacation = new Map()
const vacationState = (teamId) => {
  let s = vacation.get(teamId)
  if (!s) vacation.set(teamId, (s = { lastSync: null, inFlight: null }))
  return s
}

/**
 * One pull for one team: fetch, parse, merge, write. The write is guarded by the document version
 * exactly like an editor's PUT, and retried on a fresh read when it loses the race — an unconditional
 * write here could silently drop an edit that landed between our read and our write. Nothing is
 * written when the feed changes nothing, so idle pulls do not advance the version. Concurrent callers
 * (the timer and a click) share one run. With no link configured nothing runs and nothing is recorded.
 */
function syncVacations(teamId, reason) {
  const state = vacationState(teamId)
  if (state.inFlight) return state.inFlight
  const url = calendarUrl(teamId)
  if (!url) return Promise.resolve({ at: new Date().toISOString(), reason, ok: false, error: 'no vacation calendar link configured' })
  state.inFlight = (async () => {
    const at = new Date().toISOString()
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { accept: 'text/calendar' } })
      if (!res.ok) throw new Error(`calendar answered HTTP ${res.status}`)
      const events = parseIcs(await res.text())
      if (events.length === 0) throw new Error('calendar feed has no events')
      let result
      for (let attempt = 1; ; attempt++) {
        const row = store.readRow(teamId)
        if (!row) throw new Error('the team was deleted during the sync')
        const db = JSON.parse(row.doc)
        result = applyCalendar(db, events)
        if (!result.changed) break
        store.backup(teamId, 'daily')
        if (store.writeDoc(teamId, db, row.version).ok) break
        if (attempt >= 3) throw new Error('database kept changing under the sync')
      }
      const { changed, ...summary } = result
      state.lastSync = { at, reason, ok: true, changed, ...summary }
      console.log(
        `vacation calendar [${teamId}] (${reason}): ${summary.matched} people matched, ${summary.imported} periods` +
          (summary.approxPeople?.length ? `, ${summary.approxPeople.length} by near-miss name` : '') +
          (summary.holidayOnly ? `, ${summary.holidayOnly} not in the calendar given the shared holidays` : '') +
          (summary.replacedManual ? `, ${summary.replacedManual} manual replaced` : '') +
          (changed ? '' : ' — nothing changed'),
      )
    } catch (e) {
      const error = e instanceof Error ? (e.name === 'TimeoutError' ? 'calendar did not answer in time' : e.message) : String(e)
      state.lastSync = { at, reason, ok: false, error }
      console.warn(`vacation calendar [${teamId}] (${reason}) failed: ${error}`)
    }
    return state.lastSync
  })().finally(() => {
    state.inFlight = null
  })
  return state.inFlight
}

app.get('/api/teams/:id/vacations/status', requireView, withTeam, (req, res) => {
  const url = calendarUrl(req.team.id)
  res.json({ enabled: !!url, url: url || null, intervalHours: VACATION_SYNC_HOURS, lastSync: vacationState(req.team.id).lastSync })
})

app.post('/api/teams/:id/vacations/sync', withTeam, requireTeamEdit, async (req, res) => {
  if (!calendarUrl(req.team.id)) return res.status(404).json({ error: 'vacation calendar not configured — add the link under ⚙ Settings → Settings…' })
  const result = await syncVacations(req.team.id, 'manual')
  res.set('X-Data-Version', String(store.currentVersion(req.team.id)))
  if (!result.ok) return res.status(502).json({ error: result.error })
  res.json(result)
})

{
  const linked = store.listTeams().filter((t) => calendarUrl(t.id))
  console.log(
    `vacation calendar: ${linked.length ? `${linked.length} of ${store.listTeams().length - 1} teams linked` : 'no team linked (set the link in ⚙ Settings)'}` +
      ` (auto-sync ${VACATION_SYNC_HOURS ? `every ${VACATION_SYNC_HOURS}h` : 'off'})`,
  )
  for (const t of linked) void syncVacations(t.id, 'startup')
  // the timer is always armed and walks every team: a link added later in Settings, or a team
  // created later, is picked up on the next tick
  if (VACATION_SYNC_HOURS) {
    setInterval(() => {
      for (const t of store.listTeams()) if (calendarUrl(t.id)) void syncVacations(t.id, 'timer')
    }, VACATION_SYNC_HOURS * 60 * 60 * 1000).unref()
  }
}

// ----- serve the built frontend (production single-container mode) -----
// In dev the SPA is served by Vite (npm run dev); dist only exists in the image.
const DIST_DIR = path.resolve(__dirname, '../dist')
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR))
  // SPA fallback for everything that isn't an /api/ route or a real asset.
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(DIST_DIR, 'index.html')))
}

// idle days still get a snapshot, for every team
setInterval(() => {
  for (const t of store.listTeams()) store.backup(t.id, 'daily')
}, 6 * 60 * 60 * 1000).unref()

app.listen(PORT, () => console.log(`feature-planner storage server on http://localhost:${PORT} (db: ${DB_FILE}, ${store.listTeams().length} team${store.listTeams().length === 1 ? '' : 's'})`))
