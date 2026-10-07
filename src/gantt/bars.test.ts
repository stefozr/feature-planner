import { describe, expect, it } from 'vitest'
import { adjacentBars, barShape, mergeBars, rollup, solidSpan } from './bars'

// Mondays: W25 = 2026-06-15, W28 = 2026-07-06, W30 = 2026-07-20
const W25 = '2026-06-15'
const W26 = '2026-06-22'
const W28 = '2026-07-06'
const W30 = '2026-07-20'
const W27 = '2026-06-29'
const W29 = '2026-07-13'
const W31 = '2026-07-27'

describe('barShape', () => {
  it('draws an unstarted bar over the planned span', () => {
    const s = barShape({ start: W25, weeks: 4 }, '2026-09-30')
    expect(s.started).toBe(false)
    expect(s.plannedEnd).toBe(W28)
    expect(s.label).toBe('Planned · not started')
    expect(s.delayWeeks).toBe(0)
  })

  it('a completed bar ends where it ended and reads 100%', () => {
    const s = barShape({ start: W25, weeks: 4, actualStart: W26, actualEnd: W30, status: 'Complete', progress: 60 }, '2026-09-30')
    expect(s.end).toBe(W30)
    expect(s.progress).toBe(100)
    expect(s.delayWeeks).toBe(2)
    expect(s.label).toBe('Complete')
  })

  it('a completed bar ahead of plan has a negative delay', () => {
    const s = barShape({ start: W25, weeks: 4, actualStart: W25, actualEnd: W26, status: 'Complete' }, '2026-09-30')
    expect(s.delayWeeks).toBe(-2)
  })

  it('under the threshold an in-progress bar keeps its planned length', () => {
    // 3 days in, 5% done: neither a week elapsed nor 10% — no forecast
    const s = barShape({ start: W25, weeks: 4, actualStart: W25, status: 'In progress', progress: 5 }, '2026-06-18')
    expect(s.end).toBe(W28)
    expect(s.forecast).toBe(false)
    expect(s.overrunFrom).toBeUndefined()
  })

  it('forecasts the end from elapsed ÷ progress once under way', () => {
    // 7 weeks in at 85% → 9 weeks; planned 7 → two weeks of overrun
    const s = barShape({ start: W25, weeks: 7, actualStart: W25, status: 'In progress', progress: 85 }, '2026-08-03')
    expect(s.forecast).toBe(true)
    expect(s.end).toBe('2026-08-10')
    expect(s.overrunFrom).toBe('2026-08-03')
    expect(s.delayWeeks).toBe(2)
    expect(s.label).toBe('In progress · 85%')
  })

  it('never shortens an in-progress bar below its planned length', () => {
    // 1 week in at 90% → about 2 weeks, but 4 are planned
    const s = barShape({ start: W25, weeks: 4, actualStart: W25, status: 'In progress', progress: 90 }, W26)
    expect(s.end).toBe(W28)
    expect(s.forecast).toBe(false)
  })

  it('a late start shifts the whole bar', () => {
    const s = barShape({ start: W25, weeks: 4, actualStart: W26, status: 'In progress', progress: 0 }, W26)
    expect(s.end).toBe('2026-07-13')
    expect(s.delayWeeks).toBe(1)
  })

  it('a blocked bar past its end stretches to today without forecasting', () => {
    const s = barShape({ start: W25, weeks: 4, actualStart: W25, status: 'Blocked', progress: 30, reason: 'PROJ-142' }, '2026-07-22')
    expect(s.end).toBe(W30)
    expect(s.forecast).toBe(false)
    expect(s.overrunFrom).toBeUndefined()
    expect(s.delayWeeks).toBe(2)
    expect(s.label).toBe('Blocked · 30% · PROJ-142')
  })

  it('a blocked bar still inside its plan keeps the planned end', () => {
    const s = barShape({ start: W25, weeks: 4, actualStart: W25, status: 'On hold', progress: 40 }, W26)
    expect(s.end).toBe(W28)
    expect(s.label).toBe('On hold · 40%')
  })
})

describe('rollup', () => {
  it('is null without bars', () => {
    expect(rollup([])).toBeNull()
  })

  it('takes the envelope, the mean progress and the worst status', () => {
    const today = '2026-07-22'
    const a = barShape({ start: W25, weeks: 2, actualStart: W25, actualEnd: W26, status: 'Complete' }, today)
    const b = barShape({ start: W26, weeks: 4, actualStart: W26, status: 'In progress', progress: 50 }, today)
    const c = barShape({ start: W28, weeks: 2 }, today)
    const r = rollup([a, b, c])!
    expect(r.plannedStart).toBe(W25)
    expect(r.plannedEnd).toBe('2026-07-13')
    expect(r.actualStart).toBe(W25)
    expect(r.end).toBe(b.end)
    expect(r.progress).toBe(50)
    expect(r.status).toBe('In progress')
    expect(r.label).toBe('50%')
  })

  it('reads Complete only when every child is complete', () => {
    const today = '2026-07-22'
    const done = barShape({ start: W25, weeks: 1, actualStart: W25, actualEnd: W25, status: 'Complete' }, today)
    const r = rollup([done, done])!
    expect(r.status).toBe('Complete')
    expect(r.counts).toEqual({ total: 2, complete: 2, inProgress: 0, blocked: 0, onHold: 0, planned: 0 })
  })

  it('stays In progress with blocked or on-hold children, and counts them', () => {
    const today = '2026-07-22'
    const done = barShape({ start: W25, weeks: 1, actualStart: W25, actualEnd: W25, status: 'Complete' }, today)
    const hold = barShape({ start: W25, weeks: 1, actualStart: W25, status: 'On hold' }, today)
    const blocked = barShape({ start: W25, weeks: 1, actualStart: W25, status: 'Blocked' }, today)
    const r = rollup([hold, blocked, done])!
    expect(r.status).toBe('In progress')
    expect(r.counts).toEqual({ total: 3, complete: 1, inProgress: 0, blocked: 1, onHold: 1, planned: 0 })
  })

  it('is Planned while nothing has started', () => {
    const today = '2026-06-01'
    const a = barShape({ start: W25, weeks: 2 }, today)
    const b = barShape({ start: W28, weeks: 2 }, today)
    const r = rollup([a, b])!
    expect(r.status).toBe('Planned')
    expect(r.started).toBe(false)
    expect(r.counts!.planned).toBe(2)
  })
})

describe('solidSpan', () => {
  it('is the planned span while not started', () => {
    expect(solidSpan(barShape({ start: W25, weeks: 2 }, '2026-09-30'))).toEqual([W25, W26])
  })

  it('is only the actual span once started, so a late start frees the planned weeks before it', () => {
    expect(solidSpan(barShape({ start: W25, weeks: 2, actualStart: W27, actualEnd: W28, status: 'Complete' }, '2026-09-30'))).toEqual([W27, W28])
  })
})

describe('adjacentBars', () => {
  const today = '2026-09-30'
  const bar = { start: W26, weeks: 2 } // W26–W27

  it('matches a span touching either end of a bar, or overlapping it', () => {
    expect(adjacentBars([bar], W28, 2, today)).toEqual([0]) // right after
    expect(adjacentBars([bar], W25, 1, today)).toEqual([0]) // right before
    expect(adjacentBars([bar], W27, 3, today)).toEqual([0]) // overlapping
  })

  it('ignores a span a week or more away', () => {
    expect(adjacentBars([bar], W29, 2, today)).toEqual([])
    expect(adjacentBars([{ start: W28, weeks: 1 }], W25, 2, today)).toEqual([])
  })

  it('never offers a milestone', () => {
    expect(adjacentBars([{ start: W26, weeks: 1, milestone: true }], W27, 1, today)).toEqual([])
  })

  it('goes by the drawn span: a late bar is matched on its actual end', () => {
    // planned W25–W26, completed only in W28 → the drawn bar ends W28, so W29 touches it
    const late = { start: W25, weeks: 2, actualStart: W25, actualEnd: W28, status: 'Complete' as const }
    expect(adjacentBars([late], W29, 1, today)).toEqual([0])
  })

  it('finds both neighbours of a span that bridges a gap', () => {
    expect(adjacentBars([{ start: W25, weeks: 1 }, { start: W28, weeks: 1 }], W26, 2, today)).toEqual([0, 1])
  })
})

describe('mergeBars', () => {
  const today = '2026-09-30'
  const planned = { start: W26, weeks: 2, color: '#ff0000', reason: 'PROJ-1' }

  it('a span after an unstarted bar extends it and keeps its details', () => {
    expect(mergeBars([planned], W28, 2, today)).toEqual({ ...planned, start: W26, weeks: 4 })
  })

  it('a span before a bar moves its start earlier', () => {
    expect(mergeBars([planned], W25, 1, today)).toEqual({ ...planned, start: W25, weeks: 3 })
  })

  it('an overlapping span never shrinks the bar', () => {
    expect(mergeBars([planned], W26, 1, today)).toEqual(planned)
  })

  it('a span after a completed bar also moves its actual end, so the drawn bar grows', () => {
    const done = { start: W25, weeks: 2, actualStart: W25, actualEnd: W26, status: 'Complete' as const }
    expect(mergeBars([done], W27, 2, today)).toEqual({ ...done, weeks: 4, actualEnd: W28 })
  })

  it('a span before a started bar moves its actual start', () => {
    const going = { start: W26, weeks: 2, actualStart: W26, status: 'In progress' as const, progress: 40 }
    expect(mergeBars([going], W25, 1, today)).toEqual({ ...going, start: W25, weeks: 3, actualStart: W25 })
  })

  it('an in-progress bar follows its planned length, so only the weeks grow', () => {
    const going = { start: W26, weeks: 2, actualStart: W26, status: 'In progress' as const, progress: 40 }
    expect(mergeBars([going], W28, 1, today)).toEqual({ ...going, weeks: 3 })
  })

  it('covers an actual end already past the planned end', () => {
    const late = { start: W25, weeks: 2, actualStart: W25, actualEnd: W28, status: 'Complete' as const }
    expect(mergeBars([late], W29, 1, today)).toEqual({ ...late, weeks: 5, actualEnd: W29 })
  })

  it("bridging two bars yields one with the earlier bar's details", () => {
    const first = { start: W25, weeks: 1, status: 'Complete' as const, actualStart: W25, actualEnd: W25 }
    const second = { start: W29, weeks: 3, status: 'Blocked' as const, reason: 'later' }
    const m = mergeBars([second, first], W26, 3, today) // W26–W28 fills the gap; input order must not matter
    expect(m).toEqual({ ...first, start: W25, weeks: 7, actualEnd: W31 }) // W25–W31
    expect(addWeeksCheck(m.start, m.weeks)).toBe(W31)
  })
})

const addWeeksCheck = (start: string, weeks: number) => {
  const d = new Date(start + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + (weeks - 1) * 7)
  return d.toISOString().slice(0, 10)
}
