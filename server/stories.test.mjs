import { test } from 'node:test'
import assert from 'node:assert/strict'
import { storyHours, syncAllFeatureHours, syncFeatureHours } from '../shared/stories.mjs'
import { migrate, normalize } from './schema.mjs'
import { payloadProblem } from '../shared/db.mjs'

const doc = () => ({
  schemaVersion: 4,
  settings: { projectStart: '2026-06-15', horizonWeeks: 28, hoursPerWeek: 30, profiles: ['Engineer'], featureStatuses: ['New'], customers: [], linkCategories: [], optionColors: {} },
  people: [{ id: 'p1', name: 'Alice', profile: 'Engineer' }],
  epics: [{ id: 'e1', name: 'Onboarding' }],
  features: [
    { id: 'f1', epicId: 'e1', name: 'With stories', estimate: 1, logged: 1, remaining: 1, cells: {} },
    { id: 'f2', epicId: 'e1', name: 'Without', estimate: 8, remaining: 3, cells: {} },
  ],
  stories: [
    { id: 's1', featureId: 'f1', name: 'A', estimate: 10.25, logged: 4, leadId: 'p1' },
    { id: 's2', featureId: 'f1', name: 'B', estimate: 5.1, logged: 2.5 },
  ],
  releases: [],
  milestones: [],
  workstreams: [],
})

test('storyHours: sums each figure to 0.1h; a figure no story carries is undefined', () => {
  assert.deepEqual(storyHours(doc().stories), { estimate: 15.4, logged: 6.5 })
  assert.deepEqual(storyHours([]), {})
  assert.deepEqual(storyHours([{ remaining: 2 }, {}]), { remaining: 2 })
})

test('syncFeatureHours: writes the sums, drops a figure no story carries, reports the change', () => {
  const d = doc()
  assert.equal(syncFeatureHours(d, 'f1'), true)
  assert.deepEqual([d.features[0].estimate, d.features[0].logged, d.features[0].remaining], [15.4, 6.5, undefined])
  assert.equal('remaining' in d.features[0], false)
  assert.equal(syncFeatureHours(d, 'f1'), false, 'a second pass changes nothing')
})

test('syncFeatureHours: a feature without stories keeps its own hours', () => {
  const d = doc()
  assert.equal(syncFeatureHours(d, 'f2'), false)
  assert.deepEqual([d.features[1].estimate, d.features[1].remaining], [8, 3])
  assert.equal(syncFeatureHours(d, 'nope'), false)
})

test('syncAllFeatureHours: every feature with stories, once', () => {
  const d = doc()
  assert.equal(syncAllFeatureHours(d), true)
  assert.equal(d.features[0].estimate, 15.4)
  assert.equal(d.features[1].estimate, 8)
  assert.equal(syncAllFeatureHours(d), false)
})

test('normalize: fills stories[] on a document without it and re-syncs feature hours', () => {
  const d = doc()
  delete d.stories
  assert.equal(normalize(d), true)
  assert.deepEqual(d.stories, [])
  const e = doc()
  normalize(e)
  assert.equal(e.features[0].estimate, 15.4)
  assert.equal(migrate(e), false, 'a second migrate pass is a no-op')
})

test('payloadProblem: stories are optional, must name a feature, and references are checked', () => {
  assert.equal(payloadProblem(doc()), null)
  const noStories = doc()
  delete noStories.stories
  assert.equal(payloadProblem(noStories), null)
  const missing = doc()
  delete missing.stories[0].featureId
  assert.equal(payloadProblem(missing), 'stories[0] is missing featureId')
  const noName = doc()
  delete noName.stories[1].name
  assert.equal(payloadProblem(noName), 'stories[1] is missing id or name')
  const dangling = doc()
  dangling.stories[0].featureId = 'f9'
  assert.equal(payloadProblem(dangling), 'stories[0].featureId points at no feature ("f9")')
  assert.equal(payloadProblem(dangling, { references: false }), null)
  const lead = doc()
  lead.stories[0].leadId = 'p9'
  assert.equal(payloadProblem(lead), 'stories[0].leadId points at no person ("p9")')
  const dup = doc()
  dup.stories[1].id = 's1'
  assert.equal(payloadProblem(dup), 'stories[1] repeats id "s1"')
})
