// The built-in "Program" team's own document: no people or features (it reads every other team's),
// but its own cross-team roadmap, a programme release and milestone, and a few notes on other teams'
// features. Week numbers are relative to PROJECT_START, like the team seeds.
import { COLOR_DEFAULTS, CUSTOMER_DEFAULTS, LINK_CATEGORY_DEFAULTS, STATUS_DEFAULTS } from '../../shared/db.mjs'
import { D, PROJECT_START, W, bar } from './helpers.mjs'

export default function programTeam() {
  const workstreams = [
    { id: 'ws-launch', parentId: null, name: 'Go-live readiness', color: '#006bd8', segments: [] },
    { id: 'a-security', parentId: 'ws-launch', name: 'Security review (all teams)', segments: [bar(3, 4, { actualStart: W(3), status: 'In progress', progress: 40 })] },
    { id: 'a-integration', parentId: 'ws-launch', name: 'Cross-team integration test', segments: [bar(9, 2)] },
    { id: 'a-golive', parentId: 'ws-launch', name: 'Programme go-live', segments: [bar(12, 1, { milestone: true })] },
    { id: 'ws-comms', parentId: null, name: 'Launch communications', color: '#008060', segments: [bar(8, 5)] },
  ]
  const releases = [{ id: 'r-launch', name: 'Programme launch', label: 'Launch', date: D(12, 4), color: '#006bd8' }]
  const milestones = [{ id: 'm-integration', name: 'Integration test window', date: W(9), end: W(10), releaseId: 'r-launch', color: '#b45309' }]
  // the Program's own notes on other teams' features, keyed <team>:<feature id>
  const tracking = {
    'demo:f-201': { blockers: 'PSP contract — legal review since W3; Mobile apps 3.5 waits on it', comment: 'Escalated to the vendor steering call' },
    'mobile-apps:f-m302': { risks: 'Store review may slip the 3.5 date by a week', comment: 'Keep the review window in the 3.5 plan' },
    'data-platform:f-d201': { blockers: 'Needs the CRM change-data capture from Ingestion', comment: 'Cutover date confirmed with Finance' },
  }
  return {
    schemaVersion: 4,
    settings: {
      projectStart: PROJECT_START,
      horizonWeeks: 20,
      hoursPerWeek: 30,
      profiles: ['Engineer'],
      featureStatuses: [...STATUS_DEFAULTS],
      customers: [...CUSTOMER_DEFAULTS],
      linkCategories: [...LINK_CATEGORY_DEFAULTS],
      optionColors: structuredClone(COLOR_DEFAULTS),
    },
    people: [],
    epics: [],
    features: [],
    stories: [],
    releases,
    milestones,
    workstreams,
    program: { tracking },
  }
}
