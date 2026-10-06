import { DB, OptionColors, ROADMAP_STATUSES, RoadmapBar, RoadmapStatus, optionColor } from '../types'
import { WEEK_MS, addWeeks, mondayOf, parseISO, weeksBetween } from '../logic'

/**
 * What the Roadmap draws for one bar: the planned span (dotted) and the actual span (solid), with
 * the actual end worked out from the status and the progress. Pure, so it is unit-tested.
 */
export interface BarShape {
  plannedStart: string
  plannedEnd: string
  /** false → a grey "Planned · not started" bar over the planned span */
  started: boolean
  /** the effective status: Planned while not started */
  status: RoadmapStatus
  /** the drawn actual span, real or forecast; both unset while not started */
  actualStart?: string
  end?: string
  /** the first week past the planned length, only when an In-progress forecast runs longer → red hatch */
  overrunFrom?: string
  /** end − planned end in weeks; only a positive value is shown, as "+Nw" */
  delayWeeks: number
  /** 0–100; Complete reads 100, not started 0 */
  progress: number
  /** true when the end came from the progress rule rather than the dates */
  forecast: boolean
  /** what is written on the bar */
  label: string
  reason?: string
  milestone: boolean
}

/** Forecasting starts once either has happened, so the estimate does not jump around at the start. */
const MIN_ELAPSED_WEEKS = 1
const MIN_PROGRESS = 10

const clampPct = (v: number | undefined): number => Math.max(0, Math.min(100, Math.round(v ?? 0)))

export function barShape(bar: RoadmapBar, todayISO: string): BarShape {
  const weeks = Math.max(1, bar.weeks || 1)
  const plannedStart = bar.start
  const plannedEnd = addWeeks(plannedStart, weeks - 1)
  const today = mondayOf(todayISO)
  const status: RoadmapStatus = bar.status ?? 'Planned'
  const milestone = !!bar.milestone
  const reason = bar.reason?.trim() || undefined
  const base = { plannedStart, plannedEnd, reason, milestone }

  if (!bar.actualStart) {
    return { ...base, started: false, status: 'Planned', delayWeeks: 0, progress: 0, forecast: false, label: 'Planned · not started' }
  }

  const actualStart = mondayOf(bar.actualStart)
  let end: string
  let forecast = false
  let overrunFrom: string | undefined
  let progress = clampPct(bar.progress)

  if (status === 'Complete' || bar.actualEnd) {
    end = bar.actualEnd ? mondayOf(bar.actualEnd) : today
    if (end < actualStart) end = actualStart
    if (status === 'Complete') progress = 100
  } else if (status === 'In progress') {
    // the bar keeps its planned length; once under way, the progress says how long it will really take
    const elapsedWeeks = (parseISO(todayISO).getTime() - parseISO(actualStart).getTime()) / WEEK_MS
    let duration = weeks
    if (progress > 0 && elapsedWeeks > 0 && (elapsedWeeks >= MIN_ELAPSED_WEEKS || progress >= MIN_PROGRESS)) {
      const est = Math.ceil(elapsedWeeks / (progress / 100))
      if (est > weeks) {
        duration = est
        forecast = true
        overrunFrom = addWeeks(actualStart, weeks)
      }
    }
    end = addWeeks(actualStart, duration - 1)
  } else {
    // Blocked / On hold / Planned but started: nothing is estimated; the bar just does not end in the past
    end = addWeeks(actualStart, weeks - 1)
    if (today > end) end = today
  }

  const pctText = `${progress}%`
  const label =
    status === 'Complete'
      ? 'Complete'
      : status === 'Blocked' || status === 'On hold'
        ? [status, pctText, reason].filter(Boolean).join(' · ')
        : `${status} · ${pctText}`

  return { ...base, started: true, status, actualStart, end, overrunFrom, delayWeeks: weeksBetween(plannedEnd, end), progress, forecast, label }
}

/** Where the solid bar sits: the actual span once started, the planned span before. */
export const solidSpan = (s: BarShape): [string, string] => (s.started ? [s.actualStart!, s.end!] : [s.plannedStart, s.plannedEnd])

/** The weeks a bar is drawn on: its planned span, widened by the actual span once started. */
export function drawnSpan(bar: RoadmapBar, todayISO: string): [string, string] {
  const s = barShape(bar, todayISO)
  let lo = s.plannedStart
  let hi = s.plannedEnd
  if (s.actualStart && s.end) {
    if (s.actualStart < lo) lo = s.actualStart
    if (s.end > hi) hi = s.end
  }
  return [lo, hi]
}

/**
 * Indices of the bars a new span touches or overlaps, going by where each bar is drawn.
 * Milestones (diamonds) are never candidates: a merge would turn them into a bar.
 */
export function adjacentBars(segments: RoadmapBar[], start: string, weeks: number, todayISO: string): number[] {
  const end = addWeeks(start, Math.max(1, weeks) - 1)
  const out: number[] = []
  segments.forEach((seg, i) => {
    if (seg.milestone) return
    const [lo, hi] = drawnSpan(seg, todayISO)
    if (start <= addWeeks(hi, 1) && end >= addWeeks(lo, -1)) out.push(i)
  })
  return out
}

/**
 * One bar in place of the given bars and a new span: the earliest bar keeps its status, progress,
 * colour and reason, and is stretched to cover every drawn span plus the new one. A started bar is
 * drawn from its actual start to its actual (or forecast) end, so those move too where the data fixes them.
 */
export function mergeBars(bars: RoadmapBar[], start: string, weeks: number, todayISO: string): RoadmapBar {
  const sorted = [...bars].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
  let lo = start
  let hi = addWeeks(start, Math.max(1, weeks) - 1)
  // Complete, or any bar with an actual end, is drawn to that date rather than to its planned length
  const fixedEnd = (b: RoadmapBar) => !!b.actualStart && (b.status === 'Complete' || !!b.actualEnd)
  for (const b of sorted) {
    // a forecast end (an in-progress bar running late) is not data, so it does not set the merged length
    const [a, z] = fixedEnd(b) ? drawnSpan(b, todayISO) : [b.start, addWeeks(b.start, Math.max(1, b.weeks || 1) - 1)]
    if (a < lo) lo = a
    if (b.actualStart && mondayOf(b.actualStart) < lo) lo = mondayOf(b.actualStart)
    if (z > hi) hi = z
  }
  const kept = sorted[0]
  const out: RoadmapBar = { ...kept, start: lo, weeks: weeksBetween(lo, hi) + 1 }
  if (kept.actualStart && lo < mondayOf(kept.actualStart)) out.actualStart = lo
  if (fixedEnd(kept)) out.actualEnd = hi
  return out
}

/** Blocked outranks On hold outranks In progress outranks Planned; Complete only when everything is. */
const SEVERITY: Record<RoadmapStatus, number> = { Complete: 0, Planned: 1, 'In progress': 2, 'On hold': 3, Blocked: 4 }

/**
 * A parent row's bar: the envelope of its descendants' planned and actual spans, their mean
 * progress and the most severe status among them. Null without children bars.
 */
export function rollup(shapes: BarShape[]): BarShape | null {
  if (!shapes.length) return null
  let plannedStart = shapes[0].plannedStart
  let plannedEnd = shapes[0].plannedEnd
  let actualStart: string | undefined
  let end: string | undefined
  let progress = 0
  let status: RoadmapStatus = 'Complete'
  let forecast = false
  for (const s of shapes) {
    if (s.plannedStart < plannedStart) plannedStart = s.plannedStart
    if (s.plannedEnd > plannedEnd) plannedEnd = s.plannedEnd
    if (s.actualStart && (!actualStart || s.actualStart < actualStart)) actualStart = s.actualStart
    if (s.end && (!end || s.end > end)) end = s.end
    progress += s.progress
    forecast ||= s.forecast
    if (SEVERITY[s.status] > SEVERITY[status]) status = s.status
  }
  progress = Math.round(progress / shapes.length)
  const started = !!actualStart
  return {
    plannedStart,
    plannedEnd,
    started,
    status: started ? status : 'Planned',
    actualStart,
    end,
    delayWeeks: end ? weeksBetween(plannedEnd, end) : 0,
    progress,
    forecast,
    label: `${progress}%`,
    milestone: false,
  }
}

/** The colour a bar is painted in: its override, else the status colour from Settings. */
export const barColor = (colors: OptionColors | undefined, shape: BarShape, override?: string): string =>
  override ?? optionColor(colors, 'roadmapStatuses', shape.status) ?? '#64748b'

export const statusColor = (db: DB, status: RoadmapStatus): string => optionColor(db.settings.optionColors, 'roadmapStatuses', status) ?? '#64748b'

/** "+3w" for a late bar, '' otherwise — only lateness is flagged on the roadmap. */
export const lateTag = (shape: BarShape): string => (shape.delayWeeks > 0 ? `+${shape.delayWeeks}w` : '')

export const isLateOrStuck = (shape: BarShape): boolean => shape.delayWeeks > 0 || shape.status === 'Blocked' || shape.status === 'On hold'

export { ROADMAP_STATUSES }
