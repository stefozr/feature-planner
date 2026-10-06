// The SQLite store: one plan document per team. `openStore(sqlite, …)` takes an open
// better-sqlite3 database and the backup directory, so the server opens the real file and the
// tests open `:memory:` with a temp directory. Nothing here knows about Express or the request;
// the routes in index.mjs translate a StoreError into its HTTP status.
//
//   teams  id (slug, in URLs, never changes) · name (unique, case-folded) · position · created_at
//   docs   team_id → the whole plan as JSON, with the version counter behind optimistic concurrency
//
// Before teams existed the plan was one row in a `store` table (id = 1); migrateLegacy() moves it
// into team `default` once.
import fs from 'fs'
import path from 'path'
import { migrate, SCHEMA_VERSION } from './schema.mjs'
import { PROGRAM_ID } from '../shared/db.mjs'

export class StoreError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/**
 * ids a team may not take: the view names the hash starts with when no team is given, the API
 * prefix, and the built-in Program team's slug (ensureProgram() inserts that one itself)
 */
export const RESERVED_IDS = new Set(['planner', 'capacity', 'status', 'roadmap', 'api', PROGRAM_ID])
export const TEAM_ID = /^[a-z0-9][a-z0-9-]{0,39}$/
/** @param {unknown} id */
export const isTeamId = (id) => typeof id === 'string' && TEAM_ID.test(id) && !RESERVED_IDS.has(id)

/** the URL slug of a team name: accents folded, lower case, runs of anything else become one dash */
export function slugify(name) {
  return String(name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
}

export const NAME_MAX = 60
/** the settings a new team may take over from another one — lists, colours and the calendar grid, not the team's own data */
export const COPIED_SETTINGS = ['projectStart', 'horizonWeeks', 'hoursPerWeek', 'profiles', 'featureStatuses', 'customers', 'optionColors', 'linkCategories']

/** @param {unknown} name @returns {string} */
function cleanName(name) {
  const n = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : ''
  if (!n) throw new StoreError(400, 'the team needs a name')
  if (n.length > NAME_MAX) throw new StoreError(400, `the team name is longer than ${NAME_MAX} characters`)
  return n
}

/**
 * @param {import('better-sqlite3').Database} sqlite
 * @param {{ backupDir: string; backupKeep?: number }} opts
 */
export function openStore(sqlite, { backupDir, backupKeep = 30 }) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS teams (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
      position   INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS docs (
      team_id    TEXT PRIMARY KEY REFERENCES teams(id),
      doc        TEXT    NOT NULL,
      version    INTEGER NOT NULL,
      updated_at TEXT    NOT NULL
    )`)
  fs.mkdirSync(backupDir, { recursive: true })

  const q = {
    teams: sqlite.prepare('SELECT id, name, position, created_at AS createdAt FROM teams ORDER BY position, created_at'),
    team: sqlite.prepare('SELECT id, name, position, created_at AS createdAt FROM teams WHERE id = ?'),
    byName: sqlite.prepare('SELECT id FROM teams WHERE name = ? COLLATE NOCASE'),
    count: sqlite.prepare('SELECT COUNT(*) AS n FROM teams'),
    countOthers: sqlite.prepare('SELECT COUNT(*) AS n FROM teams WHERE id <> ?'),
    nextPosition: sqlite.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM teams'),
    insertTeam: sqlite.prepare('INSERT INTO teams (id, name, position, created_at) VALUES (?, ?, ?, ?)'),
    insertDoc: sqlite.prepare('INSERT INTO docs (team_id, doc, version, updated_at) VALUES (?, ?, ?, ?)'),
    rename: sqlite.prepare('UPDATE teams SET name = ? WHERE id = ?'),
    deleteDoc: sqlite.prepare('DELETE FROM docs WHERE team_id = ?'),
    deleteTeam: sqlite.prepare('DELETE FROM teams WHERE id = ?'),
    row: sqlite.prepare('SELECT doc, version FROM docs WHERE team_id = ?'),
    version: sqlite.prepare('SELECT version FROM docs WHERE team_id = ?'),
    write: sqlite.prepare('UPDATE docs SET doc = ?, version = version + 1, updated_at = ? WHERE team_id = ?'),
    writeGuarded: sqlite.prepare('UPDATE docs SET doc = ?, version = version + 1, updated_at = ? WHERE team_id = ? AND version = ?'),
    docs: sqlite.prepare('SELECT team_id AS id, doc FROM docs'),
  }
  const now = () => new Date().toISOString()

  // ----- teams -----

  /** every team in switcher order, with the counts the switcher and the delete confirm show; the Program team is flagged `builtin` */
  function listTeams() {
    const counts = new Map()
    for (const { id, doc } of q.docs.all()) {
      try {
        const d = JSON.parse(doc)
        counts.set(id, { features: Array.isArray(d.features) ? d.features.length : 0, people: Array.isArray(d.people) ? d.people.length : 0 })
      } catch {
        counts.set(id, { features: 0, people: 0 })
      }
    }
    return q.teams.all().map((t) => ({ ...t, builtin: t.id === PROGRAM_ID, ...(counts.get(t.id) ?? { features: 0, people: 0 }) }))
  }

  const getTeam = (id) => q.team.get(id)

  /** a slug nobody holds yet: the name's, else the name's with -2, -3, … */
  function freeId(name) {
    const base = slugify(name) || 'team'
    for (let n = 1; ; n++) {
      const id = n === 1 ? base : `${base.slice(0, 40 - `-${n}`.length)}-${n}`
      if (isTeamId(id) && !getTeam(id)) return id
    }
  }

  const insert = sqlite.transaction((id, name, docJson, version) => {
    const at = now()
    q.insertTeam.run(id, name, q.nextPosition.get().p, at)
    q.insertDoc.run(id, docJson, version, at)
  })

  /**
   * A new team. Its document is empty — no people, packages, releases or roadmap — with either the
   * defaults normalize() seeds, or the settings lists copied from `copySettingsFrom`. The calendar
   * link and the sheet-import mapping are never copied: one is another team's roster, the other
   * names that team's people by id.
   * @param {{ name?: unknown; copySettingsFrom?: unknown }} input
   */
  function createTeam({ name, copySettingsFrom } = {}) {
    const clean = cleanName(name)
    if (q.byName.get(clean)) throw new StoreError(409, `a team named "${clean}" already exists`)
    const settings = {}
    if (copySettingsFrom != null && copySettingsFrom !== '') {
      if (copySettingsFrom === PROGRAM_ID) throw new StoreError(400, 'the Program team has no team settings to copy')
      const row = typeof copySettingsFrom === 'string' ? q.row.get(copySettingsFrom) : null
      if (!row) throw new StoreError(404, 'the team to copy settings from does not exist')
      const source = JSON.parse(row.doc).settings ?? {}
      for (const k of COPIED_SETTINGS) if (source[k] !== undefined) settings[k] = structuredClone(source[k])
    }
    const doc = { people: [], epics: [], features: [], stories: [], releases: [], milestones: [], workstreams: [], settings, schemaVersion: SCHEMA_VERSION }
    migrate(doc) // fills whatever was not copied with the defaults
    const id = freeId(clean)
    insert(id, clean, JSON.stringify(doc, null, 2), 1)
    return getTeam(id)
  }

  function renameTeam(id, name) {
    if (!getTeam(id)) throw new StoreError(404, 'no such team')
    const clean = cleanName(name)
    const holder = q.byName.get(clean)
    if (holder && holder.id !== id) throw new StoreError(409, `a team named "${clean}" already exists`)
    q.rename.run(clean, id)
    return getTeam(id)
  }

  const remove = sqlite.transaction((id) => {
    q.deleteDoc.run(id)
    q.deleteTeam.run(id)
  })

  /** Snapshot, then remove. The last real team stays (the app always needs one to show), and the Program team is never removed. */
  function deleteTeam(id) {
    if (!getTeam(id)) throw new StoreError(404, 'no such team')
    if (id === PROGRAM_ID) throw new StoreError(409, 'the Program team is built in and cannot be deleted')
    if (q.countOthers.get(PROGRAM_ID).n <= 1) throw new StoreError(409, 'the last team cannot be deleted')
    backup(id, 'delete')
    remove(id)
  }

  /**
   * The built-in Program team, created on first sight: an empty plan of its own (no people or
   * features — it reads every other team's) plus `program.tracking`, its notes on their features.
   * Its name is "Program" unless a team already holds that name. Returns the team either way.
   */
  function ensureProgram() {
    const existing = getTeam(PROGRAM_ID)
    if (existing) return existing
    let name = 'Program'
    for (let n = 2; q.byName.get(name); n++) name = n === 2 ? 'Program (all teams)' : `Program ${n}`
    const doc = { people: [], epics: [], features: [], stories: [], releases: [], milestones: [], workstreams: [], settings: {}, program: { tracking: {} }, schemaVersion: SCHEMA_VERSION }
    migrate(doc)
    insert(PROGRAM_ID, name, JSON.stringify(doc, null, 2), 1)
    return getTeam(PROGRAM_ID)
  }

  // ----- documents -----

  const readRow = (teamId) => q.row.get(teamId)
  const currentVersion = (teamId) => q.version.get(teamId)?.version

  /**
   * Persist a team's document. When `expected` is a number the write is guarded: it only lands if
   * the stored version still equals it, otherwise nothing changes and { ok:false } is returned (a
   * stale write from another editor). `expected === null` writes unconditionally (startup migration
   * and whole-database imports, which intentionally replace everything). Returns the resulting version.
   */
  function writeDoc(teamId, docObj, expected = null) {
    const json = JSON.stringify(docObj, null, 2)
    const info = expected == null ? q.write.run(json, now(), teamId) : q.writeGuarded.run(json, now(), teamId, expected)
    return { ok: info.changes > 0, version: currentVersion(teamId) }
  }

  // ----- backups: data/backups/<team>/db-<stamp>-<reason>.json, the newest backupKeep kept per team -----
  // Reasons: startup (every boot, skipped when identical to the newest), daily (at most one a day,
  // on save), import (before a whole-document import), delete (before the team goes).

  const teamDir = (teamId) => path.join(backupDir, teamId)

  /** a team's backup files, oldest-first by mtime (older filename formats may sit next to the current one) */
  function backupFiles(teamId) {
    const dir = teamDir(teamId)
    if (!fs.existsSync(dir)) return []
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((name) => {
        const st = fs.statSync(path.join(dir, name))
        return { name, mtime: st.mtimeMs, size: st.size }
      })
      .sort((a, b) => a.mtime - b.mtime)
  }

  /** the file behind a backup name, or null when the name is not one of the team's backups */
  function backupPath(teamId, name) {
    const base = path.basename(String(name)) // strip any path traversal
    const file = path.join(teamDir(teamId), base)
    return base.endsWith('.json') && fs.existsSync(file) ? file : null
  }

  function backup(teamId, reason = 'startup') {
    const row = readRow(teamId)
    if (!row) return false
    const date = new Date()
    const day = date.toISOString().slice(0, 10)
    const files = backupFiles(teamId)
    if (reason === 'daily' && files.some((f) => f.name.startsWith(`db-${day}`) && f.name.includes('daily'))) return false
    // pretty-print so snapshots stay diffable
    const current = Buffer.from(JSON.stringify(JSON.parse(row.doc), null, 2))
    const dir = teamDir(teamId)
    const newest = files[files.length - 1]
    // a restart that changed nothing shouldn't push real history out of the ring
    if (reason === 'startup' && newest && fs.readFileSync(path.join(dir, newest.name)).equals(current)) return false
    fs.mkdirSync(dir, { recursive: true })
    const stamp = date.toISOString().replace(/[:.]/g, '-').slice(0, 19)
    fs.writeFileSync(path.join(dir, `db-${stamp}-${reason}.json`), current)
    const all = backupFiles(teamId)
    for (const f of all.slice(0, Math.max(0, all.length - backupKeep))) fs.rmSync(path.join(dir, f.name))
    return true
  }

  // ----- first boot and the move from the single-plan store -----

  /**
   * The pre-teams layout: one `store` row holding the plan. Move it into team `default`, drop the
   * table, and move the root-level backup files into that team's folder so they stay listed. Runs
   * once; with no `store` table it does nothing. Returns true when a plan was moved.
   */
  function migrateLegacy() {
    if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'store'").get()) return false
    const row = sqlite.prepare('SELECT doc, version, updated_at FROM store WHERE id = 1').get()
    sqlite.transaction(() => {
      if (row && q.count.get().n === 0) {
        q.insertTeam.run('default', 'Default', 0, row.updated_at)
        q.insertDoc.run('default', row.doc, row.version, row.updated_at)
      }
      sqlite.exec('DROP TABLE store')
    })()
    if (row) {
      const dir = teamDir('default')
      fs.mkdirSync(dir, { recursive: true })
      for (const f of fs.readdirSync(backupDir)) {
        if (/^db-.*\.json$/.test(f) && fs.statSync(path.join(backupDir, f)).isFile()) fs.renameSync(path.join(backupDir, f), path.join(dir, f))
      }
    }
    return !!row
  }

  /**
   * A database with no teams gets these, in order, in one transaction: `[{ id, name, doc }]`, where
   * `doc` is the raw document text (the shipped seeds, or a pre-SQLite db.json). The text is stored
   * verbatim — migrate() runs afterwards and rewrites it if the schema needs it. Returns the teams
   * created, or an empty list when there already was a team.
   */
  const seedAll = sqlite.transaction((teams) => {
    for (const { id, name, doc } of teams) insert(id, name, doc, 1)
  })
  function seedIfEmpty(teams) {
    if (q.count.get().n > 0) return []
    seedAll(teams)
    return teams.map((t) => getTeam(t.id))
  }

  return { listTeams, getTeam, createTeam, renameTeam, deleteTeam, ensureProgram, readRow, currentVersion, writeDoc, backupFiles, backupPath, backup, migrateLegacy, seedIfEmpty }
}
