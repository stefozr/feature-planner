// The document's shape over time: `normalize()` fills what is missing on every read and write,
// `migrate()` rewrites values once per schema version. Pure — no database, no fetch — so the
// ladder is unit-tested with inline documents (schema.test.mjs) and a seed can be run through it.
import { syncAllFeatureHours } from '../shared/stories.mjs'
import { COLOR_DEFAULTS, CUSTOMER_DEFAULTS, HOURS_PER_WEEK_DEFAULT, KINDS as KIND_LIST, LEGACY_STATUS_MAP, LINK_CATEGORY_DEFAULTS, STATUS_DEFAULTS } from '../shared/db.mjs'

export const SCHEMA_VERSION = 4

export function nextMonday() {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7))
  return d.toISOString().slice(0, 10)
}

// the seed defaults and the payload check live in shared/db.mjs, one copy for server and client
const KINDS = new Set(KIND_LIST)
const ARRAYS = ['people', 'epics', 'features', 'stories', 'releases', 'milestones', 'workstreams']

let entrySeq = 0
const entryId = () => `n${Date.now().toString(36)}${(entrySeq++).toString(36)}`

/**
 * Structural repair, safe to run on every read and every write: it only fills in what is
 * missing and never overwrites a value the user could have set. Anything that *rewrites*
 * values belongs in an upgrade step instead — see migrate(). The one derived field is the
 * exception: a feature's hours are the sum of its stories' once it has any (the UI never lets
 * a user set them then), and that must hold on every save, not once per version.
 */
export function normalize(db) {
  let changed = false
  const fill = (obj, key, value) => {
    if (obj[key] === undefined || obj[key] === null) {
      obj[key] = typeof value === 'function' ? value() : value
      changed = true
    }
  }
  for (const key of ARRAYS) {
    if (!Array.isArray(db[key])) {
      db[key] = []
      changed = true
    }
  }
  if (!db.settings || typeof db.settings !== 'object') {
    db.settings = {}
    changed = true
  }
  const s = db.settings
  fill(s, 'projectStart', nextMonday)
  fill(s, 'horizonWeeks', 28)
  fill(s, 'hoursPerWeek', HOURS_PER_WEEK_DEFAULT)
  if (!Array.isArray(s.profiles)) {
    s.profiles = [...new Set(['Engineer', 'QA', 'BA', ...db.people.map((p) => p.profile).filter(Boolean)])].sort()
    changed = true
  }
  // a list that is missing is seeded with the defaults plus whatever the features already use, so
  // no value in the data is left without a chip in the picker
  const usedValues = (field) => db.features.map((f) => f[field]).filter((v) => typeof v === 'string' && v)
  if (!Array.isArray(s.featureStatuses)) {
    s.featureStatuses = [...new Set([...STATUS_DEFAULTS, ...usedValues('status')])]
    changed = true
  }
  if (!Array.isArray(s.customers)) {
    const used = usedValues('customer')
    s.customers = [...new Set([...(used.length ? [] : CUSTOMER_DEFAULTS), ...used])]
    changed = true
  }
  if (!Array.isArray(s.linkCategories)) {
    s.linkCategories = [...LINK_CATEGORY_DEFAULTS]
    changed = true
  }
  if (typeof s.optionColors !== 'object' || s.optionColors == null) {
    s.optionColors = structuredClone(COLOR_DEFAULTS)
    changed = true
  }
  // a list added later (roadmapStatuses, customers) is seeded into a database that predates it
  for (const [list, colors] of Object.entries(COLOR_DEFAULTS)) {
    if (typeof s.optionColors[list] !== 'object' || s.optionColors[list] == null) {
      s.optionColors[list] = structuredClone(colors)
      changed = true
    }
  }
  // the grid walks cells/entries unguarded — an import must not be able to hand it a feature
  // without them
  for (const f of db.features) {
    if (typeof f.cells !== 'object' || f.cells == null || Array.isArray(f.cells)) {
      f.cells = {}
      changed = true
    }
    for (const cell of Object.values(f.cells)) {
      if (!Array.isArray(cell.entries)) {
        cell.entries = []
        changed = true
      }
      for (const e of cell.entries) {
        fill(e, 'id', entryId)
        if (e.personId === undefined) {
          e.personId = null
          changed = true
        }
        if (typeof e.pct !== 'number') {
          e.pct = 100
          changed = true
        }
        if (!KINDS.has(e.kind)) {
          e.kind = 'dev'
          changed = true
        }
      }
    }
  }
  for (const w of db.workstreams) {
    if (!Array.isArray(w.segments)) {
      w.segments = []
      changed = true
    }
    if (w.parentId === undefined) {
      w.parentId = null
      changed = true
    }
  }
  if (syncAllFeatureHours(db)) changed = true
  return changed
}

/**
 * Bring a database to SCHEMA_VERSION, in place. Returns true if anything changed.
 * Upgrades (value rewrites) go in the `from < N` ladder; normalize() only fills gaps.
 */
export function migrate(db) {
  let changed = normalize(db)
  const from = db.schemaVersion ?? 0
  // `<` on purpose: a document written by a newer build is left exactly as it is, never downgraded
  if (from < 2) {
    // v2: the start/end weeks the plan was imported with become the original plan (planStart/planEnd);
    // startWeek/endWeek now mean the actual dates and fall back to the booked weeks when empty.
    for (const f of db.features ?? []) {
      if (f.planStart === undefined && f.startWeek) f.planStart = f.startWeek
      if (f.planEnd === undefined && f.endWeek) f.planEnd = f.endWeek
      delete f.startWeek
      delete f.endWeek
    }
  }
  if (from < 3) {
    // v3: a roadmap row's ◆ milestones become one-week bars flagged `milestone`, so they carry a
    // status, actual dates and a delay like any other bar
    for (const w of db.workstreams ?? []) {
      if (!Array.isArray(w.segments)) w.segments = []
      for (const week of Array.isArray(w.milestones) ? w.milestones : []) {
        if (typeof week === 'string') w.segments.push({ start: week, weeks: 1, milestone: true })
      }
      delete w.milestones
    }
  }
  if (from < 4) {
    // v4: estimates are hours (the old story points × hoursPerSP); the finish week folds into the
    // actual end; the Status tab keeps only its text columns; the feature statuses are the Jira set
    const perSP = Number(db.settings?.hoursPerSP) || 4
    const hours = (v) => Math.round(v * perSP * 10) / 10
    const rename = (v) => LEGACY_STATUS_MAP[v] ?? v
    for (const f of db.features ?? []) {
      if (typeof f.estimate === 'number') f.estimate = hours(f.estimate)
      if (typeof f.remaining === 'number') f.remaining = hours(f.remaining)
      if (f.completedWeek && !f.endWeek) f.endWeek = f.completedWeek
      delete f.completedWeek
      if (f.tracking && typeof f.tracking === 'object') {
        const { risks, blockers, comment } = f.tracking
        f.tracking = Object.fromEntries(Object.entries({ risks, blockers, comment }).filter(([, v]) => typeof v === 'string' && v !== ''))
        if (!Object.keys(f.tracking).length) delete f.tracking
      }
      if (typeof f.status === 'string') f.status = rename(f.status)
    }
    const s = db.settings
    delete s.hoursPerSP
    // the new defaults first, then whatever custom values the list held (renamed), deduplicated
    const old = Array.isArray(s.featureStatuses) ? s.featureStatuses.map(rename) : []
    s.featureStatuses = [...new Set([...STATUS_DEFAULTS, ...old])]
    const colors = s.optionColors?.featureStatuses
    if (colors && typeof colors === 'object') {
      for (const k of Object.keys(LEGACY_STATUS_MAP)) delete colors[k]
      for (const [k, c] of Object.entries(COLOR_DEFAULTS.featureStatuses)) colors[k] ??= c
    }
    for (const p of db.people ?? []) delete p.aliases
  }
  if (from < SCHEMA_VERSION) {
    db.schemaVersion = SCHEMA_VERSION
    normalize(db)
    changed = true
  }
  return changed
}
