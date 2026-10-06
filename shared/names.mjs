// Person-name matching, one copy for the server (the calendar sync, server/vacations.mjs) and the
// browser (the Status tab's sheet import): a name folded into a key, the near-miss rule, and the
// alternative keys a hyphenated or multi-part first name may go by.

/**
 * Name as a matching key: case, diacritics and spacing folded, and a trailing parenthesised
 * qualifier dropped — the planner writes "Dan Okafor (ext)", the calendar "Dan Okafor".
 * @param {string | null | undefined} name
 * @returns {string}
 */
export function matchKey(name) {
  return (name ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** the shortest first-name form that may stand in for a longer one: "ale" is too little to say */
const APPROX_MIN = 3

/**
 * The one calendar key an inexact person key may mean, or null. Same surname (last token), same
 * number of tokens, and every other token equal or a ≥3-character prefix of its counterpart either
 * way — "alex morgan" ↔ "alexander morgan". Null when nothing fits, when two names fit (a guess
 * here would silently hand someone else's leave to the wrong person) or when the only fit is a key
 * another person already matched exactly.
 * @param {string} personKey
 * @param {Iterable<string>} knownKeys
 * @param {Set<string>} [usedKeys]
 * @returns {string | null}
 */
export function findApproxKey(personKey, knownKeys, usedKeys = new Set()) {
  const mine = personKey.split(' ')
  if (mine.length < 2) return null
  /** @param {string} a @param {string} b */
  const fits = (a, b) => a === b || (a.length >= APPROX_MIN && b.startsWith(a)) || (b.length >= APPROX_MIN && a.startsWith(b))
  /** @type {string[]} */
  const hits = []
  for (const key of knownKeys) {
    if (usedKeys.has(key) || key === personKey) continue
    const theirs = key.split(' ')
    if (theirs.length !== mine.length || theirs[theirs.length - 1] !== mine[mine.length - 1]) continue
    if (mine.every((tok, i) => fits(tok, theirs[i]))) hits.push(key)
  }
  return hits.length === 1 ? hits[0] : null
}

/**
 * The keys a name may be found under: the folded name itself, and — when the first name is
 * hyphenated or has several parts — just the first part with the surname ("Anna-Maria Lindqvist"
 * is "Anna Lindqvist" in the planner). Longest first, so the exact form is tried before the short one.
 * @param {string} name
 * @returns {string[]}
 */
export function nameKeys(name) {
  const key = matchKey(name)
  if (!key) return []
  const parts = key.split(/[\s-]+/).filter(Boolean)
  const out = [key]
  if (parts.length > 2) out.push(`${parts[0]} ${parts[parts.length - 1]}`)
  const dehyphen = key.replace(/-/g, ' ')
  if (dehyphen !== key) out.splice(1, 0, dehyphen)
  return [...new Set(out)]
}
