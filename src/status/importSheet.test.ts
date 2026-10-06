import { describe, expect, it } from 'vitest'
import type { DB, ImportMapping } from '../types'
import {
  applyPlan,
  buildPlan,
  columnIndex,
  detectHeaderRow,
  guessUnit,
  normHeader,
  parseDateCell,
  parseDuration,
  parseHours,
  parseNumber,
  parseWeek,
  personIndex,
  resolvePerson,
  resolveStatus,
  suggestMapping,
  type Cell,
  type Row,
} from './importSheet'

const c = (v: Cell['v'], z?: string): Cell => (z ? { v, z } : { v })
const row = (...vs: Cell['v'][]): Row => vs.map((v) => c(v))

/** a document shaped like the demo: two features, one with stories */
const db = (): DB => ({
  people: [
    { id: 'p-alice', name: 'Alice Morgan', profile: 'Engineer', short: 'Alice' },
    { id: 'p-ben', name: 'Ben Carter', profile: 'Engineer', short: 'Ben' },
    { id: 'p-anna', name: 'Anna Lindqvist', profile: 'QA' },
  ],
  epics: [{ id: 'e1', name: 'Onboarding' }],
  features: [
    { id: 'f1', epicId: 'e1', key: 'PROJ-102', name: 'KYC', status: 'In Progress', leadId: 'p-alice', estimate: 90, logged: 68, remaining: 25, cells: {} },
    { id: 'f2', epicId: 'e1', key: 'PROJ-104', name: 'Account recovery', status: 'New', estimate: 50, remaining: 50, cells: {}, tracking: { comment: 'old' } },
    { id: 'f3', epicId: 'e1', key: 'PROJ-200', name: 'Twin A', cells: {} },
    { id: 'f4', epicId: 'e1', key: 'PROJ-200', name: 'Twin B', cells: {} },
  ],
  stories: [
    { id: 's1', featureId: 'f1', key: 'PROJ-110', name: 'OCR', status: 'Closed', estimate: 40, logged: 38, remaining: 0 },
    { id: 's2', featureId: 'f1', key: 'PROJ-111', name: 'Liveness', status: 'In Progress', estimate: 50, logged: 30, remaining: 25 },
  ],
  releases: [],
  milestones: [],
  workstreams: [],
  settings: { projectStart: '2026-09-07', horizonWeeks: 26, hoursPerWeek: 30, profiles: [], featureStatuses: ['New', 'Open', 'In Progress', 'Need Verification', 'Blocked', 'Closed', 'Rejected'], customers: [], linkCategories: [] },
})

const JIRA_HEADERS = ['Key', 'Summary', 'BAC', 'Σ Original Estimate', 'Σ Remaining Estimate', 'Work Logged', 'Status', 'Assignee', 'Team']

describe('headers', () => {
  it('normHeader folds case, punctuation, Σ and the custom-field wrapper', () => {
    expect(normHeader('Σ Original Estimate')).toBe('sumoriginalestimate')
    expect(normHeader('Custom field (Epic Link)')).toBe('epiclink')
    expect(normHeader(' Risks / Issues ')).toBe('risksissues')
    expect(normHeader('Original estimate (h)')).toBe('originalestimateh')
  })
  it('detectHeaderRow skips a title row and finds the aliases', () => {
    const rows: Row[] = [row('Feature status 26H1', null), row(null, null), row('Jira ID', 'Description', 'Assignee'), row('PROJ-1', 'x', 'y')]
    expect(detectHeaderRow(rows)).toBe(2)
    expect(detectHeaderRow([row(...JIRA_HEADERS)])).toBe(0)
  })
  it('columnIndex takes the exact header, then its folded form', () => {
    expect(columnIndex(JIRA_HEADERS, 'Work Logged')).toBe(5)
    expect(columnIndex(JIRA_HEADERS, 'work logged')).toBe(5)
    expect(columnIndex(JIRA_HEADERS, 'Nope')).toBe(-1)
  })
})

describe('suggestMapping', () => {
  const rows = [row('PROJ-1', 'A', '242', 0.5, 0.25, 0.1, 'done', 'Alice Morgan', 'T')]
  it('maps the Jira export sheet, Σ columns first, BAC left for the user', () => {
    const m = suggestMapping(JIRA_HEADERS, rows)
    expect(m.columns).toEqual({ key: 'Key', name: 'Summary', estimate: 'Σ Original Estimate', remaining: 'Σ Remaining Estimate', logged: 'Work Logged', status: 'Status', leadId: 'Assignee' })
  })
  it('falls back to BAC for the estimate when no estimate column exists', () => {
    const m = suggestMapping(['Key', 'Summary', 'BAC'], [row('PROJ-1', 'A', '12')])
    expect(m.columns.estimate).toBe('BAC')
    expect(m.units?.estimate).toBe('hours')
  })
  it('unwraps Custom field (Epic Link) into the parent key and takes Jira CSV names', () => {
    const m = suggestMapping(['Issue key', 'Summary', 'Custom field (Epic Link)', 'Time Spent', 'Due date'], [])
    expect(m.columns).toMatchObject({ key: 'Issue key', parentKey: 'Custom field (Epic Link)', logged: 'Time Spent', deadline: 'Due date' })
  })
  it('a saved unit follows its saved column only; an alias-found column is read from its values', () => {
    const saved: ImportMapping = { columns: { key: 'Issue key', estimate: 'Original estimate', logged: 'Time Spent' }, units: { estimate: 'seconds', logged: 'seconds' } }
    const m = suggestMapping(['Key', 'Σ Original Estimate', 'Time Spent'], [row('PROJ-1', '12', 28800)], saved)
    expect(m.columns).toMatchObject({ key: 'Key', estimate: 'Σ Original Estimate', logged: 'Time Spent' })
    expect(m.units).toEqual({ estimate: 'hours', logged: 'seconds' })
  })
  it('a saved mapping wins where its header is present, the rest is suggested', () => {
    const saved: ImportMapping = { columns: { estimate: 'BAC', comment: 'Gone' }, units: { estimate: 'hours' }, hoursPerDay: 6, statusMap: { done: 'Closed' } }
    const m = suggestMapping(JIRA_HEADERS, rows, saved)
    expect(m.columns.estimate).toBe('BAC')
    expect(m.columns.comment).toBeUndefined()
    expect(m.columns.logged).toBe('Work Logged')
    expect(m.hoursPerDay).toBe(6)
    expect(m.statusMap).toEqual({ done: 'Closed' })
  })
})

describe('values', () => {
  it('parseNumber reads text numbers, decimal commas and h:mm', () => {
    expect(parseNumber('12')).toBe(12)
    expect(parseNumber('12,5')).toBe(12.5)
    expect(parseNumber('1 250')).toBe(1250)
    expect(parseNumber('242:30')).toBe(242.5)
    expect(parseNumber('abc')).toBeNull()
  })
  it('parseDuration reads Jira notation with the day length given', () => {
    expect(parseDuration('2d 4h 30m', 6)).toBe(16.5)
    expect(parseDuration('1w', 8)).toBe(40)
    expect(parseDuration('12')).toBeNull()
  })
  it('guessUnit tells seconds, Excel time, Jira days and hours apart', () => {
    expect(guessUnit([c(28800), c(3600), c(0)])).toBe('seconds')
    expect(guessUnit([c(0.5, '[h]:mm'), c(1.25, '[h]:mm')])).toBe('excelTime')
    expect(guessUnit([c('2d 4h'), c('3h')])).toBe('days')
    expect(guessUnit([c(12), c('7,5')])).toBe('hours')
    expect(guessUnit([c(60), c(120)])).toBe('hours')
  })
  it('parseHours converts and rounds to 0.01h; blanks and Jira "None" are undefined', () => {
    expect(parseHours(c(28800), 'seconds')).toBe(8)
    expect(parseHours(c(0.70833), 'excelTime')).toBe(17)
    expect(parseHours(c('2d'), 'days', 8)).toBe(16)
    expect(parseHours(c(90), 'minutes')).toBe(1.5)
    expect(parseHours(c(''), 'hours')).toBeUndefined()
    expect(parseHours(c('None'), 'hours')).toBeUndefined()
    expect(parseHours(c('x'), 'hours')).toBe('invalid')
    expect(parseHours(c(-1), 'hours')).toBe('invalid')
  })
  it('parseDateCell / parseWeek read the usual shapes and land on the Monday', () => {
    expect(parseDateCell('2026-10-14')).toBe('2026-10-14')
    expect(parseDateCell('14/10/2026')).toBe('2026-10-14')
    expect(parseDateCell('06/Oct/26 9:12 AM')).toBe('2026-10-06')
    expect(parseDateCell(new Date(2026, 9, 14))).toBe('2026-10-14')
    expect(parseDateCell(46309)).toBe('2026-10-14')
    expect(parseWeek('2026-10-14')).toBe('2026-10-12')
    expect(parseDateCell('soon')).toBe('invalid')
    expect(parseDateCell('')).toBeUndefined()
  })
  it('resolveStatus: the map, the same word, the Jira synonyms, else unknown', () => {
    const list = db().settings.featureStatuses
    expect(resolveStatus('in progress', list)).toBe('In Progress')
    expect(resolveStatus('done', list)).toBe('Closed')
    expect(resolveStatus('Backlog', list)).toBe('New')
    expect(resolveStatus('Weird', list)).toBeUndefined()
    expect(resolveStatus('Weird', list, { weird: 'Blocked' })).toBe('Blocked')
    expect(resolveStatus('Weird', list, { weird: '' })).toBe('')
  })
  it('resolvePerson: exact, hyphenated first name, near miss, else unknown', () => {
    const idx = personIndex(db().people)
    expect(resolvePerson('Alice Morgan', idx)).toBe('p-alice')
    expect(resolvePerson('alice', idx)).toBe('p-alice')
    expect(resolvePerson('Anna-Maria Lindqvist', idx)).toBe('p-anna')
    expect(resolvePerson('Benjamin Carter', idx)).toBe('p-ben')
    expect(resolvePerson('Zed Zed', idx)).toBeUndefined()
    expect(resolvePerson('Zed Zed', idx, { zedzed: 'p-ben' })).toBe('p-ben')
  })
})

describe('buildPlan', () => {
  const mapping = (): ImportMapping => ({
    columns: { key: 'Key', name: 'Summary', parentKey: 'Parent', status: 'Status', leadId: 'Assignee', estimate: 'Estimate', logged: 'Logged', remaining: 'Remaining', comment: 'Comment' },
    units: { estimate: 'seconds', logged: 'seconds', remaining: 'seconds' },
    hoursPerDay: 8,
  })
  const HEAD = row('Key', 'Summary', 'Parent', 'Status', 'Assignee', 'Estimate', 'Logged', 'Remaining', 'Comment')
  let seq = 0
  const newId = () => `n${++seq}`

  it('matches stories and features, creates under a parent, skips the rest with reasons', () => {
    const rows: Row[] = [
      HEAD,
      row('PROJ-111', 'Liveness check', 'PROJ-102', 'done', 'Ben Carter', 180000, 108000, 0, 'shipped'), // story: status + lead + hours + comment
      row('PROJ-102', 'KYC', '', 'In Progress', '', 999999, '', '', ''), // feature with stories: hours skipped
      row('PROJ-999', 'Reset link email', 'PROJ-104', 'To Do', 'Unassigned', 72000, '', 72000, ''), // new story
      row('PROJ-111', 'dup', '', '', '', '', '', '', ''), // duplicate key
      row('PROJ-200', 'twin', '', 'Blocked', '', '', '', '', ''), // ambiguous
      row('PROJ-777', 'orphan', 'PROJ-111', '', '', '', '', '', ''), // parent is a story
      row('PROJ-778', 'orphan', 'NOPE-1', '', '', '', '', '', ''), // parent unresolved
      row('', 'subtotal', '', '', '', 1, 2, 3, ''), // no key
      row('PROJ-110', 'OCR', '', 'Closed', '', 144000, 136800, 0, ''), // unchanged
      row('PROJ-104', 'Account recovery', '', 'Weird', 'Zed Zed', '', '', '', 'old'), // unknown status + person, same comment
    ]
    const plan = buildPlan(db(), rows, 0, mapping(), newId)
    const by = Object.fromEntries(plan.rows.map((p) => [p.key + '@' + p.row, p]))
    expect(by['PROJ-111@2'].outcome).toEqual({ kind: 'story', id: 's2' })
    expect(by['PROJ-111@2'].patch).toEqual({ name: 'Liveness check', status: 'Closed', leadId: 'p-ben', remaining: 0 }) // logged 108000s = 30h, already there
    expect(by['PROJ-111@2'].tracking).toEqual({ comment: 'shipped' })
    expect(by['PROJ-102@3'].outcome).toEqual({ kind: 'feature', id: 'f1' })
    expect(by['PROJ-102@3'].patch).toEqual({})
    expect(by['PROJ-102@3'].notes[0]).toMatch(/hours not written/)
    expect(by['PROJ-999@4'].outcome).toMatchObject({ kind: 'new-story', featureId: 'f2' })
    expect(by['PROJ-999@4'].patch).toEqual({ key: 'PROJ-999', name: 'Reset link email', status: 'New', estimate: 20, remaining: 20 })
    expect(by['PROJ-111@5'].outcome).toMatchObject({ kind: 'skip', reason: 'duplicate' })
    expect(by['PROJ-200@6'].outcome).toMatchObject({ kind: 'skip', reason: 'ambiguous' })
    expect(by['PROJ-777@7'].outcome).toMatchObject({ kind: 'skip', reason: 'parent-is-story' })
    expect(by['PROJ-778@8'].outcome).toMatchObject({ kind: 'skip', reason: 'parent-unresolved' })
    expect(by['PROJ-110@10'].changes).toEqual([])
    expect(by['PROJ-104@11'].patch).toEqual({})
    expect(plan.summary).toMatchObject({ featuresUpdated: 0, storiesUpdated: 1, storiesCreated: 1, unchanged: 3, skipped: 4, noKey: 1 })
    expect(plan.summary.unknownStatuses).toEqual([{ value: 'Weird', rows: 1 }])
    expect(plan.summary.unmatchedPeople).toEqual([{ value: 'Zed Zed', rows: 1 }])
    expect(plan.summary.unresolvedParents).toEqual([{ value: 'NOPE-1', rows: 1 }])
    expect(plan.summary.hoursSkipped).toEqual([{ key: 'PROJ-102', rows: 1 }])
    // Account recovery (50h, no stories) gains its first story: its figures become the story's
    expect(plan.summary.hoursReplaced).toEqual([{ featureId: 'f2', key: 'PROJ-104', name: 'Account recovery', from: { estimate: 50, remaining: 50 }, to: { estimate: 20, remaining: 20 }, stories: 1 }])
  })

  it('blank cells leave values, a zero estimate stays unset, the value maps add a new status', () => {
    const rows: Row[] = [HEAD, row('PROJ-104', '', '', 'Weird', '', 0, 3600, '', '')]
    const m = { ...mapping(), statusMap: { weird: 'Weird' } }
    const plan = buildPlan(db(), rows, 0, m, newId)
    expect(plan.rows[0].patch).toEqual({ status: 'Weird', logged: 1 })
    expect(plan.newStatuses).toEqual(['Weird'])
    expect(plan.summary.invalid).toEqual([])
  })

  it('reports unreadable cells instead of throwing', () => {
    const rows: Row[] = [HEAD, row('PROJ-104', '', '', '', '', 'lots', '', '', '')]
    const plan = buildPlan(db(), rows, 0, mapping(), newId)
    expect(plan.summary.invalid).toEqual([{ row: 2, field: 'estimate', value: 'lots' }])
    expect(plan.rows[0].changes).toEqual([])
  })
})

describe('applyPlan', () => {
  it('writes the plan once, rolls the hours up, and is a no-op the second time', () => {
    const d = db()
    const rows: Row[] = [
      row('Key', 'Summary', 'Parent', 'Status', 'Estimate', 'Comment'),
      row('PROJ-111', 'Liveness check', '', 'done', 180000, 'shipped'),
      row('PROJ-999', 'Reset link email', 'PROJ-104', 'Weird', 72000, ''),
      row('PROJ-104', 'Account recovery', '', '', 999, 'new comment'),
    ]
    const m: ImportMapping = { columns: { key: 'Key', name: 'Summary', parentKey: 'Parent', status: 'Status', estimate: 'Estimate', comment: 'Comment' }, units: { estimate: 'seconds' }, statusMap: { weird: 'Weird' } }
    const plan = buildPlan(d, rows, 0, m, () => 'new-1')
    const r1 = applyPlan(d, plan)
    expect(r1).toEqual({ updated: 2, created: 1, dropped: 0 })
    expect(d.stories.find((s) => s.id === 's2')).toMatchObject({ status: 'Closed', estimate: 50, tracking: { comment: 'shipped' } })
    expect(d.stories.filter((s) => s.featureId === 'f2')).toEqual([{ id: 'new-1', featureId: 'f2', key: 'PROJ-999', name: 'Reset link email', status: 'Weird', estimate: 20 }])
    // the feature's own 50h gave way to its story's 20h, and the hours on its own row were not applied
    expect(d.features.find((f) => f.id === 'f2')).toMatchObject({ estimate: 20, tracking: { comment: 'new comment' } })
    expect(d.features.find((f) => f.id === 'f2')!.remaining).toBeUndefined()
    expect(d.settings.featureStatuses).toContain('Weird')
    const r2 = applyPlan(d, plan)
    expect(r2.created).toBe(0)
    expect(d.stories.filter((s) => s.key === 'PROJ-999')).toHaveLength(1)
    expect(d.settings.featureStatuses.filter((s) => s === 'Weird')).toHaveLength(1)
  })
  it('skips records that vanished before the replay', () => {
    const d = db()
    const plan = buildPlan(d, [row('Key', 'Estimate'), row('PROJ-111', 10)], 0, { columns: { key: 'Key', estimate: 'Estimate' } }, () => 'x')
    d.stories = []
    expect(applyPlan(d, plan)).toEqual({ updated: 0, created: 0, dropped: 1 })
  })
})
