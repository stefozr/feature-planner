import { useCallback, useEffect, useState } from 'react'

export type View = 'planner' | 'capacity' | 'status' | 'roadmap'

/**
 * Where the app is, as the URL hash says it:
 *   #/planner                      the grid
 *   #/planner?feature=<id>         the grid, landed on that feature's row
 *   #/planner?epic=<id>            the grid, landed on that epic's row
 *   #/capacity                     the capacity dashboard
 *   #/capacity?at=attention        the dashboard, scrolled to "Needs attention"
 *   #/capacity?at=scope            the dashboard, scrolled to "Scope Overview"
 *   #/status                       the per-feature status table
 *   #/roadmap                      the roadmap
 * A query string inside the fragment (not a second `#`) so URLSearchParams parses it and the
 * browser never tries to jump to an anchor of that name.
 */
export type Route =
  | { view: 'planner'; feature?: string; epic?: string }
  | { view: 'capacity'; at?: CapacityCard }
  | { view: 'status' }
  | { view: 'roadmap' }

/** the dashboard cards a link can return to */
export type CapacityCard = 'attention' | 'scope'
const CARDS: CapacityCard[] = ['attention', 'scope']

/** what a link into the planner lands on */
export type JumpTarget = { feature: string } | { epic: string }

export function parseHash(h: string = location.hash): Route | null {
  const m = /^#\/(planner|capacity|status|roadmap)(\?(.*))?$/.exec(h)
  if (!m) return null
  const q = new URLSearchParams(m[3] ?? '')
  if (m[1] === 'planner') {
    const feature = q.get('feature')
    const epic = q.get('epic')
    return feature ? { view: 'planner', feature } : epic ? { view: 'planner', epic } : { view: 'planner' }
  }
  if (m[1] === 'capacity') {
    const at = CARDS.find((c) => c === q.get('at'))
    return at ? { view: 'capacity', at } : { view: 'capacity' }
  }
  if (m[1] === 'status') return { view: 'status' }
  return { view: 'roadmap' }
}

export function toHash(r: Route): string {
  if (r.view === 'planner' && r.feature) return `#/planner?feature=${encodeURIComponent(r.feature)}`
  if (r.view === 'planner' && r.epic) return `#/planner?epic=${encodeURIComponent(r.epic)}`
  if (r.view === 'capacity' && r.at) return `#/capacity?at=${r.at}`
  return `#/${r.view}`
}

/**
 * The hash as React state. `navigate` pushes a history entry (or replaces the current one) and
 * always stores a fresh route object, so re-navigating to the same place still re-runs whatever
 * effects hang off the route — clicking the same Needs-attention item twice lands twice.
 * Back/Forward arrive through `popstate`.
 */
export function useHashRoute() {
  const [route, setRoute] = useState<Route | null>(() => parseHash())
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
