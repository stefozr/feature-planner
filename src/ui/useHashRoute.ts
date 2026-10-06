import { useCallback, useEffect, useState } from 'react'

export type View = 'planner' | 'capacity' | 'status' | 'roadmap'

/**
 * Where the app is inside a team, as the URL hash says it:
 *   #/<team>/planner                      the grid
 *   #/<team>/planner?feature=<id>         the grid, landed on that feature's row
 *   #/<team>/planner?epic=<id>            the grid, landed on that epic's row
 *   #/<team>/capacity                     the capacity dashboard
 *   #/<team>/capacity?at=attention        the dashboard, scrolled to "Needs attention"
 *   #/<team>/capacity?at=scope            the dashboard, scrolled to "Scope Overview"
 *   #/<team>/status                       the per-feature status table
 *   #/<team>/roadmap                      the roadmap
 * A query string inside the fragment (not a second `#`) so URLSearchParams parses it and the
 * browser never tries to jump to an anchor of that name.
 */
export type ViewRoute =
  | { view: 'planner'; feature?: string; epic?: string }
  | { view: 'capacity'; at?: CapacityCard }
  | { view: 'status' }
  | { view: 'roadmap' }

/** a full route: the team's id (its URL slug) and the view inside it */
export type Route = ViewRoute & { team: string }

/**
 * What a hash parses to. `team` is missing for a link from before teams existed (`#/planner…`);
 * the shell then fills in the team the browser used last and rewrites the hash.
 */
export type ParsedHash = ViewRoute & { team?: string }

/** the dashboard cards a link can return to */
export type CapacityCard = 'attention' | 'scope'
const CARDS: CapacityCard[] = ['attention', 'scope']

/** what a link into the planner lands on */
export type JumpTarget = { feature: string } | { epic: string }

/** the view names cannot be team ids (server/store.mjs refuses them), so `#/planner` is never a team */
const VIEWS = new Set<string>(['planner', 'capacity', 'status', 'roadmap'])
const HASH = /^#\/(?:([a-z0-9][a-z0-9-]{0,39})\/)?(planner|capacity|status|roadmap)(\?(.*))?$/

export function parseHash(h: string = location.hash): ParsedHash | null {
  const m = HASH.exec(h)
  if (!m) return null
  const team = m[1]
  if (team && (VIEWS.has(team) || team === 'api')) return null
  const q = new URLSearchParams(m[4] ?? '')
  const withTeam = <R extends ViewRoute>(r: R): ParsedHash => (team ? { ...r, team } : r)
  if (m[2] === 'planner') {
    const feature = q.get('feature')
    const epic = q.get('epic')
    return withTeam(feature ? { view: 'planner', feature } : epic ? { view: 'planner', epic } : { view: 'planner' })
  }
  if (m[2] === 'capacity') {
    const at = CARDS.find((c) => c === q.get('at'))
    return withTeam(at ? { view: 'capacity', at } : { view: 'capacity' })
  }
  if (m[2] === 'status') return withTeam({ view: 'status' })
  return withTeam({ view: 'roadmap' })
}

export function toHash(r: Route): string {
  const base = `#/${r.team}/${r.view}`
  if (r.view === 'planner' && r.feature) return `${base}?feature=${encodeURIComponent(r.feature)}`
  if (r.view === 'planner' && r.epic) return `${base}?epic=${encodeURIComponent(r.epic)}`
  if (r.view === 'capacity' && r.at) return `${base}?at=${r.at}`
  return base
}

/**
 * The hash as React state. `navigate` pushes a history entry (or replaces the current one) and
 * always stores a fresh route object, so re-navigating to the same place still re-runs whatever
 * effects hang off the route — clicking the same Needs-attention item twice lands twice.
 * Back/Forward arrive through `popstate`.
 */
export function useHashRoute() {
  const [route, setRoute] = useState<ParsedHash | null>(() => parseHash())
  useEffect(() => {
    const on = () => setRoute(parseHash())
    window.addEventListener('popstate', on)
    return () => window.removeEventListener('popstate', on)
  }, [])
  const navigate = useCallback((r: Route, opts?: { replace?: boolean }) => {
    const h = toHash(r)
    if (opts?.replace) history.replaceState(null, '', h)
    else if (h !== location.hash) history.pushState(null, '', h)
    setRoute({ ...r })
  }, [])
  return { route, navigate }
}
