#!/usr/bin/env node
// Builds server/seed.json — the demo data set a fresh database starts from (`just seed`).
//
// Everything here is invented: eight people, four packages, fourteen features (six of them split into
// stories), three releases, a
// handful of milestones and a two-workstream roadmap, chosen so that every state the app can show
// appears somewhere: a feature ahead of plan, one delayed, one blocked, one nobody is booked on,
// one over budget, an overbooked person, a partial away week, a leaver serving notice, someone
// not on the project yet, every roadmap bar status, a ◆ milestone bar. Week keys are computed
// from PROJECT_START so the demo stays coherent — the "current" week is PROJECT_START + 4.
//
// The output is checked with the same payloadProblem() the server runs on an import, then written
// pretty-printed. Run it from the repo root: `node scripts/make-seed.mjs`.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CUSTOMER_DEFAULTS, LINK_CATEGORY_DEFAULTS, STATUS_DEFAULTS, payloadProblem } from '../shared/db.mjs'
import { syncAllFeatureHours } from '../shared/stories.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'server/seed.json')

/** a Monday — the grid's first week; week N of the demo is this plus N weeks */
const PROJECT_START = '2026-09-07'

const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
/** week key of demo week N */
const W = (n) => addDays(PROJECT_START, 7 * n)
/** an ISO date inside demo week N: Monday + `day` (0 = Monday) */
const D = (n, day) => addDays(W(n), day)

// ----- people -----
const [ACME, GLOBEX, INITECH] = CUSTOMER_DEFAULTS

const people = [
  { id: 'p-alice', name: 'Alice Morgan', profile: 'Engineer', short: 'Alice',
    away: [{ start: D(3, 2), end: D(3, 4), type: 'Vacation', note: 'long weekend' }] }, // part of a week away → the "!" marker
  { id: 'p-ben', name: 'Ben Carter', profile: 'Engineer', short: 'Ben', capacity: 80 }, // 80%: one day a week on support
  { id: 'p-chloe', name: 'Chloe Nguyen', profile: 'QA', short: 'Chloe', defaultKind: 'test',
    away: [{ start: D(4, 2), end: D(4, 2), type: 'Sick' }] },
  { id: 'p-dan', name: 'Dan Okafor', profile: 'Engineer', short: 'Dan',
    away: [{ start: D(6, 0), end: D(6, 4), type: 'Vacation' }] }, // a whole week away
  { id: 'p-eva', name: 'Eva Lindqvist', profile: 'BA', short: 'Eva',
    away: [{ start: D(5, 0), end: D(5, 0), type: 'Public holiday', note: 'Thanksgiving (CA)' }] },
  { id: 'p-finn', name: 'Finn Harper', profile: 'QA', short: 'Finn', defaultKind: 'test',
    away: [{ start: D(8, 0), end: D(8, 1), type: 'Training', note: 'test automation course' }] },
  // leaving in week 7: struck through everywhere, capacity 0 from that day, bookings past it read as overbooked
  { id: 'p-grace', name: 'Grace Kim', profile: 'Engineer', short: 'Grace', resignedFrom: W(7) },
  // joins in week 8: "not on the project yet" until then
  { id: 'p-hugo', name: 'Hugo Silva', profile: 'Engineer', short: 'Hugo',
    external: [{ start: '2026-01-05', end: D(7, 6), pct: 100, note: 'Not on the project yet' }] },
]

// ----- packages (the `Epic` records) -----
const epics = [
  { id: 'e-100', key: 'PKG-100', name: 'Customer onboarding' },
  { id: 'e-200', key: 'PKG-200', name: 'Payments' },
  { id: 'e-300', key: 'PKG-300', name: 'Reporting & analytics' },
  { id: 'e-400', key: 'PKG-400', name: 'Platform maintenance' },
]

// ----- features -----
let seq = 0
const entry = (personId, kind = 'dev', pct = 100, note) => ({ id: `n${(++seq).toString(36).padStart(4, '0')}`, personId, pct, kind, ...(note ? { note } : {}) })
const slot = (label, kind, pct = 100) => ({ id: `n${(++seq).toString(36).padStart(4, '0')}`, personId: null, label, pct, kind })
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
/** the same entries on every week from a to b inclusive */
const span = (a, b, ...items) => Object.fromEntries(Array.from({ length: b - a + 1 }, (_, i) => [a + i, items]))

const features = [
  // --- PKG-100 Customer onboarding ---
  { id: 'f-101', epicId: 'e-100', key: 'PROJ-101', name: 'Self-service sign-up form', status: 'Closed', releaseId: 'r-1-0', customer: ACME,
    leadId: 'p-alice', buddyId: 'p-ben', testLeadId: 'p-chloe', planStart: W(0), planEnd: W(2), deadline: W(3),
    estimate: 60, logged: 52, remaining: 0,
    cells: cells({ 0: [entry('p-alice')], 1: [entry('p-alice', 'dev', 40), entry('p-chloe', 'test', 60)] }), // finished a week early
    tracking: { comment: 'Shipped a week ahead of plan.' },
    links: [{ label: 'PROJ-101', url: 'https://jira.example.com/browse/PROJ-101', category: 'Jira' }] },
  { id: 'f-102', epicId: 'e-100', key: 'PROJ-102', name: 'Identity verification (KYC)', status: 'In Progress', releaseId: 'r-1-0', customer: ACME,
    leadId: 'p-alice', testLeadId: 'p-chloe', planStart: W(1), planEnd: W(5), deadline: W(5),
    estimate: 120, logged: 70, remaining: 40,
    cells: cells({ 1: [entry('p-alice', 'dev', 60)], 2: [entry('p-alice')], 3: [entry('p-alice', 'dev', 40)], 4: [entry('p-alice', 'dev', 80, 'in code review'), entry('p-chloe', 'test', 40)], 5: [entry('p-alice', 'dev', 40), entry('p-chloe', 'test', 100)] }), // week 3: Alice is away Wed–Fri
    tracking: { risks: 'The KYC provider’s sandbox is flaky; retries are in place.' },
    links: [{ label: 'KYC spec', url: 'https://wiki.example.com/kyc', category: 'Spec' }] },
  { id: 'f-103', epicId: 'e-100', key: 'PROJ-103', name: 'Welcome email sequence', status: 'In Progress', releaseId: 'r-1-0', customer: ACME,
    leadId: 'p-dan', buddyId: 'p-alice', testLeadId: 'p-finn', planStart: W(0), planEnd: W(2), deadline: W(2),
    estimate: 40, logged: 48, remaining: 10, // over budget, and still running three weeks past its planned end
    cells: cells({ ...span(0, 3, entry('p-dan', 'dev', 60)), 4: [entry('p-dan', 'dev', 60), entry('p-finn', 'test', 40)], 5: [entry('p-finn', 'test', 60, 'regression')] }),
    tracking: { comment: 'Template approvals from marketing took longer than planned.', blockers: 'Legal sign-off on the footer text' } },
  { id: 'f-104', epicId: 'e-100', key: 'PROJ-104', name: 'Account recovery flow', status: 'New', releaseId: 'r-1-1', customer: GLOBEX,
    leadId: 'p-ben', planStart: W(6), planEnd: W(8), deadline: W(9),
    estimate: 50, remaining: 50, cells: {} }, // estimated, nobody booked → "Needs attention"

  // --- PKG-200 Payments ---
  { id: 'f-201', epicId: 'e-200', key: 'PROJ-201', name: 'Card payments via PSP', status: 'Blocked', releaseId: 'r-1-1', customer: GLOBEX,
    leadId: 'p-ben', testLeadId: 'p-finn', planStart: W(2), planEnd: W(6), deadline: W(6),
    estimate: 100, logged: 35, remaining: 60,
    cells: cells({ ...span(2, 4, entry('p-ben', 'dev', 80)), 5: [entry('p-ben', 'buffer', 40, 'waiting for credentials'), 'Blocked on PSP sandbox access'] }),
    tracking: { blockers: 'PROJ-299 — PSP sandbox credentials', risks: 'Release 1.1 slips if the credentials take another week.' } },
  { id: 'f-202', epicId: 'e-200', key: 'PROJ-202', name: 'Refunds & chargebacks', status: 'Analyzing', releaseId: 'r-1-1', customer: GLOBEX,
    leadId: 'p-eva', planStart: W(6), planEnd: W(9),
    estimate: 80, remaining: 80,
    cells: cells({ 6: [entry('p-eva', 'dev', 40, 'analysis'), slot('Test', 'test', 60), 'Waiting for the PSP contract'], 7: [entry('p-eva', 'dev', 40)] }) },
  { id: 'f-203', epicId: 'e-200', key: 'PROJ-203', name: 'Invoice PDF export', status: 'Need Verification', releaseId: 'r-1-0', customer: INITECH,
    leadId: 'p-dan', testLeadId: 'p-finn', planStart: W(2), planEnd: W(4), deadline: W(4),
    estimate: 30, logged: 28, remaining: 4,
    cells: cells({ ...span(2, 3, entry('p-dan', 'dev', 40)), 4: [entry('p-finn', 'test', 60)], 5: [entry('p-finn', 'test', 40, 'edge cases')] }) },
  { id: 'f-204', epicId: 'e-200', key: 'PROJ-204', name: 'Crypto payments', status: 'Rejected', releaseId: 'r-2-0', customer: GLOBEX,
    leadId: 'p-eva', estimate: 60, logged: 6, remaining: 0, cells: {},
    tracking: { comment: 'Out of scope this year — revisit with the 2.0 roadmap.' } },

  // --- PKG-300 Reporting & analytics ---
  { id: 'f-301', epicId: 'e-300', key: 'PROJ-301', name: 'Usage dashboard', status: 'In Progress', releaseId: 'r-1-1', customer: INITECH,
    leadId: 'p-grace', testLeadId: 'p-chloe', planStart: W(3), planEnd: W(7), deadline: W(7),
    estimate: 90, logged: 30, remaining: 60,
    cells: cells({ ...span(3, 7, entry('p-grace')), 6: [entry('p-grace'), entry('p-chloe', 'test', 40)], 7: [entry('p-grace'), entry('p-chloe', 'test', 80)] }), // week 7 is past Grace's last day → to be reassigned
    tracking: { risks: 'Grace leaves in week 7 — handover to Hugo needed.' } },
  { id: 'f-302', epicId: 'e-300', key: 'PROJ-302', name: 'Scheduled report emails', status: 'Open', releaseId: 'r-1-1', customer: INITECH,
    leadId: 'p-hugo', testLeadId: 'p-chloe', planStart: W(8), planEnd: W(10), deadline: W(10),
    estimate: 45, remaining: 45,
    cells: cells({ ...span(8, 10, entry('p-hugo')), 10: [entry('p-hugo', 'dev', 60), entry('p-chloe', 'test', 40)] }) },
  { id: 'f-303', epicId: 'e-300', key: 'PROJ-303', name: 'Data export API', status: 'In Progress', releaseId: 'r-2-0', customer: GLOBEX,
    leadId: 'p-ben', buddyId: 'p-dan', planStart: W(4), planEnd: W(8),
    estimate: 70, logged: 12, remaining: 55,
    cells: cells({ 4: [entry('p-ben', 'dev', 80)], 5: [entry('p-ben', 'dev', 40)], ...span(6, 8, entry('p-ben', 'dev', 80)) }), // week 4: Ben is also 80% on PROJ-201 → overbooked
    links: [{ label: 'PROJ-303', url: 'https://jira.example.com/browse/PROJ-303', category: 'Jira' }, { label: 'API design', url: 'https://wiki.example.com/export-api', category: 'Docs' }] },

  // --- PKG-400 Platform maintenance ---
  { id: 'f-401', epicId: 'e-400', key: 'PROJ-401', name: 'Upgrade to Node 24', status: 'Closed', releaseId: 'r-1-0',
    leadId: 'p-ben', planStart: W(0), planEnd: W(1), estimate: 20, logged: 24, remaining: 0,
    cells: cells(span(0, 1, entry('p-ben', 'dev', 40))) },
  { id: 'f-402', epicId: 'e-400', key: 'PROJ-402', name: 'Security patch rollout', status: 'In Progress',
    leadId: 'p-alice', planStart: W(4), planEnd: W(5), deadline: W(5), estimate: 16, logged: 6, remaining: 8,
    cells: cells({ 4: [entry('p-alice', 'dev', 20)], 5: [entry('p-alice', 'dev', 20), entry('p-dan', 'buffer', 20)] }) },
  { id: 'f-403', epicId: 'e-400', key: 'PROJ-403', name: 'Observability: distributed tracing', status: 'New', releaseId: 'r-2-0',
    cells: {}, description: 'Not estimated yet — spike planned for release 2.0.' },
]

// ----- releases and milestones -----
// ----- stories -----
// The Status tab's third level. A feature with stories carries their sums, so every split below
// adds up to the feature's own figures: KYC 120 / 70 / 40, the welcome emails 40 / 48 / 10, account
// recovery 50 / — / 50, card payments 100 / 35 / 60, the usage dashboard 90 / 30 / 60, and the
// tracing spike nothing at all. Between them: a story deep over budget, a blocked one, one with no
// assignee, one with no Jira key, and a feature whose stories carry no hours yet.
const stories = [
  // PROJ-102 Identity verification (KYC) — fully split, mixed statuses
  { id: 's-102-1', featureId: 'f-102', key: 'PROJ-110', name: 'Document upload and OCR', status: 'Closed', leadId: 'p-alice', deadline: W(3),
    estimate: 40, logged: 38, remaining: 0, tracking: { comment: 'Done; OCR accuracy is above the 95% target.' } },
  { id: 's-102-2', featureId: 'f-102', key: 'PROJ-111', name: 'Liveness check', status: 'In Progress', leadId: 'p-alice', deadline: W(5),
    estimate: 50, logged: 30, remaining: 25, tracking: { risks: 'Provider sandbox returns timeouts under load.' } },
  { id: 's-102-3', featureId: 'f-102', key: 'PROJ-112', name: 'Manual review queue', status: 'New', leadId: 'p-chloe', deadline: W(5),
    estimate: 30, logged: 2, remaining: 15 },
  // PROJ-103 Welcome email sequence — the first story is where the budget went
  { id: 's-103-1', featureId: 'f-103', key: 'PROJ-113', name: 'Template design & approvals', status: 'In Progress', leadId: 'p-dan', deadline: W(2),
    estimate: 25, logged: 36, remaining: 4,
    tracking: { risks: 'Every template change restarts the marketing review.', blockers: 'Legal sign-off on the footer text', comment: 'Three rounds of marketing feedback so far.' } },
  { id: 's-103-2', featureId: 'f-103', key: 'PROJ-114', name: 'Send scheduling & open tracking', status: 'In Progress', leadId: 'p-finn', deadline: W(2),
    estimate: 15, logged: 12, remaining: 6, tracking: { comment: 'Regression run in progress.' } },
  // PROJ-104 Account recovery flow — estimated, nothing logged, one story unassigned
  { id: 's-104-1', featureId: 'f-104', key: 'PROJ-115', name: 'Reset link email', status: 'New', leadId: 'p-ben', deadline: W(9),
    estimate: 30, remaining: 30 },
  { id: 's-104-2', featureId: 'f-104', key: 'PROJ-116', name: 'Security questions', status: 'New',
    estimate: 20, remaining: 20, tracking: { comment: 'Needs an owner once Ben is free.' } },
  // PROJ-201 Card payments via PSP — a blocked story
  { id: 's-201-1', featureId: 'f-201', key: 'PROJ-210', name: 'PSP tokenisation', status: 'Blocked', leadId: 'p-ben', deadline: W(5),
    estimate: 60, logged: 35, remaining: 25, tracking: { blockers: 'PROJ-299 — PSP sandbox credentials' } },
  { id: 's-201-2', featureId: 'f-201', key: 'PROJ-211', name: '3-D Secure challenge flow', status: 'New', leadId: 'p-ben', deadline: W(6),
    estimate: 40, remaining: 35 },
  // PROJ-301 Usage dashboard — the handover from Grace to Hugo, story by story
  { id: 's-301-1', featureId: 'f-301', key: 'PROJ-310', name: 'Usage charts', status: 'In Progress', leadId: 'p-grace', deadline: W(6),
    estimate: 40, logged: 25, remaining: 15, tracking: { risks: 'Grace leaves in week 7 — must land before then.' } },
  { id: 's-301-2', featureId: 'f-301', key: 'PROJ-311', name: 'Tenant filter', status: 'In Progress', leadId: 'p-hugo', deadline: W(7),
    estimate: 30, logged: 5, remaining: 25, tracking: { comment: 'Handover from Grace: design walkthrough done, Hugo takes it from week 8.' } },
  { id: 's-301-3', featureId: 'f-301', name: 'Export to CSV', status: 'New', leadId: 'p-hugo', deadline: W(7),
    estimate: 20, remaining: 20 }, // no Jira ticket yet
  // PROJ-403 Observability — stories exist, nothing estimated yet
  { id: 's-403-1', featureId: 'f-403', key: 'PROJ-410', name: 'Instrument the API gateway', status: 'New' },
  { id: 's-403-2', featureId: 'f-403', key: 'PROJ-411', name: 'Trace storage sizing', status: 'Blocked',
    tracking: { blockers: 'Waiting on the infra budget for 2.0' } },
]

const releases = [
  { id: 'r-1-0', name: 'Release 1.0', label: 'Oct', date: D(7, 4), color: '#008060' },
  { id: 'r-1-1', name: 'Release 1.1', label: 'Dec', date: D(13, 4), color: '#006bd8' },
  { id: 'r-2-0', name: 'Release 2.0', label: 'Mar', date: D(28, 4), color: '#feb913' },
]
const milestones = [
  { id: 'm-freeze-1-0', name: 'Code freeze 1.0', date: W(6), releaseId: 'r-1-0' },
  { id: 'm-st-1-0', name: 'System test 1.0', date: W(6), end: D(7, 4), releaseId: 'r-1-0', color: '#006bd8' },
  { id: 'm-golive-1-0', name: 'Go-live 1.0', date: W(8), releaseId: 'r-1-0', color: '#008060' },
  { id: 'm-freeze-1-1', name: 'Code freeze 1.1', date: W(12), releaseId: 'r-1-1' },
]

// ----- roadmap -----
const bar = (start, weeks, rest = {}) => ({ start: W(start), weeks, ...rest })
const workstreams = [
  { id: 'ws-product', parentId: null, name: 'Onboarding & payments', color: '#006bd8', segments: [] },
  { id: 'g-discovery', parentId: 'ws-product', name: 'Discovery', segments: [] },
  { id: 'a-requirements', parentId: 'g-discovery', name: 'Requirements review', segments: [bar(0, 2, { actualStart: W(0), actualEnd: W(1), status: 'Complete', progress: 100 })] },
  { id: 'a-architecture', parentId: 'g-discovery', name: 'Architecture & estimates', segments: [bar(1, 2, { actualStart: W(1), actualEnd: W(2), status: 'Complete', progress: 100 })] },
  { id: 'g-build', parentId: 'ws-product', name: 'Build', segments: [] },
  { id: 'a-onboarding', parentId: 'g-build', name: 'Onboarding features', segments: [bar(2, 5, { actualStart: W(2), status: 'In progress', progress: 45 })] }, // re-estimated past its plan
  { id: 'a-payments', parentId: 'g-build', name: 'Payments integration', segments: [bar(3, 6, { actualStart: W(3), status: 'Blocked', progress: 30, reason: 'PROJ-299 — PSP sandbox credentials' })] },
  { id: 'g-release-1-0', parentId: 'ws-product', name: 'Release 1.0', segments: [] },
  { id: 'a-system-test', parentId: 'g-release-1-0', name: 'System test', segments: [bar(6, 2)] },
  { id: 'a-golive', parentId: 'g-release-1-0', name: 'Go-live', segments: [bar(8, 1, { milestone: true })] },
  { id: 'ws-platform', parentId: null, name: 'Platform', color: '#fd6b1c', segments: [] },
  { id: 'g-maintenance', parentId: 'ws-platform', name: 'Maintenance', segments: [] },
  { id: 'a-node', parentId: 'g-maintenance', name: 'Node upgrade', segments: [bar(0, 2, { actualStart: W(0), actualEnd: W(1), status: 'Complete', progress: 100 })] },
  { id: 'a-security', parentId: 'g-maintenance', name: 'Security hardening', segments: [bar(4, 3, { actualStart: W(4), status: 'On hold', progress: 20, reason: 'Waiting for the pentest report' })] },
  { id: 'g-reporting', parentId: 'ws-platform', name: 'Reporting', segments: [] },
  { id: 'a-dashboard', parentId: 'g-reporting', name: 'Usage dashboard', segments: [bar(3, 5, { actualStart: W(3), status: 'In progress', progress: 60 })] },
  { id: 'a-report-emails', parentId: 'g-reporting', name: 'Scheduled report emails', segments: [bar(8, 3)] },
  { id: 'a-analytics-kickoff', parentId: 'g-reporting', name: 'Analytics 2.0 kick-off', segments: [bar(12, 1, { milestone: true })] },
]

const seed = {
  schemaVersion: 4,
  settings: {
    projectStart: PROJECT_START,
    horizonWeeks: 26,
    hoursPerWeek: 30,
    profiles: ['BA', 'Engineer', 'QA'],
    featureStatuses: [...STATUS_DEFAULTS],
    customers: [...CUSTOMER_DEFAULTS],
    linkCategories: [...LINK_CATEGORY_DEFAULTS],
  },
  people,
  epics,
  features,
  stories,
  releases,
  milestones,
  workstreams,
}

// belt and braces: the figures above are hand-summed, the helper is the source of truth
if (syncAllFeatureHours(seed)) {
  console.error('seed: a feature with stories does not carry their sums — fix the figures in this script')
  process.exit(1)
}
const problem = payloadProblem(seed)
if (problem) {
  console.error(`seed is not a valid database: ${problem}`)
  process.exit(1)
}
fs.writeFileSync(OUT, JSON.stringify(seed, null, 2) + '\n')
console.log(`seed OK — wrote ${path.relative(ROOT, OUT)}: ${people.length} people, ${epics.length} packages, ${features.length} features, ${stories.length} stories, ${releases.length} releases, ${milestones.length} milestones, ${workstreams.length} roadmap rows`)
