import { AllocEntry, AllocKind, DB, ExternalEntry, Feature, hasLeft, isFinishedStatus, Person, Settings, WeekCell } from './types'
import { HOURS_PER_WEEK_DEFAULT } from '../shared/db.mjs'

export const WEEK_MS = 7 * 86400000

export function parseISO(d: string): Date {
  const [y, m, dd] = d.split('-').map(Number)
  return new Date(Date.UTC(y, (m ?? 1) - 1, dd ?? 1))
}

export function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** Normalize any ISO date to the Monday of its week. */
export function mondayOf(dateStr: string): string {
  const d = parseISO(dateStr)
  const diff = (d.getUTCDay() + 6) % 7
  return fmtDate(new Date(d.getTime() - diff * 86400000))
}

export function addWeeks(weekKey: string, n: number): string {
  return fmtDate(new Date(parseISO(weekKey).getTime() + n * WEEK_MS))
}

export function weekLabel(weekKey: string): string {
  const d = parseISO(weekKey)
  return `${d.getUTCDate()} ${d.toLocaleString('en', { month: 'short', timeZone: 'UTC' })}`
}

/** ISO-8601 week number (the week containing Thursday). */
export function isoWeekNum(weekKey: string): number {
  const d = parseISO(weekKey)
  d.setUTCDate(d.getUTCDate() + 3) // Monday -> Thursday of the same ISO week
  const jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil(((d.getTime() - jan1.getTime()) / 86400000 + 1) / 7)
}

/** The week as it is written everywhere in the UI: "W37"; "—" for no week. */
export const weekTag = (weekKey?: string): string => (weekKey ? `W${isoWeekNum(weekKey)}` : '—')

/** Consecutive week keys grouped by calendar month — the upper row of a month / week header. */
export function monthGroups(weeks: string[]): { key: string; label: string; weeks: string[] }[] {
  const groups: { key: string; label: string; weeks: string[] }[] = []
  for (const w of weeks) {
    const d = parseISO(w)
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`
    const last = groups[groups.length - 1]
    if (last && last.key === key) last.weeks.push(w)
    else groups.push({ key, label: d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }), weeks: [w] })
  }
  return groups
}

/** Whole weeks from one Monday key to another; negative when `to` precedes `from`. */
export const weeksBetween = (from: string, to: string): number =>
  Math.round((parseISO(to).getTime() - parseISO(from).getTime()) / WEEK_MS)

const awayCache = new WeakMap<Person, Map<string, number>>()

/** % of the working week (Mon–Fri) the person is away. */
export function awayPct(person: Person | undefined, weekKey: string): number {
  if (!person?.away?.length) return 0
  let m = awayCache.get(person)
  if (!m) {
    m = new Map()
    awayCache.set(person, m)
  }
  const hit = m.get(weekKey)
  if (hit != null) return hit
  let days = 0
  for (const iso of weekdays(weekKey)) {
    if (person.away.some((o) => o.start <= iso && iso <= o.end)) days++
  }
  m.set(weekKey, days * 20)
  return days * 20
}

const externalCache = new WeakMap<Person, Map<string, { raw: number; net: number }>>()

/** The five weekdays of a week, as ISO dates. */
function weekdays(weekKey: string): string[] {
  const out: string[] = []
  for (let i = 0; i < 5; i++) {
    const d = parseISO(weekKey)
    d.setUTCDate(d.getUTCDate() + i)
    out.push(fmtDate(d))
  }
  return out
}

/** An external entry that is well-formed enough to deduct anything. */
function usableExternal(e: ExternalEntry): boolean {
  if (!e?.start) return false
  if (e.end && e.end < e.start) return false
  const pct = Number(e.pct)
  return Number.isFinite(pct) && pct > 0
}

function covers(e: ExternalEntry, iso: string): boolean {
  return e.start <= iso && (!e.end || iso <= e.end)
}

/**
 * External-allocation % for a week, day-granular over Mon–Fri (each covered day
 * contributes pct/5). `raw` is the contractual figure, for display. `net` skips
 * days an away period already claims, so `capacity - net - away` never
 * double-counts the same day. Both capped at 100.
 */
/**
 * Every commitment that deducts from the person's week: the stored external periods plus, for
 * someone who has resigned, an implicit open-ended 100% from their last day on — so a leaver
 * reads as fully unavailable through the same maths and the same tooltips as time outside the project.
 */
function externalEntries(person: Person | undefined): ExternalEntry[] {
  const stored = person?.external ?? []
  if (!person?.resignedFrom) return stored
  return [...stored, { start: person.resignedFrom, pct: 100, note: 'Resigned' }]
}

function externalParts(person: Person | undefined, weekKey: string): { raw: number; net: number } {
  const entries = externalEntries(person)
  if (!person || entries.length === 0) return { raw: 0, net: 0 }
  let m = externalCache.get(person)
  if (!m) {
    m = new Map()
    externalCache.set(person, m)
  }
  const hit = m.get(weekKey)
  if (hit) return hit
  let raw = 0
  let net = 0
  for (const iso of weekdays(weekKey)) {
    const isAway = person.away?.some((o) => o.start <= iso && iso <= o.end) ?? false
    for (const e of entries) {
      if (!usableExternal(e) || !covers(e, iso)) continue
      raw += Number(e.pct) / 5
      if (!isAway) net += Number(e.pct) / 5
    }
  }
  const parts = { raw: Math.round(Math.min(100, raw)), net: Math.round(Math.min(100, net)) }
  m.set(weekKey, parts)
  return parts
}

/**
 * Effective weekly capacity ceiling %: the person's base capacity (default 100)
 * minus anything committed externally that week, floored at 0. A 0 means nothing
 * is left this week — fully committed elsewhere, or capacity 0.
 */
export function capacityPct(person: Person | undefined, weekKey: string): number {
  if (!person) return 100
  return Math.max(0, (person.capacity ?? 100) - externalParts(person, weekKey).net)
}

/** Available % of a working week: capacity ceiling (after external commitments) minus away time. */
export function availablePct(person: Person | undefined, weekKey: string): number {
  return Math.max(0, capacityPct(person, weekKey) - awayPct(person, weekKey))
}

// ----- weeks -----

/** Week keys that have at least one allocation entry or a note, sorted. */
export function workedWeeks(f: Feature): string[] {
  return Object.keys(f.cells)
    .filter((w) => f.cells[w].entries.length > 0 || !!f.cells[w].note)
    .sort()
}

/** Where the feature is planned to end: the stated end week, else the last week anyone works on it. */
export function derivedEndWeek(f: Feature): string | undefined {
  if (f.endWeek) return f.endWeek
  const w = workedWeeks(f)
  return w.length ? w[w.length - 1] : undefined
}

/** Where the feature starts: the stated start week, else the first week anyone works on it. */
export function derivedStartWeek(f: Feature): string | undefined {
  if (f.startWeek) return f.startWeek
  return workedWeeks(f)[0]
}

export type Schedule = 'ahead' | 'onplan' | 'delayed'
export interface ScheduleInfo {
  status: Schedule
  /** signed: negative = ahead by that many weeks, positive = late by that many */
  weeks: number
  plannedStart?: string
  plannedEnd: string
  actualStart?: string
  /** the finish week, or for an unfinished feature its forecast end */
  actualEnd?: string
  finished: boolean
  /** true when the delay is only because today is past the planned end */
  overdue: boolean
}

/**
 * Plan vs actual, from the end dates. Finished (a Closed / Rejected status): the actual end week
 * (stated end, else last booked week) against the planned end. Unfinished: the same week read as a
 * forecast — and past the planned end with work still open counts as delayed up to today.
 * No planned end → null.
 */
export function scheduleStatus(f: Feature, todayISO: string): ScheduleInfo | null {
  if (!f.planEnd) return null
  const plannedEnd = f.planEnd
  const finished = isFinishedStatus(f.status)
  const actualEnd = derivedEndWeek(f)
  const base = { plannedStart: f.planStart, plannedEnd, actualStart: derivedStartWeek(f), actualEnd, finished }
  const cmp = (end: string | undefined) => (end ? weeksBetween(plannedEnd, end) : 0)
  if (finished) {
    const d = cmp(actualEnd)
    return { ...base, status: d < 0 ? 'ahead' : d > 0 ? 'delayed' : 'onplan', weeks: d, overdue: false }
  }
  const today = mondayOf(todayISO)
  const forecast = cmp(actualEnd)
  const overdueBy = weeksBetween(plannedEnd, today)
  if (overdueBy > 0 && overdueBy > forecast) return { ...base, status: 'delayed', weeks: overdueBy, overdue: true }
  return { ...base, status: forecast < 0 ? 'ahead' : forecast > 0 ? 'delayed' : 'onplan', weeks: forecast, overdue: false }
}

export const SCHEDULE_LABEL: Record<Schedule, string> = { ahead: 'Ahead', onplan: 'On plan', delayed: 'Delayed' }
/** "+2w" / "−1w" / "" */
export const scheduleDelta = (weeks: number) => (weeks > 0 ? `+${weeks}w` : weeks < 0 ? `−${-weeks}w` : '')

/** What the planner's Gantt view draws for one feature: the plan outline, the booked bar and where they disagree. */
export interface BarInfo {
  /** weeks with at least one entry — a cell holding only a note is not allocation */
  booked: Set<string>
  /** the original plan, when both ends are set */
  plan: [string, string] | null
  /** weeks after the planned end the feature runs late by — booked or not, up to the forecast end (today when overdue) */
  slip: Set<string>
  /** planned weeks left unused because the feature ends ahead of plan */
  early: Set<string>
  /** weeks inside the actual span (stated start / end) that hold no booking — the lane stays continuous */
  stated: Set<string>
  /** the week a finished feature ended on — the ✓ in the Gantt view */
  done?: string
}

export function featureBars(f: Feature, todayISO: string): BarInfo {
  const booked = new Set(Object.keys(f.cells).filter((w) => f.cells[w].entries.length > 0))
  const plan: BarInfo['plan'] = f.planStart && f.planEnd ? [f.planStart, f.planEnd] : null
  const slip = new Set<string>()
  const early = new Set<string>()
  const stated = new Set<string>()
  const s = scheduleStatus(f, todayISO)
  if (s?.status === 'delayed') {
    const end = s.overdue ? mondayOf(todayISO) : s.actualEnd
    if (end && end > s.plannedEnd) for (const w of weekRange(addWeeks(s.plannedEnd, 1), end)) slip.add(w)
  } else if (s?.status === 'ahead' && s.actualEnd && s.actualEnd < s.plannedEnd) {
    for (const w of weekRange(addWeeks(s.actualEnd, 1), s.plannedEnd)) if (!booked.has(w)) early.add(w)
  }
  const a = derivedStartWeek(f)
  const b = derivedEndWeek(f)
  if (a && b && a <= b) for (const w of weekRange(a, b)) if (!booked.has(w) && !slip.has(w)) stated.add(w)
  const done = isFinishedStatus(f.status) ? b : undefined
  return { booked, plan, slip, early, stated, done }
}

/**
 * The grid's week axis: from the project start (or earlier work) to the later of the horizon,
 * the last scheduled week and a runway past today. `compact` drops weeks more than 4 before today.
 */
export function gridWeeks(db: DB, todayISO: string, compact = false): string[] {
  const s = db.settings
  const today = mondayOf(todayISO)
  let start = mondayOf(s.projectStart || today)
  let end = addWeeks(start, Math.max(1, s.horizonWeeks || 26))
  for (const f of db.features) {
    const worked = workedWeeks(f)
    if (worked.length) {
      if (worked[0] < start) start = worked[0]
      const last = addWeeks(worked[worked.length - 1], 1)
      if (last > end) end = last
    }
    if (f.endWeek && addWeeks(f.endWeek, 1) > end) end = addWeeks(f.endWeek, 1)
  }
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

// ----- load -----

export interface PersonWeekLoad {
  pct: number
  featureIds: string[]
}

const loadCache = new WeakMap<DB, Map<string, Map<string, PersonWeekLoad>>>()

/** week -> personId -> summed % and the features it is spent on. One pass per db. */
export function loadIndex(db: DB): Map<string, Map<string, PersonWeekLoad>> {
  const hit = loadCache.get(db)
  if (hit) return hit
  const idx = new Map<string, Map<string, PersonWeekLoad>>()
  for (const f of db.features) {
    for (const [week, cell] of Object.entries(f.cells)) {
      for (const e of cell.entries) {
        if (!e.personId) continue
        let byPerson = idx.get(week)
        if (!byPerson) idx.set(week, (byPerson = new Map()))
        let l = byPerson.get(e.personId)
        if (!l) byPerson.set(e.personId, (l = { pct: 0, featureIds: [] }))
        l.pct += e.pct
        if (!l.featureIds.includes(f.id)) l.featureIds.push(f.id)
      }
    }
  }
  loadCache.set(db, idx)
  return idx
}

export function personLoad(db: DB, personId: string, weekKey: string): PersonWeekLoad {
  return loadIndex(db).get(weekKey)?.get(personId) ?? { pct: 0, featureIds: [] }
}

export type PersonWeekState = 'off' | 'away' | 'unused' | 'used' | 'over'

const EPS = 1e-9

/**
 * The bottom-block colour of the Excel, made exact: `over` when allocated beyond what the person
 * has that week, `unused` when available and on nothing, `used` in between. `away`/`off` when
 * there is nothing available at all (away vs not on the project / committed elsewhere) and
 * nothing booked — booked work on a zero-availability week reads as `over`.
 */
export function personWeekState(db: DB, person: Person, weekKey: string): PersonWeekState {
  const avail = availablePct(person, weekKey)
  const load = personLoad(db, person.id, weekKey).pct
  if (load > avail + EPS) return 'over'
  if (avail <= EPS) return awayPct(person, weekKey) > 0 ? 'away' : 'off'
  return load <= EPS ? 'unused' : 'used'
}

export interface WeekFte {
  available: number
  dev: number
  test: number
  buffer: number
  /** of the allocated FTE, how much sits on unnamed slots */
  slots: number
}

const weekFteCache = new WeakMap<DB, Map<string, WeekFte>>()

/** Team-wide FTE for a week: what people have available vs what the plan books, by kind. */
export function weekFte(db: DB, weekKey: string): WeekFte {
  let m = weekFteCache.get(db)
  if (!m) weekFteCache.set(db, (m = new Map()))
  const hit = m.get(weekKey)
  if (hit) return hit
  const out: WeekFte = { available: 0, dev: 0, test: 0, buffer: 0, slots: 0 }
  for (const p of db.people) out.available += availablePct(p, weekKey) / 100
  for (const f of db.features) {
    for (const e of f.cells[weekKey]?.entries ?? []) {
      out[e.kind] += e.pct / 100
      if (!e.personId) out.slots += e.pct / 100
    }
  }
  m.set(weekKey, out)
  return out
}

// ----- per-feature numbers -----

export const entryHours = (e: AllocEntry, s: Settings): number => (e.pct / 100) * (s.hoursPerWeek || HOURS_PER_WEEK_DEFAULT)

export interface FeatureHours {
  total: number
  dev: number
  test: number
  buffer: number
}

/** Hours booked on the feature across all weeks, named people and unnamed slots alike. */
export function featureHours(f: Feature, s: Settings): FeatureHours {
  const out: FeatureHours = { total: 0, dev: 0, test: 0, buffer: 0 }
  for (const cell of Object.values(f.cells)) {
    for (const e of cell.entries) {
      const h = entryHours(e, s)
      out.total += h
      out[e.kind] += h
    }
  }
  return out
}

/** Estimate minus booked hours. Negative = more booked than estimated. Null without an estimate. */
export function featureBalance(f: Feature, s: Settings): number | null {
  return f.estimate == null ? null : f.estimate - featureHours(f, s).total
}

/** 0..1, or null when there is nothing to measure against. A finished feature is always 1. */
export function featureProgress(f: Feature): number | null {
  if (isFinishedStatus(f.status)) return 1
  if (f.estimate && f.estimate > 0 && f.remaining != null) {
    return Math.max(0, Math.min(1, 1 - f.remaining / f.estimate))
  }
  return null
}

export interface Rollup {
  /** null when no feature has both estimate and remaining */
  pct: number | null
  estimated: number
  total: number
  estimate: number
  remaining: number
}

/** Hour-weighted progress over the features that carry an estimate. */
export function rollupProgress(features: Feature[]): Rollup {
  let est = 0
  let rem = 0
  let n = 0
  for (const f of features) {
    if (!f.estimate || f.estimate <= 0) continue
    const r = isFinishedStatus(f.status) ? 0 : f.remaining ?? f.estimate
    est += f.estimate
    rem += Math.min(f.estimate, Math.max(0, r))
    n++
  }
  return { pct: est > 0 ? 1 - rem / est : null, estimated: n, total: features.length, estimate: est, remaining: rem }
}

/** The kind a cell is painted as — the Excel's precedence: buffer, then test, then dev. */
export function cellKind(cell: WeekCell | undefined): AllocKind | null {
  if (!cell?.entries.length) return null
  if (cell.entries.some((e) => e.kind === 'buffer')) return 'buffer'
  if (cell.entries.some((e) => e.kind === 'test')) return 'test'
  return 'dev'
}

/** Chip label for a person: their short name, else their first name. */
export const personShort = (p: Person | undefined): string => p?.short?.trim() || p?.name.split(' ')[0] || '?'

const peopleByIdCache = new WeakMap<DB, Map<string, Person>>()
export function peopleById(db: DB): Map<string, Person> {
  let m = peopleByIdCache.get(db)
  if (!m) peopleByIdCache.set(db, (m = new Map(db.people.map((p) => [p.id, p]))))
  return m
}

/** A fresh copy of a cell with new entry ids — for paste and fill. */
export function cloneCell(cell: WeekCell): WeekCell {
  return {
    entries: cell.entries.map((e) => ({ ...e, id: uid() })),
    ...(cell.note ? { note: cell.note } : {}),
  }
}

/** Default kind for a new entry for this person — the stored preference, else read off the profile. Also what decides whether a person is a tester or a developer wherever the two are told apart. */
export const defaultKindFor = (p: Person | undefined): AllocKind =>
  p?.defaultKind ?? (p && /qa|test/i.test(p.profile) ? 'test' : 'dev')

/**
 * The people a picker offers, sorted by short name: leavers already gone are left out when the
 * app-wide switch says so, except those in `keep` (whoever holds the role now), so the current
 * choice can always be read and undone.
 */
export function pickablePeople(people: Person[], opts: { hideResigned: boolean; today: string; keep?: (string | undefined)[] }): Person[] {
  const keep = new Set(opts.keep ?? [])
  return people
    .filter((p) => !(opts.hideResigned && hasLeft(p, opts.today)) || keep.has(p.id))
    .sort((a, b) => personShort(a).localeCompare(personShort(b)))
}

/** The tooltip line for a leaver — "Resigned — unavailable from 6 Oct" — or '' for anyone else. */
export const resignedTitle = (p: Person): string => (p.resignedFrom ? `Resigned — unavailable from ${weekLabel(p.resignedFrom)}` : '')

/**
 * Remove the keys whose value is undefined (and, with `alsoEmpty`, the empty strings), in place.
 * "Clear this field" stores no key at all, never `undefined` or '' — so the document stays free
 * of nulls and an emptied object can be dropped.
 */
export function deleteUndefined<T extends object>(obj: T, alsoEmpty = false): T {
  for (const k of Object.keys(obj) as (keyof T)[]) {
    const v = obj[k]
    if (v === undefined || (alsoEmpty && v === '')) delete obj[k]
  }
  return obj
}
export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6)
}

export function fmtNum(v: number): string {
  return (Math.round(v * 10) / 10).toString()
}

/** Inclusive list of week keys between two keys (order-insensitive). */
export function weekRange(a: string, b: string): string[] {
  const [lo, hi] = a <= b ? [a, b] : [b, a]
  const out: string[] = []
  for (let w = lo; w <= hi; w = addWeeks(w, 1)) out.push(w)
  return out
}
