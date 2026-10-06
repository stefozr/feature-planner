import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { COPIED_SETTINGS, StoreError, isTeamId, openStore, slugify } from './store.mjs'
import { STATUS_DEFAULTS } from '../shared/db.mjs'

const LEGACY_TABLE = 'CREATE TABLE store (id INTEGER PRIMARY KEY CHECK (id = 1), doc TEXT NOT NULL, version INTEGER NOT NULL, updated_at TEXT NOT NULL)'

/** a fresh in-memory database and a throwaway backup directory */
const fresh = (opts = {}) => {
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-store-'))
  const sqlite = new Database(':memory:')
  return { sqlite, backupDir, store: openStore(sqlite, { backupDir, ...opts }) }
}

const seedDoc = (extra = {}) =>
  JSON.stringify({
    schemaVersion: 4,
    settings: { projectStart: '2026-06-15', horizonWeeks: 20, hoursPerWeek: 32, profiles: ['Engineer'], featureStatuses: ['New', 'Closed'], customers: ['Acme'], linkCategories: ['Jira'], optionColors: { featureStatuses: { New: '#111111' }, customers: { Acme: '#222222' }, roadmapStatuses: { Planned: '#333333' } }, calendarUrl: 'https://cal.example/x.ics', importMapping: { columns: { key: 'Key' } } },
    people: [{ id: 'p1', name: 'Alice', profile: 'Engineer' }],
    epics: [{ id: 'e1', name: 'Onboarding' }],
    features: [{ id: 'f1', epicId: 'e1', name: 'A', cells: {} }, { id: 'f2', epicId: 'e1', name: 'B', cells: {} }],
    stories: [],
    releases: [],
    milestones: [],
    workstreams: [],
    ...extra,
  })

const expectError = (fn, status) => {
  try {
    fn()
  } catch (e) {
    assert.ok(e instanceof StoreError, `expected a StoreError, got ${e}`)
    assert.equal(e.status, status)
    return e
  }
  assert.fail(`expected a StoreError ${status}`)
}

test('slugify folds accents and punctuation; reserved and malformed ids are refused', () => {
  assert.equal(slugify('  Équipe Plate-forme 2 '), 'equipe-plate-forme-2')
  assert.equal(slugify('Mobile Apps!'), 'mobile-apps')
  assert.equal(slugify('---'), '')
  assert.equal(slugify('x'.repeat(50)).length, 40)
  for (const ok of ['default', 'platform', 'a', 'team-2']) assert.equal(isTeamId(ok), true, ok)
  for (const bad of ['planner', 'capacity', 'status', 'roadmap', 'api', '-a', 'A', 'a b', '', 'a'.repeat(41)]) assert.equal(isTeamId(bad), false, bad)
})

test('seedIfEmpty creates the given teams in order, once', () => {
  const { store } = fresh()
  const created = store.seedIfEmpty([
    { id: 'demo', name: 'Demo team', doc: seedDoc() },
    { id: 'mobile-apps', name: 'Mobile apps', doc: seedDoc({ features: [] }) },
  ])
  assert.deepEqual(created.map((t) => t.id), ['demo', 'mobile-apps'])
  assert.deepEqual(store.seedIfEmpty([{ id: 'other', name: 'Other', doc: seedDoc() }]), [])
  const list = store.listTeams()
  assert.deepEqual(list.map((t) => [t.id, t.name, t.features, t.people]), [['demo', 'Demo team', 2, 1], ['mobile-apps', 'Mobile apps', 0, 1]])
  assert.equal(store.currentVersion('mobile-apps'), 1)
})

test('seedIfEmpty is all or nothing', () => {
  const { store } = fresh()
  assert.throws(() => store.seedIfEmpty([{ id: 'a', name: 'A', doc: seedDoc() }, { id: 'b', name: 'a', doc: seedDoc() }])) // duplicate name
  assert.equal(store.listTeams().length, 0)
})

test('migrateLegacy moves the single store row into team "default" with its version, drops the table and moves the root backups', () => {
  const { sqlite, backupDir, store } = fresh()
  sqlite.exec(LEGACY_TABLE)
  sqlite.prepare('INSERT INTO store (id, doc, version, updated_at) VALUES (1, ?, 91, ?)').run(seedDoc(), '2026-10-01T10:00:00.000Z')
  fs.writeFileSync(path.join(backupDir, 'db-2026-10-01T09-00-00-startup.json'), '{}')
  fs.writeFileSync(path.join(backupDir, 'notes.txt'), 'keep')
  assert.equal(store.migrateLegacy(), true)
  assert.equal(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name = 'store'").get(), undefined)
  const [t] = store.listTeams()
  assert.deepEqual([t.id, t.name, t.features], ['default', 'Default', 2])
  assert.equal(store.currentVersion('default'), 91)
  assert.equal(fs.existsSync(path.join(backupDir, 'default', 'db-2026-10-01T09-00-00-startup.json')), true)
  assert.equal(fs.existsSync(path.join(backupDir, 'db-2026-10-01T09-00-00-startup.json')), false)
  assert.equal(fs.existsSync(path.join(backupDir, 'notes.txt')), true)
  assert.equal(store.migrateLegacy(), false) // nothing left to move
  assert.deepEqual(store.seedIfEmpty([{ id: 'demo', name: 'Demo', doc: seedDoc() }]), []) // the migrated team counts
})

test('migrateLegacy with an empty store table just drops it', () => {
  const { sqlite, store } = fresh()
  sqlite.exec(LEGACY_TABLE)
  assert.equal(store.migrateLegacy(), false)
  assert.equal(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name = 'store'").get(), undefined)
  assert.equal(store.listTeams().length, 0)
})

test('createTeam: blank gets the defaults, a copy takes the settings lists but not the calendar link or the import mapping', () => {
  const { store } = fresh()
  store.seedIfEmpty([{ id: 'default', name: 'Default', doc: seedDoc() }])
  const blank = store.createTeam({ name: 'Platform' })
  assert.equal(blank.id, 'platform')
  const blankDoc = JSON.parse(store.readRow('platform').doc)
  assert.deepEqual(blankDoc.people, [])
  assert.deepEqual(blankDoc.features, [])
  assert.deepEqual(blankDoc.settings.featureStatuses, STATUS_DEFAULTS)
  assert.equal(blankDoc.settings.hoursPerWeek, 30)
  assert.equal('calendarUrl' in blankDoc.settings, false)

  const copy = store.createTeam({ name: 'Mobile', copySettingsFrom: 'default' })
  const copyDoc = JSON.parse(store.readRow(copy.id).doc)
  const source = JSON.parse(store.readRow('default').doc).settings
  for (const k of COPIED_SETTINGS) assert.deepEqual(copyDoc.settings[k], source[k], k)
  assert.equal('calendarUrl' in copyDoc.settings, false)
  assert.equal('importMapping' in copyDoc.settings, false)
  assert.deepEqual(copyDoc.people, [])
  assert.deepEqual(copyDoc.releases, [])
  assert.equal(store.listTeams().map((t) => t.id).join(','), 'default,platform,mobile')
  assert.equal(store.currentVersion('mobile'), 1)
})

test('createTeam: ids are unique slugs, names are unique case-insensitively, the source must exist', () => {
  const { store } = fresh()
  store.createTeam({ name: 'Platform' })
  assert.equal(store.createTeam({ name: 'platform!' }).id, 'platform-2')
  assert.equal(store.createTeam({ name: 'Planner' }).id, 'planner-2') // reserved word skipped
  assert.equal(store.createTeam({ name: '???' }).id, 'team')
  expectError(() => store.createTeam({ name: 'PLATFORM' }), 409)
  expectError(() => store.createTeam({ name: '   ' }), 400)
  expectError(() => store.createTeam({ name: 'x'.repeat(61) }), 400)
  expectError(() => store.createTeam({ name: 'Copy', copySettingsFrom: 'nope' }), 404)
})

test('renameTeam keeps the id and refuses a name another team holds', () => {
  const { store } = fresh()
  store.createTeam({ name: 'Platform' })
  store.createTeam({ name: 'Mobile' })
  const t = store.renameTeam('platform', 'Platform team')
  assert.deepEqual([t.id, t.name], ['platform', 'Platform team'])
  assert.equal(store.renameTeam('platform', 'platform TEAM').name, 'platform TEAM') // its own name, recased
  expectError(() => store.renameTeam('platform', 'mobile'), 409)
  expectError(() => store.renameTeam('nope', 'x'), 404)
  expectError(() => store.renameTeam('platform', ''), 400)
})

test('deleteTeam snapshots first and keeps the last team', () => {
  const { store, backupDir } = fresh()
  store.seedIfEmpty([{ id: 'default', name: 'Default', doc: seedDoc() }])
  expectError(() => store.deleteTeam('default'), 409)
  store.createTeam({ name: 'Mobile' })
  store.deleteTeam('default')
  assert.deepEqual(store.listTeams().map((t) => t.id), ['mobile'])
  assert.equal(store.readRow('default'), undefined)
  const files = fs.readdirSync(path.join(backupDir, 'default'))
  assert.equal(files.length, 1)
  assert.match(files[0], /-delete\.json$/)
  expectError(() => store.deleteTeam('nope'), 404)
})

test('writeDoc is guarded per team: a stale write fails and never touches another team', () => {
  const { store } = fresh()
  store.seedIfEmpty([{ id: 'a', name: 'A', doc: seedDoc() }])
  store.createTeam({ name: 'B' })
  const docA = JSON.parse(store.readRow('a').doc)
  assert.deepEqual(store.writeDoc('a', docA, 1), { ok: true, version: 2 })
  assert.deepEqual(store.writeDoc('a', docA, 1), { ok: false, version: 2 })
  assert.deepEqual(store.writeDoc('a', docA, null), { ok: true, version: 3 })
  assert.equal(store.currentVersion('b'), 1)
  assert.deepEqual(store.writeDoc('gone', docA, null), { ok: false, version: undefined })
})

test('backups live per team, prune per team and skip an unchanged startup snapshot', () => {
  const { store, backupDir } = fresh({ backupKeep: 2 })
  store.seedIfEmpty([{ id: 'a', name: 'A', doc: seedDoc() }])
  store.createTeam({ name: 'B' })
  assert.equal(store.backup('a', 'startup'), true)
  assert.equal(store.backup('a', 'startup'), false) // identical to the newest
  assert.equal(store.backup('a', 'daily'), true)
  assert.equal(store.backup('a', 'daily'), false) // one a day
  assert.equal(store.backup('a', 'import'), true)
  assert.equal(store.backup('a', 'import'), true)
  assert.equal(store.backupFiles('a').length, 2) // pruned to backupKeep
  assert.equal(store.backupFiles('b').length, 0)
  assert.equal(fs.existsSync(path.join(backupDir, 'b')), false)
  assert.equal(store.backup('nope', 'daily'), false)
  const [{ name }] = store.backupFiles('a')
  assert.equal(store.backupPath('a', name), path.join(backupDir, 'a', name))
  assert.equal(store.backupPath('a', `../a/${name}`), path.join(backupDir, 'a', name)) // traversal stripped
  assert.equal(store.backupPath('b', name), null)
  assert.equal(store.backupPath('a', 'nope.json'), null)
})

test('ensureProgram creates the built-in team once, under a free name, and marks it builtin', () => {
  const { store } = fresh()
  store.seedIfEmpty([{ id: 'a', name: 'A', doc: seedDoc() }])
  const created = store.ensureProgram()
  assert.equal(created.id, 'program')
  assert.equal(created.name, 'Program')
  assert.equal(store.ensureProgram().id, 'program') // idempotent
  assert.deepEqual(store.listTeams().map((t) => [t.id, t.builtin]), [['a', false], ['program', true]])
  const doc = JSON.parse(store.readRow('program').doc)
  assert.deepEqual(doc.people, [])
  assert.deepEqual(doc.program, { tracking: {} })
  assert.ok(doc.settings.featureStatuses.length > 0) // migrate() filled the defaults
  assert.equal(isTeamId('program'), false) // the slug is reserved: no user team can take it

  const other = fresh().store
  other.createTeam({ name: 'Program' })
  assert.equal(other.ensureProgram().name, 'Program (all teams)')
})

test('the Program team cannot be deleted, does not count as the last team, and is not a settings source', () => {
  const { store } = fresh()
  store.seedIfEmpty([{ id: 'a', name: 'A', doc: seedDoc() }])
  store.ensureProgram()
  expectError(() => store.deleteTeam('program'), 409)
  expectError(() => store.deleteTeam('a'), 409) // the last real team, even though Program is there
  store.createTeam({ name: 'B' })
  store.deleteTeam('a')
  assert.deepEqual(store.listTeams().map((t) => t.id), ['program', 'b'])
  expectError(() => store.createTeam({ name: 'C', copySettingsFrom: 'program' }), 400)
})
