import { ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { DB, GanttItem, Milestone, ROADMAP_STATUSES, Release, RoadmapStatus } from '../types'
import { addWeeks, mondayOf, uid, weekLabel, weekRange, weekTag } from '../logic'
import { usePersisted } from '../ui/usePersisted'
import { GanttBarDialog, GanttItemDialog } from '../ui/FeatureDialogs'
import { BarCounts, BarShape, adjacentBars, barColor, barShape, isLateOrStuck, lateTag, mergeBars, rollup, solidSpan, statusColor } from './bars'
import { useConfirm } from '../ui/ConfirmDialog'
import { useTip } from '../ui/useTip'
import { TimelineHead } from '../ui/TimelineHead'
import { useTimelineBands } from '../ui/useTimelineBands'
import '../capacity/capacity.css'

interface Props {
  db: DB
  todayISO: string
  colorOf: (hex: string | undefined) => string | undefined
  readOnly: boolean
  /** the dotted planned bar above the actual one — shared with the planner's Gantt view */
  showPlanned: boolean
  onShowPlanned: (v: boolean) => void
  update: (fn: (d: DB) => void) => void
  /**
   * Read-only rows drawn above the workstreams (the Program's critical path per team): one summary
   * bar each, with that row's own releases (⚑) and milestones (◆) marked in its lane.
   */
  pinned?: PinnedRow[]
  /** the heading over the pinned rows */
  pinnedLabel?: string
  /** weeks the axis must cover besides this document's own (the Program's union of every team) */
  extraWeeks?: string[]
}

export interface PinnedRow {
  id: string
  name: string
  color?: string
  /** null: nothing to draw — the row says so */
  shape: BarShape | null
  releases: Release[]
  milestones: Milestone[]
  title?: string
  onClick?: () => void
}

/** Week column width; the rows and type in capacity.css are sized to match, and the planner's Gantt view uses it too. */
export const ROADMAP_COL = 51
const LABEL = 380
/** about what one character of the bar label takes, for deciding whether the text fits inside */
const CHAR_W = 6.8

/** the states a roll-up counts its bars in, in the order the tooltip lists them */
const COUNT_ROWS: { key: keyof BarCounts; status: RoadmapStatus; label: string }[] = [
  { key: 'complete', status: 'Complete', label: 'Complete' },
  { key: 'inProgress', status: 'In progress', label: 'In progress' },
  { key: 'blocked', status: 'Blocked', label: 'Blocked' },
  { key: 'onHold', status: 'On hold', label: 'On hold' },
  { key: 'planned', status: 'Planned', label: 'Not started' },
]

interface Node {
  item: GanttItem
  depth: number
  color?: string
  children: Node[]
}

/** Parent/child tree from the flat list, keeping array order among siblings. */
function buildTree(items: GanttItem[]): Node[] {
  const byParent = new Map<string | null, GanttItem[]>()
  const ids = new Set(items.map((i) => i.id))
  for (const it of items) {
    const p = it.parentId && ids.has(it.parentId) ? it.parentId : null
    byParent.set(p, [...(byParent.get(p) ?? []), it])
  }
  const walk = (parent: string | null, depth: number, color?: string): Node[] =>
    (byParent.get(parent) ?? []).map((item) => {
      const c = item.color ?? color
      return { item, depth, color: c, children: walk(item.id, depth + 1, c) }
    })
  return walk(null, 0)
}

/** the row dialog (from a name, or + Workstream / ＋), or the dialog for one bar clicked in the grid */
type Dialog = { kind: 'row'; item: GanttItem; create: boolean } | { kind: 'bar'; id: string; index: number } | null
type Drag = { id: string; anchor: string; head: string } | null

/** A leaf row's own bars, shaped; a parent row's roll-up of every descendant leaf's bars. */
interface RowBars {
  own: { shape: BarShape; index: number; color: string }[]
  summary: BarShape | null
}

export default function GanttView({ db, todayISO, colorOf, readOnly, showPlanned, onShowPlanned, update, pinned = [], pinnedLabel, extraWeeks }: Props) {
  const [collapsed, setCollapsed] = usePersisted<Record<string, boolean>>('feature-planner:ganttCollapsed', {})
  const [lateOnly, setLateOnly] = usePersisted<boolean>('feature-planner:roadmapLateOnly', false)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [drag, setDrag] = useState<Drag>(null)
  const dragRef = useRef<Drag>(null)
  dragRef.current = drag
  // the mouseup handler reads the row it is adding to from here, so it need not re-register on every change
  const dbRef = useRef(db)
  dbRef.current = db
  const { ask: confirm, ui: confirmUI } = useConfirm()
  const { attach, hide: hideTip, element: tipEl } = useTip()
  const wrapRef = useRef<HTMLDivElement>(null)
  const today = mondayOf(todayISO)
  const tree = useMemo(() => buildTree(db.workstreams), [db.workstreams])
  const colors = db.settings.optionColors

  // every row's bars, shaped once per document: leaves from their own segments, parents from their leaves
  const rowBars = useMemo(() => {
    const out = new Map<string, RowBars>()
    const walk = (n: Node): BarShape[] => {
      if (n.children.length) {
        const leaves = n.children.flatMap(walk)
        out.set(n.item.id, { own: [], summary: rollup(leaves) })
        return leaves
      }
      const own = n.item.segments.map((seg, index) => {
        const shape = barShape(seg, todayISO)
        return { shape, index, color: colorOf(barColor(colors, shape, seg.color)) ?? 'var(--accent)' }
      })
      out.set(n.item.id, { own, summary: null })
      return own.map((o) => o.shape)
    }
    for (const n of tree) walk(n)
    return out
  }, [tree, todayISO, colors, colorOf])

  const weeks = useMemo(() => {
    let start = mondayOf(db.settings.projectStart)
    let end = addWeeks(start, db.settings.horizonWeeks)
    const stretch = (s: BarShape) => {
      if (s.plannedStart < start) start = s.plannedStart
      if (s.actualStart && s.actualStart < start) start = s.actualStart
      for (const e of [s.plannedEnd, s.end]) if (e && addWeeks(e, 1) > end) end = addWeeks(e, 1)
    }
    for (const rb of rowBars.values()) for (const o of rb.own) stretch(o.shape)
    for (const r of db.releases) if (r.date && addWeeks(mondayOf(r.date), 2) > end) end = addWeeks(mondayOf(r.date), 2)
    for (const p of pinned) {
      if (p.shape) stretch(p.shape)
      for (const r of p.releases) if (r.date && addWeeks(mondayOf(r.date), 2) > end) end = addWeeks(mondayOf(r.date), 2)
      for (const m of p.milestones) if (addWeeks(mondayOf(m.end ?? m.date), 2) > end) end = addWeeks(mondayOf(m.end ?? m.date), 2)
    }
    if (extraWeeks?.length) {
      if (extraWeeks[0] < start) start = extraWeeks[0]
      const last = addWeeks(extraWeeks[extraWeeks.length - 1], 1)
      if (last > end) end = last
    }
    const out: string[] = []
    for (let w = start; w < end; w = addWeeks(w, 1)) out.push(w)
    return out
  }, [db, rowBars, pinned, extraWeeks])
  const weekIndex = useMemo(() => new Map(weeks.map((w, i) => [w, i])), [weeks])
  // the months, phases and one-day events of the header, and the same tints for the body cells
  const bands = useTimelineBands(weeks, today, db.milestones, db.releases, colorOf)

  // initial horizontal position: today with a month of lead-in, like the planner
  useEffect(() => {
    const el = wrapRef.current
    const idx = weeks.indexOf(today)
    if (el && idx >= 0) el.scrollLeft = Math.max(0, (idx - 4) * ROADMAP_COL)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weeks[0]])

  // "Late / blocked only": a leaf stays when one of its bars is late, Blocked or On hold; a parent when a descendant stays
  const keep = (n: Node): boolean => {
    if (!lateOnly) return true
    const rb = rowBars.get(n.item.id)
    if (n.children.length) return n.children.some(keep)
    return !!rb?.own.some((o) => isLateOrStuck(o.shape))
  }
  const visible: Node[] = []
  const shownPinned = lateOnly ? pinned.filter((p) => p.shape && isLateOrStuck(p.shape)) : pinned
  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      if (!keep(n)) continue
      visible.push(n)
      if (!collapsed[n.item.id]) walk(n.children)
    }
  }
  walk(tree)

  useEffect(() => {
    const up = async () => {
      const d = dragRef.current
      if (!d) return
      setDrag(null)
      const [a, b] = d.anchor <= d.head ? [d.anchor, d.head] : [d.head, d.anchor]
      const n = weekRange(a, b).length
      const addSeparately = () =>
        update((db2) => {
          const it = db2.workstreams.find((w) => w.id === d.id)
          if (it) it.segments.push({ start: a, weeks: n })
        })
      // a span touching a bar of the row is usually meant to extend it: offer that before adding a second bar
      const row = dbRef.current.workstreams.find((w) => w.id === d.id)
      const hits = row ? adjacentBars(row.segments, a, n, todayISO) : []
      if (!row || !hits.length) return addSeparately()
      const touched = hits.map((i) => row.segments[i])
      const merged = mergeBars(touched, a, n, todayISO)
      const named = touched.map((seg) => {
        const s = barShape(seg, todayISO)
        return `${s.label} (${weekTag(s.plannedStart)} → ${weekTag(s.plannedEnd)})`
      })
      const ok = await confirm({
        title: 'Merge bars?',
        message: `The new bar ${weekTag(a)} → ${weekTag(b)} touches ${named.join(' and ')}.\nMerge them into one bar from ${weekTag(merged.start)} to ${weekTag(addWeeks(merged.start, merged.weeks - 1))}? The existing bar keeps its status, progress and colour.`,
        confirmLabel: 'Merge',
        cancelLabel: 'Keep separate',
        danger: false,
      })
      if (!ok) return addSeparately()
      update((db2) => {
        const it = db2.workstreams.find((w) => w.id === d.id)
        if (!it) return
        // the bars may have moved under us (another editor's save): then the new bar simply goes in on its own
        const same = hits.every((i, k) => it.segments[i]?.start === touched[k].start && it.segments[i]?.weeks === touched[k].weeks)
        if (!same) {
          it.segments.push({ start: a, weeks: n })
          return
        }
        it.segments[hits[0]] = merged
        for (const i of [...hits.slice(1)].sort((x, y) => y - x)) it.segments.splice(i, 1)
      })
    }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [update, confirm, todayISO])

  const move = (id: string, dir: -1 | 1) =>
    update((d) => {
      const it = d.workstreams.find((w) => w.id === id)
      if (!it) return
      const sibs = d.workstreams.filter((w) => w.parentId === it.parentId)
      const j = sibs.indexOf(it) + dir
      if (j < 0 || j >= sibs.length) return
      const a = d.workstreams.indexOf(it)
      const b = d.workstreams.indexOf(sibs[j])
      ;[d.workstreams[a], d.workstreams[b]] = [d.workstreams[b], d.workstreams[a]]
    })

  const collapseAll = (on: boolean) => setCollapsed(on ? Object.fromEntries(db.workstreams.filter((w) => db.workstreams.some((c) => c.parentId === w.id)).map((w) => [w.id, true])) : {})

  /** left edge and width, in px, of a span of weeks — clipped to the timeline */
  const spanBox = (from: string, to: string): { left: number; width: number } | null => {
    const a = weekIndex.get(from < weeks[0] ? weeks[0] : from)
    const b = weekIndex.get(to > weeks[weeks.length - 1] ? weeks[weeks.length - 1] : to)
    if (a == null || b == null || b < a) return null
    return { left: a * ROADMAP_COL + 2, width: (b - a + 1) * ROADMAP_COL - 4 }
  }

  /**
   * The hover plate of a bar: its dates, its status and progress; for a roll-up the mean progress
   * and how many bars are in each state.
   */
  const tipContent = (name: string, s: BarShape, summary: boolean): ReactNode => {
    const c = s.counts
    const progressLine = summary
      ? `${s.status === 'Complete' ? 'Complete' : `Progress ${s.progress}%`}${c ? ` · mean of ${c.total} ${c.total === 1 ? 'bar' : 'bars'}` : ''}`
      : [s.status === 'Complete' ? 'Complete' : `${s.status} · ${s.progress}%`, s.reason].filter(Boolean).join(' · ')
    return (
      <div className="gv-tip">
        <b>{name}</b>
        <div>
          Planned {weekTag(s.plannedStart)} → {weekTag(s.plannedEnd)} · {weekLabel(s.plannedStart)} → {weekLabel(s.plannedEnd)}
        </div>
        {s.started ? (
          <div>
            Actual {weekTag(s.actualStart)} → {weekTag(s.end)}
            {s.forecast ? ' (forecast from progress)' : s.status === 'Complete' ? '' : ' (expected)'}
          </div>
        ) : (
          <div>Not started</div>
        )}
        {s.started && (
          <div className="gv-tip-progress">
            <span>{progressLine}</span>
            <span className="gv-tip-meter">
              <i style={{ width: `${s.progress}%` }} />
            </span>
          </div>
        )}
        {c && (
          <div className="gv-tip-counts">
            {COUNT_ROWS.filter((r) => c[r.key] > 0).map((r) => (
              <div key={r.key} className="gv-tip-row">
                <span className="gv-key" style={{ '--c': colorOf(statusColor(db, r.status)) } as React.CSSProperties} />
                {r.label}: {c[r.key]}
              </div>
            ))}
          </div>
        )}
        {s.delayWeeks > 0 && <div className="gv-tip-late">{lateTag(s)} past the planned end</div>}
        {!readOnly && !summary && <div className="gv-tip-hint">Click to edit this bar</div>}
      </div>
    )
  }

  /** one bar (or the roll-up) drawn into the row's lane */
  const renderBar = (name: string, s: BarShape, color: string, opts: { summary?: boolean; onClick?: () => void }) => {
    const style = { '--c': color } as React.CSSProperties
    const late = lateTag(s)
    const after: React.ReactNode[] = []
    const cls = (extra: string) => `${extra}${s.started ? '' : ' unstarted'}${opts.summary ? ' summary' : ''}`
    // the dialog (or the team it navigates to) opens over the plate, whose mouseleave then never fires
    const onClick = opts.onClick && (() => {
      hideTip()
      opts.onClick!()
    })
    const tipOf = () => attach(tipContent(name, s, !!opts.summary))
    const common = { style, onClick, ...tipOf() }
    if (s.milestone) {
      // a diamond on the actual week (planned week while not started), the planned week dotted, the text beside it
      const at = s.started ? s.actualStart! : s.plannedStart
      const box = spanBox(at, at)
      const plan = spanBox(s.plannedStart, s.plannedStart)
      after.push(<span key="st" className={s.status === 'Complete' ? 'done' : 'status'}>{s.label}</span>)
      if (late) after.push(<span key="late" className="late"> {late}</span>)
      return (
        <>
          {showPlanned && plan && <div className="gv-plan" style={{ left: plan.left + 10, width: plan.width - 20 }} />}
          {box && (
            <div className={cls('gv-ms')} {...common} style={{ ...style, left: box.left, width: box.width }}>
              ◆
            </div>
          )}
          {box && (
            <div className="gv-after" style={{ left: box.left + box.width }} onClick={onClick} {...tipOf()}>
              {after}
            </div>
          )}
        </>
      )
    }
    const [from, to] = solidSpan(s)
    const box = spanBox(from, to)
    const plan = spanBox(s.plannedStart, s.plannedEnd)
    // an unstarted bar already sits on its planned span, so it needs no plan line of its own
    const planLine = showPlanned && plan && (s.started || opts.summary) ? <div className="gv-plan" style={plan} /> : null
    if (!box) return planLine
    const label = opts.summary ? '' : s.label
    const fits = label.length * CHAR_W + 16 <= box.width
    if (opts.summary) after.push(<span key="pct" className="status">{s.label}</span>)
    else if (!fits) after.push(<span key="lbl" className={s.status === 'Complete' ? 'done' : 'status'}>{label}</span>)
    if (late) after.push(<span key="late" className="late">{after.length ? ' ' : ''}{late}</span>)
    const over = s.overrunFrom && s.end && s.overrunFrom <= s.end ? spanBox(s.overrunFrom, s.end) : null
    const stuck = s.status === 'Blocked' || s.status === 'On hold'
    return (
      <>
        {planLine}
        <div className={cls(`gv-act${stuck ? ' stuck' : ''}`)} {...common} style={{ ...style, left: box.left, width: box.width }}>
          {s.started && <span className="gv-fill" style={{ width: `${s.progress}%` }} />}
          {over && <span className="gv-over" style={{ left: over.left - box.left, width: over.width + 2 }} />}
          {fits && label && <span className="gv-act-lbl">{label}</span>}
        </div>
        {after.length > 0 && (
          <div className="gv-after" style={{ left: box.left + box.width }} onClick={onClick} {...tipOf()}>
            {after}
          </div>
        )}
      </>
    )
  }

  return (
    <div className="gv">
      <div className="gv-bar">
        <button className="btn small" onClick={() => collapseAll(true)}>Collapse all</button>
        <button className="btn small" onClick={() => collapseAll(false)}>Expand all</button>
        {!readOnly && (
          <button className="btn small primary" onClick={() => setDialog({ kind: 'row', item: { id: uid(), parentId: null, name: '', segments: [], color: '#006bd8' }, create: true })}>
            + Workstream
          </button>
        )}
        <label className="cv-check" title="The dotted bar above each actual bar: the planned start and length">
          <input type="checkbox" checked={showPlanned} onChange={(e) => onShowPlanned(e.target.checked)} /> Show planned
        </label>
        <label className="cv-check" title="Only the rows with a bar past its planned end, Blocked or On hold">
          <input type="checkbox" checked={lateOnly} onChange={(e) => setLateOnly(e.target.checked)} /> Late / blocked only
        </label>
        <span className="hint">
          {readOnly ? 'Hover a bar for its dates.' : 'Drag across empty weeks on a row to add a bar · click a bar for its status, actual dates and colour · click a name to edit the row'}
        </span>
        <span className="gv-legend">
          {ROADMAP_STATUSES.map((st: RoadmapStatus) => (
            <span key={st}>
              <span className="gv-key" style={{ '--c': colorOf(statusColor(db, st)) } as React.CSSProperties} /> {st}
            </span>
          ))}
          <span>
            <span className="gv-key plan" /> planned
          </span>
        </span>
      </div>
      <div className="gv-wrap" ref={wrapRef}>
        <table className="gv-table" style={{ width: LABEL + weeks.length * ROADMAP_COL }}>
          <colgroup>
            <col style={{ width: LABEL }} />
            {weeks.map((w) => <col key={w} style={{ width: ROADMAP_COL }} />)}
          </colgroup>
          <TimelineHead weeks={weeks} todayWeek={today} bands={bands} labelClassName="gv-lbl" label="Workstream / activity" />
          <tbody>
            {shownPinned.length > 0 && (
              <tr className="gv-row gv-section">
                <td className="gv-lbl">
                  <div className="gv-name" style={{ paddingLeft: 10 }}>
                    <span className="lbl-name">{pinnedLabel ?? 'Pinned'}</span>
                  </div>
                </td>
                {weeks.map((w) => (
                  <td key={w} className={`gv-cell${w === today ? ' today' : ''}${bands.bandWeeks.has(w) ? ' band' : ''}${bands.monthStarts.has(w) ? ' month-start' : ''}`} style={bands.weekStyle(w)} />
                ))}
              </tr>
            )}
            {shownPinned.map((p) => {
              const color = colorOf(p.color) ?? 'var(--accent)'
              const barColorOf = p.shape ? (colorOf(statusColor(db, p.shape.status)) ?? color) : color
              return (
                <tr key={`pin:${p.id}`} className="gv-row d0 gv-pinned">
                  <td className="gv-lbl">
                    <div className="gv-name" style={{ paddingLeft: 6 }}>
                      <span className="caret-spacer" />
                      <span className="tag-dot" style={{ background: color }} />
                      <span className={`lbl-name${p.onClick ? ' lbl-link' : ''}`} title={p.title ?? p.name} onClick={p.onClick}>
                        {p.name}
                      </span>
                    </div>
                  </td>
                  {weeks.map((w, wi) => (
                    <td key={w} className={`gv-cell${w === today ? ' today' : ''}${bands.bandWeeks.has(w) ? ' band' : ''}${bands.monthStarts.has(w) ? ' month-start' : ''}`} style={bands.weekStyle(w)}>
                      {wi === 0 && (
                        <div className="gv-lane" style={{ width: weeks.length * ROADMAP_COL }}>
                          {p.shape ? renderBar(p.name, p.shape, barColorOf, { summary: true, onClick: p.onClick }) : <span className="gv-none hint">no roadmap bars</span>}
                          {p.milestones
                            .filter((m) => m.end)
                            .map((m) => {
                              const box = spanBox(mondayOf(m.date), mondayOf(m.end!))
                              return box && <div key={m.id} className="gv-band" style={{ left: box.left - 2, width: box.width + 4, '--ph': m.color } as React.CSSProperties} title={`◆ ${m.name} · ${m.date} → ${m.end}`} />
                            })}
                          {p.releases.map((r) => {
                            const box = spanBox(mondayOf(r.date!), mondayOf(r.date!))
                            return box && <span key={r.id} className="gv-mark" style={{ left: box.left, width: box.width, color: colorOf(r.color) }} title={`⚑ ${r.name} release ${r.date}`}>⚑</span>
                          })}
                          {p.milestones
                            .filter((m) => !m.end)
                            .map((m) => {
                              const box = spanBox(mondayOf(m.date), mondayOf(m.date))
                              return box && <span key={m.id} className="gv-mark" style={{ left: box.left, width: box.width, color: m.color ?? 'var(--danger)' }} title={`◆ ${m.name} · ${m.date}`}>◆</span>
                            })}
                        </div>
                      )}
                    </td>
                  ))}
                </tr>
              )
            })}
            {shownPinned.length > 0 && db.workstreams.length > 0 && (
              <tr className="gv-row gv-section">
                <td className="gv-lbl">
                  <div className="gv-name" style={{ paddingLeft: 10 }}>
                    <span className="lbl-name">Workstreams</span>
                  </div>
                </td>
                {weeks.map((w) => (
                  <td key={w} className={`gv-cell${w === today ? ' today' : ''}${bands.bandWeeks.has(w) ? ' band' : ''}${bands.monthStarts.has(w) ? ' month-start' : ''}`} style={bands.weekStyle(w)} />
                ))}
              </tr>
            )}
            {visible.map((n) => {
              const it = n.item
              const color = colorOf(n.color) ?? 'var(--accent)'
              const hasKids = n.children.length > 0
              const rb = rowBars.get(it.id)
              // weeks a solid bar of this row sits on: no drag-to-add starts there (the dotted plan line does not block)
              const covered = new Set<string>()
              for (const o of rb?.own ?? []) {
                const s = o.shape
                const [from, to] = solidSpan(s)
                for (const w of s.milestone ? [from] : weekRange(from, to)) covered.add(w)
              }
              const dragging = drag?.id === it.id ? new Set(weekRange(drag.anchor, drag.head)) : null
              return (
                <tr key={it.id} className={`gv-row d${Math.min(n.depth, 3)}`}>
                  <td className="gv-lbl">
                    <div className="gv-name" style={{ paddingLeft: 6 + n.depth * 16 }}>
                      {hasKids ? (
                        <button className="caret" onClick={() => setCollapsed((c) => ({ ...c, [it.id]: !c[it.id] }))}>{collapsed[it.id] ? '▸' : '▾'}</button>
                      ) : (
                        <span className="caret-spacer" />
                      )}
                      {n.depth === 0 && <span className="tag-dot" style={{ background: color }} />}
                      <span className={`lbl-name${readOnly ? '' : ' lbl-link'}`} title={it.name} onClick={readOnly ? undefined : () => setDialog({ kind: 'row', item: it, create: false })}>
                        {it.name}
                      </span>
                      {!readOnly && (
                        <span className="gv-actions">
                          <button className="mini-btn" title="Move up" onClick={() => move(it.id, -1)}>↑</button>
                          <button className="mini-btn" title="Move down" onClick={() => move(it.id, 1)}>↓</button>
                          <button className="mini-btn" title="Add a sub-row" onClick={() => setDialog({ kind: 'row', item: { id: uid(), parentId: it.id, name: '', segments: [] }, create: true })}>＋</button>
                        </span>
                      )}
                    </div>
                  </td>
                  {weeks.map((w, wi) => (
                    <td
                      key={w}
                      className={`gv-cell${w === today ? ' today' : ''}${bands.bandWeeks.has(w) ? ' band' : ''}${bands.relWeeks.has(w) ? ' rel' : ''}${bands.monthStarts.has(w) ? ' month-start' : ''}`}
                      style={bands.weekStyle(w)}
                      onMouseDown={(e) => {
                        if (readOnly || hasKids || covered.has(w) || e.button !== 0) return
                        // a mousedown on a bar bubbles up through the lane, which lives in the first cell: a click, not a drag-to-add
                        if ((e.target as HTMLElement).closest('.gv-lane')) return
                        e.preventDefault()
                        setDrag({ id: it.id, anchor: w, head: w })
                      }}
                      onMouseEnter={() => drag && drag.id === it.id && setDrag({ ...drag, head: w })}
                    >
                      {dragging?.has(w) && <div className="gv-seg ghost" style={{ background: color }} />}
                      {wi === 0 && rb && (
                        <div className="gv-lane" style={{ width: weeks.length * ROADMAP_COL }}>
                          {hasKids
                            ? rb.summary && renderBar(it.name, rb.summary, colorOf(statusColor(db, rb.summary.status)) ?? color, { summary: true })
                            : rb.own.map((o) => (
                                <div key={o.index} style={{ display: 'contents' }}>
                                  {renderBar(it.name, o.shape, o.color, { onClick: readOnly ? undefined : () => setDialog({ kind: 'bar', id: it.id, index: o.index }) })}
                                </div>
                              ))}
                        </div>
                      )}
                    </td>
                  ))}
                </tr>
              )
            })}
            {visible.length === 0 && shownPinned.length === 0 && (
              <tr>
                <td className="gv-lbl"><span className="hint">{lateOnly ? 'No late or blocked bars.' : 'No roadmap rows yet.'}</span></td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {dialog?.kind === 'bar' && (() => {
        // the row or the bar may have gone under us (another editor's save): then there is nothing to edit
        const row = db.workstreams.find((w) => w.id === dialog.id)
        if (!row?.segments[dialog.index]) return null
        return (
          <GanttBarDialog
            db={db}
            item={row}
            index={dialog.index}
            todayISO={todayISO}
            onClose={() => setDialog(null)}
            onSave={(seg) =>
              update((d) => {
                const it = d.workstreams.find((w) => w.id === dialog.id)
                if (it?.segments[dialog.index]) it.segments[dialog.index] = seg
              })
            }
            onDelete={() =>
              update((d) => {
                const it = d.workstreams.find((w) => w.id === dialog.id)
                if (it?.segments[dialog.index]) it.segments.splice(dialog.index, 1)
              })
            }
          />
        )
      })()}
      {dialog?.kind === 'row' && (
        <GanttItemDialog
          db={db}
          item={dialog.item}
          create={dialog.create}
          onClose={() => setDialog(null)}
          onSave={(g) =>
            update((d) => {
              const i = d.workstreams.findIndex((w) => w.id === g.id)
              if (i >= 0) {
                d.workstreams[i] = g
                return
              }
              // a new child goes after its parent's last descendant, so it lands inside it
              if (g.parentId) {
                const desc = new Set([g.parentId])
                let end = d.workstreams.findIndex((w) => w.id === g.parentId)
                for (let k = end + 1; k < d.workstreams.length; k++) {
                  const p = d.workstreams[k].parentId
                  if (p && desc.has(p)) {
                    desc.add(d.workstreams[k].id)
                    end = k
                  } else break
                }
                d.workstreams.splice(end + 1, 0, g)
              } else d.workstreams.push(g)
            })
          }
          onDelete={() =>
            update((d) => {
              const gone = new Set([dialog.item.id])
              let grew = true
              while (grew) {
                grew = false
                for (const w of d.workstreams) if (w.parentId && gone.has(w.parentId) && !gone.has(w.id)) gone.add(w.id), (grew = true)
              }
              d.workstreams = d.workstreams.filter((w) => !gone.has(w.id))
            })
          }
        />
      )}
      {confirmUI}
      {tipEl}
    </div>
  )
}
