// Demo team "Mobile apps": an iOS and an Android app plus push notifications.
//
// Five people (one a designer, a profile only this team has), three packages, eight features (two
// split into stories), two app releases with a store-review window, and a roadmap with one
// workstream per platform. Its settings differ from the other teams' on purpose: 32 hours a
// person-week, its own customers, and an extra "In Review" status.
// What it shows: a feature finished on plan, one delayed, one blocked, one nobody is booked on, an
// overbooked engineer (Kenji, 80% capacity, booked 120% in week 4), a whole week away.
import { COLOR_DEFAULTS, LINK_CATEGORY_DEFAULTS, STATUS_DEFAULTS } from '../../shared/db.mjs'
import { D, PROJECT_START, W, bar, makeHelpers, span } from './helpers.mjs'

export default function mobileTeam() {
  const { entry, slot, cells } = makeHelpers()
  const [RETAIL, BANKING, INTERNAL] = ['Retail', 'Banking', 'Internal']

  const people = [
    { id: 'p-ivy', name: 'Ivy Brennan', profile: 'Engineer', short: 'Ivy' },
    { id: 'p-jonas', name: 'Jonas Weber', profile: 'Engineer', short: 'Jonas',
      away: [{ start: D(5, 0), end: D(5, 4), type: 'Vacation' }] },
    { id: 'p-kenji', name: 'Kenji Sato', profile: 'Engineer', short: 'Kenji', capacity: 80 }, // Fridays on the support rota
    { id: 'p-lena', name: 'Lena Duarte', profile: 'QA', short: 'Lena', defaultKind: 'test',
      away: [{ start: D(4, 1), end: D(4, 1), type: 'Sick' }] },
    { id: 'p-milo', name: 'Milo Fischer', profile: 'Designer', short: 'Milo' },
  ]

  const epics = [
    { id: 'e-ios', key: 'MOB-100', name: 'iOS app' },
    { id: 'e-android', key: 'MOB-200', name: 'Android app' },
    { id: 'e-push', key: 'MOB-300', name: 'Push notifications' },
  ]

  const features = [
    // --- MOB-100 iOS app ---
    { id: 'f-m101', epicId: 'e-ios', key: 'MOB-101', name: 'Dark mode', status: 'Closed', releaseId: 'r-3-4', customer: RETAIL,
      leadId: 'p-ivy', testLeadId: 'p-lena', planStart: W(0), planEnd: W(2), deadline: W(3),
      estimate: 64, logged: 60, remaining: 0,
      cells: cells({ ...span(0, 1, entry('p-ivy')), 2: [entry('p-lena', 'test', 60), entry('p-milo', 'dev', 20, 'icon tweaks')] }),
      tracking: { comment: 'Shipped with 3.4; design QA signed off.' } },
    { id: 'f-m102', epicId: 'e-ios', key: 'MOB-102', name: 'Apple Pay checkout', status: 'In Progress', releaseId: 'r-3-4', customer: BANKING,
      leadId: 'p-ivy', buddyId: 'p-kenji', testLeadId: 'p-lena', planStart: W(2), planEnd: W(5), deadline: W(5),
      estimate: 96, logged: 50, remaining: 40,
      cells: cells({ ...span(2, 3, entry('p-ivy')), 4: [entry('p-ivy'), entry('p-kenji', 'dev', 40, 'pairing on tokens')], 5: [entry('p-ivy', 'dev', 60), entry('p-lena', 'test', 60)] }),
      tracking: { risks: 'The bank’s tokenisation sandbox is only up on weekdays.' },
      links: [{ label: 'MOB-102', url: 'https://jira.example.com/browse/MOB-102', category: 'Jira' }] },
    { id: 'f-m103', epicId: 'e-ios', key: 'MOB-103', name: 'Home-screen balance widget', status: 'New', releaseId: 'r-3-5', customer: BANKING,
      leadId: 'p-ivy', planStart: W(7), planEnd: W(9), deadline: W(10),
      estimate: 48, remaining: 48, cells: {} }, // estimated, nobody booked → "Needs attention"

    // --- MOB-200 Android app ---
    { id: 'f-m201', epicId: 'e-android', key: 'MOB-201', name: 'Material You redesign', status: 'In Progress', releaseId: 'r-3-4', customer: RETAIL,
      leadId: 'p-kenji', buddyId: 'p-milo', testLeadId: 'p-lena', planStart: W(0), planEnd: W(3), deadline: W(4),
      estimate: 120, logged: 80, remaining: 50, // still running two weeks past its planned end
      cells: cells({ ...span(0, 5, entry('p-kenji', 'dev', 80)), 1: [entry('p-kenji', 'dev', 80), entry('p-milo', 'dev', 60)], 2: [entry('p-kenji', 'dev', 80), entry('p-milo', 'dev', 60)], 5: [entry('p-kenji', 'dev', 80), entry('p-lena', 'test', 40)] }),
      tracking: { risks: 'Dynamic colour on older devices needs a fallback palette.', comment: 'Scope grew with the new navigation bar.' } },
    { id: 'f-m202', epicId: 'e-android', key: 'MOB-202', name: 'Biometric login', status: 'Blocked', releaseId: 'r-3-5', customer: BANKING,
      leadId: 'p-jonas', testLeadId: 'p-lena', planStart: W(3), planEnd: W(6), deadline: W(7),
      estimate: 72, logged: 20, remaining: 52,
      cells: cells({ 3: [entry('p-jonas')], 4: [entry('p-jonas', 'buffer', 60, 'waiting for the certificate'), 'Blocked on the bank’s FIDO certificate'] }), // week 5: Jonas is away
      tracking: { blockers: 'MOB-299 — FIDO certificate from the bank', risks: '3.5 slips if the certificate is not in by week 6.' } },
    { id: 'f-m203', epicId: 'e-android', key: 'MOB-203', name: 'Offline mode', status: 'Analyzing', releaseId: 'r-3-5', customer: INTERNAL,
      leadId: 'p-jonas', planStart: W(8), planEnd: W(11),
      estimate: 90, remaining: 90,
      cells: cells({ 8: [entry('p-jonas', 'dev', 40, 'analysis'), slot('Test', 'test', 40)] }) },

    // --- MOB-300 Push notifications ---
    { id: 'f-m301', epicId: 'e-push', key: 'MOB-301', name: 'Notification preferences screen', status: 'In Review', releaseId: 'r-3-4', customer: RETAIL,
      leadId: 'p-milo', testLeadId: 'p-lena', planStart: W(1), planEnd: W(3), deadline: W(4),
      estimate: 40, logged: 36, remaining: 6,
      cells: cells({ ...span(1, 2, entry('p-milo', 'dev', 40)), 3: [entry('p-milo', 'dev', 40), entry('p-lena', 'test', 40)] }) },
    { id: 'f-m302', epicId: 'e-push', key: 'MOB-302', name: 'Rich push with images', status: 'New', releaseId: 'r-3-5', customer: RETAIL,
      leadId: 'p-kenji', planStart: W(9), planEnd: W(11),
      estimate: 56, remaining: 56,
      cells: cells(span(9, 11, entry('p-kenji', 'dev', 80))) },
  ]

  // stories carry the feature's figures: Apple Pay 96 / 50 / 40, preferences 40 / 36 / 6
  const stories = [
    { id: 's-m102-1', featureId: 'f-m102', key: 'MOB-110', name: 'Payment sheet UI', status: 'Closed', leadId: 'p-ivy', deadline: W(3),
      estimate: 40, logged: 38, remaining: 0 },
    { id: 's-m102-2', featureId: 'f-m102', key: 'MOB-111', name: 'Tokenisation with the bank', status: 'In Progress', leadId: 'p-kenji', deadline: W(5),
      estimate: 56, logged: 12, remaining: 40, tracking: { risks: 'Sandbox downtime at weekends.' } },
    { id: 's-m301-1', featureId: 'f-m301', key: 'MOB-310', name: 'Preferences UI', status: 'In Review', leadId: 'p-milo', deadline: W(3),
      estimate: 24, logged: 22, remaining: 2 },
    { id: 's-m301-2', featureId: 'f-m301', key: 'MOB-311', name: 'Sync preferences to the backend', status: 'In Progress', leadId: 'p-ivy', deadline: W(4),
      estimate: 16, logged: 14, remaining: 4, tracking: { comment: 'Backend endpoint ready; client retry logic left.' } },
  ]

  const releases = [
    { id: 'r-3-4', name: 'App 3.4', label: 'Oct', date: D(6, 3), color: '#7c3aed' },
    { id: 'r-3-5', name: 'App 3.5', label: 'Dec', date: D(14, 3), color: '#0f766e' },
  ]
  const milestones = [
    { id: 'm-freeze-3-4', name: 'Code freeze 3.4', date: W(5), releaseId: 'r-3-4' },
    { id: 'm-review-3-4', name: 'Store review 3.4', date: W(6), end: D(7, 4), releaseId: 'r-3-4', color: '#7c3aed' },
    { id: 'm-freeze-3-5', name: 'Code freeze 3.5', date: W(12), releaseId: 'r-3-5' },
  ]

  const workstreams = [
    { id: 'ws-ios', parentId: null, name: 'iOS', color: '#006bd8', segments: [] },
    { id: 'a-dark-mode', parentId: 'ws-ios', name: 'Dark mode', segments: [bar(0, 3, { actualStart: W(0), actualEnd: W(2), status: 'Complete', progress: 100 })] },
    { id: 'a-apple-pay', parentId: 'ws-ios', name: 'Apple Pay checkout', segments: [bar(2, 4, { actualStart: W(2), status: 'In progress', progress: 55 })] },
    { id: 'a-store-review', parentId: 'ws-ios', name: 'App Store review 3.4', segments: [bar(6, 2)] },
    { id: 'a-release-3-4', parentId: 'ws-ios', name: 'Release 3.4', segments: [bar(8, 1, { milestone: true })] },
    { id: 'ws-android', parentId: null, name: 'Android', color: '#008060', segments: [] },
    { id: 'a-material', parentId: 'ws-android', name: 'Material You redesign', segments: [bar(0, 4, { actualStart: W(0), status: 'In progress', progress: 60 })] }, // re-estimated past its plan
    { id: 'a-biometric', parentId: 'ws-android', name: 'Biometric login', segments: [bar(3, 4, { actualStart: W(3), status: 'Blocked', progress: 25, reason: 'MOB-299 — FIDO certificate' })] },
    { id: 'a-offline', parentId: 'ws-android', name: 'Offline mode', segments: [bar(8, 4)] },
  ]

  const statuses = [...STATUS_DEFAULTS]
  statuses.splice(statuses.indexOf('In Progress') + 1, 0, 'In Review')

  return {
    schemaVersion: 4,
    settings: {
      projectStart: PROJECT_START,
      horizonWeeks: 26,
      hoursPerWeek: 32,
      profiles: ['Designer', 'Engineer', 'QA'],
      featureStatuses: statuses,
      customers: [RETAIL, BANKING, INTERNAL],
      linkCategories: [...LINK_CATEGORY_DEFAULTS],
      optionColors: {
        featureStatuses: { ...COLOR_DEFAULTS.featureStatuses, 'In Review': '#7c3aed' },
        customers: { [RETAIL]: '#c2410c', [BANKING]: '#0f766e', [INTERNAL]: '#64748b' },
        roadmapStatuses: { ...COLOR_DEFAULTS.roadmapStatuses },
      },
    },
    people,
    epics,
    features,
    stories,
    releases,
    milestones,
    workstreams,
  }
}
