import { COLOR_DEFAULTS } from '../shared/db.mjs'

export type Profile = string

/** Preset reasons a person is away; picked from a dropdown, not free text. */
export const AWAY_TYPES = ['Vacation', 'Sick', 'Public holiday', 'Parental', 'Training', 'Borrowed out', 'Other'] as const
export type AwayType = (typeof AWAY_TYPES)[number]

/** An away interval (vacation, leave, borrowed out, …), ISO dates, inclusive. */
export interface AwayEntry {
  start: string
  end: string
  type?: AwayType
  /** free-form qualifier next to the type, e.g. "requested, not approved" */
  note?: string
  /**
   * Set when the entry came from the shared vacation calendar (server/vacations.mjs). The sync
   * owns such rows — it replaces them wholesale on every pull — so the UI shows them read-only.
   */
  source?: 'calendar'
  /** the calendar event's UID, the entry's identity across syncs */
  uid?: string
}

/**
 * Capacity committed outside this project — another engagement, not yet on the team, or gone
 * for good. Deducted from the person's weekly ceiling. `pct` is a share of a full working week.
 * Omitting `end` means open-ended.
 */
export interface ExternalEntry {
  start: string
  end?: string
  pct: number
  note?: string
}

/** What a person's week on a feature is spent on. Drives the cell and chip colour. */
export type AllocKind = 'dev' | 'test' | 'buffer'
export const ALLOC_KINDS: AllocKind[] = ['dev', 'test', 'buffer']
export const KIND_LABEL: Record<AllocKind, string> = { dev: 'Dev', test: 'Test', buffer: 'Buffer' }

export interface Person {
  id: string
  name: string
  profile: Profile
  /** chip label in the grid ("Alice", "BenC"); falls back to the first name */
  short?: string
  /** kind a new allocation gets by default — testers start as 'test' */
  defaultKind?: 'dev' | 'test'
  away?: AwayEntry[]
  /** weekly capacity ceiling %, default 100 */
  capacity?: number
  external?: ExternalEntry[]
  /** name as the shared vacation calendar spells it, when that differs from `name` */
  calendarName?: string
  /**
   * ISO date of the first day this person is no longer available. Capacity reads 0 from here on
   * (logic.ts treats it as an open-ended 100% external commitment), lists strike the name through
   * as soon as it is set, and "Hide resigned" hides the person once the date has passed.
   */
  resignedFrom?: string
}

/** Flagged as leaving, whether or not the date has passed — what the strikethrough marks. */
export const isResigned = (p: Person): boolean => !!p.resignedFrom
/** Already gone as of `today` (ISO date) — what "Hide resigned" hides. */
export const hasLeft = (p: Person, today: string): boolean => !!p.resignedFrom && p.resignedFrom <= today

/** GET /api/vacations/status — what the server's last pull of the shared vacation calendar did */
export interface VacationSyncStatus {
  enabled: boolean
  intervalHours: number
  lastSync: {
    at: string
    reason: string
    ok: boolean
    error?: string
    changed?: boolean
    matched?: number
    imported?: number
    replacedManual?: number
    /** people the calendar has no events for, under their name or Calendar name */
    unmatchedPeople?: { id: string; name: string }[]
    /** people matched by the one-candidate near-miss rule, and the calendar's spelling that took them */
    approxPeople?: { id: string; name: string; calendarName: string }[]
    /** how many unmatched people received only the company-wide holidays */
    holidayOnly?: number
    unmatchedCalendarNames?: string[]
  } | null
}

/** A useful link attached to a feature (Jira, spec, …). */
export interface ProjectLink {
  label: string
  url: string
  category: string
}

/**
 * One person (or an unnamed slot like "Test") working on a feature in one week.
 * `pct` 100 = a full week = settings.hoursPerWeek hours.
 */
export interface AllocEntry {
  /** identity inside the cell, so concurrent edits replay onto the right entry */
  id: string
  /** null = an unnamed slot ("Test", "Dev") — counts toward the feature, not toward a person */
  personId: string | null
  /** slot text when personId is null */
  label?: string
  pct: number
  kind: AllocKind
  /** "in code review", "TBD", "no test data" … */
  note?: string
}

export interface WeekCell {
  entries: AllocEntry[]
  /** text in the cell not attached to anyone ("waiting for clarifications") */
  note?: string
}

export interface Epic {
  id: string
  /** Jira key, e.g. PKG-100 */
  key?: string
  name: string
  description?: string
}

export interface Feature {
  id: string
  epicId: string
  /** Jira key — not necessarily unique (a story can be split over several rows), so never an identity */
  key?: string
  name: string
  status?: string
  releaseId?: string
  /** a name from settings.customers */
  customer?: string
  leadId?: string
  buddyId?: string
  testLeadId?: string
  /** Monday week keys. The original plan — what the feature was committed to. */
  planStart?: string
  planEnd?: string
  /** Actual start / end (empty = the first / last week with booked work). A finished feature's end week is its finish. */
  startWeek?: string
  endWeek?: string
  /** Monday week key the feature is due by — the Status tab's Deadline; display only, the schedule maths use the plan */
  deadline?: string
  /**
   * hours — the original estimate. Once the feature has stories, the three hour figures are the
   * sum of its stories' (shared/stories.mjs keeps them in step) and the UI shows them read-only.
   */
  estimate?: number
  /** hours logged so far (hand-entered, e.g. from Jira worklogs) */
  logged?: number
  /** hours of work left */
  remaining?: number
  /** weekKey (ISO Monday) -> who works on it that week */
  cells: Record<string, WeekCell>
  description?: string
  links?: ProjectLink[]
  /** the Status tab's free-text columns; absent until something is filled in */
  tracking?: FeatureTracking
}

/**
 * The Status tab's text columns. Every field is optional, and an empty object is never stored —
 * see `patchTracking` in App.tsx.
 */
export interface FeatureTracking {
  risks?: string
  /** Dependencies/Blockers — Jira keys or free text */
  blockers?: string
  comment?: string
}

/** The fields a Status-tab row edits: a Feature has them all, a Story has only these. */
export type Trackable = Pick<Feature, 'id' | 'key' | 'name' | 'status' | 'leadId' | 'deadline' | 'estimate' | 'logged' | 'remaining' | 'tracking'>

/**
 * A story under a feature — the Status tab's third level. It lives only there: no cells, no
 * planner row. Its hours add up into the feature's (shared/stories.mjs).
 */
export interface Story extends Trackable {
  featureId: string
}

export interface Release {
  id: string
  name: string
  /** short human label, e.g. "June" */
  label?: string
  /** ISO date the release ships */
  date?: string
  color?: string
}

/** A dated marker on the timeline; with `end` it is a band (e.g. a system test window). */
export interface Milestone {
  id: string
  name: string
  date: string
  end?: string
  releaseId?: string
  /** header tint / edge lines / label colour; unset = red */
  color?: string
}

/** The states a roadmap bar can be in; fixed, coloured once in Settings (optionColors.roadmapStatuses). */
export const ROADMAP_STATUSES = ['Planned', 'In progress', 'Blocked', 'On hold', 'Complete'] as const
export type RoadmapStatus = (typeof ROADMAP_STATUSES)[number]

/**
 * One bar of a roadmap row. `start` + `weeks` are the plan (drawn as a dotted line); the rest is
 * the actual side, drawn as the solid bar — see src/gantt/bars.ts for how the end is worked out.
 */
export interface RoadmapBar {
  /** planned start, a Monday week key */
  start: string
  /** planned length */
  weeks: number
  /** Monday week keys; no actualStart = not started yet */
  actualStart?: string
  actualEnd?: string
  /** absent = Planned */
  status?: RoadmapStatus
  /** 0–100 */
  progress?: number
  /** override; absent = the status colour */
  color?: string
  /** why it is Blocked / On hold, or the Jira ticket */
  reason?: string
  /** ◆: a one-week bar drawn as a diamond */
  milestone?: boolean
}

/** A row of the high-level roadmap: workstream → group → activity, linked by parentId. */
export interface GanttItem {
  id: string
  parentId: string | null
  name: string
  /** top-level rows carry the workstream colour; children inherit it */
  color?: string
  segments: RoadmapBar[]
}

export type OptionListKey = 'featureStatuses' | 'roadmapStatuses' | 'customers'
/** value -> hex accent color; tags render it as text color over a ~12% alpha background */
export type OptionColors = Partial<Record<OptionListKey, Record<string, string>>>

/** what a database with no `settings.optionColors` gets — the server seeds the same table (shared/db.mjs) */
export const DEFAULT_OPTION_COLORS: OptionColors = COLOR_DEFAULTS

export function optionColor(colors: OptionColors | undefined, list: OptionListKey, value: string): string | undefined {
  return colors?.[list]?.[value] ?? DEFAULT_OPTION_COLORS[list]?.[value]
}

/** Inline style for a value tag/chip: accent text over a translucent tint of the same color. */
export function tagStyle(color: string | undefined): { background: string; color: string } | undefined {
  return color ? { background: `${color}1f`, color } : undefined
}

/** The Status-tab fields a spreadsheet column can feed, plus the parent columns that place a new story. */
export type ImportField = 'key' | 'name' | 'parentKey' | 'parentName' | 'status' | 'leadId' | 'estimate' | 'logged' | 'remaining' | 'deadline' | 'risks' | 'blockers' | 'comment'
/** how an hours column is written: plain hours, minutes, Jira's seconds, Jira's "2d 4h" days, or an Excel [h]:mm time (a fraction of a day) */
export type ImportUnit = 'hours' | 'minutes' | 'seconds' | 'days' | 'excelTime'
/**
 * The saved column mapping of the Status tab's sheet import (settings.importMapping): which header
 * feeds which field, how hours are written, and what the sheet's status and assignee values mean.
 */
export interface ImportMapping {
  /** target field → the source column's header text, as it appears in the file */
  columns: Partial<Record<ImportField, string>>
  units?: Partial<Record<'estimate' | 'logged' | 'remaining', ImportUnit>>
  /** hours in one Jira working day, for the "2d 4h" notation (Jira's default is 8) */
  hoursPerDay?: number
  /** folded sheet value → app status; '' = leave the record's status alone */
  statusMap?: Record<string, string>
  /** folded sheet value → person id; '' = leave the assignee alone */
  personMap?: Record<string, string>
  sheet?: string
}

export interface Settings {
  /** Monday the plan starts on; the grid's first week */
  projectStart: string
  /** weeks the plan runs for (the grid may extend past it when work is scheduled later) */
  horizonWeeks: number
  /** hours one person-week (100%) is worth */
  hoursPerWeek: number
  /** roles offered in the People dialog */
  profiles: Profile[]
  featureStatuses: string[]
  /** the customers a feature can be tagged with; a Group-by and a filter in the planner */
  customers: string[]
  optionColors?: OptionColors
  linkCategories: string[]
  /** public .ics link of the team's vacation calendar; the server pulls it (server/vacations.mjs). Empty = sync off. */
  calendarUrl?: string
  /** the Status tab's default sheet-import mapping (src/status/importSheet.ts) */
  importMapping?: ImportMapping
}

export interface DB {
  people: Person[]
  /** array order = display order */
  epics: Epic[]
  features: Feature[]
  /** array order = display order under the feature */
  stories: Story[]
  releases: Release[]
  milestones: Milestone[]
  /** flat, ordered; the tree comes from parentId */
  workstreams: GanttItem[]
  settings: Settings
  schemaVersion?: number
}

export const statusKey = (s: string | undefined): string => (s ?? '').toLowerCase().replace(/[^a-z]/g, '')
/** Nothing left to do on it: Closed or Rejected — and Done, for a database from before the Jira statuses. */
const FINISHED = new Set(['closed', 'rejected', 'done'])
export const isFinishedStatus = (s: string | undefined): boolean => FINISHED.has(statusKey(s))
export const isBlockedStatus = (s: string | undefined): boolean => statusKey(s) === 'blocked'

/** How the planner groups features above the epic level. */
export type GroupBy = 'none' | 'release' | 'status' | 'lead' | 'customer'

export type ClipboardData = { sourceLabel: string; cells: (WeekCell | null)[] }
