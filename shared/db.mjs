// Shared by the storage server (server/index.mjs) and the browser (src/App.tsx, src/types.ts):
// the defaults a new database is seeded with and the structural check an uploaded database must
// pass. One copy, so the two sides cannot drift — the client rejects exactly what the server would.
// Plain ESM with JSDoc types: Node imports it directly, Vite/TS through allowJs.

// Defaults only: they seed a database that has no such list. After that the lists belong to the
// user — the Settings dialog may add, remove, recolor and reorder freely.
/** The Jira workflow's statuses, plus Blocked — which the Capacity tab's "Needs attention" list keys on. */
export const STATUS_DEFAULTS = ['New', 'Open', 'Analyzing', 'In Progress', 'Need Verification', 'Blocked', 'Closed', 'Rejected']
/** The statuses a database from before schema v4 was seeded with → their v4 names; migrate() renames them in place. */
export const LEGACY_STATUS_MAP = {
  'Not started': 'New',
  Clarify: 'Analyzing',
  'In progress': 'In Progress',
  'Code review': 'In Progress',
  Testing: 'Need Verification',
  Done: 'Closed',
}
export const CUSTOMER_DEFAULTS = ['Acme Corp', 'Globex', 'Initech']
export const LINK_CATEGORY_DEFAULTS = ['Jira', 'Spec', 'Docs', 'Other']
/** hours one person-week (100%) is worth, until Settings says otherwise */
export const HOURS_PER_WEEK_DEFAULT = 30
/** value -> hex accent color; tags render it as text color over a ~12% alpha background */
export const COLOR_DEFAULTS = {
  featureStatuses: {
    New: '#94a3b8',
    Open: '#64748b',
    Analyzing: '#b45309',
    'In Progress': '#0369a1',
    'Need Verification': '#0e7490',
    Blocked: '#dc2626',
    Closed: '#15803d',
    Rejected: '#78716c',
  },
  customers: {
    'Acme Corp': '#7c3aed',
    Globex: '#0f766e',
    Initech: '#c2410c',
  },
  /** the roadmap bar statuses — a fixed list, so only the colours are settable */
  roadmapStatuses: {
    Planned: '#64748b',
    'In progress': '#006bd8',
    Blocked: '#e62200',
    'On hold': '#fd6b1c',
    Complete: '#008060',
  },
}
export const KINDS = ['dev', 'test', 'buffer']
/**
 * The id of the built-in Program team: the one team that holds no people or features of its own
 * but reads every other team's plan. The server creates it at startup; nobody can delete it or
 * take its slug.
 */
export const PROGRAM_ID = 'program'

/** @param {unknown} v */
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
/** @param {unknown} v */
const isRef = (v) => typeof v === 'string' && v !== ''

/**
 * The only shape a vacation calendar link may take: an absolute https:// URL. The server fetches
 * whatever is stored here, so anything else (file:, http: to an internal host, …) is refused on
 * both sides before it is saved.
 * @param {unknown} v
 */
export function isCalendarUrl(v) {
  if (typeof v !== 'string') return false
  try {
    return new URL(v).protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Why an object cannot be stored as the database, or null when it can. Strict enough to catch a
 * wrong, truncated or hand-edited file before it replaces everything — every id unique, every
 * container the shape the grid walks unguarded — and loose enough that exports from older schema
 * versions still import: every optional field stays optional, and the server's normalize() fills
 * the rest in. Messages name the path.
 *
 * With `references` (the default, and what an import gets) every id a record points at — a
 * feature's epic, lead, buddy, test lead and release, a story's feature and lead, an entry's person,
 * a milestone's release, a roadmap row's parent — must exist. An autosave is checked without it: the app cleans references up when
 * it deletes things, but a database that already carried a stale one must keep saving, since the
 * UI only shows such a reference as "—".
 * @param {unknown} input
 * @param {{ references?: boolean }} [opts]
 * @returns {string | null}
 */
export function payloadProblem(input, { references = true } = {}) {
  if (!isObj(input)) return 'expected a JSON object'
  const db = /** @type {Record<string, any>} */ (input)
  for (const key of ['people', 'epics', 'features']) {
    if (!Array.isArray(db[key])) return `missing ${key}[]`
  }
  for (const key of ['stories', 'releases', 'milestones', 'workstreams']) {
    if (db[key] != null && !Array.isArray(db[key])) return `${key} is not an array`
  }
  if (db.settings != null) {
    if (!isObj(db.settings)) return 'settings is not an object'
    const s = db.settings
    for (const k of ['horizonWeeks', 'hoursPerWeek']) {
      if (s[k] != null && typeof s[k] !== 'number') return `settings.${k} is not a number`
    }
    for (const k of ['projectStart', 'calendarUrl']) {
      if (s[k] != null && typeof s[k] !== 'string') return `settings.${k} is not a string`
    }
    if (s.calendarUrl && !isCalendarUrl(s.calendarUrl)) return 'settings.calendarUrl is not an https:// link'
    for (const k of ['profiles', 'featureStatuses', 'customers', 'linkCategories']) {
      if (s[k] != null && !Array.isArray(s[k])) return `settings.${k} is not an array`
    }
    if (s.optionColors != null && !isObj(s.optionColors)) return 'settings.optionColors is not an object'
    if (s.importMapping != null && !isObj(s.importMapping)) return 'settings.importMapping is not an object'
  }
  // the Program team's own notes on other teams' features, keyed "<team>:<feature>"
  if (db.program != null) {
    if (!isObj(db.program)) return 'program is not an object'
    if (db.program.tracking != null) {
      if (!isObj(db.program.tracking)) return 'program.tracking is not an object'
      for (const [k, t] of Object.entries(db.program.tracking)) {
        if (!isObj(t)) return `program.tracking["${k}"] is not an object`
        for (const f of ['risks', 'blockers', 'comment']) if (t[f] != null && typeof t[f] !== 'string') return `program.tracking["${k}"].${f} is not a string`
      }
    }
  }

  /**
   * Every record an object with a string id and name, ids unique within the array.
   * @param {string} key
   * @param {(item: Record<string, any>, at: string) => string | null} [more]
   * @returns {{ ids: Set<string> } | string}
   */
  const records = (key, more) => {
    /** @type {Set<string>} */
    const ids = new Set()
    for (const [i, item] of (db[key] ?? []).entries()) {
      const at = `${key}[${i}]`
      if (!isObj(item)) return `${at} is not an object`
      if (!isRef(item.id) || !isRef(item.name)) return `${at} is missing id or name`
      if (ids.has(item.id)) return `${at} repeats id "${item.id}"`
      ids.add(item.id)
      const problem = more?.(item, at)
      if (problem) return problem
    }
    return { ids }
  }

  const people = records('people', (p, at) => {
    if (!isRef(p.profile)) return `${at} is missing profile`
    for (const k of ['away', 'external']) {
      if (p[k] != null && !Array.isArray(p[k])) return `${at}.${k} is not an array`
    }
    for (const k of ['away', 'external']) {
      for (const [j, e] of (p[k] ?? []).entries()) if (!isObj(e)) return `${at}.${k}[${j}] is not an object`
    }
    return null
  })
  if (typeof people === 'string') return people
  const epics = records('epics')
  if (typeof epics === 'string') return epics
  const releases = records('releases')
  if (typeof releases === 'string') return releases

  /** @param {string} at @param {string} field @param {unknown} v @param {Set<string>} ids @param {string} what */
  const ref = (at, field, v, ids, what) => {
    if (v == null || v === '') return null
    if (typeof v !== 'string') return `${at}.${field} is not an id`
    return !references || ids.has(v) ? null : `${at}.${field} points at no ${what} ("${v}")`
  }

  const features = records('features', (f, at) => {
    if (!isRef(f.epicId)) return `${at} is missing epicId`
    let problem = ref(at, 'epicId', f.epicId, epics.ids, 'epic')
    if (problem) return problem
    if (f.cells != null) {
      if (!isObj(f.cells)) return `${at}.cells is not an object`
      for (const [week, cell] of Object.entries(f.cells)) {
        const cat = `${at}.cells["${week}"]`
        if (!isObj(cell)) return `${cat} is not an object`
        if (cell.entries != null && !Array.isArray(cell.entries)) return `${cat}.entries is not an array`
        for (const [j, e] of (cell.entries ?? []).entries()) {
          if (!isObj(e)) return `${cat}.entries[${j}] is not an object`
          problem = ref(cat, `entries[${j}].personId`, e.personId, people.ids, 'person')
          if (problem) return problem
        }
      }
    }
    return (
      ref(at, 'leadId', f.leadId, people.ids, 'person') ??
      ref(at, 'buddyId', f.buddyId, people.ids, 'person') ??
      ref(at, 'testLeadId', f.testLeadId, people.ids, 'person') ??
      ref(at, 'releaseId', f.releaseId, releases.ids, 'release')
    )
  })
  if (typeof features === 'string') return features

  const stories = records('stories', (st, at) => {
    if (!isRef(st.featureId)) return `${at} is missing featureId`
    return ref(at, 'featureId', st.featureId, features.ids, 'feature') ?? ref(at, 'leadId', st.leadId, people.ids, 'person')
  })
  if (typeof stories === 'string') return stories

  const milestones = records('milestones', (m, at) => {
    if (typeof m.date !== 'string') return `${at} is missing date`
    return ref(at, 'releaseId', m.releaseId, releases.ids, 'release')
  })
  if (typeof milestones === 'string') return milestones

  const workstreams = records('workstreams', (w, at) => {
    if (w.segments != null && !Array.isArray(w.segments)) return `${at}.segments is not an array`
    for (const [j, seg] of (w.segments ?? []).entries()) {
      if (!isObj(seg)) return `${at}.segments[${j}] is not an object`
      if (typeof seg.start !== 'string') return `${at}.segments[${j}] is missing start`
      if (typeof seg.weeks !== 'number') return `${at}.segments[${j}] is missing weeks`
    }
    return null
  })
  if (typeof workstreams === 'string') return workstreams
  for (const [i, w] of (db.workstreams ?? []).entries()) {
    const problem = ref(`workstreams[${i}]`, 'parentId', w.parentId, workstreams.ids, 'roadmap row')
    if (problem) return problem
  }
  return null
}
