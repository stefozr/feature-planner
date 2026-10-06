// A feature's hours once it has stories: the sum of the stories'. One copy for the browser (every
// story op in App.tsx) and the server (normalize() on every read and write), so the figure stored
// on the feature can never drift from its stories.

const FIGURES = /** @type {const} */ (['estimate', 'logged', 'remaining'])

/** @typedef {{ estimate?: number, logged?: number, remaining?: number }} Hours */

/**
 * Per-figure sums over the stories, rounded to 0.1h. A figure no story carries is undefined, so
 * the feature reads "—" there instead of 0.
 * @param {Hours[]} stories
 * @returns {Hours}
 */
export function storyHours(stories) {
  /** @type {Hours} */
  const out = {}
  for (const key of FIGURES) {
    let sum = 0
    let any = false
    for (const s of stories) {
      if (typeof s[key] === 'number') {
        sum += s[key]
        any = true
      }
    }
    if (any) out[key] = Math.round(sum * 10) / 10
  }
  return out
}

/**
 * Write the roll-up onto a feature. A feature with no stories is left alone (it keeps whatever it
 * holds, editable again). Returns true when a figure changed.
 * @param {{ features?: any[], stories?: any[] }} db
 * @param {string} featureId
 */
export function syncFeatureHours(db, featureId) {
  const f = (db.features ?? []).find((x) => x.id === featureId)
  if (!f) return false
  const stories = (db.stories ?? []).filter((s) => s.featureId === featureId)
  if (!stories.length) return false
  const sums = storyHours(stories)
  let changed = false
  for (const key of FIGURES) {
    if (sums[key] === undefined) {
      if (f[key] !== undefined) {
        delete f[key]
        changed = true
      }
    } else if (f[key] !== sums[key]) {
      f[key] = sums[key]
      changed = true
    }
  }
  return changed
}

/**
 * Every feature that has stories. Returns true when anything changed.
 * @param {{ features?: any[], stories?: any[] }} db
 */
export function syncAllFeatureHours(db) {
  let changed = false
  for (const id of new Set((db.stories ?? []).map((s) => s.featureId))) {
    if (syncFeatureHours(db, id)) changed = true
  }
  return changed
}
