import type { ExpandedState } from '@tanstack/react-table'
import { DB, Epic, Feature, GroupBy } from './types'
import { peopleById } from './logic'

/** A row of the planner tree: an optional group, an epic, a feature. */
export type FRow =
  | { id: string; kind: 'group'; label: string; color?: string; features: Feature[]; subRows: FRow[] }
  | { id: string; kind: 'epic'; epic: Epic; features: Feature[]; subRows: FRow[] }
  | { id: string; kind: 'feature'; feature: Feature; epic: Epic }

/** Expanded state that reveals rows down to `target` levels (0 = collapse all). */
export function expandToDepth<T extends { id: string; subRows?: T[] }>(rows: T[], target: number): Record<string, boolean> {
  if (target <= 0) return {}
  const out: Record<string, boolean> = {}
  const walk = (nodes: T[], level: number) => {
    if (level >= target) return
    for (const n of nodes) {
      if (n.subRows && n.subRows.length) {
        out[n.id] = true
        walk(n.subRows, level + 1)
      }
    }
  }
  walk(rows, 0)
  return out
}

/** Expansion state that reveals every level of `rows`. */
export function expandAll<T extends { id: string; subRows?: T[] }>(rows: T[]): Record<string, boolean> {
  return expandToDepth(rows, Number.POSITIVE_INFINITY)
}

/**
 * Order-insensitive equality for expansion maps: TanStack rebuilds the object on every toggle
 * (expand spreads, collapse rest-destructures), so key order carries no meaning and comparing
 * serialized maps reports a difference where there is none.
 */
export function sameExpansion(a: ExpandedState, b: ExpandedState): boolean {
  if (a === true || b === true) return a === b
  const on = (m: Record<string, boolean>) => Object.keys(m).filter((k) => m[k])
  const ka = on(a)
  return ka.length === on(b).length && ka.every((k) => b[k])
}

/** Stepper labels: "Collapse All" then one per level — label i names the deepest level it reveals. */
export function treeLevels(groupBy: GroupBy): string[] {
  const groupLabel: Record<GroupBy, string> = { none: '', release: 'Releases', status: 'Statuses', lead: 'Leads', customer: 'Customers' }
  return groupBy === 'none' ? ['Collapse All', 'Packages', 'Features'] : ['Collapse All', groupLabel[groupBy], 'Packages', 'Features']
}

/** What the tree is being narrowed by — decides whether epics with no matching feature still show. */
export interface TreeFilter {
  /** any search text, facet or "hide done" is active */
  filtering: boolean
  /** the lower-cased search text */
  query: string
}

function epicRows(db: DB, features: Feature[], prefix: string, filter?: TreeFilter): FRow[] {
  const byEpic = new Map<string, Feature[]>()
  for (const f of features) {
    let list = byEpic.get(f.epicId)
    if (!list) byEpic.set(f.epicId, (list = []))
    list.push(f)
  }
  const out: FRow[] = []
  for (const epic of db.epics) {
    const fs = byEpic.get(epic.id)
    // An epic with no (matching) features still shows when nothing is filtering and the tree isn't
    // grouped, so it can be given its first one — or when the search names the epic itself.
    if (!fs) {
      const q = filter?.query
      const named = !!q && `${epic.key ?? ''} ${epic.name}`.toLowerCase().includes(q)
      if (prefix || (filter?.filtering && !named)) continue
    }
    out.push({
      id: `${prefix}e:${epic.id}`,
      kind: 'epic',
      epic,
      features: fs ?? [],
      subRows: (fs ?? []).map((feature) => ({ id: `${prefix}f:${feature.id}`, kind: 'feature' as const, feature, epic })),
    })
  }
  return out
}

/** The value a feature is grouped under (the `g:<key>` of its group row); null when not grouped. */
export function groupKey(f: Feature, groupBy: GroupBy): string | null {
  switch (groupBy) {
    case 'release':
      return f.releaseId ?? ''
    case 'status':
      return f.status ?? ''
    case 'lead':
      return f.leadId ?? ''
    case 'customer':
      return f.customer ?? ''
    default:
      return null
  }
}

/**
 * The planner tree. `features` is the filtered list to show; epics and array order come from the
 * db so display order is always the stored order.
 */
export function buildFeatureTree(db: DB, features: Feature[], groupBy: GroupBy, filter?: TreeFilter): FRow[] {
  if (groupBy === 'none') return epicRows(db, features, '', filter)
  const people = peopleById(db)
  const groups: { key: string; label: string; color?: string }[] = []
  const keyOf = (f: Feature): string => groupKey(f, groupBy) ?? ''
  if (groupBy === 'release') for (const r of db.releases) groups.push({ key: r.id, label: r.name, color: r.color })
  if (groupBy === 'status') for (const st of db.settings.featureStatuses) groups.push({ key: st, label: st })
  if (groupBy === 'customer') for (const c of db.settings.customers) groups.push({ key: c, label: c })
  if (groupBy === 'lead') {
    const leads = [...new Set(db.features.map((f) => f.leadId).filter(Boolean) as string[])]
    leads.sort((a, b) => (people.get(a)?.name ?? a).localeCompare(people.get(b)?.name ?? b))
    for (const id of leads) groups.push({ key: id, label: people.get(id)?.name ?? id })
  }
  // values in use that the list doesn't name (a removed status, a deleted person) still get a group
  for (const f of features) {
    const k = keyOf(f)
    if (!groups.some((g) => g.key === k)) groups.push({ key: k, label: k ? k : 'Not set' })
  }
  const unset = groups.findIndex((g) => g.key === '')
  if (unset >= 0) groups.push(...groups.splice(unset, 1))
  return groups
    .map((g) => {
      const fs = features.filter((f) => keyOf(f) === g.key)
      return {
        id: `g:${g.key}`,
        kind: 'group' as const,
        label: g.label,
        color: g.color,
        features: fs,
        subRows: epicRows(db, fs, `g:${g.key}|`),
      }
    })
    .filter((g) => g.features.length > 0)
}

/** Text a feature is searched by: key, name, epic, customer, the people on it and its Status-tab notes. */
export function featureSearchText(db: DB, f: Feature): string {
  const people = peopleById(db)
  const epic = db.epics.find((e) => e.id === f.epicId)
  const names = new Set<string>()
  for (const id of [f.leadId, f.buddyId, f.testLeadId]) if (id) names.add(id)
  for (const c of Object.values(f.cells)) for (const e of c.entries) if (e.personId) names.add(e.personId)
  const who = [...names].map((id) => `${people.get(id)?.name ?? ''} ${people.get(id)?.short ?? ''}`).join(' ')
  const noteText = (t: Feature['tracking']) => (t ? [t.risks, t.blockers, t.comment].filter(Boolean).join(' ') : '')
  // a hit inside a story lists its feature
  const stories = db.stories
    .filter((s) => s.featureId === f.id)
    .map((s) => `${s.key ?? ''} ${s.name} ${noteText(s.tracking)}`)
    .join(' ')
  return `${f.key ?? ''} ${f.name} ${epic?.key ?? ''} ${epic?.name ?? ''} ${f.customer ?? ''} ${who} ${noteText(f.tracking)} ${stories}`.toLowerCase()
}
