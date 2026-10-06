import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseIcs, absencesOf, applyCalendar, matchKey, findApproxKey, companyHolidays, sharedHolidaysOf, resolveCalendarUrl } from './vacations.mjs'

const event = (uid, start, endExclusive, summary, description, extra = '') =>
  [
    'BEGIN:VEVENT',
    `DTSTART;VALUE=DATE:${start}`,
    `DTEND;VALUE=DATE:${endExclusive}`,
    `UID:${uid}`,
    extra,
    `DESCRIPTION:${description}`,
    `SUMMARY:${summary}`,
    'END:VEVENT',
  ]
    .filter(Boolean)
    .join('\r\n')

const FEED = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  event('v1', '20260907', '20260912', 'Alice Morgan - Vacation', 'Vacation - Spain'),
  event('h1', '20261201', '20261202', 'Alice Morgan - National holiday', 'National Day'),
  event('v2', '20260824', '20260829', 'Dan Okafor - Vacation', 'Vacation - Portugal'),
  event('b1', '20261002', '20261003', 'Dan Okafor - Birthday', 'Birthday', 'RRULE:FREQ=YEARLY;COUNT=5'),
  event('p1', '20260915', '20260916', 'Eva Lindqvist - Paternity leave', 'Paternity'),
  event('m1', '20260920', '20260922', 'Eva Lindqvist - Marriage wedding leave', 'Wedding'),
  event('x1', '20260920', '20260921', 'Eva Lindqvist - Team offsite', 'not an absence'),
  event('b2', '20261110', '20261111', 'Only Birthday - Birthday', 'Birthday', 'RRULE:FREQ=YEARLY;COUNT=5'),
  // folded line + escaped comma
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20261005',
  'DTEND;VALUE=DATE:20261006',
  'UID:f1',
  'DESCRIPTION:Vacation\\, folded',
  '  description',
  'SUMMARY:Eva Lindqvist - Vacation',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

test('parseIcs: all-day DTEND is exclusive, lines unfold, text unescapes, RRULE flags recurring', () => {
  const evs = parseIcs(FEED)
  assert.equal(evs.length, 9)
  const v1 = evs.find((e) => e.uid === 'v1')
  assert.deepEqual([v1.start, v1.end], ['2026-09-07', '2026-09-11'])
  const h1 = evs.find((e) => e.uid === 'h1')
  assert.deepEqual([h1.start, h1.end], ['2026-12-01', '2026-12-01'])
  assert.equal(evs.find((e) => e.uid === 'b1').recurring, true)
  assert.equal(evs.find((e) => e.uid === 'f1').description, 'Vacation, folded description')
})

test('parseIcs: a timed event collapses to its dates; midnight DTEND is the previous day', () => {
  const evs = parseIcs(
    ['BEGIN:VEVENT', 'DTSTART:20260907T090000Z', 'DTEND:20260908T000000Z', 'UID:t1', 'SUMMARY:X Y - Vacation', 'END:VEVENT'].join('\n'),
  )
  assert.deepEqual([evs[0].start, evs[0].end], ['2026-09-07', '2026-09-07'])
  const evs2 = parseIcs(
    ['BEGIN:VEVENT', 'DTSTART:20260907T090000Z', 'DTEND:20260908T170000Z', 'UID:t2', 'SUMMARY:X Y - Vacation', 'END:VEVENT'].join('\n'),
  )
  assert.deepEqual([evs2[0].start, evs2[0].end], ['2026-09-07', '2026-09-08'])
})

test('absencesOf: kinds map to planner types, birthdays and unknown kinds drop out', () => {
  const abs = absencesOf(parseIcs(FEED))
  const types = Object.fromEntries(abs.map((a) => [a.uid, a.type]))
  assert.deepEqual(types, {
    v1: 'Vacation',
    h1: 'Public holiday',
    v2: 'Vacation',
    p1: 'Parental',
    m1: 'Other',
    f1: 'Vacation',
  })
  assert.equal(abs.find((a) => a.uid === 'v1').note, 'Vacation - Spain')
})

test('absencesOf: every planner away type has a kind, matched regardless of case', () => {
  const feed = [
    'BEGIN:VCALENDAR',
    event('s', '20260901', '20260902', 'Alice Morgan - sick', ''),
    event('t', '20260903', '20260904', 'Alice Morgan - TRAINING', ''),
    event('b', '20260907', '20260912', 'Alice Morgan - Borrowed out', 'on loan'),
    event('p', '20260914', '20260915', 'Alice Morgan - Public Holiday', ''),
    event('a', '20260916', '20260917', 'Alice Morgan - Annual leave', ''),
    'END:VCALENDAR',
  ].join('\n')
  assert.deepEqual(
    absencesOf(parseIcs(feed)).map((a) => a.type),
    ['Sick', 'Training', 'Borrowed out', 'Public holiday', 'Vacation'],
  )
})

test('matchKey folds case, diacritics, spacing and a trailing (suffix)', () => {
  assert.equal(matchKey('Dán  Okafor (ext)'), 'dan okafor')
  assert.equal(matchKey('Hugo Silva (prod)'), matchKey('hugo silva'))
  assert.equal(matchKey(''), '')
})

const db = () => ({
  people: [
    {
      id: 'am',
      name: 'Alice Morgan',
      profile: 'PM',
      away: [
        { start: '2026-09-07', end: '2026-09-11', type: 'Vacation', note: 'Vacation (requested)' }, // covered → dropped
        { start: '2026-09-08', end: '2026-09-09', type: 'Sick' }, // other type → kept
        { start: '2026-10-19', end: '2026-10-23', type: 'Vacation' }, // not covered → kept
        { start: '2026-07-01', end: '2026-07-03', type: 'Vacation', source: 'calendar', uid: 'old' }, // before horizon → kept
        { start: '2026-09-01', end: '2026-09-01', type: 'Vacation', source: 'calendar', uid: 'gone' }, // in window, not in feed → dropped
      ],
    },
    { id: 'do', name: 'Dan Okafor (ext)', profile: 'PO' },
    { id: 'el', name: 'E. Lindqvist', profile: 'BA', calendarName: 'Eva Lindqvist' },
    { id: 'fh', name: 'Finn Harper', profile: 'Architect', away: [{ start: '2026-09-01', end: '2026-09-02', type: 'Vacation' }] },
  ],
})

test('applyCalendar: replaces imported entries in the window, keeps history and uncovered manual ones', () => {
  const d = db()
  const r = applyCalendar(d, parseIcs(FEED))
  assert.equal(r.changed, true)
  assert.equal(r.matched, 3)
  assert.deepEqual(r.unmatchedPeople, [{ id: 'fh', name: 'Finn Harper' }])
  assert.deepEqual(r.unmatchedCalendarNames, ['Only Birthday'])
  assert.equal(r.replacedManual, 1)
  assert.equal(r.horizon, '2026-08-24')

  const am = d.people[0].away
  assert.deepEqual(
    am.map((o) => [o.start, o.end, o.type, o.source ?? 'manual']),
    [
      ['2026-07-01', '2026-07-03', 'Vacation', 'calendar'],
      ['2026-09-07', '2026-09-11', 'Vacation', 'calendar'],
      ['2026-09-08', '2026-09-09', 'Sick', 'manual'],
      ['2026-10-19', '2026-10-23', 'Vacation', 'manual'],
      ['2026-12-01', '2026-12-01', 'Public holiday', 'calendar'],
    ],
  )
  assert.equal(am[1].uid, 'v1')
  assert.equal(am[1].note, 'Vacation - Spain')

  // suffix match and calendarName alias both land entries
  assert.equal(d.people[1].away.length, 1)
  assert.deepEqual(d.people[2].away.map((o) => o.type), ['Parental', 'Other', 'Vacation'])
  // unmatched person untouched
  assert.deepEqual(d.people[3].away, [{ start: '2026-09-01', end: '2026-09-02', type: 'Vacation' }])
})

test('applyCalendar: a second run is a no-op', () => {
  const d = db()
  applyCalendar(d, parseIcs(FEED))
  const snapshot = JSON.stringify(d)
  const r = applyCalendar(d, parseIcs(FEED))
  assert.equal(r.changed, false)
  assert.equal(JSON.stringify(d), snapshot)
})

test('applyCalendar: an empty feed changes nothing', () => {
  const d = db()
  const snapshot = JSON.stringify(d)
  const r = applyCalendar(d, [])
  assert.equal(r.changed, false)
  assert.equal(JSON.stringify(d), snapshot)
})

test('applyCalendar: a person whose only imported entries vanish loses the away key', () => {
  const d = { people: [{ id: 'x', name: 'Alice Morgan', profile: 'PM', away: [{ start: '2026-09-01', end: '2026-09-01', source: 'calendar', uid: 'gone' }] }] }
  const feed = ['BEGIN:VCALENDAR', event('b', '20260901', '20260902', 'Alice Morgan - Birthday', 'Birthday', 'RRULE:FREQ=YEARLY'), 'END:VCALENDAR'].join('\n')
  const r = applyCalendar(d, parseIcs(feed))
  assert.equal(r.changed, true)
  assert.equal('away' in d.people[0], false)
})

test('applyCalendar: a leaver already gone is skipped, one still serving notice is synced', () => {
  const d = {
    people: [
      // not in the feed: would be reported unmatched, except they left last month
      { id: 'gone', name: 'Finn Harper', profile: 'Architect', resignedFrom: '2026-08-15', away: [{ start: '2026-09-01', end: '2026-09-02', type: 'Vacation' }] },
      // in the feed and leaving next month: still imported like anyone else
      { id: 'notice', name: 'Alice Morgan', profile: 'PM', resignedFrom: '2026-10-15' },
    ],
  }
  const r = applyCalendar(d, parseIcs(FEED), '2026-09-23')
  assert.equal(r.matched, 1)
  assert.deepEqual(r.unmatchedPeople, [])
  assert.deepEqual(d.people[0].away, [{ start: '2026-09-01', end: '2026-09-02', type: 'Vacation' }])
  assert.deepEqual(d.people[1].away.map((o) => o.uid), ['v1', 'h1'])
})

test('findApproxKey: a shortened first name finds its one owner, never a shared or taken one', () => {
  const known = ['alexander reed', 'alexander price', 'alice morgan', 'alexander pope', 'alex pope']
  assert.equal(findApproxKey('alex reed', known), 'alexander reed')
  assert.equal(findApproxKey('alexander reed', ['alex reed']), 'alex reed') // either direction
  assert.equal(findApproxKey('alex price', known, new Set(['alexander price'])), null) // taken exactly by someone else
  assert.equal(findApproxKey('alexa pope', known), null) // two candidates → no guess
  assert.equal(findApproxKey('alex carter', known), null) // surname differs
  assert.equal(findApproxKey('al reed', known), null) // too short to stand for a name
  assert.equal(findApproxKey('alex james reed', known), null) // token count differs
})

/** a feed where a holiday covers most people, and one person carries a foreign holiday alone */
const HOLIDAY_FEED = [
  'BEGIN:VCALENDAR',
  event('a1', '20261130', '20261201', 'Alexander Reed - National holiday', "Founders' Day"),
  event('a2', '20261201', '20261202', 'Alexander Reed - National holiday', 'National Day'),
  event('s1', '20261130', '20261201', 'Alice Morgan - National holiday', "Founders' Day"),
  event('s2', '20261201', '20261202', 'Alice Morgan - National holiday', 'National Day'),
  event('c1', '20261126', '20261127', 'Chloe Nguyen - National holiday', 'Thanksgiving Day'),
  event('c2', '20261130', '20261201', 'Chloe Nguyen - National holiday', "Founders' Day"),
  event('v1', '20261005', '20261010', 'Alice Morgan - Vacation', 'Vacation - Spain'),
  'END:VCALENDAR',
].join('\r\n')

test('companyHolidays: more than half the names makes a holiday company-wide', () => {
  const shared = companyHolidays(absencesOf(parseIcs(HOLIDAY_FEED)), 3)
  assert.deepEqual(shared.map((a) => [a.start, a.note]), [['2026-11-30', "Founders' Day"], ['2026-12-01', 'National Day']])
})

test("applyCalendar: the export's missing people still get the company holidays; near-miss names match", () => {
  const d = {
    people: [
      { id: 'ar', name: 'Alex Reed', profile: 'PO' }, // "Alexander" in the calendar
      { id: 'fh', name: 'Finn Harper', profile: 'Architect', away: [{ start: '2026-12-01', end: '2026-12-01', type: 'Public holiday' }, { start: '2026-10-19', end: '2026-10-23', type: 'Vacation' }] },
      { id: 'cn', name: 'Chloe Nguyen', profile: 'PM' },
      { id: 'gone', name: 'Grace Kim', profile: 'Engineer', resignedFrom: '2026-08-01' },
    ],
  }
  const r = applyCalendar(d, parseIcs(HOLIDAY_FEED), '2026-09-23')
  assert.equal(r.matched, 2)
  assert.deepEqual(r.approxPeople, [{ id: 'ar', name: 'Alex Reed', calendarName: 'Alexander Reed' }])
  assert.deepEqual(r.unmatchedPeople, [{ id: 'fh', name: 'Finn Harper' }])
  assert.equal(r.holidayOnly, 1)
  assert.deepEqual(r.unmatchedCalendarNames, ['Alice Morgan'])
  // the near-miss gets exactly their own calendar rows
  assert.deepEqual(d.people[0].away.map((o) => o.uid), ['a1', 'a2'])
  // the missing person gets the two shared holidays, keeps the vacation, loses the duplicate manual holiday
  assert.deepEqual(
    d.people[1].away.map((o) => [o.start, o.type, o.source ?? 'manual', o.uid ?? null]),
    [
      ['2026-10-19', 'Vacation', 'manual', null],
      ['2026-11-30', 'Public holiday', 'calendar', 'company-holiday:2026-11-30'],
      ['2026-12-01', 'Public holiday', 'calendar', 'company-holiday:2026-12-01'],
    ],
  )
  assert.equal(r.replacedManual, 1)
  // a matched person follows their own calendar: Thanksgiving stays theirs alone, National Day is not forced on them
  assert.deepEqual(d.people[2].away.map((o) => o.note), ['Thanksgiving Day', "Founders' Day"])
  // the leaver is left alone
  assert.equal('away' in d.people[3], false)
  // and it settles
  const snapshot = JSON.stringify(d)
  const r2 = applyCalendar(d, parseIcs(HOLIDAY_FEED), '2026-09-23')
  assert.equal(r2.changed, false)
  assert.equal(JSON.stringify(d), snapshot)
})

/** a public-holidays calendar: no names at all, plus one person's own vacation */
const PUBLIC_FEED = [
  'BEGIN:VCALENDAR',
  event('xmas', '20261225', '20261226', 'Christmas Day', ''),
  event('ny', '20270101', '20270102', "New Year's Day", ''),
  event('v1', '20261005', '20261010', 'Alice Morgan - Vacation', 'Vacation - Spain'),
  event('own', '20261225', '20261226', 'Alice Morgan - National holiday', 'Christmas Day'),
  'END:VCALENDAR',
].join('\r\n')

test('sharedHolidaysOf: events with no name are holidays for everyone', () => {
  assert.deepEqual(
    sharedHolidaysOf(parseIcs(PUBLIC_FEED)).map((h) => [h.start, h.note, h.type]),
    [
      ['2026-12-25', 'Christmas Day', 'Public holiday'],
      ['2027-01-01', "New Year's Day", 'Public holiday'],
    ],
  )
})

test('applyCalendar: nameless holidays reach everyone, matched or not, without doubling a day already on their own calendar', () => {
  const d = {
    people: [
      { id: 'am', name: 'Alice Morgan', profile: 'PM' },
      { id: 'fh', name: 'Finn Harper', profile: 'Architect' },
    ],
  }
  const r = applyCalendar(d, parseIcs(PUBLIC_FEED), '2026-09-23')
  assert.equal(r.matched, 1)
  assert.equal(r.holidayOnly, 1)
  assert.equal(r.horizon, '2026-10-05')
  // the matched person: own rows, then New Year's — Christmas is already their own row
  assert.deepEqual(
    d.people[0].away.map((o) => [o.start, o.uid]),
    [
      ['2026-10-05', 'v1'],
      ['2026-12-25', 'own'],
      ['2027-01-01', 'holiday:ny'],
    ],
  )
  // the unknown person: both holidays, nothing else — Christmas via the company rule (the one
  // named person has it), so the nameless copy is not added on top
  assert.deepEqual(
    d.people[1].away.map((o) => [o.start, o.type, o.source, o.uid]),
    [
      ['2026-12-25', 'Public holiday', 'calendar', 'company-holiday:2026-12-25'],
      ['2027-01-01', 'Public holiday', 'calendar', 'holiday:ny'],
    ],
  )
  const snapshot = JSON.stringify(d)
  assert.equal(applyCalendar(d, parseIcs(PUBLIC_FEED), '2026-09-23').changed, false)
  assert.equal(JSON.stringify(d), snapshot)
})

test('resolveCalendarUrl: the setting wins, the environment is the fallback, anything but https is ignored', () => {
  assert.equal(resolveCalendarUrl('https://calendar.example.com/a.ics', 'https://env.example.com/b.ics'), 'https://calendar.example.com/a.ics')
  assert.equal(resolveCalendarUrl(undefined, 'https://env.example.com/b.ics'), 'https://env.example.com/b.ics')
  assert.equal(resolveCalendarUrl('', ''), '')
  assert.equal(resolveCalendarUrl(undefined, undefined), '')
  assert.equal(resolveCalendarUrl('http://calendar.example.com/a.ics', undefined), '')
  assert.equal(resolveCalendarUrl('file:///etc/passwd', 'ftp://x'), '')
  assert.equal(resolveCalendarUrl('not a url', 'https://env.example.com/b.ics'), 'https://env.example.com/b.ics')
})
