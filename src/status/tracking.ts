import type { Feature, FeatureTracking } from '../types'

/*
 * The Status tab's columns, in the order of the tracking sheet it mirrors: the three hour figures
 * (original estimate, logged, remaining) and the budget they add up to, then the free-text notes.
 */

export type HourKey = 'estimate' | 'logged' | 'remaining'
export const HOUR_COLUMNS: { key: HourKey; label: string; hint: string }[] = [
  { key: 'estimate', label: 'Original estimate (h)', hint: 'Original estimate in hours — the planner’s estimation' },
  { key: 'logged', label: 'Logged (h)', hint: 'Hours logged so far' },
  { key: 'remaining', label: 'Remaining (h)', hint: 'Hours of work left — the planner’s remaining' },
]

export type TextKey = keyof FeatureTracking
export const TEXT_COLUMNS: { key: TextKey; label: string; hint: string; wide?: boolean }[] = [
  { key: 'risks', label: 'Risks / issues', hint: 'Known risks and issues' },
  { key: 'blockers', label: 'Dependencies / blockers', hint: 'Jira keys or anything else this waits on' },
  { key: 'comment', label: 'Comment', hint: 'Free-form status note', wide: true },
]

type Hours = Pick<Feature, 'estimate' | 'logged' | 'remaining'>

/** Overall budget = original estimate − logged − remaining; negative = over budget. Null without an estimate. */
export const budgetHours = (f: Hours): number | null => (f.estimate == null ? null : f.estimate - (f.logged ?? 0) - (f.remaining ?? 0))

export interface HourTotals {
  estimate: number
  logged: number
  remaining: number
  budget: number
  /** how many features carry any of the three figures */
  n: number
}

/**
 * Column sums over the features given, a missing figure counting as 0 — the sheet's "Total" rows.
 * Budget is the sum of the other three, so the columns always foot.
 */
export function sumHours(fs: Hours[]): HourTotals {
  const t: HourTotals = { estimate: 0, logged: 0, remaining: 0, budget: 0, n: 0 }
  for (const f of fs) {
    if (f.estimate == null && f.logged == null && f.remaining == null) continue
    t.estimate += f.estimate ?? 0
    t.logged += f.logged ?? 0
    t.remaining += f.remaining ?? 0
    t.n++
  }
  t.budget = t.estimate - t.logged - t.remaining
  return t
}
