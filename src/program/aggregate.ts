import { DB, Epic, Feature, Milestone, Release, RoadmapStatus } from '../types'
import { addWeeks, gridWeeks, mondayOf, weekFte, weeksBetween, type WeekFte } from '../logic'
import { BarShape, barShape, drawnSpan } from '../gantt/bars'

/**
 * What the Program team computes from the other teams' documents. Everything here is pure: the
 * documents come from GET /api/program/teams, nothing is ever merged into one DB (ids repeat
 * across teams), and every figure is keyed by the team it belongs to.
 */

/** one other team, as the Program sees it */
export interface TeamDoc {
  id: string
  name: string
  position: number
  version: number
  db: DB
}

/** one feature of one team */
export interface ProgramFeature {
  /** `<teamId>:<featureId>` — the key of the Program's own notes on it */
  key: string
  team: TeamDoc
  feature: Feature
  epic?: Epic
}

export const programKey = (teamId: string, featureId: string): string => `${teamId}:${featureId}`

/** every team's features, in team order then document order */
export function flattenFeatures(teams: TeamDoc[]): ProgramFeature[] {
  const out: ProgramFeature[] = []
  for (const team of teams) {
    const epics = new Map(team.db.epics.map((e) => [e.id, e]))
    for (const feature of team.db.features) out.push({ key: programKey(team.id, feature.id), team, feature, epic: epics.get(feature.epicId) })
  }
  return out
}

/**
 * The Program's week axis: from the earliest week any team's planner shows (or the Program's own
 * project start) to the latest, widened for the Program's own roadmap bars and releases. With
 * `compact`, trimmed to start 4 weeks before today, like the planner's "From today".
 */
export function programWeeks(teams: TeamDoc[], program: DB, todayISO: string, compact = false): string[] {
  const today = mondayOf(todayISO)
  let start = mondayOf(program.settings.projectStart || today)
  let end = addWeeks(start, Math.max(1, program.settings.horizonWeeks || 26))
  for (const t of teams) {
    const ws = gridWeeks(t.db, todayISO, false)
    if (!ws.length) continue
    if (ws[0] < start) start = ws[0]
    const last = addWeeks(ws[ws.length - 1], 1)
    if (last > end) end = last
  }
  for (const w of program.workstreams) {
    for (const seg of w.segments) {
      const [lo, hi] = drawnSpan(seg, todayISO)
      if (lo < start) start = lo
      if (addWeeks(hi, 1) > end) end = addWeeks(hi, 1)
    }
  }
  for (const r of program.releases) if (r.date && addWeeks(mondayOf(r.date), 2) > end) end = addWeeks(mondayOf(r.date), 2)
  const runway = addWeeks(today, 8)
  if (runway > end) end = runway
  if (compact) {
    const cut = addWeeks(today, -4)
    if (cut > start) start = cut
  }
  const weeks: string[] = []
  for (let w = start; w < end; w = addWeeks(w, 1)) weeks.push(w)
  return weeks
}

/** a team's week in FTE: what its people have available against what its plan books */
export interface TeamLoad extends WeekFte {
  booked: number
  free: number
  /** booked beyond the available FTE (the same 0.05 FTE tolerance as the team's own chart) */
  over: boolean
}

export function teamLoad(team: TeamDoc, week: string): TeamLoad {
  const f = weekFte(team.db, week)
  const booked = f.dev + f.test + f.buffer
  return { ...f, booked, free: f.available - booked, over: booked > f.available + 0.05 }
}

/** Blocked outranks On hold outranks In progress outranks Planned; Complete only when everything is. */
const SEVERITY: Record<RoadmapStatus, number> = { Complete: 0, Planned: 1, 'In progress': 2, 'On hold': 3, Blocked: 4 }

/**
 * A team's critical path: one bar from the earliest of its roadmap bars to the latest. The dotted
 * part runs from the earliest planned start to the latest planned end; the solid one from the
 * earliest actual start to the latest end of any bar — a started bar's actual or forecast end, an
 * unstarted bar's planned end — with the mean progress and the most severe status of what has
 * started. Taken over every leaf row of the team; a parent row's own segments are ignored, as the
 * team's roadmap ignores them. Null without bars.
 */
export function teamCriticalPath(team: TeamDoc, todayISO: string): BarShape | null {
  const ws = team.db.workstreams
  const parents = new Set(ws.map((w) => w.parentId).filter((p): p is string => !!p))
  const shapes: BarShape[] = []
  for (const w of ws) {
    if (parents.has(w.id)) continue
    for (const seg of w.segments) shapes.push(barShape(seg, todayISO))
  }
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
    const last = s.started ? s.end! : s.plannedEnd
    if (!end || last > end) end = last
    progress += s.progress
    forecast ||= s.forecast
    if (s.started && SEVERITY[s.status] > SEVERITY[status]) status = s.status
  }
  const started = !!actualStart
  return {
    plannedStart,
    plannedEnd,
    started,
    status: started ? status : 'Planned',
    actualStart,
    end: started ? end : undefined,
    delayWeeks: started && end ? Math.max(0, weeksBetween(plannedEnd, end)) : 0,
    progress: Math.round(progress / shapes.length),
    forecast,
    label: `${Math.round(progress / shapes.length)}%`,
    milestone: false,
  }
}

/** a team's dated releases and milestones, for the markers on its critical-path row */
export function teamMarkers(team: TeamDoc): { releases: Release[]; milestones: Milestone[] } {
  return { releases: team.db.releases.filter((r) => !!r.date), milestones: team.db.milestones }
}

/** the statuses in use across the teams, in team order, each once */
export const unionStatuses = (teams: TeamDoc[]): string[] => [...new Set(teams.flatMap((t) => t.db.settings.featureStatuses))]
export const unionCustomers = (teams: TeamDoc[]): string[] => [...new Set(teams.flatMap((t) => t.db.settings.customers))]

/** the FTE a feature books in a week: every entry, named people and unnamed slots alike */
export function featureFte(f: Feature, week: string): number {
  const cell = f.cells[week]
  if (!cell) return 0
  let sum = 0
  for (const e of cell.entries) sum += e.pct / 100
  return sum
}
