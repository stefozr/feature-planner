import { useDropdown } from './useDropdown'

export interface FacetOption {
  value: string
  /** shown instead of the value (e.g. a person's name for their id) */
  label?: string
  count: number
}

export interface Facet {
  key: string
  label: string
  options: FacetOption[]
  selected: string[]
  onToggle: (value: string) => void
}

/** A standalone on/off filter rendered above the facet groups. */
export interface FilterToggle {
  key: string
  label: string
  on: boolean
  count: number
  onChange: () => void
}

/** A one-line footnote under the result summary, with a button that acts on it. */
export interface FilterNotice {
  text: string
  actionLabel: string
  onAction: () => void
}

interface Props {
  facets: Facet[]
  toggles?: FilterToggle[]
  onClearAll: () => void
  resultCount: number
  totalCount: number
  /** the active query: counted as an active filter even when it's edited elsewhere */
  search?: string
  /** pass to also edit the query from inside the panel; omit when the search box lives outside it */
  onSearch?: (v: string) => void
  notice?: FilterNotice
  /** noun for the result summary, e.g. "projects" (default) or "links" */
  noun?: string
  searchPlaceholder?: string
  filterTitle?: string
}

/** All filters behind one button: opens a panel with every facet group (+ optional search); chips stay outside. */
export default function FilterBar({
  facets,
  toggles = [],
  onClearAll,
  resultCount,
  totalCount,
  search = '',
  onSearch,
  notice,
  noun = 'projects',
  searchPlaceholder = 'Filter…',
  filterTitle = 'Filter features',
}: Props) {
  const { open, setOpen, ref } = useDropdown()

  const activeCount = facets.reduce((n, f) => n + f.selected.length, 0) + toggles.filter((t) => t.on).length
  const anyActive = activeCount > 0 || search.length > 0

  return (
    <div className="filterbar">
      <div className="filterbar-row">
        <div className="filter-dd-wrap" ref={ref}>
          <button
            className={`filter-dd ${anyActive ? 'active' : ''}`}
            title={filterTitle}
            onClick={() => setOpen((o) => !o)}
          >
            Filters
            {activeCount > 0 && <span className="filter-badge">{activeCount}</span>}
            <span className="filter-caret">▾</span>
          </button>
          {open && (
            <div className="filter-panel">
              {onSearch && (
                <input
                  className="search-input filter-panel-search"
                  type="search"
                  placeholder={searchPlaceholder}
                  value={search}
                  autoFocus
                  onChange={(e) => onSearch(e.target.value)}
                />
              )}
              {toggles.length > 0 && (
                <div className="filter-group">
                  {toggles.map((t) => (
                    <label key={t.key} className="filter-opt">
                      <input type="checkbox" checked={t.on} onChange={t.onChange} />
                      <span className="filter-opt-label">{t.label}</span>
                      <span className="filter-opt-count">{t.count}</span>
                    </label>
                  ))}
                </div>
              )}
              {facets.map((f) => (
                <div key={f.key} className="filter-group">
                  <div className="filter-group-title">{f.label}</div>
                  {f.options.map((o) => {
                    const on = f.selected.includes(o.value)
                    return (
                      <label key={o.value} className={`filter-opt ${o.count === 0 && !on ? 'empty' : ''}`}>
                        <input type="checkbox" checked={on} onChange={() => f.onToggle(o.value)} />
                        <span className="filter-opt-label">{o.label ?? o.value}</span>
                        <span className="filter-opt-count">{o.count}</span>
                      </label>
                    )
                  })}
                </div>
              ))}
              <div className="filter-panel-foot">
                <span className={`filter-count ${resultCount === 0 ? 'none' : ''}`}>
                  {resultCount === 0 ? `No ${noun} match` : `${resultCount} of ${totalCount} ${noun}`}
                </span>
                {anyActive && (
                  <button className="btn small" onClick={onClearAll}>
                    Clear all
                  </button>
                )}
              </div>
              {notice && (
                <div className="filter-panel-notice">
                  <span>{notice.text}</span>
                  <button className="btn small" onClick={notice.onAction}>
                    {notice.actionLabel}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
