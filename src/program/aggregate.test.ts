import { describe, expect, it } from 'vitest'
import type { DB } from '../types'
import { featureFte, flattenFeatures, programKey, programWeeks, teamCriticalPath, teamLoad, unionStatuses } from './aggregate'
import type { TeamDoc } from './aggregate'

// Mondays: W25 = 2026-06-15 … W30 = 2026-07-20
const W25 = '2026-06-15'
const W26 = '2026-06-22'
const W28 = '2026-07-06'
const W30 = '2026-07-20'
const TODAY = '2026-07-01' // in W27

const doc = (over: Partial<DB> = {}): DB => ({
  people: [],
  epics: [],
  features: [],
  stories: [],
  releases: [],
  milestones: [],
  workstreams: [],
  settings: { projectStart: W25, horizonWeeks: 4, hoursPerWeek: 30, profiles: ['Engineer'], featureStatuses: ['New', 'Closed'], customers: ['Acme'], linkCategories: [] },
  ...over,
})
const team = (id: string, db: DB, position = 0): TeamDoc => ({ id, name: id.toUpperCase(), position, version: 1, db })

describe('teamCriticalPath', () => {
  it('is null for a team without roadmap bars', () => {
    expect(teamCriticalPath(team('a', doc()), TODAY)).toBeNull()
    expect(teamCriticalPath(team('a', doc({ workstreams: [{ id: 'w', parentId: null, name: 'Empty', segments: [] }] })), TODAY)).toBeNull()
  })

  it('spans the earliest planned start to the latest planned end, and the actual span likewise', () => {
    const db = doc({
      workstreams: [
        { id: 'a', parentId: null, name: 'A', segments: [{ start: W26, weeks: 2, actualStart: W26, actualEnd: W28, status: 'Complete' }] },
        { id: 'b', parentId: null, name: 'B', segments: [{ start: W25, weeks: 1 }, { start: W28, weeks: 3 }] },
      ],
    })
    const s = teamCriticalPath(team('t', db), TODAY)!
    expect(s.plannedStart).toBe(W25)
    expect(s.plannedEnd).toBe(W30)
    expect(s.started).toBe(true)
    expect(s.actualStart).toBe(W26)
    expect(s.end).toBe(W30) // the latest bar is unstarted: its planned end is where the path ends
    expect(s.delayWeeks).toBe(0)
    expect(s.status).toBe('In progress') // one bar is complete, but two are still to come
    expect(s.counts).toEqual({ total: 3, complete: 1, inProgress: 0, blocked: 0, onHold: 0, planned: 2 })
  })

  it('is a planned, unstarted bar while nothing has started', () => {
    const db = doc({ workstreams: [{ id: 'a', parentId: null, name: 'A', segments: [{ start: W26, weeks: 2 }, { start: W28, weeks: 1 }] }] })
    const s = teamCriticalPath(team('t', db), TODAY)!
    expect(s.started).toBe(false)
    expect(s.status).toBe('Planned')
    expect(s.actualStart).toBeUndefined()
    expect(s.end).toBeUndefined()
    expect(s.plannedStart).toBe(W26)
    expect(s.plannedEnd).toBe(W28)
  })

  it('runs late only when a started bar\'s end passes the latest planned end', () => {
    // a 1-week bar started in W25, 10% done after 2 weeks: forecast far past W26
    const db = doc({ workstreams: [{ id: 'a', parentId: null, name: 'A', segments: [{ start: W25, weeks: 1, actualStart: W25, status: 'In progress', progress: 10 }, { start: W26, weeks: 1 }] }] })
    const s = teamCriticalPath(team('t', db), TODAY)!
    expect(s.forecast).toBe(true)
    expect(s.end! > W26).toBe(true)
    expect(s.delayWeeks).toBeGreaterThan(0)
  })

  it('stays In progress with blocked or on-hold bars, counts them, and ignores a parent row\'s own segments', () => {
    const db = doc({
      workstreams: [
        { id: 'p', parentId: null, name: 'Parent', segments: [{ start: '2026-01-05', weeks: 40, actualStart: '2026-01-05', status: 'Blocked' }] },
        { id: 'c1', parentId: 'p', name: 'Child 1', segments: [{ start: W25, weeks: 2, actualStart: W25, status: 'In progress', progress: 50 }] },
        { id: 'c2', parentId: 'p', name: 'Child 2', segments: [{ start: W26, weeks: 2, actualStart: W26, status: 'On hold', progress: 10 }] },
      ],
    })
    const s = teamCriticalPath(team('t', db), TODAY)!
    expect(s.plannedStart).toBe(W25) // not the parent's January
    expect(s.status).toBe('In progress')
    expect(s.counts).toEqual({ total: 2, complete: 0, inProgress: 1, blocked: 0, onHold: 1, planned: 0 })
    expect(s.progress).toBe(30)
  })
})

describe('teamLoad', () => {
  it('counts named people and unnamed slots as booked, and a leaver as no availability', () => {
    const db = doc({
      people: [
        { id: 'p1', name: 'Ann', profile: 'Engineer' },
        { id: 'p2', name: 'Bob', profile: 'Engineer', resignedFrom: W25 },
      ],
      epics: [{ id: 'e', name: 'E' }],
      features: [{ id: 'f', epicId: 'e', name: 'F', cells: { [W26]: { entries: [{ id: 'x', personId: 'p1', pct: 80, kind: 'dev' }, { id: 'y', personId: null, pct: 50, kind: 'test' }] } } }],
    })
    const l = teamLoad(team('t', db), W26)
    expect(l.available).toBeCloseTo(1)
    expect(l.booked).toBeCloseTo(1.3)
    expect(l.slots).toBeCloseTo(0.5)
    expect(l.free).toBeCloseTo(-0.3)
    expect(l.over).toBe(true)
    expect(teamLoad(team('t', db), W25).over).toBe(false)
  })
})

describe('programWeeks', () => {
  it('spans every team\'s planner axis and the Program\'s own', () => {
    const early = team('a', doc({ settings: { ...doc().settings, projectStart: '2026-05-04', horizonWeeks: 2 } }))
    const late = team('b', doc({ settings: { ...doc().settings, projectStart: W28, horizonWeeks: 20 } }))
    const weeks = programWeeks([early, late], doc(), TODAY)
    expect(weeks[0]).toBe('2026-05-04')
    expect(weeks[weeks.length - 1]).toBe('2026-11-16') // W28 + 20 weeks − 1
    expect(programWeeks([early, late], doc(), TODAY, true)[0]).toBe('2026-06-01') // today − 4 weeks
  })

  it('without teams still shows the Program\'s own horizon and runway', () => {
    const weeks = programWeeks([], doc(), TODAY)
    expect(weeks[0]).toBe(W25)
    expect(weeks.length).toBeGreaterThanOrEqual(8)
  })
})

describe('flattenFeatures', () => {
  it('keys every feature by team and keeps team order, then document order', () => {
    const a = team('a', doc({ epics: [{ id: 'e', name: 'Pkg' }], features: [{ id: 'f1', epicId: 'e', name: 'One', cells: {} }, { id: 'f2', epicId: 'e', name: 'Two', cells: {} }] }), 1)
    const b = team('b', doc({ epics: [{ id: 'e', name: 'Other' }], features: [{ id: 'f1', epicId: 'e', name: 'Same id', cells: {} }] }), 2)
    const all = flattenFeatures([a, b])
    expect(all.map((x) => x.key)).toEqual(['a:f1', 'a:f2', 'b:f1'])
    expect(all[2].epic?.name).toBe('Other')
    expect(programKey('a', 'f1')).toBe('a:f1')
  })
})

describe('small helpers', () => {
  it('featureFte sums every entry of the week', () => {
    const f = { id: 'f', epicId: 'e', name: 'F', cells: { [W25]: { entries: [{ id: '1', personId: 'p', pct: 50, kind: 'dev' as const }, { id: '2', personId: null, pct: 25, kind: 'test' as const }] } } }
    expect(featureFte(f, W25)).toBeCloseTo(0.75)
    expect(featureFte(f, W26)).toBe(0)
  })
  it('unionStatuses lists each status once, in team order', () => {
    const a = team('a', doc({ settings: { ...doc().settings, featureStatuses: ['New', 'Closed'] } }))
    const b = team('b', doc({ settings: { ...doc().settings, featureStatuses: ['In Review', 'Closed'] } }))
    expect(unionStatuses([a, b])).toEqual(['New', 'Closed', 'In Review'])
  })
})
