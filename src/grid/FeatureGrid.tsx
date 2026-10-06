import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ExpandedState,
  getCoreRowModel,
  getExpandedRowModel,
  useReactTable,
  type ColumnDef,
  type Row as TRow,
} from '@tanstack/react-table'
import { AllocEntry, AwayEntry, ClipboardData, DB, Feature, FeatureTracking, KIND_LABEL, Milestone, Story } from '../types'
import {
  addWeeks,
  awayPct,
  cellKind,
  featureBars,
  featureProgress,
  fmtDate,
  fmtNum,
  isoWeekNum,
  mondayOf,
  monthGroups,
  peopleById,
  personShort,
  personWeekState,
  rollupProgress,
  SCHEDULE_LABEL,
  scheduleDelta,
  scheduleStatus,
  type ScheduleInfo,
  weekLabel,
  weekRange,
  weekTag,
} from '../logic'
import { CustomerPicker, CustomerTag, PersonCell, PersonPicker, ReleaseCell, ReleasePicker, StatusPicker, StatusTag } from '../ui/pickers'
import { FRow } from '../rows'
import { usePersisted } from '../ui/usePersisted'
import type { JumpTarget } from '../ui/useHashRoute'
import { TipLayer, type TipHandle } from '../ui/useTip'
import { NumberInput } from '../ui/fields'
import { CellPopover, RangePopover } from './CellPopover'
import { ROADMAP_COL } from '../gantt/GanttView'

export interface FeatureOps {
  addEntry(featureId: string, weeks: string[], entry: Omit<AllocEntry, 'id'>): void
  patchEntry(featureId: string, week: string, entryId: string, patch: Partial<AllocEntry>): void
  removeEntry(featureId: string, week: string, entryId: string): void
  setCellNote(featureId: string, week: string, note: string): void
  clearCells(featureId: string, weeks: string[]): void
  /** copy the previous week's cell into this one (replacing it) */
  fillFromPrevious(featureId: string, week: string): void
  copyCells(featureId: string, weeks: string[]): void
  pasteCells(featureId: string, startWeek: string): void
  clipboard(): ClipboardData | null
  patchFeature(featureId: string, patch: Partial<Feature>): void
  /** merge into the Status tab's checklist; undefined / empty values remove the key */
  patchTracking(featureId: string, patch: Partial<FeatureTracking>): void
  addAway(personId: string, entry: AwayEntry): void
  /** the caller makes the record (uid() outside the updater); a second run with the same id is a no-op */
  addStory(story: Story): void
  patchStory(storyId: string, patch: Partial<Story>): void
  patchStoryTracking(storyId: string, patch: Partial<FeatureTracking>): void
  removeStory(storyId: string): void
}

export interface FeatureCallbacks {
  openFeature(featureId: string): void
  openEpic(epicId: string): void
  newFeature(epicId: string): void
  openPerson(personId: string): void
}

export const COL_W = 96
const COL_W_DENSE = 60
/** The Gantt view needs no room for chips: it takes the Roadmap's column so the two tabs read alike */
const COL_W_BARS = ROADMAP_COL
const COL_W_BARS_DENSE = 40
const NAME_W_DEFAULT = 360
const NAME_W_MIN = 200
const NAME_W_MAX = 720
const clampNameW = (w: number) => (Number.isFinite(w) ? Math.min(NAME_W_MAX, Math.max(NAME_W_MIN, Math.round(w))) : NAME_W_DEFAULT)

/** The fixed columns right of the name, in order. `compact` keeps only the ones marked. */
const FIELDS = [
  { id: 'status', label: 'Status', w: 92, compact: true },
  { id: 'customer', label: 'Customer', w: 84, title: 'The customer the feature is for' },
  { id: 'release', label: 'Release', w: 64 },
  { id: 'lead', label: 'Lead', w: 64, compact: true },
  { id: 'buddy', label: 'Buddy', w: 60 },
  { id: 'testLead', label: 'Test lead', w: 68 },
  { id: 'est', label: 'Estimate (h)', w: 84, title: 'Original estimate, hours' },
  { id: 'rem', label: 'Remaining (h)', w: 86, title: 'Hours of work left — click to update' },
  { id: 'progress', label: 'Progress', w: 74 },
  { id: 'schedule', label: 'Schedule', w: 84, title: 'Plan vs actual end: ahead, on plan or delayed' },
] as const
type FieldId = (typeof FIELDS)[number]['id']
type FieldDef = { id: FieldId; label: string; w: number; compact?: boolean; title?: string }

type PickField = 'status' | 'customer' | 'release' | 'lead' | 'buddy' | 'testLead'
/** the person fields a picker edits: column id → stored key and popover caption */
const PERSON_FIELDS = { lead: ['leadId', 'Feature lead'], buddy: ['buddyId', 'Feature buddy'], testLead: ['testLeadId', 'Test lead'] } as const
type Focus = { rowId: string; week: string } | null
type Selection = { rowId: string; featureId: string; anchor: string; head: string }
export type PopState =
  | { kind: 'cell'; x: number; y: number; featureId: string; week: string }
  | { kind: 'range'; x: number; y: number; featureId: string; weeks: string[] }
  | { kind: 'field'; x: number; y: number; featureId: string; field: PickField }

interface Props {
  db: DB
  /** the unfiltered db — the capacity section always counts everything */
  fullDb: DB
  /** the app-wide switch: leavers already gone are not offered in the person, lead, buddy and test lead pickers */
  hideResigned: boolean
  weeks: string[]
  treeRows: FRow[]
  expanded: ExpandedState
  onExpandedChange: React.Dispatch<React.SetStateAction<ExpandedState>>
  search: string
  onSearchChange: (v: string) => void
  compactFields: boolean
  dense: boolean
  /** planned vs booked weeks as bars instead of name chips (the simplified gantt) */
  bars: boolean
  /** in the Gantt view, draw the dotted planned bar above the booked one */
  showPlanned: boolean
  scrollToStart: boolean
  /** land on this feature's or epic's row (from a link); a new nonce lands again even for the same target */
  focusRequest: { target: JumpTarget; nonce: number } | null
  ops: FeatureOps
  cb: FeatureCallbacks
  readOnly: boolean
  /** release/milestone colours snapped to the theme */
  colorOf: (hex: string | undefined) => string | undefined
}


/** A timeline label that shrinks (11px → 8px, up to two lines) until it fits its phase's weeks. */
function FitLabel({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = () => {
      let size = 11
      el.style.fontSize = `${size}px`
      while (size > 8 && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)) {
        size -= 0.5
        el.style.fontSize = `${size}px`
      }
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el.parentElement ?? el)
    return () => ro.disconnect()
  }, [text])
  return (
    <div ref={ref} className="phase-name">
      {text}
    </div>
  )
}

function ProgressBar({ value, title }: { value: number | null; title?: string }) {
  if (value == null) return <span className="muted-dash" title={title ?? 'No estimate / remaining yet'}>—</span>
  const pct = Math.round(value * 100)
  return (
    <span className="pbar-mini" title={title ?? `${pct}% done`}>
      <span className="pbar-mini-fill" style={{ width: `${pct}%` }} />
      <span className="pbar-mini-num">{pct}%</span>
    </span>
  )
}

/** Ahead / On plan / Delayed, with the week delta; the tooltip spells out planned vs actual. */
function ScheduleBadge({ info }: { info: ScheduleInfo | null }) {
  if (!info) return <span className="muted-dash" title="No planned end — set the plan in the feature details">—</span>
  const tip = [
    `Planned ${weekTag(info.plannedStart)}–${weekTag(info.plannedEnd)}`,
    `Actual ${weekTag(info.actualStart)}–${weekTag(info.actualEnd)}${info.finished ? ' (finished)' : ' (forecast)'}`,
    info.overdue ? `Past the planned end with work still open — ${info.weeks} week${info.weeks === 1 ? '' : 's'} late so far` : '',
  ]
    .filter(Boolean)
    .join('\n')
  return (
    <span className={`sched ${info.status}`} title={tip}>
      {SCHEDULE_LABEL[info.status]}
      {info.weeks !== 0 && <b>&nbsp;{scheduleDelta(info.weeks)}</b>}
    </span>
  )
}

// ----- one tree row -----

interface RowProps {
  tr: TRow<FRow>
  isExpanded: boolean
  db: DB
  fullDb: DB
  weeks: string[]
  colW: number
  nameW: number
  fields: readonly FieldDef[]
  /** the grid's week classes / phase colour — one source for header, rows and capacity section */
  weekClass: (w: string) => string
  weekStyle: (w: string) => React.CSSProperties | undefined
  todayISO: string
  colorOf: (hex: string | undefined) => string | undefined
  readOnly: boolean
  bars: boolean
  showPlanned: boolean
  selection: Selection | null
  /** weeks of this row last copied with ⌘C — outlined until the next paste / Esc */
  copied: { anchor: string; head: string } | null
  focusWeek: string | null
  /** just landed here from a link: the row lights up for a moment */
  flash: boolean
  ops: FeatureOps
  cb: FeatureCallbacks
  onCellDown: (row: FRow, featureId: string, week: string, e: React.MouseEvent) => void
  onCellEnter: (rowId: string, week: string) => void
  onFieldClick: (featureId: string, field: PickField, e: React.MouseEvent) => void
}

const GridRow = React.memo(function GridRow(p: RowProps) {
  const { tr, db, weeks, fields, readOnly } = p
  const row = tr.original
  const s = db.settings
  const people = peopleById(p.fullDb)
  const depth = tr.depth
  const { weekClass } = p

  const caret =
    row.kind !== 'feature' ? (
      <button className="caret" onClick={tr.getToggleExpandedHandler()} aria-label={p.isExpanded ? 'Collapse' : 'Expand'}>
        {p.isExpanded ? '▾' : '▸'}
      </button>
    ) : (
      <span className="caret-spacer" />
    )

  const fieldCell = (id: FieldId, content: React.ReactNode) => {
    const f = fields.find((x) => x.id === id)
    return f ? (
      <span key={id} className={`fcell f-${id}`} style={{ width: f.w }}>
        {content}
      </span>
    ) : null
  }

  // ----- label (sticky) -----
  let label: React.ReactNode
  let weekCells: React.ReactNode
  if (row.kind === 'feature') {
    const f = row.feature
    const release = db.releases.find((r) => r.id === f.releaseId)
    const prog = featureProgress(f)
    const sched = scheduleStatus(f, p.todayISO)
    const planned = (w: string) => !!f.planStart && !!f.planEnd && w >= f.planStart && w <= f.planEnd
    const bi = p.bars ? featureBars(f, p.todayISO) : null
    // editable cells open the picker; viewers get the plain value
    const pick = (field: PickField) => (readOnly ? undefined : (e: React.MouseEvent) => p.onFieldClick(f.id, field, e))
    // a feature with stories carries their sum — edited in the Status tab, read-only here
    const storyCount = db.stories.filter((st) => st.featureId === f.id).length
    label = (
      <div className="flbl" style={{ paddingLeft: 6 + depth * 16 }}>
        {caret}
        <span className="flbl-name" style={{ width: p.nameW - 22 - depth * 16 }}>
          {f.key && <span className="jira-key">{f.key}</span>}
          <span className="lbl-name lbl-link" title={`${f.key ? f.key + ' · ' : ''}${f.name}\nClick for details`} onClick={() => p.cb.openFeature(f.id)}>
            {f.name}
          </span>
        </span>
        {fieldCell('status', <StatusTag status={f.status} colors={s.optionColors} onClick={pick('status')} />)}
        {fieldCell('customer', <CustomerTag customer={f.customer} colors={s.optionColors} onClick={pick('customer')} />)}
        {fieldCell('release', <ReleaseCell release={release} variant="version" colorOf={p.colorOf} onClick={pick('release')} />)}
        {fieldCell('lead', <PersonCell person={f.leadId ? people.get(f.leadId) : undefined} setLabel="Set lead" onClick={pick('lead')} />)}
        {fieldCell('buddy', <PersonCell person={f.buddyId ? people.get(f.buddyId) : undefined} setLabel="Set buddy" onClick={pick('buddy')} />)}
        {fieldCell('testLead', <PersonCell person={f.testLeadId ? people.get(f.testLeadId) : undefined} setLabel="Set test lead" onClick={pick('testLead')} />)}
        {fieldCell(
          'est',
          readOnly || storyCount ? (
            <span className="num" title={storyCount ? `Sum of ${storyCount} stor${storyCount === 1 ? 'y' : 'ies'} — edit them in the Status tab` : undefined}>{f.estimate ?? '—'}</span>
          ) : (
            <NumberInput value={f.estimate} title="Estimate, hours — click to update" onCommit={(v) => p.ops.patchFeature(f.id, { estimate: v })} />
          ),
        )}
        {fieldCell(
          'rem',
          readOnly || storyCount ? (
            <span className="num" title={storyCount ? `Sum of ${storyCount} stor${storyCount === 1 ? 'y' : 'ies'} — edit them in the Status tab` : undefined}>{f.remaining ?? '—'}</span>
          ) : (
            <NumberInput value={f.remaining} title="Remaining hours — click to update" onCommit={(v) => p.ops.patchFeature(f.id, { remaining: v })} />
          ),
        )}
        {fieldCell('progress', <ProgressBar value={prog} />)}
        {fieldCell('schedule', <ScheduleBadge info={sched} />)}
      </div>
    )
    weekCells = weeks.map((w) => {
      const cell = f.cells[w]
      const kind = cellKind(cell)
      const sel = p.selection && p.selection.rowId === row.id && w >= (p.selection.anchor < p.selection.head ? p.selection.anchor : p.selection.head) && w <= (p.selection.anchor < p.selection.head ? p.selection.head : p.selection.anchor)
      const entries = cell?.entries ?? []
      const copied = p.copied && w >= p.copied.anchor && w <= p.copied.head
      const hasNote = !!cell?.note || entries.some((e) => e.note)
      // Gantt view: the plan outline and the booked bar replace the chips, the dashed plan outline
      // and the kind-coloured cell; the td itself (classes, data-*, handlers) stays, so selection,
      // the keyboard and the editors work as before.
      let body: React.ReactNode
      if (bi) {
        const booked = bi.booked.has(w)
        const inPlan = !!bi.plan && w >= bi.plan[0] && w <= bi.plan[1]
        // one lane: the booked bar first, the planned outline after it so the dashes frame the bar
        body = (
          <>
            {booked ? (
              <div
                className={`gbar act k-${kind}${bi.booked.has(addWeeks(w, -1)) ? '' : ' first'}${bi.booked.has(addWeeks(w, 1)) ? '' : ' last'}${
                  bi.slip.has(w) ? ' slip' : ''
                }`}
              />
            ) : bi.slip.has(w) ? (
              <div className="gbar gap slip" />
            ) : bi.early.has(w) ? (
              <div className="gbar gap early" />
            ) : bi.stated.has(w) ? (
              <div className={`gbar act stated${bi.stated.has(addWeeks(w, -1)) ? '' : ' first'}${bi.stated.has(addWeeks(w, 1)) ? '' : ' last'}`} />
            ) : null}
            {inPlan && p.showPlanned && <div className={`gbar plan${w === bi.plan![0] ? ' first' : ''}${w === bi.plan![1] ? ' last' : ''}`} />}
            {bi?.done === w && (
              <span className="gbar-done" title="Finished this week">
                ✓
              </span>
            )}
          </>
        )
      } else {
        body = (
          <div className="chips">
            {entries.map((e) => {
              const pe = e.personId ? people.get(e.personId) : undefined
              const state = pe ? personWeekState(p.fullDb, pe, w) : null
              // away all week strikes the name through; away part of it keeps the name and adds a mark
              const away = pe ? awayPct(pe, w) : 0
              return (
                <span
                  key={e.id}
                  className={`chip-p k-${e.kind}${pe ? '' : ' slot'}${state === 'over' ? ' over' : ''}${away >= 100 ? ' away' : away > 0 ? ' part-away' : ''}`}
                >
                  <span className="chip-name">{pe ? personShort(pe) : e.label ?? KIND_LABEL[e.kind]}</span>
                  {away > 0 && away < 100 && <span className="chip-warn">!</span>}
                  {e.pct !== 100 && <span className="chip-pct">·{e.pct}%</span>}
                </span>
              )
            })}
            {!entries.length && cell?.note && <span className="cell-note-text">{cell.note}</span>}
          </div>
        )
      }
      return (
        <td
          key={w}
          className={`${weekClass(w)}${kind && !bi ? ` kind-${kind}` : ''}${sel ? ' sel' : ''}${copied ? ' copied' : ''}${p.focusWeek === w ? ' cur' : ''}${
            !bi && planned(w) ? ` plan${w === f.planStart ? ' plan-start' : ''}${w === f.planEnd ? ' plan-end' : ''}` : ''
          }`}
          style={p.weekStyle(w)}
          data-row={row.id}
          data-week={w}
          onMouseDown={(e) => p.onCellDown(row, f.id, w, e)}
          onMouseEnter={() => p.onCellEnter(row.id, w)}
        >
          {body}
          {hasNote && <span className="note-mark" />}
        </td>
      )
    })
  } else {
    // group or epic: roll-ups
    const fs = row.features
    const roll = rollupProgress(fs)
    let est = 0
    let delayed = 0
    for (const f of fs) {
      if (f.estimate) est += f.estimate
      if (scheduleStatus(f, p.todayISO)?.status === 'delayed') delayed++
    }
    const isEpic = row.kind === 'epic'
    label = (
      <div className={`flbl ${isEpic ? 'flbl-epic' : 'flbl-group'}`} style={{ paddingLeft: 6 + depth * 16 }}>
        {caret}
        <span className="flbl-name" style={{ width: p.nameW - 22 - depth * 16 }}>
          {row.kind === 'group' && row.color && <span className="tag-dot" style={{ background: p.colorOf(row.color) }} />}
          {isEpic && row.epic.key && <span className="jira-key">{row.epic.key}</span>}
          {isEpic ? (
            <span className="lbl-name lbl-link" title={`${row.epic.name}\nClick for details`} onClick={() => p.cb.openEpic(row.epic.id)}>
              {row.epic.name}
            </span>
          ) : (
            <span className="lbl-name">{row.label}</span>
          )}
          <span className="hint count">{fs.length}</span>
          {isEpic && !readOnly && (
            <button className="mini-btn" title="Add a feature to this package" onClick={() => p.cb.newFeature(row.epic.id)}>
              + Feature
            </button>
          )}
        </span>
        {fields.map((f) =>
          f.id === 'est' ? (
            <span key={f.id} className="fcell num" style={{ width: f.w }}>{est || '—'}</span>
          ) : f.id === 'rem' ? (
            <span key={f.id} className="fcell num" style={{ width: f.w }}>{roll.estimated ? fmtNum(roll.remaining) : '—'}</span>
          ) : f.id === 'progress' ? (
            <span key={f.id} className="fcell" style={{ width: f.w }}>
              <ProgressBar value={roll.pct} title={roll.pct == null ? 'No feature has an estimate yet' : `${Math.round(roll.pct * 100)}% of estimated hours done · ${roll.estimated} of ${roll.total} features estimated`} />
            </span>
          ) : f.id === 'schedule' ? (
            <span key={f.id} className="fcell" style={{ width: f.w }}>
              {delayed > 0 && (
                <span className="sched delayed" title={`${delayed} of ${fs.length} features behind their planned end`}>
                  {delayed} delayed
                </span>
              )}
            </span>
          ) : (
            <span key={f.id} className="fcell" style={{ width: f.w }} />
          ),
        )}
      </div>
    )
    // Gantt view: the envelope of the features' plans, and the union of their booked weeks
    let planLo: string | undefined
    let planHi: string | undefined
    if (p.bars) {
      for (const f of fs) {
        if (!f.planStart || !f.planEnd) continue
        if (!planLo || f.planStart < planLo) planLo = f.planStart
        if (!planHi || f.planEnd > planHi) planHi = f.planEnd
      }
    }
    const fteAt = (w: string) => {
      let fte = 0
      for (const f of fs) for (const e of f.cells[w]?.entries ?? []) fte += e.pct / 100
      return fte
    }
    weekCells = weeks.map((w) => {
      const fte = fteAt(w)
      const title = `${fmtNum(fte)} FTE booked on ${isEpic ? 'this package' : 'this group'} in ${weekTag(w)}`
      return (
        <td key={w} className={weekClass(w)} style={p.weekStyle(w)} title={p.bars && fte > 0 ? title : undefined}>
          {p.bars ? (
            <>
              {fte > 0 && (
                <div
                  className={`gbar act sum${fteAt(addWeeks(w, -1)) > 0 ? '' : ' first'}${fteAt(addWeeks(w, 1)) > 0 ? '' : ' last'}`}
                  style={{ '--heat': Math.min(1, fte / 4) } as React.CSSProperties}
                />
              )}
              {p.showPlanned && planLo && planHi && w >= planLo && w <= planHi && <div className={`gbar plan sum${w === planLo ? ' first' : ''}${w === planHi ? ' last' : ''}`} />}
            </>
          ) : (
            fte > 0 && (
              <span className="fte-heat" style={{ '--heat': Math.min(1, fte / 4) } as React.CSSProperties} title={title}>
                {fmtNum(fte)}
              </span>
            )
          )}
        </td>
      )
    })
  }

  return (
    <tr className={`frow frow-${row.kind}${p.flash ? ' frow-flash' : ''}`}>
      <td className="lbl-col">{label}</td>
      {weekCells}
    </tr>
  )
})

// ----- the grid -----

export default function FeatureGrid({
  db,
  fullDb,
  hideResigned,
  weeks,
  treeRows,
  expanded,
  onExpandedChange,
  search,
  onSearchChange,
  compactFields,
  dense,
  bars,
  showPlanned,
  scrollToStart,
  focusRequest,
  ops,
  cb,
  readOnly,
  colorOf,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const colW = bars ? (dense ? COL_W_BARS_DENSE : COL_W_BARS) : dense ? COL_W_DENSE : COL_W
  const fields = useMemo<readonly FieldDef[]>(() => (compactFields ? FIELDS.filter((f) => 'compact' in f && f.compact) : FIELDS), [compactFields])
  const fieldsW = fields.reduce((n, f) => n + f.w, 0)
  const [rawNameW, setNameW] = usePersisted('feature-planner:nameW', NAME_W_DEFAULT)
  const nameW = clampNameW(rawNameW)
  const labelW = nameW + fieldsW + 12

  const [focus, setFocus] = useState<Focus>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const selectionRef = useRef<Selection | null>(null)
  selectionRef.current = selection
  const dragRef = useRef<Selection | null>(null)
  const [pop, setPop] = useState<PopState | null>(null)
  const closePop = useCallback(() => {
    setPop(null)
    // the popover's input had focus; hand it back so the grid keys keep working
    requestAnimationFrame(() => wrapRef.current?.focus({ preventScroll: true }))
  }, [])
  /** cells last copied (for the outline); the clipboard itself lives in App */
  const [copied, setCopied] = useState<{ rowId: string; anchor: string; head: string } | null>(null)
  /** true when the mousedown hit the cell that was already selected — the click that opens the editor */
  const reclickRef = useRef(false)
  const copyWeeks = (rowId: string, featureId: string, ws: string[]) => {
    ops.copyCells(featureId, ws)
    setCopied({ rowId, anchor: ws[0], head: ws[ws.length - 1] })
  }
  const pasteAt = (featureId: string, week: string) => {
    ops.pasteCells(featureId, week)
    setCopied(null)
  }

  // ----- label resize -----
  const [resizing, setResizing] = useState(false)
  const resizeStart = useRef({ x: 0, w: nameW })
  const onResizeDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    resizeStart.current = { x: e.clientX, w: nameW }
    setResizing(true)
  }
  const onResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    setNameW(clampNameW(resizeStart.current.w + e.clientX - resizeStart.current.x))
  }
  const onResizeUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    setResizing(false)
  }

  // ----- header geometry -----
  const months = useMemo(() => monthGroups(weeks), [weeks])
  const monthStarts = useMemo(() => new Set(months.slice(1).map((m) => m.weeks[0])), [months])
  const todayISO = fmtDate(new Date())
  const todayWeek = mondayOf(todayISO)

  /** milestones by the week they fall in; bands mark every week they cover */
  const { msWeeks, bandWeeks, relWeeks, weekTint } = useMemo(() => {
    const msWeeks = new Map<string, Milestone[]>()
    const bandWeeks = new Map<string, string>()
    /** week → the colour its header tint / edge lines use (a one-day event wins over the phase around it) */
    const weekTint = new Map<string, string>()
    for (const m of db.milestones) {
      const w = mondayOf(m.date)
      msWeeks.set(w, [...(msWeeks.get(w) ?? []), m])
      if (!m.end) continue
      // a milestone's colour is used as picked (the theme palette has no purple, so snapping would grey it)
      const color = m.color
      const ws = weekRange(w, mondayOf(m.end))
      ws.forEach((x, i) => {
        bandWeeks.set(x, ` band${i === 0 ? ' band-start' : ''}${i === ws.length - 1 ? ' band-end' : ''}`)
        if (color) weekTint.set(x, color)
      })
    }
    const relWeeks = new Map<string, DB['releases']>()
    for (const r of db.releases) if (r.date) relWeeks.set(mondayOf(r.date), [...(relWeeks.get(mondayOf(r.date)) ?? []), r])
    // one-day events (milestones without an end, release dates) are one-week phases of their own, drawn
    // on top of any phase they fall in (a code stop mid system-test keeps its own colour and edges); the
    // earliest event in a week sets its colour
    const oneDay = [
      ...db.milestones.filter((m) => !m.end).map((m) => ({ date: m.date, color: m.color })),
      ...db.releases.filter((r) => r.date).map((r) => ({ date: r.date!, color: colorOf(r.color) })),
    ].sort((a, b) => a.date.localeCompare(b.date))
    const owned = new Set<string>()
    for (const ev of oneDay) {
      const w = mondayOf(ev.date)
      if (owned.has(w)) continue
      owned.add(w)
      bandWeeks.set(w, ' band band-start band-end')
      if (ev.color) weekTint.set(w, ev.color)
      else weekTint.delete(w)
    }
    return { msWeeks, bandWeeks, relWeeks, weekTint }
  }, [db.milestones, db.releases, colorOf])

  /**
   * The phase row under the months: one centred name per phase (a milestone with an end date) across
   * its weeks, and per one-day event (milestone without an end, release date) on its week. A one-day
   * event inside a phase cuts it: the event gets its own cell and the phase continues either side of it,
   * named on its widest segment; the gaps merge into empty cells.
   */
  const phaseCells = useMemo(() => {
    type Point = { week: string; date: string; name: string; text: string; color?: string }
    type Phase = { start: number; end: number; names: string[]; dates: string[]; color?: string }
    const idx = new Map(weeks.map((w, i) => [w, i]))
    const clampIdx = (w: string, side: 'start' | 'end') => {
      if (idx.has(w)) return idx.get(w)!
      return side === 'start' ? (w < weeks[0] ? 0 : -1) : w > weeks[weeks.length - 1] ? weeks.length - 1 : -1
    }
    const phases: Phase[] = []
    for (const m of db.milestones) {
      if (!m.end) continue
      const a = clampIdx(mondayOf(m.date), 'start')
      const b = clampIdx(mondayOf(m.end), 'end')
      if (a < 0 || b < 0 || a > b) continue
      phases.push({ start: a, end: b, names: [m.name], dates: [`${weekLabel(m.date)} – ${weekLabel(m.end)}`], color: m.color })
    }
    phases.sort((x, y) => x.start - y.start)
    const merged: Phase[] = []
    for (const ph of phases) {
      const last = merged[merged.length - 1]
      if (last && ph.start <= last.end) {
        last.end = Math.max(last.end, ph.end)
        last.names.push(...ph.names)
        last.dates.push(...ph.dates)
      } else merged.push(ph)
    }
    const points: Point[] = [
      ...db.milestones
        .filter((m) => !m.end)
        .map((m) => ({ week: mondayOf(m.date), date: m.date, name: m.name, text: `${m.name} ${weekLabel(m.date)}`, color: m.color })),
      ...db.releases
        .filter((r) => r.date)
        .map((r) => ({ week: mondayOf(r.date!), date: r.date!, name: `${r.name} release`, text: `${r.name} release ${weekLabel(r.date!)}`, color: colorOf(r.color) })),
    ]
    const loose = new Map<number, Point[]>()
    for (const pt of points) {
      const i = idx.get(pt.week)
      if (i == null) continue
      loose.set(i, [...(loose.get(i) ?? []), pt])
    }
    type Edges = { start: boolean; end: boolean }
    type Cell =
      | { kind: 'phase'; span: number; key: string; name: string; color?: string; title: string; label: boolean; edges: Edges }
      | { kind: 'empty'; span: number; key: string }
    /** the phase's segments between the one-day events inside it; the name goes on the widest */
    const labelAt = new Map<Phase, number>()
    for (const ph of merged) {
      let best: { start: number; end: number } | undefined
      let s = ph.start
      for (let k = ph.start; k <= ph.end + 1; k++) {
        if (k <= ph.end && !loose.has(k)) continue
        if (k > s && (!best || k - 1 - s > best.end - best.start)) best = { start: s, end: k - 1 }
        s = k + 1
      }
      if (best) labelAt.set(ph, best.start)
    }
    const cells: Cell[] = []
    let i = 0
    while (i < weeks.length) {
      const pts = loose.get(i)
      if (pts) {
        const sorted = [...pts].sort((a, b) => a.date.localeCompare(b.date))
        const name = sorted.map((x) => x.name).join(' · ')
        cells.push({ kind: 'phase', span: 1, key: weeks[i], name, color: sorted.find((x) => x.color)?.color, title: sorted.map((x) => x.text).join('\n'), label: true, edges: { start: true, end: true } })
        i++
        continue
      }
      const ph = merged.find((x) => i >= x.start && i <= x.end)
      if (ph) {
        let j = i
        while (j < ph.end && !loose.has(j + 1)) j++
        const name = ph.names.join(' · ')
        // title only on the label; the dates are in the tooltip
        cells.push({
          kind: 'phase', span: j - i + 1, key: weeks[i], name, color: ph.color, title: `${name}\n${ph.dates.join('\n')}`,
          label: labelAt.get(ph) === i, edges: { start: i === ph.start, end: j === ph.end },
        })
        i = j + 1
        continue
      }
      let j = i
      // an empty run also stops at a month start, so the month line runs through this row too
      while (j < weeks.length && !loose.has(j) && !merged.some((x) => x.start === j) && !(j > i && monthStarts.has(weeks[j]))) j++
      cells.push({ kind: 'empty', span: j - i, key: weeks[i] })
      i = j
    }
    return cells
  }, [weeks, db.milestones, db.releases, colorOf, monthStarts])

  // A phase edge on a month boundary replaces the month line: `next-month` drops a phase's right
  // edge when the next week starts a month, `after-band` colours that month border instead.
  const endsBand = useCallback((w: string | undefined) => !!w && !!bandWeeks.get(w)?.includes('band-end'), [bandWeeks])
  const weekClass = useCallback(
    (w: string) => {
      const band = bandWeeks.get(w) ?? ''
      const next = addWeeks(w, 1)
      const prev = addWeeks(w, -1)
      return `cell-week${monthStarts.has(w) ? ' month-start' : ''}${w === todayWeek ? ' today-col' : ''}${band}${
        band.includes('band-end') && monthStarts.has(next) ? ' next-month' : ''
      }${monthStarts.has(w) && endsBand(prev) ? ' after-band' : ''}`
    },
    [monthStarts, todayWeek, bandWeeks, endsBand],
  )
  /** Timeline-row cells get the same edge / month-line classes as the week columns below them. */
  const timelineClass = (first: string, span: number, edges: { start: boolean; end: boolean } | null) => {
    const last = addWeeks(first, span - 1)
    const monthStart = monthStarts.has(first)
    return `${edges ? `phase-cell band${edges.start ? ' band-start' : ''}${edges.end ? ' band-end' : ''}` : 'phase-empty'}${monthStart ? ' month-start' : ''}${
      edges?.end && monthStarts.has(addWeeks(last, 1)) ? ' next-month' : ''
    }${monthStart && endsBand(addWeeks(first, -1)) ? ' after-band' : ''}`
  }
  const weekStyle = useCallback(
    (w: string) => {
      const own = weekTint.get(w)
      const prev = addWeeks(w, -1)
      const prevTint = monthStarts.has(w) && endsBand(prev) ? weekTint.get(prev) : undefined
      if (!own && !prevTint) return undefined
      return { ...(own ? { '--ph': own } : {}), ...(prevTint ? { '--ph-prev': prevTint } : {}) } as React.CSSProperties
    },
    [weekTint, monthStarts, endsBand],
  )

  const columns = useMemo<ColumnDef<FRow>[]>(() => [{ id: 'label' }], [])
  const table = useReactTable({
    data: treeRows,
    columns,
    state: { expanded },
    onExpandedChange,
    getRowId: (r) => r.id,
    getSubRows: (r) => (r.kind === 'feature' ? undefined : r.subRows),
    getCoreRowModel: getCoreRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
  })
  const rows = table.getRowModel().rows
  const featureRows = useMemo(() => rows.filter((r) => r.original.kind === 'feature'), [rows])

  // initial horizontal position: today with a month of lead-in, or the left edge when trimmed
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    if (scrollToStart) {
      el.scrollLeft = 0
      return
    }
    const idx = weeks.indexOf(todayWeek)
    if (idx >= 0) el.scrollLeft = Math.max(0, idx * colW - 4 * colW)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weeks[0], scrollToStart, colW])

  useEffect(() => {
    const ae = document.activeElement
    if (!ae || ae === document.body) wrapRef.current?.focus({ preventScroll: true })
  }, [])

  // ----- landing on a row from a link -----
  // The request is consumed once per nonce. If the row isn't visible yet (App is still clearing
  // filters or expanding the epic), the effect simply retries when `featureRows` changes. The
  // scroll runs a frame later so it wins over the mount-scroll effect above.
  const [flashRowId, setFlashRowId] = useState<string | null>(null)
  const doneNonce = useRef(0)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!focusRequest || focusRequest.nonce === doneNonce.current) return
    const t = focusRequest.target
    const row = rows.find((r) =>
      'feature' in t ? r.original.kind === 'feature' && r.original.feature.id === t.feature : r.original.kind === 'epic' && r.original.epic.id === t.epic,
    )
    if (!row) return
    doneNonce.current = focusRequest.nonce
    const f = row.original.kind === 'feature' ? row.original.feature : null
    const firstWorked = f
      ? Object.keys(f.cells)
          .filter((w) => f.cells[w].entries.length)
          .sort()[0]
      : undefined
    // a week the grid shows: the plan's start, else the first booked week, else today ("From today" may trim the plan away)
    const week = [f?.planStart, firstWorked, todayWeek].find((w): w is string => !!w && weeks.includes(w)) ?? weeks[0]
    setFocus({ rowId: row.id, week })
    setSelection(null)
    setFlashRowId(row.id)
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlashRowId(null), 1600)
    requestAnimationFrame(() => {
      wrapRef.current?.querySelector(`td[data-row="${CSS.escape(row.id)}"][data-week="${week}"]`)?.scrollIntoView({ block: 'center', inline: 'nearest' })
      wrapRef.current?.focus({ preventScroll: true })
    })
  }, [focusRequest, rows, weeks, todayWeek])
  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current)
    },
    [],
  )

  // ----- hover plate: one delegated handler for the whole grid -----
  // The plate lives in TipLayer (its own state), so moving the mouse never re-renders the grid;
  // the content is built only when the hovered cell changes.
  const tipRef = useRef<TipHandle>(null)
  const hoverRef = useRef<string | null>(null)
  const rowById = useMemo(() => new Map(rows.map((r) => [r.id, r.original])), [rows])
  const cellTip = useCallback(
    (f: Feature, w: string) => {
      const cell = f.cells[w]
      const entries = cell?.entries ?? []
      const people = peopleById(fullDb)
      const planned = !!f.planStart && !!f.planEnd && w >= f.planStart && w <= f.planEnd
      // in the Gantt view the plate also reads the lane: planned vs actual, and the delta
      const sched = bars ? scheduleStatus(f, todayISO) : null
      return (
        <>
          <b>{f.key ? `${f.key} · ` : ''}{f.name}</b>
          <div className="tip-muted">
            {weekTag(w)} · {weekLabel(w)}{planned ? ' · planned week' : ''}
          </div>
          {sched && (
            <div className="cell-tip-sched">
              <span>Planned {weekTag(sched.plannedStart)}–{weekTag(sched.plannedEnd)}</span>
              <span>
                Actual {weekTag(sched.actualStart)}–{weekTag(sched.actualEnd)} {sched.finished ? '(finished)' : '(forecast)'}
              </span>
              <span className={`sched ${sched.status}`}>
                {SCHEDULE_LABEL[sched.status]}
                {sched.weeks !== 0 && <b>&nbsp;{scheduleDelta(sched.weeks)}</b>}
              </span>
            </div>
          )}
          {entries.length > 0 && (
            <div className="cell-tip-people">
              {entries.map((e) => {
                const pe = e.personId ? people.get(e.personId) : undefined
                const over = pe && personWeekState(fullDb, pe, w) === 'over'
                const away = pe ? awayPct(pe, w) : 0
                return (
                  <React.Fragment key={e.id}>
                    <span className={pe ? undefined : 'tip-muted'}>
                      {pe ? personShort(pe) : e.label ?? KIND_LABEL[e.kind]}
                      {pe && pe.name !== personShort(pe) && <span className="tip-muted"> {pe.name}</span>}
                    </span>
                    <span className={`num${over ? ' tip-over' : ''}`}>
                      {KIND_LABEL[e.kind]} {e.pct}%{away > 0 ? ` · away ${away}%` : ''}
                    </span>
                    {e.note && <span className="sub">{e.note}</span>}
                  </React.Fragment>
                )
              })}
            </div>
          )}
          {cell?.note && <div className="cell-tip-note">Note: {cell.note}</div>}
        </>
      )
    },
    [fullDb, bars, todayISO],
  )
  const onGridOver = useCallback(
    (e: React.MouseEvent) => {
      const td = (e.target as HTMLElement).closest<HTMLElement>('td.cell-week[data-row]')
      const key = td ? `${td.dataset.row}\u0000${td.dataset.week}` : null
      if (key === hoverRef.current) return
      hoverRef.current = key
      if (!td || !key || pop) {
        tipRef.current?.hide()
        return
      }
      const row = rowById.get(td.dataset.row!)
      const w = td.dataset.week!
      if (!row || row.kind !== 'feature') {
        tipRef.current?.hide()
        return
      }
      const cell = row.feature.cells[w]
      // in the Gantt view any week with a bar in it (plan-only, slip, early) has something to say
      const empty = bars ? !td.querySelector('.gbar') && !cell?.note : !cell?.entries.length && !cell?.note
      if (empty) {
        tipRef.current?.hide()
        return
      }
      tipRef.current?.show(cellTip(row.feature, w), e.clientX, e.clientY)
    },
    [rowById, cellTip, pop, bars],
  )
  // a move also resolves the cell: the pointer can land on a cell without a mouseover reaching us
  // (e.g. entering the window, or the grid scrolling under a still cursor)
  const onGridMove = useCallback(
    (e: React.MouseEvent) => {
      onGridOver(e)
      tipRef.current?.move(e.clientX, e.clientY)
    },
    [onGridOver],
  )
  const onGridLeave = useCallback(() => {
    hoverRef.current = null
    tipRef.current?.hide()
  }, [])

  // ----- mouse -----
  const onCellDown = useCallback(
    (row: FRow, featureId: string, week: string, e: React.MouseEvent) => {
      if (e.button !== 0) return
      tipRef.current?.hide()
      wrapRef.current?.focus({ preventScroll: true })
      setFocus({ rowId: row.id, week })
      const cur = selectionRef.current
      reclickRef.current = !e.shiftKey && !!cur && cur.rowId === row.id && cur.anchor === week && cur.head === week
      if (e.shiftKey && cur && cur.rowId === row.id) {
        setSelection({ ...cur, head: week })
        return
      }
      const sel = { rowId: row.id, featureId, anchor: week, head: week }
      dragRef.current = sel
      setSelection(sel)
      e.preventDefault()
    },
    [],
  )
  const onCellEnter = useCallback((rowId: string, week: string) => {
    const d = dragRef.current
    if (d && d.rowId === rowId && d.head !== week) {
      const next = { ...d, head: week }
      dragRef.current = next
      setSelection(next)
    }
  }, [])
  useEffect(() => {
    const up = (ev: MouseEvent) => {
      const d = dragRef.current
      if (!d) return
      dragRef.current = null
      // Spreadsheet-style: a click selects, a click on the selected cell (or a double-click) edits.
      // A dragged range stays selected for ⌘C / R / ⌫; Enter opens its editor.
      if (d.anchor === d.head && reclickRef.current) setPop({ kind: 'cell', x: ev.clientX, y: ev.clientY, featureId: d.featureId, week: d.anchor })
      reclickRef.current = false
    }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [])

  const onFieldClick = useCallback((featureId: string, field: PickField, e: React.MouseEvent) => {
    setPop({ kind: 'field', x: e.clientX, y: e.clientY, featureId, field })
  }, [])

  // ----- keyboard -----
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (pop) return
    const target = e.target as HTMLElement
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return
    const idx = focus ? featureRows.findIndex((r) => r.id === focus.rowId) : -1
    const wIdx = focus ? weeks.indexOf(focus.week) : -1
    const cur = idx >= 0 ? featureRows[idx] : null
    const feature = cur && cur.original.kind === 'feature' ? cur.original.feature : null
    const move = (dr: number, dw: number, extend = false) => {
      if (!featureRows.length) return
      if (!focus || idx < 0) {
        const start = weeks.indexOf(todayWeek)
        setFocus({ rowId: featureRows[0].id, week: weeks[Math.max(0, start)] })
        return
      }
      const nr = Math.max(0, Math.min(featureRows.length - 1, idx + dr))
      const nw = Math.max(0, Math.min(weeks.length - 1, wIdx + dw))
      const next = { rowId: featureRows[nr].id, week: weeks[nw] }
      setFocus(next)
      if (extend && feature && dr === 0) {
        const s = selectionRef.current
        setSelection(s && s.rowId === next.rowId ? { ...s, head: next.week } : { rowId: next.rowId, featureId: feature.id, anchor: focus.week, head: next.week })
      } else setSelection(null)
      requestAnimationFrame(() =>
        wrapRef.current?.querySelector(`td[data-row="${CSS.escape(next.rowId)}"][data-week="${next.week}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }),
      )
    }
    const k = e.key
    if (k === 'ArrowDown' || k === 'j') return e.preventDefault(), move(1, 0)
    if (k === 'ArrowUp' || k === 'k') return e.preventDefault(), move(-1, 0)
    if (k === 'ArrowLeft' || k === 'h') return e.preventDefault(), move(0, -1, e.shiftKey)
    if (k === 'ArrowRight' || k === 'l') return e.preventDefault(), move(0, 1, e.shiftKey)
    if (k === 'Escape') {
      setSelection(null)
      setCopied(null)
      return
    }
    if (!feature || !focus) return
    const selWeeks = selection && selection.rowId === focus.rowId ? weekRange(selection.anchor, selection.head) : [focus.week]
    const cell = wrapRef.current?.querySelector(`td[data-row="${CSS.escape(focus.rowId)}"][data-week="${focus.week}"]`)
    const r = cell?.getBoundingClientRect()
    if (k === 'Enter') {
      e.preventDefault()
      const x = r ? r.left + r.width / 2 : 200
      const y = r ? r.bottom : 200
      if (selWeeks.length > 1) setPop({ kind: 'range', x, y, featureId: feature.id, weeks: selWeeks })
      else setPop({ kind: 'cell', x, y, featureId: feature.id, week: focus.week })
      return
    }
    if (readOnly) return
    const mod = e.metaKey || e.ctrlKey
    if (mod && k.toLowerCase() === 'c') {
      e.preventDefault()
      copyWeeks(focus.rowId, feature.id, selWeeks)
      return
    }
    if (mod && k.toLowerCase() === 'v') {
      e.preventDefault()
      pasteAt(feature.id, selWeeks[0])
      return
    }
    if (!mod && k.toLowerCase() === 'r') {
      e.preventDefault()
      for (const w of selWeeks) ops.fillFromPrevious(feature.id, w)
      return
    }
    if (k === 'Backspace' || k === 'Delete') {
      e.preventDefault()
      ops.clearCells(feature.id, selWeeks)
    }
  }

  // ⌘C / ⌘V still work while a cell or range editor is open, unless the key is meant for text
  // being typed (an empty "Add person…" box doesn't count).
  const clipKeysRef = useRef<(e: KeyboardEvent) => void>(() => {})
  clipKeysRef.current = (e: KeyboardEvent) => {
    if (readOnly || !pop || (pop.kind !== 'cell' && pop.kind !== 'range')) return
    if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return
    const key = e.key.toLowerCase()
    if (key !== 'c' && key !== 'v') return
    const t = e.target as HTMLElement
    if ((t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) && t.value !== '') return
    const ws = pop.kind === 'cell' ? [pop.week] : pop.weeks
    const r = featureRows.find((x) => x.original.kind === 'feature' && x.original.feature.id === pop.featureId)
    e.preventDefault()
    if (key === 'c') copyWeeks(r?.id ?? '', pop.featureId, ws)
    else pasteAt(pop.featureId, ws[0])
    closePop()
  }
  useEffect(() => {
    if (!pop || (pop.kind !== 'cell' && pop.kind !== 'range')) return
    const h = (e: KeyboardEvent) => clipKeysRef.current(e)
    window.addEventListener('keydown', h, true)
    return () => window.removeEventListener('keydown', h, true)
  }, [pop])

  // ----- popovers -----
  const renderPop = () => {
    if (!pop) return null
    const feature = fullDb.features.find((f) => f.id === pop.featureId)
    if (!feature) return null
    if (pop.kind === 'cell')
      return (
        <CellPopover
          x={pop.x}
          y={pop.y}
          db={fullDb}
          feature={feature}
          week={pop.week}
          readOnly={readOnly}
          hideResigned={hideResigned}
          today={todayISO}
          ops={ops}
          onClose={closePop}
        />
      )
    if (pop.kind === 'range')
      return (
        <RangePopover
          x={pop.x}
          y={pop.y}
          db={fullDb}
          feature={feature}
          weeks={pop.weeks}
          readOnly={readOnly}
          hideResigned={hideResigned}
          today={todayISO}
          ops={ops}
          onClose={() => {
            closePop()
          }}
        />
      )
    // field pickers (src/ui/pickers.tsx — the Status tab opens the same ones)
    const base = { x: pop.x, y: pop.y, db: fullDb, feature, onClose: closePop }
    if (pop.field === 'status') return <StatusPicker {...base} onPick={(status) => ops.patchFeature(feature.id, { status })} />
    if (pop.field === 'customer') return <CustomerPicker {...base} onPick={(customer) => ops.patchFeature(feature.id, { customer })} />
    if (pop.field === 'release') return <ReleasePicker {...base} colorOf={colorOf} onPick={(releaseId) => ops.patchFeature(feature.id, { releaseId })} />
    const [field, label] = PERSON_FIELDS[pop.field]
    return (
      <PersonPicker
        {...base}
        field={field}
        label={label}
        hideResigned={hideResigned}
        today={todayISO}
        onPick={(id) => ops.patchFeature(feature.id, { [field]: id })}
      />
    )
  }

  const tableW = labelW + weeks.length * colW
  return (
    <div className={`grid-outer${resizing ? ' resizing' : ''}${dense ? ' dense' : ''}${bars ? ' bars' : ''}`}>
      <TipLayer ref={tipRef} />
      <div className="grid-wrap" ref={wrapRef} tabIndex={0} onKeyDown={onKeyDown} onMouseOver={onGridOver} onMouseMove={onGridMove} onMouseLeave={onGridLeave}>
        <table className="planner fplan" style={{ width: tableW }}>
          <colgroup>
            <col style={{ width: labelW }} />
            {weeks.map((w) => (
              <col key={w} style={{ width: colW }} />
            ))}
          </colgroup>
          <thead>
            <tr className="month-row">
              <th className="lbl-col" rowSpan={3}>
                <div className="flbl flbl-head">
                  <span className="flbl-name" style={{ width: nameW - 16 }}>
                    <input
                      className="search-input lbl-search"
                      type="search"
                      placeholder="Search packages, features, people…"
                      value={search}
                      onChange={(e) => onSearchChange(e.target.value)}
                    />
                  </span>
                  {fields.map((f) => (
                    <span key={f.id} className={`fcell fhead f-${f.id}`} style={{ width: f.w }} title={f.title}>
                      {f.label}
                    </span>
                  ))}
                </div>
              </th>
              {months.map((g, i) => (
                <th key={g.key} colSpan={g.weeks.length} className={`month-head${i % 2 ? ' alt' : ''}`}>
                  {g.label}
                </th>
              ))}
            </tr>
            <tr className="timeline-row">
              {phaseCells.map((c) =>
                c.kind === 'phase' ? (
                  <th
                    key={c.key}
                    colSpan={c.span}
                    className={timelineClass(c.key, c.span, c.edges)}
                    title={c.title}
                    style={{ ...weekStyle(c.key), ...(c.color ? { '--ph': c.color } : {}) } as React.CSSProperties}
                  >
                    {c.label && <FitLabel text={c.name} />}
                  </th>
                ) : (
                  <th key={c.key} colSpan={c.span} className={timelineClass(c.key, c.span, null)} style={weekStyle(c.key)} />
                ),
              )}
            </tr>
            <tr className="week-row">
              {weeks.map((w) => {
                const ms = msWeeks.get(w) ?? []
                const rel = relWeeks.get(w) ?? []
                // the phase row names these; the week header keeps W## + date
                const tip = [
                  `ISO week ${isoWeekNum(w)} · week of ${w}`,
                  ...rel.map((r) => `🏁 ${r.name} release · ${r.date}`),
                  ...ms.map((m) => `◆ ${m.name} · ${m.date}${m.end ? ` → ${m.end}` : ''}`),
                ].join('\n')
                return (
                  <th key={w} title={tip} className={weekClass(w)} style={weekStyle(w)}>
                    <div className="week-head">
                      <div>{weekTag(w)}</div>
                      {w === todayWeek ? (
                        <div className="week-head-chip"><span className="today-chip">today</span></div>
                      ) : (
                        <div className="week-head-date">{weekLabel(w)}</div>
                      )}
                    </div>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((tr) => (
              <GridRow
                key={tr.id}
                tr={tr}
                isExpanded={tr.getIsExpanded()}
                db={db}
                fullDb={fullDb}
                weeks={weeks}
                colW={colW}
                nameW={nameW}
                fields={fields}
                weekClass={weekClass}
                weekStyle={weekStyle}
                todayISO={todayISO}
                colorOf={colorOf}
                readOnly={readOnly}
                bars={bars}
                showPlanned={showPlanned}
                selection={selection && selection.rowId === tr.id ? selection : null}
                copied={copied && copied.rowId === tr.id ? copied : null}
                focusWeek={focus && focus.rowId === tr.id ? focus.week : null}
                flash={flashRowId === tr.id}
                ops={ops}
                cb={cb}
                onCellDown={onCellDown}
                onCellEnter={onCellEnter}
                onFieldClick={onFieldClick}
              />
            ))}
            {rows.length === 0 && (
              <tr>
                <td className="lbl-col">
                  <div className="flbl"><span className="hint">No features match.</span></div>
                </td>
                {weeks.map((w) => <td key={w} className={weekClass(w)} style={weekStyle(w)} />)}
              </tr>
            )}
          </tbody>
        </table>
        {renderPop()}
      </div>
      <div
        className="col-resizer"
        style={{ left: nameW + 3 }}
        title="Drag to resize the name column · double-click to reset"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        onPointerCancel={onResizeUp}
        onDoubleClick={() => setNameW(NAME_W_DEFAULT)}
      />
    </div>
  )
}

