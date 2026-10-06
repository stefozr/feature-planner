import { DB, Feature, FeatureTracking, ImportField, ImportMapping, ImportUnit, Person, Story, Trackable, statusKey } from '../types'
import { deleteUndefined, mondayOf } from '../logic'
import { findApproxKey, nameKeys } from '../../shared/names.mjs'
import { syncFeatureHours } from '../../shared/stories.mjs'

/*
 * The Status tab's sheet import, the thinking half: which column feeds which field, what a cell
 * means, which record a row is, and what the import would change. Pure — it takes rows of cells
 * (src/status/readSheet.ts turns a file into them) and a document, and hands back a plan the
 * dialog shows and `applyPlan` writes inside one `update()`. No SheetJS in here, so vitest covers
 * it with inline rows.
 */

/** one cell: the value SheetJS gives (dates as Date with cellDates) and its number format, when it has one */
export type Cell = { v: string | number | boolean | Date | null; z?: string }
export type Row = Cell[]

export interface TargetField {
  key: ImportField
  label: string
  hint: string
  kind: 'key' | 'parent' | 'text' | 'status' | 'person' | 'hours' | 'date'
  /** normalised header texts (normHeader) that mean this field, best first */
  aliases: string[]
}

export const TARGET_FIELDS: TargetField[] = [
  { key: 'key', label: 'Jira key', kind: 'key', hint: 'Required — the row is matched to the feature or story with this key', aliases: ['issuekey', 'key', 'jiraid', 'jirakey', 'issue', 'id', 'ticket'] },
  { key: 'name', label: 'Name', kind: 'text', hint: 'The feature or story name (Summary in Jira)', aliases: ['summary', 'name', 'description', 'title', 'featurename', 'issuesummary'] },
  { key: 'parentKey', label: 'Parent key', kind: 'parent', hint: 'A row that matches nothing becomes a story under the feature with this key', aliases: ['parentkey', 'parent', 'epiclink', 'parentissue', 'parentissuekey', 'epic', 'feature', 'featurekey'] },
  { key: 'parentName', label: 'Parent name', kind: 'parent', hint: 'Fallback for the parent: the feature with this name', aliases: ['parentsummary', 'epicname', 'parentname', 'epicsummary'] },
  { key: 'status', label: 'Status', kind: 'status', hint: 'Matched to the app’s statuses; anything else is mapped in the review', aliases: ['status', 'statusplan', 'state'] },
  { key: 'leadId', label: 'Assignee', kind: 'person', hint: 'Matched to a person by name; anything else is mapped in the review', aliases: ['assignee', 'lead', 'featurelead', 'owner', 'assignedto'] },
  {
    key: 'estimate',
    label: 'Original estimate (h)',
    kind: 'hours',
    hint: 'Budget (h) is computed as original estimate − logged − remaining, so a budget figure such as BAC belongs here',
    aliases: ['sumoriginalestimate', 'originalestimate', 'estimate', 'originalestimateh', 'estimateh', 'bac', 'budget', 'overallbudget', 'budgeth', 'budgetatcompletion'],
  },
  { key: 'logged', label: 'Logged (h)', kind: 'hours', hint: 'Hours spent so far', aliases: ['sumtimespent', 'timespent', 'worklogged', 'logged', 'loggedhours', 'loggedh', 'timelogged', 'hourslogged', 'spent'] },
  { key: 'remaining', label: 'Remaining (h)', kind: 'hours', hint: 'Hours of work left', aliases: ['sumremainingestimate', 'remainingestimate', 'remaining', 'remainingh', 'remainingestimateh', 'timeremaining', 'remainingwork'] },
  { key: 'deadline', label: 'Deadline', kind: 'date', hint: 'A date; it is stored as the Monday of its week', aliases: ['duedate', 'deadline', 'targetdate', 'due', 'enddate'] },
  { key: 'risks', label: 'Risks / issues', kind: 'text', hint: 'Free text', aliases: ['risks', 'risksissues', 'risk', 'issues', 'riskissues'] },
  { key: 'blockers', label: 'Dependencies / blockers', kind: 'text', hint: 'Free text', aliases: ['dependenciesblockers', 'blockers', 'dependencies', 'blockedby', 'dependency', 'blocker'] },
  { key: 'comment', label: 'Comment', kind: 'text', hint: 'Free text', aliases: ['comment', 'comments', 'notes', 'note', 'statusnote', 'statuscomment', 'remarks'] },
]

export const HOUR_FIELDS = ['estimate', 'logged', 'remaining'] as const
export type HourField = (typeof HOUR_FIELDS)[number]

export const UNIT_LABEL: Record<ImportUnit, string> = {
  hours: 'hours',
  minutes: 'minutes',
  seconds: 'seconds (Jira CSV)',
  days: 'days — "2d 4h"',
  excelTime: 'Excel time [h]:mm',
}

/** Jira’s default working day; the mapping can override it */
export const DEFAULT_HOURS_PER_DAY = 8

/**
 * A header folded for matching: case, punctuation and spaces dropped, a `Σ` prefix becomes `sum`,
 * and Jira’s `Custom field (X)` wrapper is removed — "Σ Original Estimate" → "sumoriginalestimate".
 */
export function normHeader(h: unknown): string {
  let s = String(h ?? '').trim()
  const custom = /^custom field \((.*)\)$/i.exec(s)
  if (custom) s = custom[1]
  s = s.replace(/^[Σ∑]\s*/, 'sum ')
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

const isBlank = (v: Cell['v']): boolean => v == null || (typeof v === 'string' && v.trim() === '')
const text = (v: Cell['v']): string => (v == null ? '' : v instanceof Date ? v.toISOString() : String(v).trim())

/** the sheet’s way of saying nobody / nothing */
const NONE_WORDS = new Set(['unassigned', 'none', '-', '—', 'n/a', 'na', 'null'])
/** true for the sheet’s “nobody / nothing” words (Unassigned, None, —) */
export const isNone = (s: string): boolean => NONE_WORDS.has(s.trim().toLowerCase())

/** The first row that looks like a header: at least two cells that are a known alias, else the first row with two text cells. */
export function detectHeaderRow(rows: Row[]): number {
  const known = new Set(TARGET_FIELDS.flatMap((t) => t.aliases))
  const limit = Math.min(rows.length, 20)
  for (let i = 0; i < limit; i++) {
    const hits = rows[i].filter((c) => typeof c.v === 'string' && known.has(normHeader(c.v))).length
    if (hits >= 2) return i
  }
  for (let i = 0; i < limit; i++) {
    if (rows[i].filter((c) => typeof c.v === 'string' && c.v.trim()).length >= 2) return i
  }
  return 0
}

export const headersOf = (rows: Row[], headerRow: number): string[] => (rows[headerRow] ?? []).map((c) => text(c.v))

/** the column a mapped header points at: the header text itself first, its folded form as a fallback; -1 when absent */
export function columnIndex(headers: string[], header: string | undefined): number {
  if (!header) return -1
  const exact = headers.indexOf(header)
  if (exact >= 0) return exact
  const want = normHeader(header)
  return want ? headers.findIndex((h) => normHeader(h) === want) : -1
}

/**
 * Which header feeds which field: the saved mapping wins wherever its header is in the file, the
 * rest comes from the alias table, each header used once. A saved hour unit follows its saved
 * column; any other hour column's unit is read from its values. The day length is the saved one.
 */
export function suggestMapping(headers: string[], rows: Row[], saved?: ImportMapping): ImportMapping {
  const columns: ImportMapping['columns'] = {}
  const used = new Set<number>()
  const fromSaved = new Set<ImportField>()
  for (const t of TARGET_FIELDS) {
    const i = columnIndex(headers, saved?.columns[t.key])
    if (i >= 0 && !used.has(i)) {
      columns[t.key] = headers[i]
      used.add(i)
      fromSaved.add(t.key)
    }
  }
  const folded = headers.map(normHeader)
  for (const t of TARGET_FIELDS) {
    if (columns[t.key]) continue
    for (const alias of t.aliases) {
      const i = folded.findIndex((h, j) => h === alias && !used.has(j) && headers[j])
      if (i >= 0) {
        columns[t.key] = headers[i]
        used.add(i)
        break
      }
    }
  }
  // a saved unit belongs to the saved column; a column found by its alias is read from its values
  const units: ImportMapping['units'] = {}
  for (const f of HOUR_FIELDS) {
    const i = columnIndex(headers, columns[f])
    if (i < 0) continue
    units[f] = (fromSaved.has(f) ? saved?.units?.[f] : undefined) ?? guessUnit(rows.map((r) => r[i]).filter(Boolean))
  }
  return {
    columns,
    units,
    hoursPerDay: saved?.hoursPerDay ?? DEFAULT_HOURS_PER_DAY,
    statusMap: { ...saved?.statusMap },
    personMap: { ...saved?.personMap },
    ...(saved?.sheet ? { sheet: saved.sheet } : {}),
  }
}

const DURATION = /^\s*(?:(\d+(?:[.,]\d+)?)\s*w)?\s*(?:(\d+(?:[.,]\d+)?)\s*d)?\s*(?:(\d+(?:[.,]\d+)?)\s*h)?\s*(?:(\d+(?:[.,]\d+)?)\s*m)?\s*$/i

/** "2d 4h 30m" (Jira) in hours, or null when it is not that shape */
export function parseDuration(s: string, hoursPerDay = DEFAULT_HOURS_PER_DAY): number | null {
  if (!/\d\s*[wdhm]/i.test(s)) return null
  const m = DURATION.exec(s)
  if (!m) return null
  const n = (x: string | undefined) => (x ? Number(x.replace(',', '.')) : 0)
  return n(m[1]) * 5 * hoursPerDay + n(m[2]) * hoursPerDay + n(m[3]) + n(m[4]) / 60
}

/** A number as the sheet wrote it: 12, "12", "12,5", "1 250", "242:00" (hours:minutes). Null when it is not one. */
export function parseNumber(v: Cell['v']): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  let s = v.trim().replace(/\s/g, '')
  if (!s) return null
  const hm = /^(\d+):(\d{1,2})$/.exec(s)
  if (hm) return Number(hm[1]) + Number(hm[2]) / 60
  if (s.includes(',') && !s.includes('.')) s = s.replace(',', '.')
  else if (s.includes(',') && s.includes('.')) s = s.replace(/,/g, '')
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/**
 * How an hours column is written, from its cells: an Excel time format, Jira’s "2d 4h" strings,
 * integers that are all whole minutes with some ≥ 1h (Jira’s seconds), else hours.
 */
export function guessUnit(cells: Cell[]): ImportUnit {
  const filled = cells.filter((c) => c && !isBlank(c.v))
  if (!filled.length) return 'hours'
  if (filled.some((c) => c.z && /\[h+\]/i.test(c.z))) return 'excelTime'
  const strings = filled.filter((c) => typeof c.v === 'string') as { v: string }[]
  if (strings.length && strings.every((c) => parseDuration(c.v) != null)) return 'days'
  const nums = filled.map((c) => parseNumber(c.v)).filter((n): n is number => n != null)
  if (nums.length && nums.every((n) => Number.isInteger(n) && n % 60 === 0) && nums.some((n) => n >= 3600)) return 'seconds'
  return 'hours'
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** A cell as hours: undefined when blank, 'invalid' when unreadable, else rounded to 0.01h. */
export function parseHours(cell: Cell | undefined, unit: ImportUnit, hoursPerDay = DEFAULT_HOURS_PER_DAY): number | undefined | 'invalid' {
  const v = cell?.v
  if (v == null || isBlank(v)) return undefined
  if (typeof v === 'string' && isNone(v)) return undefined
  if (typeof v === 'string') {
    const d = parseDuration(v, hoursPerDay)
    if (d != null) return round2(d)
  }
  const n = parseNumber(v)
  if (n == null || n < 0) return 'invalid'
  const h = unit === 'minutes' ? n / 60 : unit === 'seconds' ? n / 3600 : unit === 'days' ? n * hoursPerDay : unit === 'excelTime' ? n * 24 : n
  return round2(h)
}

const pad = (n: number) => String(n).padStart(2, '0')
/** a Date’s calendar day as the browser sees it — SheetJS hands back local midnight, which toISOString would shift */
const localISO = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }

/** A cell as an ISO date: a Date, "2026-10-14", "14/10/2026", "14.10.2026", Jira’s "06/Oct/26 9:12 AM", or an Excel serial. */
export function parseDateCell(v: Cell['v']): string | undefined | 'invalid' {
  if (v == null || isBlank(v)) return undefined
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? 'invalid' : localISO(v)
  if (typeof v === 'number') {
    if (v < 20000 || v > 80000) return 'invalid'
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000)
    return d.toISOString().slice(0, 10)
  }
  const s = String(v).trim()
  if (isNone(s)) return undefined
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})/.exec(s)
  if (m) return `${m[3]}-${pad(+m[2])}-${pad(+m[1])}`
  m = /^(\d{1,2})[/ -]([A-Za-z]{3})[/ -](\d{2,4})/.exec(s)
  if (m && MONTHS[m[2].toLowerCase()]) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]
    return `${y}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(+m[1])}`
  }
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? 'invalid' : localISO(d)
}

/** A date cell as the Monday week key the deadline field stores. */
export function parseWeek(v: Cell['v']): string | undefined | 'invalid' {
  const iso = parseDateCell(v)
  return iso === undefined || iso === 'invalid' ? iso : mondayOf(iso)
}

/** Jira’s usual status names → the app’s defaults (used only when the target status exists in the list) */
const STATUS_SYNONYMS: Record<string, string> = {
  done: 'Closed',
  resolved: 'Closed',
  complete: 'Closed',
  completed: 'Closed',
  finished: 'Closed',
  backlog: 'New',
  todo: 'New',
  selectedfordevelopment: 'New',
  indevelopment: 'In Progress',
  development: 'In Progress',
  inreview: 'Need Verification',
  codereview: 'Need Verification',
  review: 'Need Verification',
  testing: 'Need Verification',
  intesting: 'Need Verification',
  qa: 'Need Verification',
  readyfortest: 'Need Verification',
  onhold: 'Blocked',
  wontdo: 'Rejected',
  cancelled: 'Rejected',
  canceled: 'Rejected',
  analysis: 'Analyzing',
  inanalysis: 'Analyzing',
  refinement: 'Analyzing',
}

/** the key a sheet’s status or name is matched and remembered by */
export const fold = (v: unknown): string => statusKey(String(v ?? ''))

/**
 * The app status a sheet value means: the saved map first ('' = leave alone), then the same word
 * in the list, then the Jira synonyms. `undefined` = unknown, to be decided in the review.
 */
export function resolveStatus(raw: string, statuses: string[], statusMap?: Record<string, string>): string | undefined {
  const k = fold(raw)
  if (statusMap && k in statusMap) return statusMap[k]
  const same = statuses.find((s) => statusKey(s) === k)
  if (same) return same
  const syn = STATUS_SYNONYMS[k]
  if (syn) return statuses.find((s) => statusKey(s) === statusKey(syn))
  return undefined
}

/** name key → person id, every spelling a person may go by */
export function personIndex(people: Person[]): Map<string, string> {
  const idx = new Map<string, string>()
  for (const p of people) {
    for (const k of [...nameKeys(p.name), ...(p.calendarName ? nameKeys(p.calendarName) : []), (p.short ?? '').toLowerCase().trim()]) {
      if (k && !idx.has(k)) idx.set(k, p.id)
    }
  }
  return idx
}

/** The person a sheet’s assignee text means, via the saved map ('' = leave alone), the name index, then the near-miss rule. */
export function resolvePerson(raw: string, idx: Map<string, string>, personMap?: Record<string, string>): string | undefined {
  const k = fold(raw)
  if (personMap && k in personMap) return personMap[k]
  for (const key of nameKeys(raw)) {
    const id = idx.get(key)
    if (id) return id
  }
  const approx = findApproxKey(nameKeys(raw)[0] ?? '', [...idx.keys()])
  return approx ? idx.get(approx) : undefined
}

// ----- the plan -----

export type RowOutcome =
  | { kind: 'feature'; id: string }
  | { kind: 'story'; id: string }
  | { kind: 'new-story'; id: string; featureId: string }
  | { kind: 'skip'; reason: 'ambiguous' | 'duplicate' | 'unmatched' | 'parent-unresolved' | 'parent-is-story'; detail?: string }

export interface Change {
  field: ImportField
  from: unknown
  to: unknown
}

export interface RowPlan {
  /** 1-based row in the sheet */
  row: number
  key: string
  name: string
  outcome: RowOutcome
  patch: Partial<Trackable>
  tracking: Partial<FeatureTracking>
  changes: Change[]
  notes: string[]
}

export interface Hours {
  estimate?: number
  logged?: number
  remaining?: number
}

export interface PlanSummary {
  featuresUpdated: number
  storiesUpdated: number
  storiesCreated: number
  unchanged: number
  skipped: number
  /** rows with an empty key column: subtotal and group rows, dropped silently */
  noKey: number
  unknownStatuses: { value: string; rows: number }[]
  unmatchedPeople: { value: string; rows: number }[]
  unresolvedParents: { value: string; rows: number }[]
  /** features whose hours were not written because they come from stories */
  hoursSkipped: { key: string; rows: number }[]
  /** features with their own hours that gain their first stories: the figures become the stories’ sums */
  hoursReplaced: { featureId: string; key: string; name: string; from: Hours; to: Hours; stories: number }[]
  invalid: { row: number; field: ImportField; value: string }[]
}

export interface ImportPlan {
  rows: RowPlan[]
  /** statuses the value map points at that the list does not have yet; applyPlan adds them */
  newStatuses: string[]
  summary: PlanSummary
}

const upper = (s: string) => s.trim().toUpperCase()

const hoursOf = (t: Hours): Hours => deleteUndefined({ estimate: t.estimate, logged: t.logged, remaining: t.remaining })

/**
 * What importing these rows with this mapping would do to the document. Pure: nothing is written,
 * ids for new stories come from `newId` so the apply (and its 409 replay) create each once.
 */
export function buildPlan(db: DB, rows: Row[], headerRow: number, mapping: ImportMapping, newId: () => string): ImportPlan {
  const headers = headersOf(rows, headerRow)
  const col = (f: ImportField) => columnIndex(headers, mapping.columns[f])
  const ci = Object.fromEntries(TARGET_FIELDS.map((t) => [t.key, col(t.key)])) as Record<ImportField, number>
  const hoursPerDay = mapping.hoursPerDay ?? DEFAULT_HOURS_PER_DAY
  const statuses = db.settings.featureStatuses
  const people = personIndex(db.people)

  const featuresByKey = new Map<string, Feature[]>()
  const featuresByName = new Map<string, Feature[]>()
  for (const f of db.features) {
    if (f.key) (featuresByKey.get(upper(f.key)) ?? featuresByKey.set(upper(f.key), []).get(upper(f.key))!).push(f)
    const n = fold(f.name)
    if (n) (featuresByName.get(n) ?? featuresByName.set(n, []).get(n)!).push(f)
  }
  const storiesByKey = new Map<string, Story[]>()
  const storyCount = new Map<string, number>()
  for (const s of db.stories) {
    if (s.key) (storiesByKey.get(upper(s.key)) ?? storiesByKey.set(upper(s.key), []).get(upper(s.key))!).push(s)
    storyCount.set(s.featureId, (storyCount.get(s.featureId) ?? 0) + 1)
  }
  const featureById = new Map(db.features.map((f) => [f.id, f]))

  const count = (m: Map<string, number>, v: string) => m.set(v, (m.get(v) ?? 0) + 1)
  const unknownStatuses = new Map<string, number>()
  const unmatchedPeople = new Map<string, number>()
  const unresolvedParents = new Map<string, number>()
  const hoursSkipped = new Map<string, number>()
  const invalid: PlanSummary['invalid'] = []
  const newStatuses = new Set<string>()
  const seenKeys = new Map<string, number>()
  /** stories planned under each feature, so the roll-up warning and the hours rule see them */
  const plannedStories = new Map<string, number>()

  const plans: RowPlan[] = []
  let noKey = 0
  for (let r = headerRow + 1; r < rows.length; r++) {
    const cells = rows[r] ?? []
    const cell = (f: ImportField): Cell | undefined => (ci[f] >= 0 ? cells[ci[f]] : undefined)
    const str = (f: ImportField): string => text(cell(f)?.v ?? null)
    const key = str('key')
    if (!key) {
      noKey++
      continue
    }
    const rowNo = r + 1
    const name = str('name')
    const plan: RowPlan = { row: rowNo, key, name, outcome: { kind: 'skip', reason: 'unmatched' }, patch: {}, tracking: {}, changes: [], notes: [] }
    plans.push(plan)

    const K = upper(key)
    const dup = seenKeys.get(K)
    if (dup != null) {
      plan.outcome = { kind: 'skip', reason: 'duplicate', detail: `same key as row ${dup}` }
      continue
    }
    seenKeys.set(K, rowNo)

    // ----- which record -----
    const S = storiesByKey.get(K) ?? []
    const F = featuresByKey.get(K) ?? []
    let target: Trackable | undefined
    let featureId: string | undefined
    if (S.length === 1 && (F.length === 0 || (F.length === 1 && S[0].featureId === F[0].id))) {
      plan.outcome = { kind: 'story', id: S[0].id }
      target = S[0]
      featureId = S[0].featureId
      if (F.length) plan.notes.push('the key is on the feature and its story — the story takes the values')
    } else if (S.length === 0 && F.length === 1) {
      plan.outcome = { kind: 'feature', id: F[0].id }
      target = F[0]
      featureId = F[0].id
    } else if (S.length || F.length) {
      plan.outcome = { kind: 'skip', reason: 'ambiguous', detail: `${F.length} feature${F.length === 1 ? '' : 's'} and ${S.length} stor${S.length === 1 ? 'y' : 'ies'} carry this key` }
      continue
    } else {
      // nothing has the key: a new story under the parent column, when it names one feature
      const pk = str('parentKey')
      const pn = str('parentName')
      let parent: Feature | undefined
      if (pk && !isNone(pk)) {
        const pf = featuresByKey.get(upper(pk)) ?? []
        const ps = storiesByKey.get(upper(pk)) ?? []
        if (pf.length === 1) parent = pf[0]
        else if (pf.length === 0 && ps.length) {
          plan.outcome = { kind: 'skip', reason: 'parent-is-story', detail: `${pk} is a story; a story cannot hold stories` }
          continue
        }
      }
      if (!parent && pn && !isNone(pn)) {
        const pf = featuresByName.get(fold(pn)) ?? []
        if (pf.length === 1) parent = pf[0]
      }
      if (!parent) {
        const label = pk || pn
        if (label) count(unresolvedParents, label)
        plan.outcome = { kind: 'skip', reason: label ? 'parent-unresolved' : 'unmatched', detail: label ? `no feature is “${label}”` : 'no feature or story has this key, and no parent column names one' }
        continue
      }
      featureId = parent.id
      plan.outcome = { kind: 'new-story', id: newId(), featureId }
      plannedStories.set(featureId, (plannedStories.get(featureId) ?? 0) + 1)
      plan.patch.key = key
      plan.patch.name = name || key
      plan.changes.push({ field: 'key', from: undefined, to: key }, { field: 'name', from: undefined, to: name || key })
    }

    // ----- the values; a blank cell leaves the record alone -----
    const set = (field: ImportField, value: unknown) => {
      if (value === undefined) return
      if (field === 'risks' || field === 'blockers' || field === 'comment') {
        if ((target?.tracking?.[field] ?? '') === value) return
        plan.tracking[field] = value as string
        plan.changes.push({ field, from: target?.tracking?.[field], to: value })
        return
      }
      const from = target?.[field as keyof Trackable]
      if (target && from === value) return
      ;(plan.patch as Record<string, unknown>)[field] = value
      plan.changes.push({ field, from, to: value })
    }
    if (target && name) set('name', name)
    const rawStatus = str('status')
    if (rawStatus && !isNone(rawStatus)) {
      const st = resolveStatus(rawStatus, statuses, mapping.statusMap)
      if (st === undefined) count(unknownStatuses, rawStatus)
      else if (st) {
        if (!statuses.includes(st)) newStatuses.add(st)
        set('status', st)
      }
    }
    const rawLead = str('leadId')
    if (rawLead && !isNone(rawLead)) {
      const id = resolvePerson(rawLead, people, mapping.personMap)
      if (id === undefined) count(unmatchedPeople, rawLead)
      else if (id) set('leadId', id)
    }
    const hoursLocked = plan.outcome.kind === 'feature' && ((storyCount.get(featureId!) ?? 0) > 0 || (plannedStories.get(featureId!) ?? 0) > 0)
    let anyHours = false
    for (const f of HOUR_FIELDS) {
      const c = cell(f)
      if (!c) continue
      const h = parseHours(c, mapping.units?.[f] ?? 'hours', hoursPerDay)
      if (h === 'invalid') {
        invalid.push({ row: rowNo, field: f, value: text(c.v) })
        continue
      }
      if (h === undefined) continue
      anyHours = true
      if (hoursLocked) continue
      // "no estimate" and "0h estimate" differ for progress and budget: a zero estimate is left unset
      if (f === 'estimate' && h === 0) continue
      set(f, h)
    }
    if (anyHours && hoursLocked) {
      count(hoursSkipped, key)
      plan.notes.push('hours not written — a feature with stories carries their sum')
    }
    const dl = cell('deadline')
    if (dl) {
      const w = parseWeek(dl.v)
      if (w === 'invalid') invalid.push({ row: rowNo, field: 'deadline', value: text(dl.v) })
      else if (w) set('deadline', w)
    }
    for (const f of ['risks', 'blockers', 'comment'] as const) {
      const v = str(f)
      if (v && !isNone(v)) set(f, v)
    }
  }

  // a feature with its own hours that gains its first stories: its figures become their sums
  const hoursReplaced: PlanSummary['hoursReplaced'] = []
  for (const [fid, n] of plannedStories) {
    const f = featureById.get(fid)
    if (!f || (storyCount.get(fid) ?? 0) > 0) continue
    const from = hoursOf(f)
    if (!Object.keys(from).length) continue
    const to: Hours = {}
    for (const p of plans) {
      if (p.outcome.kind !== 'new-story' || p.outcome.featureId !== fid) continue
      for (const h of HOUR_FIELDS) if (p.patch[h] != null) to[h] = Math.round(((to[h] ?? 0) + p.patch[h]!) * 10) / 10
    }
    hoursReplaced.push({ featureId: fid, key: f.key ?? '', name: f.name, from, to, stories: n })
  }

  const summary: PlanSummary = {
    featuresUpdated: 0,
    storiesUpdated: 0,
    storiesCreated: 0,
    unchanged: 0,
    skipped: 0,
    noKey,
    unknownStatuses: [...unknownStatuses].map(([value, rows]) => ({ value, rows })),
    unmatchedPeople: [...unmatchedPeople].map(([value, rows]) => ({ value, rows })),
    unresolvedParents: [...unresolvedParents].map(([value, rows]) => ({ value, rows })),
    hoursSkipped: [...hoursSkipped].map(([key, rows]) => ({ key, rows })),
    hoursReplaced,
    invalid,
  }
  for (const p of plans) {
    if (p.outcome.kind === 'skip') summary.skipped++
    else if (p.outcome.kind === 'new-story') summary.storiesCreated++
    else if (!p.changes.length) summary.unchanged++
    else if (p.outcome.kind === 'feature') summary.featuresUpdated++
    else summary.storiesUpdated++
  }
  return { rows: plans, newStatuses: [...newStatuses], summary }
}

/**
 * Write the plan into a document — inside one `update()`, so one autosave and one replayable op.
 * Every record is found by id (gone = skipped, never thrown), a story is created once (its id is
 * in the plan), a feature with stories keeps their sum, and the touched features are rolled up.
 */
export function applyPlan(d: DB, plan: ImportPlan): { updated: number; created: number; dropped: number } {
  let updated = 0
  let created = 0
  let dropped = 0
  const touched = new Set<string>()
  const mergeTracking = (t: Trackable, patch: Partial<FeatureTracking>) => {
    if (!Object.keys(patch).length) return
    const next: FeatureTracking = deleteUndefined({ ...t.tracking, ...patch }, true)
    if (Object.keys(next).length) t.tracking = next
    else delete t.tracking
  }
  // stories first, then features: a feature that gains stories here must not take hours below
  for (const p of plan.rows) {
    if (p.outcome.kind !== 'new-story') continue
    const { id, featureId } = p.outcome
    const f = d.features.find((x) => x.id === featureId)
    if (!f) {
      dropped++
      continue
    }
    if (!d.stories.some((s) => s.id === id)) {
      const story: Story = { ...deleteUndefined({ ...p.patch }), id, featureId: f.id, name: p.patch.name || p.key }
      mergeTracking(story, p.tracking)
      const last = d.stories.map((s) => s.featureId).lastIndexOf(f.id)
      d.stories.splice(last < 0 ? d.stories.length : last + 1, 0, story)
      created++
    }
    touched.add(f.id)
  }
  for (const p of plan.rows) {
    const o = p.outcome
    if (o.kind !== 'story') continue
    const s = d.stories.find((x) => x.id === o.id)
    if (!s) {
      dropped++
      continue
    }
    if (!p.changes.length) continue
    deleteUndefined(Object.assign(s, p.patch))
    mergeTracking(s, p.tracking)
    touched.add(s.featureId)
    updated++
  }
  for (const p of plan.rows) {
    const o = p.outcome
    if (o.kind !== 'feature') continue
    const f = d.features.find((x) => x.id === o.id)
    if (!f) {
      dropped++
      continue
    }
    if (!p.changes.length) continue
    const patch = { ...p.patch }
    if (d.stories.some((s) => s.featureId === f.id)) for (const h of HOUR_FIELDS) delete patch[h]
    deleteUndefined(Object.assign(f, patch))
    mergeTracking(f, p.tracking)
    touched.add(f.id)
    updated++
  }
  for (const st of plan.newStatuses) if (!d.settings.featureStatuses.includes(st)) d.settings.featureStatuses.push(st)
  for (const id of touched) syncFeatureHours(d, id)
  return { updated, created, dropped }
}
