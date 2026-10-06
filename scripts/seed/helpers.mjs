// Shared by the demo team builders in scripts/seed/: the week arithmetic every document is laid
// out in, the booking and roadmap-bar shorthands, and the check a finished document must pass.
// Every team uses the same PROJECT_START, so "today" (week 4 of the demo) sits in the same place
// in each of them.
import { payloadProblem } from '../../shared/db.mjs'
import { syncAllFeatureHours } from '../../shared/stories.mjs'

/** a Monday — the grid's first week; week N of the demo is this plus N weeks */
export const PROJECT_START = '2026-09-07'

export const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
/** week key of demo week N */
export const W = (n) => addDays(PROJECT_START, 7 * n)
/** an ISO date inside demo week N: Monday + `day` (0 = Monday) */
export const D = (n, day) => addDays(W(n), day)

/** the same entries on every week from a to b inclusive */
export const span = (a, b, ...items) => Object.fromEntries(Array.from({ length: b - a + 1 }, (_, i) => [a + i, items]))

/** a roadmap bar: planned start week, planned length, then the actual side */
export const bar = (start, weeks, rest = {}) => ({ start: W(start), weeks, ...rest })

/**
 * The booking shorthands for one document. Entry ids only need to be unique inside a cell, but a
 * fresh counter per document keeps each team's ids stable however many teams are built before it.
 */
export function makeHelpers() {
  let seq = 0
  const nextId = () => `n${(++seq).toString(36).padStart(4, '0')}`
  /** a named booking: person, kind, % of the week, optional note */
  const entry = (personId, kind = 'dev', pct = 100, note) => ({ id: nextId(), personId, pct, kind, ...(note ? { note } : {}) })
  /** an unnamed slot ("Test", "Dev") nobody is assigned to yet */
  const slot = (label, kind, pct = 100) => ({ id: nextId(), personId: null, label, pct, kind })
  /** cells: week N → entries (and an optional cell note as a trailing string) */
  const cells = (spec) => {
    const out = {}
    for (const [n, items] of Object.entries(spec)) {
      const entries = items.filter((x) => typeof x !== 'string')
      const note = items.find((x) => typeof x === 'string')
      out[W(Number(n))] = { entries, ...(note ? { note } : {}) }
    }
    return out
  }
  return { entry, slot, cells }
}

/**
 * Throws when a document is not one the server would accept: a feature with stories must already
 * carry their sums (the figures are hand-summed in the builders, the helper is the source of
 * truth), and the import check must pass.
 */
export function checkDoc(label, doc) {
  if (syncAllFeatureHours(structuredClone(doc))) throw new Error(`${label}: a feature with stories does not carry their sums — fix the figures in its builder`)
  const problem = payloadProblem(doc)
  if (problem) throw new Error(`${label} is not a valid database: ${problem}`)
}

/** one line for the console: what a document holds */
export const summary = (doc) =>
  `${doc.people.length} people, ${doc.epics.length} packages, ${doc.features.length} features, ${doc.stories.length} stories, ${doc.releases.length} releases, ${doc.milestones.length} milestones, ${doc.workstreams.length} roadmap rows`
