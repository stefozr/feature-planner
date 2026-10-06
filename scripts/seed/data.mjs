// Demo team "Data platform": ingestion pipelines and the warehouse behind the company's reporting.
//
// Four people (one borrowed out to another team for a week, one analyst at 60%), two packages, six
// features (one split into stories), one release with a schema freeze and a cutover window, and a
// single-workstream roadmap.
// What it shows: a feature delayed by the borrowed-out week, one blocked, one finished, one nobody
// is booked on, an overbooked engineer (Oscar, 120% in week 4), an On hold roadmap bar.
import { COLOR_DEFAULTS, LINK_CATEGORY_DEFAULTS, STATUS_DEFAULTS } from '../../shared/db.mjs'
import { D, PROJECT_START, W, bar, makeHelpers, span } from './helpers.mjs'

export default function dataTeam() {
  const { entry, slot, cells } = makeHelpers()
  const [FINANCE, OPERATIONS] = ['Finance', 'Operations']

  const people = [
    { id: 'p-nora', name: 'Nora Ahmed', profile: 'Data engineer', short: 'Nora',
      away: [{ start: D(5, 0), end: D(5, 4), type: 'Borrowed out', note: 'helping Mobile apps with the release' }] },
    { id: 'p-oscar', name: 'Oscar Lind', profile: 'Data engineer', short: 'Oscar' },
    { id: 'p-priya', name: 'Priya Raman', profile: 'Analyst', short: 'Priya', capacity: 60 }, // part-time
    { id: 'p-quinn', name: 'Quinn Rossi', profile: 'QA', short: 'Quinn', defaultKind: 'test' },
  ]

  const epics = [
    { id: 'e-ingest', key: 'DATA-100', name: 'Ingestion pipelines' },
    { id: 'e-warehouse', key: 'DATA-200', name: 'Warehouse & BI' },
  ]

  const features = [
    // --- DATA-100 Ingestion pipelines ---
    { id: 'f-d101', epicId: 'e-ingest', key: 'DATA-101', name: 'CRM change-data capture', status: 'In Progress', releaseId: 'r-q4', customer: OPERATIONS,
      leadId: 'p-nora', testLeadId: 'p-quinn', planStart: W(0), planEnd: W(4), deadline: W(5),
      estimate: 110, logged: 70, remaining: 50, // week 5 lost to the borrowed-out week → delayed
      cells: cells({ ...span(0, 4, entry('p-nora')), 6: [entry('p-nora', 'dev', 80), entry('p-quinn', 'test', 40)] }),
      tracking: { risks: 'Backfill volume is three times the estimate.' },
      links: [{ label: 'CDC design', url: 'https://wiki.example.com/cdc', category: 'Spec' }] },
    { id: 'f-d102', epicId: 'e-ingest', key: 'DATA-102', name: 'Billing events stream', status: 'Blocked', releaseId: 'r-q4', customer: FINANCE,
      leadId: 'p-oscar', planStart: W(2), planEnd: W(5), deadline: W(6),
      estimate: 80, logged: 24, remaining: 60,
      cells: cells({ ...span(2, 3, entry('p-oscar')), 4: [entry('p-oscar', 'buffer', 40, 'waiting for Kafka ACLs'), 'Blocked on platform ACLs'] }),
      tracking: { blockers: 'INFRA-512 — Kafka ACLs for the billing topic' } },
    { id: 'f-d103', epicId: 'e-ingest', key: 'DATA-103', name: 'Ingestion monitoring alerts', status: 'Closed', releaseId: 'r-q4', customer: OPERATIONS,
      leadId: 'p-oscar', planStart: W(0), planEnd: W(1), estimate: 24, logged: 20, remaining: 0,
      cells: cells(span(0, 1, entry('p-oscar', 'dev', 60))) },

    // --- DATA-200 Warehouse & BI ---
    { id: 'f-d201', epicId: 'e-warehouse', key: 'DATA-201', name: 'Finance data mart', status: 'In Progress', releaseId: 'r-q4', customer: FINANCE,
      leadId: 'p-priya', buddyId: 'p-nora', testLeadId: 'p-quinn', planStart: W(3), planEnd: W(8), deadline: W(9),
      estimate: 140, logged: 30, remaining: 110,
      cells: cells({ ...span(3, 8, entry('p-priya', 'dev', 60)), 4: [entry('p-priya', 'dev', 60), entry('p-oscar', 'dev', 80, 'dbt models')], 7: [entry('p-priya', 'dev', 60), entry('p-quinn', 'test', 60)], 8: [entry('p-priya', 'dev', 60), entry('p-quinn', 'test', 60)] }), // week 4: Oscar is also on DATA-102 → 120%
      tracking: { comment: 'Finance reviews the model every second Thursday.' } },
    { id: 'f-d202', epicId: 'e-warehouse', key: 'DATA-202', name: 'Self-service BI rollout', status: 'New', releaseId: 'r-q4', customer: OPERATIONS,
      leadId: 'p-priya', planStart: W(9), planEnd: W(12), deadline: W(13),
      estimate: 60, remaining: 60, cells: {} }, // estimated, nobody booked → "Needs attention"
    { id: 'f-d203', epicId: 'e-warehouse', key: 'DATA-203', name: 'Retire the legacy warehouse', status: 'Analyzing', releaseId: 'r-q4', customer: FINANCE,
      leadId: 'p-nora', planStart: W(10), planEnd: W(12),
      estimate: 40, remaining: 40,
      cells: cells({ 10: [entry('p-nora', 'dev', 40, 'analysis'), slot('Dev', 'dev', 60)] }) },
  ]

  // stories carry the feature's figures: CDC 110 / 70 / 50
  const stories = [
    { id: 's-d101-1', featureId: 'f-d101', key: 'DATA-110', name: 'Debezium connectors', status: 'Closed', leadId: 'p-nora', deadline: W(2),
      estimate: 50, logged: 48, remaining: 0 },
    { id: 's-d101-2', featureId: 'f-d101', key: 'DATA-111', name: 'Schema registry', status: 'In Progress', leadId: 'p-oscar', deadline: W(4),
      estimate: 35, logged: 22, remaining: 20 },
    { id: 's-d101-3', featureId: 'f-d101', key: 'DATA-112', name: 'Backfill of history', status: 'New', leadId: 'p-nora', deadline: W(6),
      estimate: 25, remaining: 30, tracking: { risks: 'Three times more rows than estimated.' } },
  ]

  const releases = [{ id: 'r-q4', name: 'Platform Q4', label: 'Dec', date: D(15, 4), color: '#c2410c' }]
  const milestones = [
    { id: 'm-schema-freeze', name: 'Schema freeze', date: W(8), releaseId: 'r-q4' },
    { id: 'm-cutover', name: 'Warehouse cutover', date: W(10), end: D(11, 4), releaseId: 'r-q4', color: '#c2410c' },
  ]

  const workstreams = [
    { id: 'ws-data', parentId: null, name: 'Data platform', color: '#7c3aed', segments: [] },
    { id: 'g-ingestion', parentId: 'ws-data', name: 'Ingestion', segments: [] },
    { id: 'a-alerts', parentId: 'g-ingestion', name: 'Monitoring alerts', segments: [bar(0, 2, { actualStart: W(0), actualEnd: W(1), status: 'Complete', progress: 100 })] },
    { id: 'a-cdc', parentId: 'g-ingestion', name: 'CRM change-data capture', segments: [bar(0, 5, { actualStart: W(0), status: 'In progress', progress: 60 })] },
    { id: 'a-billing', parentId: 'g-ingestion', name: 'Billing events stream', segments: [bar(2, 4, { actualStart: W(2), status: 'Blocked', progress: 30, reason: 'INFRA-512 — Kafka ACLs' })] },
    { id: 'g-warehouse', parentId: 'ws-data', name: 'Warehouse', segments: [] },
    { id: 'a-mart', parentId: 'g-warehouse', name: 'Finance data mart', segments: [bar(3, 6, { actualStart: W(3), status: 'In progress', progress: 20 })] },
    { id: 'a-governance', parentId: 'g-warehouse', name: 'Data governance review', segments: [bar(4, 2, { actualStart: W(4), status: 'On hold', progress: 10, reason: 'Waiting for the DPO' })] },
    { id: 'a-cutover', parentId: 'g-warehouse', name: 'Warehouse cutover', segments: [bar(10, 2)] },
    { id: 'a-legacy-off', parentId: 'g-warehouse', name: 'Legacy warehouse off', segments: [bar(13, 1, { milestone: true })] },
  ]

  return {
    schemaVersion: 4,
    settings: {
      projectStart: PROJECT_START,
      horizonWeeks: 26,
      hoursPerWeek: 30,
      profiles: ['Analyst', 'Data engineer', 'QA'],
      featureStatuses: [...STATUS_DEFAULTS],
      customers: [FINANCE, OPERATIONS],
      linkCategories: [...LINK_CATEGORY_DEFAULTS],
      optionColors: {
        featureStatuses: { ...COLOR_DEFAULTS.featureStatuses },
        customers: { [FINANCE]: '#15803d', [OPERATIONS]: '#0369a1' },
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
