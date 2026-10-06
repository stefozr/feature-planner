/**
 * Shared vacation calendar → people's away periods.
 *
 * The team's absences live in a calendar with a public ICS export (typically a Google Calendar fed
 * by an HR tool); this module turns that export into `AwayEntry` rows on the matching people.
 * Pure: no fetch, no database — the server hands in the feed text and a parsed document and
 * writes back what comes out. That keeps it unit-testable with an inline fixture (see
 * vacations.test.mjs).
 *
 * What the feed is expected to look like:
 *   - all-day events: `DTSTART;VALUE=DATE:20260907` / `DTEND;VALUE=DATE:20260912`. DTEND is
 *     *exclusive* per RFC 5545, while AwayEntry.end is inclusive — hence the minus one.
 *   - `SUMMARY:<Full Name> - <Kind>`; DESCRIPTION is the qualifier ("Vacation - Spain",
 *     "Boxing Day"). The kinds are listed in KIND_TO_TYPE.
 *   - an event with no `<Name> - ` part ("Christmas Day") is a public holiday for everyone — so a
 *     plain public-holidays calendar works through the same link.
 *   - recurring events (RRULE — birthdays) are not absences: skipped.
 *   - the export may be a rolling window (some weeks back, a few months ahead). Events older than
 *     the window are not "deleted", they merely fell off the feed — so a sync only replaces
 *     imported entries from the window's start onwards and keeps older imported history.
 *
 * Matching is by folded name (matchKey). A person the exact match misses gets one more chance:
 * the same surname with a shortened first name ("Alex" for "Alexander") counts when it points at
 * exactly one calendar name nobody else claimed (findApproxKey). A person the export does not
 * know at all still receives the company-wide holidays — a National holiday that most calendar
 * names share, and every nameless holiday — so a missing HR row costs them their vacations, not
 * the public holidays.
 */

import { isCalendarUrl } from '../shared/db.mjs'
import { matchKey, findApproxKey } from '../shared/names.mjs'

/** calendar event kinds worth an away period, and the planner type each becomes (case-insensitive) */
export const KIND_TO_TYPE = {
  vacation: 'Vacation',
  holiday: 'Vacation',
  'annual leave': 'Vacation',
  sick: 'Sick',
  'sick leave': 'Sick',
  'national holiday': 'Public holiday',
  'public holiday': 'Public holiday',
  parental: 'Parental',
  'parental leave': 'Parental',
  'paternity leave': 'Parental',
  'maternity leave': 'Parental',
  training: 'Training',
  'borrowed out': 'Borrowed out',
  other: 'Other',
  'marriage wedding leave': 'Other',
}

/** marks an AwayEntry as imported — the UI shows such rows read-only and the sync owns them */
export const SOURCE = 'calendar'

// the name matching lives in shared/names.mjs (the Status tab's sheet import uses it too); re-exported
// so the tests and the server keep one import
export { matchKey, findApproxKey }

/** `20260907` or `20260907T090000Z` → `2026-09-07` */
const isoDate = (v) => `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** RFC 5545 text unescaping: `\,` `\;` `\n` `\\` */
const unescapeText = (s) => s.replace(/\\([,;nN\\])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c))

/** `NAME;PARAM=V:value` → [name, params, value]; null for anything that is not a property line */
const PROPERTY = /^([A-Za-z-]+)((?:;[^:]*)?):(.*)$/

/**
 * Minimal iCalendar reader for what this feed uses: unfolds continuation lines, walks VEVENTs and
 * returns one plain object per event with inclusive ISO dates. Anything it cannot date is dropped.
 *
 * @returns {{ uid: string, summary: string, description: string, start: string, end: string, recurring: boolean }[]}
 */
export function parseIcs(text) {
  // a line starting with a space or tab continues the previous one
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n')
  const events = []
  let cur = null
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      cur = { uid: '', summary: '', description: '', start: '', end: '', endExclusive: true, recurring: false }
      continue
    }
    if (line === 'END:VEVENT') {
      if (cur && cur.start) {
        if (!cur.end) cur.end = cur.start
        else if (cur.endExclusive) cur.end = addDays(cur.end, -1)
        if (cur.end < cur.start) cur.end = cur.start
        const { endExclusive: _drop, ...ev } = cur
        events.push(ev)
      }
      cur = null
      continue
    }
    if (!cur) continue
    const m = line.match(PROPERTY)
    if (!m) continue
    const [, name, params, value] = m
    switch (name.toUpperCase()) {
      case 'UID':
        cur.uid = value.trim()
        break
      case 'SUMMARY':
        cur.summary = unescapeText(value).trim()
        break
      case 'DESCRIPTION':
        cur.description = unescapeText(value).trim()
        break
      case 'RRULE':
        cur.recurring = true
        break
      case 'DTSTART':
        if (/^\d{8}/.test(value)) cur.start = isoDate(value)
        break
      case 'DTEND': {
        if (!/^\d{8}/.test(value)) break
        cur.end = isoDate(value)
        // all-day DTEND is the day after; a timed DTEND is exclusive too, but only lands on the
        // previous day when it sits exactly at midnight
        const allDay = /VALUE=DATE(?:;|$)/i.test(params) || value.length === 8
        cur.endExclusive = allDay || /T000000/.test(value)
        break
      }
      default:
        break
    }
  }
  return events
}

/**
 * The events that become away periods, with the person's name split off the summary and the kind
 * mapped to a planner type. Birthdays (recurring) and unknown kinds are left out.
 */
export function absencesOf(events) {
  const out = []
  for (const ev of events) {
    if (ev.recurring) continue
    const i = ev.summary.lastIndexOf(' - ')
    if (i < 0) continue
    const name = ev.summary.slice(0, i).trim()
    const kind = ev.summary.slice(i + 3).trim().toLowerCase()
    const type = KIND_TO_TYPE[kind]
    if (!type || !name) continue
    out.push({ name, key: matchKey(name), type, start: ev.start, end: ev.end, note: ev.description || undefined, uid: ev.uid })
  }
  return out
}

/**
 * The events that are a holiday for everyone: non-recurring, with no `<Name> - ` part. The summary
 * is the holiday's name ("Christmas Day"). What a public-holidays calendar is made of.
 */
export function sharedHolidaysOf(events) {
  const out = []
  for (const ev of events) {
    if (ev.recurring || !ev.summary || ev.summary.includes(' - ')) continue
    out.push({ type: 'Public holiday', start: ev.start, end: ev.end, note: ev.summary, uid: ev.uid })
  }
  return out.sort((a, b) => a.start.localeCompare(b.start))
}

/**
 * The link the server should pull: the database's setting when it is a valid https:// link, else
 * the environment's, else nothing (sync off). An invalid setting is ignored, never fetched.
 */
export function resolveCalendarUrl(settingUrl, envUrl) {
  if (isCalendarUrl(settingUrl)) return settingUrl
  return typeof envUrl === 'string' && isCalendarUrl(envUrl) ? envUrl : ''
}

/** every person the calendar knows, by match key — birthdays count, so a person with no leave still matches */
function calendarNames(events) {
  const names = new Map()
  for (const ev of events) {
    const i = ev.summary.lastIndexOf(' - ')
    if (i < 0) continue
    const name = ev.summary.slice(0, i).trim()
    if (name) names.set(matchKey(name), name)
  }
  return names
}

const inside = (a, b) => b.start <= a.start && a.end <= b.end

/**
 * Replace one person's imported away entries from `horizon` on with `fresh`, keeping imported
 * history that predates the window and every manual entry not swallowed by an imported one of
 * the same type. Writes `person.away` in place and tallies into `result`.
 */
function mergeAway(person, fresh, horizon, result) {
  const before = JSON.stringify(person.away ?? [])
  const kept = []
  for (const o of person.away ?? []) {
    if (o.source === SOURCE) {
      if (o.end < horizon) kept.push(o) // fell off the feed's window, not deleted
      continue
    }
    const covered = fresh.some((f) => (f.type ?? 'Vacation') === (o.type ?? 'Vacation') && inside(o, f))
    if (covered) result.replacedManual++
    else kept.push(o)
  }
  const next = [...kept, ...fresh].sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end))
  result.imported += fresh.length
  const after = JSON.stringify(next)
  if (after !== before) {
    if (next.length) person.away = next
    else delete person.away
    result.changed = true
  }
}

/** an absence as the AwayEntry the sync writes */
const toEntry = (a, uid) => ({
  start: a.start,
  end: a.end,
  type: a.type,
  ...(a.note ? { note: a.note } : {}),
  source: SOURCE,
  uid,
})

/**
 * Public holidays most of the calendar shares — the company's, as opposed to one colleague's
 * Thanksgiving. Grouped by dates and label; "most" is more than half the names the feed knows.
 * (The nameless holidays of a public-holidays feed are shared by definition — see sharedHolidaysOf.)
 */
export function companyHolidays(absences, nameCount) {
  const groups = new Map()
  for (const a of absences) {
    if (a.type !== 'Public holiday') continue
    const gk = `${a.start}|${a.end}|${a.note ?? ''}`
    let g = groups.get(gk)
    if (!g) groups.set(gk, (g = { sample: a, keys: new Set() }))
    g.keys.add(a.key)
  }
  const out = []
  for (const g of groups.values()) if (g.keys.size * 2 > nameCount) out.push(g.sample)
  return out.sort((a, b) => a.start.localeCompare(b.start))
}

/**
 * Write the feed into `db.people[*].away` in place.
 *
 * Per matched person: imported entries from the feed's window onwards are replaced by what the
 * feed says now; imported entries that end before the window are history and stay; manual entries
 * stay unless one of the same type lies wholly inside an imported period (then the calendar is
 * the record and the hand-typed duplicate goes). The list ends up sorted by start.
 *
 * Matching runs in two passes — exact keys first, then the one-candidate approximate match — so
 * a shortened first name can never take a key someone else holds exactly. People the feed does
 * not know keep their `unmatchedPeople` flag but still receive the company-wide holidays. The
 * feed's nameless holidays go to everyone, matched or not.
 *
 * An empty feed changes nothing — a failed or truncated download must never wipe absences.
 *
 * @param {string} [today] ISO date; people whose `resignedFrom` is on or before it are skipped entirely
 * @returns {{ changed: boolean, matched: number, unmatchedPeople: { id: string, name: string }[], approxPeople: { id: string, name: string, calendarName: string }[], holidayOnly: number, unmatchedCalendarNames: string[], imported: number, replacedManual: number, horizon: string | null }}
 */
export function applyCalendar(db, events, today = new Date().toISOString().slice(0, 10)) {
  const result = {
    changed: false,
    matched: 0,
    unmatchedPeople: [],
    approxPeople: [],
    holidayOnly: 0,
    unmatchedCalendarNames: [],
    imported: 0,
    replacedManual: 0,
    horizon: null,
  }
  if (!events.length) return result

  const absences = absencesOf(events)
  const nameless = sharedHolidaysOf(events)
  const known = calendarNames(events)
  const earliest = (list) => list.reduce((h, e) => (h == null || e.start < h ? e.start : h), null)
  const horizon = earliest([...absences, ...nameless]) ?? earliest(events)
  result.horizon = horizon

  const byKey = new Map()
  for (const a of absences) {
    if (!byKey.has(a.key)) byKey.set(a.key, [])
    byKey.get(a.key).push(a)
  }

  // someone who has already left is neither synced nor reported missing: the HR export drops
  // leavers, and a permanent "not in the calendar" warning on them would say nothing useful
  const people = (db.people ?? []).filter((p) => !(p.resignedFrom && p.resignedFrom <= today))

  // pass 1: exact keys claim first, so an approximate match can never take someone's exact name
  const usedKeys = new Set()
  const keyOf = new Map()
  const pending = []
  for (const person of people) {
    const key = matchKey(person.calendarName || person.name)
    if (known.has(key)) {
      keyOf.set(person, key)
      usedKeys.add(key)
    } else pending.push({ person, key })
  }
  // pass 2: one unambiguous near-miss each, among the keys still free
  for (const { person, key } of pending) {
    const approx = findApproxKey(key, known.keys(), usedKeys)
    if (!approx) continue
    keyOf.set(person, approx)
    usedKeys.add(approx)
    result.approxPeople.push({ id: person.id, name: person.name, calendarName: known.get(approx) })
  }

  const shared = companyHolidays(absences, known.size)
  const everyone = nameless.map((a) => toEntry(a, `holiday:${a.uid || a.start}`))
  // a person's own rows first; a nameless holiday on the same dates is the same day off, not a second one
  const withShared = (own) => [...own, ...everyone.filter((h) => !own.some((o) => o.start === h.start && o.end === h.end))]
  for (const person of people) {
    const key = keyOf.get(person)
    if (key) {
      result.matched++
      mergeAway(person, withShared((byKey.get(key) ?? []).map((a) => toEntry(a, a.uid))), horizon, result)
      continue
    }
    result.unmatchedPeople.push({ id: person.id, name: person.name })
    const fresh = withShared(shared.map((a) => toEntry(a, `company-holiday:${a.start}`)))
    if (fresh.length) {
      result.holidayOnly++
      mergeAway(person, fresh, horizon, result)
    }
  }

  for (const [key, name] of known) if (!usedKeys.has(key)) result.unmatchedCalendarNames.push(name)
  result.unmatchedCalendarNames.sort((a, b) => a.localeCompare(b))
  return result
}
