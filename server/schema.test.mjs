import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SCHEMA_VERSION, migrate, normalize } from './schema.mjs'
import { STATUS_DEFAULTS, payloadProblem } from '../shared/db.mjs'

/** a v3 document the way the app wrote it before hours, customers and the Jira statuses */
const v3 = () => ({
  schemaVersion: 3,
  settings: {
    projectStart: '2026-06-15',
    horizonWeeks: 28,
    hoursPerWeek: 30,
    hoursPerSP: 4,
    profiles: ['Engineer'],
    featureStatuses: ['Not started', 'Clarify', 'Blocked', 'In progress', 'Code review', 'Testing', 'Done', 'Parked'],
    linkCategories: ['Jira'],
    optionColors: { featureStatuses: { 'Not started': '#111111', Done: '#222222', Parked: '#333333' }, roadmapStatuses: {} },
  },
  people: [{ id: 'p1', name: 'Alice Morgan', profile: 'Engineer', aliases: ['Ali'] }],
  epics: [{ id: 'e1', name: 'Onboarding' }],
  features: [
    { id: 'f1', epicId: 'e1', name: 'A', status: 'Done', estimate: 10, remaining: 0, completedWeek: '2026-07-06', cells: {}, tracking: { complete: 100, testDocs: 'yes', comment: 'shipped' } },
    { id: 'f2', epicId: 'e1', name: 'B', status: 'Code review', estimate: 2.5, remaining: 1, endWeek: '2026-08-03', completedWeek: '2026-08-10', cells: {}, tracking: { ui: 50, risks: '' } },
    { id: 'f3', epicId: 'e1', name: 'C', status: 'Parked', cells: {} },
  ],
  releases: [],
  milestones: [],
  workstreams: [],
})

test('migrate v3 → v4: story points become hours, the finish week folds into the end week', () => {
  const db = v3()
  assert.equal(migrate(db), true)
  assert.equal(db.schemaVersion, SCHEMA_VERSION)
  const [a, b] = db.features
  assert.deepEqual([a.estimate, a.remaining], [40, 0])
  assert.deepEqual([b.estimate, b.remaining], [10, 4])
  assert.equal(a.endWeek, '2026-07-06') // taken from completedWeek
  assert.equal(b.endWeek, '2026-08-03') // the stated end wins
  for (const f of db.features) assert.equal('completedWeek' in f, false)
  assert.equal('hoursPerSP' in db.settings, false)
})

test('migrate v3 → v4: a non-default hours-per-SP is honoured and rounded to 0.1h', () => {
  const db = v3()
  db.settings.hoursPerSP = 3
  db.features[1].estimate = 1.33
  migrate(db)
  assert.equal(db.features[0].estimate, 30)
  assert.equal(db.features[1].estimate, 4)
})

test('migrate v3 → v4: tracking keeps only its text columns and vanishes when empty', () => {
  const db = v3()
  migrate(db)
  assert.deepEqual(db.features[0].tracking, { comment: 'shipped' })
  assert.equal('tracking' in db.features[1], false)
})

test('migrate v3 → v4: statuses are renamed, custom ones kept, colours re-keyed', () => {
  const db = v3()
  migrate(db)
  assert.deepEqual(
    db.features.map((f) => f.status),
    ['Closed', 'In Progress', 'Parked'],
  )
  assert.deepEqual(db.settings.featureStatuses, [...STATUS_DEFAULTS, 'Parked'])
  const colors = db.settings.optionColors.featureStatuses
  assert.equal('Not started' in colors, false)
  assert.equal('Done' in colors, false)
  assert.equal(colors.Parked, '#333333') // a custom colour survives
  assert.equal(typeof colors.Closed, 'string') // the new names get the defaults
  assert.equal('aliases' in db.people[0], false)
})

test('migrate v3 → v4: customers are seeded, with their colours', () => {
  const db = v3()
  migrate(db)
  assert.ok(Array.isArray(db.settings.customers) && db.settings.customers.length > 0)
  assert.equal(typeof db.settings.optionColors.customers, 'object')
})

test('migrate: a v4 document is left alone', () => {
  const db = v3()
  migrate(db)
  const snapshot = JSON.stringify(db)
  assert.equal(migrate(db), false)
  assert.equal(JSON.stringify(db), snapshot)
})

test('normalize: a customers list is seeded from the values in use, else the defaults', () => {
  const used = { features: [{ id: 'f', epicId: 'e', name: 'x', customer: 'Wayne Corp', cells: {} }], people: [], epics: [], settings: {} }
  normalize(used)
  assert.deepEqual(used.settings.customers, ['Wayne Corp'])
  const fresh = { features: [], people: [], epics: [], settings: {} }
  normalize(fresh)
  assert.ok(fresh.settings.customers.length > 0)
  assert.equal('hoursPerSP' in fresh.settings, false)
  assert.equal(fresh.settings.hoursPerWeek, 30)
})

test('a Program document keeps its program.tracking through migrate and the payload check', () => {
  const doc = { schemaVersion: SCHEMA_VERSION, settings: {}, people: [], epics: [], features: [], program: { tracking: { 'demo:f1': { comment: 'escalated', blockers: 'vendor' } } } }
  migrate(doc)
  assert.deepEqual(doc.program, { tracking: { 'demo:f1': { comment: 'escalated', blockers: 'vendor' } } })
  assert.equal(payloadProblem(doc), null)
  assert.equal(payloadProblem({ ...doc, program: 1 }), 'program is not an object')
  assert.equal(payloadProblem({ ...doc, program: { tracking: [] } }), 'program.tracking is not an object')
  assert.equal(payloadProblem({ ...doc, program: { tracking: { x: 'str' } } }), 'program.tracking["x"] is not an object')
  assert.equal(payloadProblem({ ...doc, program: { tracking: { x: { risks: 3 } } } }), 'program.tracking["x"].risks is not a string')
})
