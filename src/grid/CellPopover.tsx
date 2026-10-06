import { useMemo, useState } from 'react'
import { ALLOC_KINDS, AllocEntry, AllocKind, AWAY_TYPES, AwayEntry, AwayType, DB, Feature, KIND_LABEL, Person, hasLeft, isResigned } from '../types'
import {
  addWeeks,
  availablePct,
  awayPct,
  defaultKindFor,
  fmtDate,
  parseISO,
  peopleById,
  personLoad,
  personShort,
  resignedTitle,
  weekLabel,
  weekTag,
} from '../logic'
import Popover from '../ui/Popover'
import { NoteInput } from '../ui/fields'
import type { FeatureOps } from './FeatureGrid'

/** the share-of-week steps offered on an entry: fifths of a week, and 0 for someone named with no load yet */
const PCTS = [0, 20, 40, 60, 80, 100]
const fridayOf = (weekKey: string) => fmtDate(new Date(parseISO(weekKey).getTime() + 4 * 86400000))

function KindToggle({ kind, onChange, disabled }: { kind: AllocKind; onChange: (k: AllocKind) => void; disabled?: boolean }) {
  return (
    <span className="kind-toggle">
      {ALLOC_KINDS.map((k) => (
        <button key={k} disabled={disabled} className={`k-${k}${kind === k ? ' on' : ''}`} title={KIND_LABEL[k]} onClick={() => onChange(k)}>
          {KIND_LABEL[k][0]}
        </button>
      ))}
    </span>
  )
}

/** Who a picker offers: everyone not excluded, minus leavers already gone when the app-wide switch says so. */
type PickerProps = { db: DB; weeks: string[]; exclude: Set<string>; hideResigned: boolean; today: string }

/** People sorted by how free they are over `weeks` (the least free week counts), with their state. */
function usePeopleByFreedom({ db, weeks, exclude, hideResigned, today }: PickerProps) {
  return useMemo(
    () =>
      db.people
        .filter((p) => !exclude.has(p.id) && !(hideResigned && hasLeft(p, today)))
        .map((p) => {
          let free = Infinity
          let away = 0
          let avail = Infinity
          for (const w of weeks) {
            const a = availablePct(p, w)
            free = Math.min(free, a - personLoad(db, p.id, w).pct)
            avail = Math.min(avail, a)
            away = Math.max(away, awayPct(p, w))
          }
          return { p, free, away, avail }
        })
        .sort((a, b) => b.free - a.free || personShort(a.p).localeCompare(personShort(b.p))),
    [db, weeks, exclude, hideResigned, today],
  )
}

function PersonPicker({ onPick, ...props }: PickerProps & { onPick: (p: Person) => void }) {
  const [q, setQ] = useState('')
  const ranked = usePeopleByFreedom(props)
  // a leaver reads "resigned" rather than "not on the project" once their date falls inside the picked weeks
  const lastDay = fridayOf(props.weeks[props.weeks.length - 1])
  const gone = (p: Person) => !!p.resignedFrom && p.resignedFrom <= lastDay
  const needle = q.trim().toLowerCase()
  const list = ranked.filter(({ p }) => !needle || p.name.toLowerCase().includes(needle) || personShort(p).toLowerCase().includes(needle))
  return (
    <div className="person-picker">
      <input
        className="search-input"
        placeholder="Add person…"
        value={q}
        autoFocus
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && list[0]) onPick(list[0].p)
          if (e.key !== 'Escape') e.stopPropagation()
        }}
      />
      <div className="pick-list">
        {list.map(({ p, free, away, avail }) => (
          <button
            key={p.id}
            className="pick-item person-pick"
            onClick={() => onPick(p)}
            title={`${p.name} · ${p.profile}${isResigned(p) ? `\n${resignedTitle(p)}` : ''}`}
          >
            <b className={isResigned(p) ? 'resigned' : undefined}>{personShort(p)}</b>
            <span className="hint">{defaultKindFor(p) === 'test' ? 'tester' : 'dev'}</span>
            <span className="spacer" />
            {avail <= 0 && away > 0 ? (
              <span className="free away">away</span>
            ) : avail <= 0 && gone(p) ? (
              <span className="free off">resigned</span>
            ) : avail <= 0 ? (
              <span className="free off">not on the project</span>
            ) : (
              <span className={`free ${free < 0 ? 'over' : free === 0 ? 'full' : 'ok'}`}>{free < 0 ? `over ${-Math.round(free)}%` : `free ${Math.round(free)}%`}</span>
            )}
          </button>
        ))}
        {!list.length && <span className="hint">No one matches.</span>}
      </div>
    </div>
  )
}

function SlotButtons({ onAdd }: { onAdd: (kind: AllocKind) => void }) {
  return (
    <div className="slot-buttons">
      <span className="hint">Unnamed slot:</span>
      {ALLOC_KINDS.map((k) => (
        <button key={k} className={`btn small slot-btn k-${k}`} onClick={() => onAdd(k)}>
          + {KIND_LABEL[k]}
        </button>
      ))}
    </div>
  )
}

export function CellPopover({
  x,
  y,
  db,
  feature,
  week,
  readOnly,
  hideResigned,
  today,
  ops,
  onClose,
}: {
  x: number
  y: number
  db: DB
  feature: Feature
  week: string
  readOnly: boolean
  /** the app-wide switch: leavers already gone are not offered */
  hideResigned: boolean
  /** ISO date "has left" is judged against */
  today: string
  ops: FeatureOps
  onClose: () => void
}) {
  const cell = feature.cells[week]
  const entries = cell?.entries ?? []
  const people = peopleById(db)
  const onCell = useMemo(() => new Set(entries.map((e) => e.personId).filter(Boolean) as string[]), [entries])
  const prev = feature.cells[addWeeks(week, -1)]
  const weeks = useMemo(() => [week], [week])
  const [adding, setAdding] = useState(entries.length === 0 && !readOnly)

  const entryRow = (e: AllocEntry) => {
    const pe = e.personId ? people.get(e.personId) : undefined
    const load = pe ? personLoad(db, pe.id, week).pct : 0
    const avail = pe ? availablePct(pe, week) : 0
    return (
      <div key={e.id} className="entry-row">
        <span className={`chip-p k-${e.kind}${pe ? '' : ' slot'}${pe && load > avail ? ' over' : ''}`} title={pe ? `${pe.name} · booked ${load}% of ${avail}% this week` : 'Unnamed slot'}>
          {pe ? personShort(pe) : e.label ?? KIND_LABEL[e.kind]}
        </span>
        {readOnly ? (
          <span className="hint">
            {KIND_LABEL[e.kind]} · {e.pct}%{e.note ? ` · ${e.note}` : ''}
          </span>
        ) : (
          <>
            <KindToggle kind={e.kind} onChange={(k) => ops.patchEntry(feature.id, week, e.id, { kind: k })} />
            <span className="pct-mini">
              {PCTS.map((p) => (
                <button key={p} className={e.pct === p ? 'on' : ''} onClick={() => ops.patchEntry(feature.id, week, e.id, { pct: p })}>
                  {p}%
                </button>
              ))}
            </span>
            <NoteInput key={e.id + (e.note ?? '')} value={e.note ?? ''} placeholder="note" onCommit={(v) => ops.patchEntry(feature.id, week, e.id, { note: v || undefined })} />
            <button className="icon-btn" title="Remove" onClick={() => ops.removeEntry(feature.id, week, e.id)}>✕</button>
          </>
        )}
      </div>
    )
  }

  return (
    <Popover x={x} y={y} onClose={onClose} overlay={false}>
      <div className="cellpop">
        <div className="pop-label">
          <b>{feature.key ?? ''}</b> {feature.name}
          <div className="hint">{weekTag(week)} · week of {weekLabel(week)}</div>
        </div>
        {entries.length === 0 && <p className="hint">Nobody on this feature this week.</p>}
        {entries.map(entryRow)}
        {!readOnly && (
          <>
            {adding ? (
              <>
                <PersonPicker
                  db={db}
                  weeks={weeks}
                  exclude={onCell}
                  hideResigned={hideResigned}
                  today={today}
                  onPick={(p) => {
                    ops.addEntry(feature.id, [week], { personId: p.id, pct: 100, kind: defaultKindFor(p) })
                    setAdding(false)
                  }}
                />
                <SlotButtons
                  onAdd={(k) => {
                    ops.addEntry(feature.id, [week], { personId: null, label: KIND_LABEL[k], pct: 100, kind: k })
                    setAdding(false)
                  }}
                />
              </>
            ) : (
              <button className="btn small ghost" onClick={() => setAdding(true)}>+ Add person or slot</button>
            )}
            <NoteInput key={cell?.note ?? ''} multiline value={cell?.note ?? ''} placeholder="Cell note (not tied to anyone) — e.g. waiting on clarifications" onCommit={(v) => ops.setCellNote(feature.id, week, v)} />
            <div className="pop-actions">
              <button className="btn small" disabled={!prev?.entries.length} title="Replace this week with a copy of the previous week (R)" onClick={() => ops.fillFromPrevious(feature.id, week)}>
                Same as last week
              </button>
              <span className="spacer" />
              <button className="btn small danger" disabled={!entries.length && !cell?.note} onClick={() => ops.clearCells(feature.id, [week])}>
                Clear
              </button>
            </div>
          </>
        )}
        {readOnly && cell?.note && <p className="hint">Note: {cell.note}</p>}
      </div>
    </Popover>
  )
}

export function RangePopover({
  x,
  y,
  db,
  feature,
  weeks,
  readOnly,
  hideResigned,
  today,
  ops,
  onClose,
}: {
  x: number
  y: number
  db: DB
  feature: Feature
  weeks: string[]
  readOnly: boolean
  /** the app-wide switch: leavers already gone are not offered */
  hideResigned: boolean
  /** ISO date "has left" is judged against */
  today: string
  ops: FeatureOps
  onClose: () => void
}) {
  const empty = useMemo(() => new Set<string>(), [])
  const [pct, setPct] = useState(100)
  const n = weeks.length
  const label = `${weekTag(weeks[0])}–${weekTag(weeks[n - 1])}`
  const booked = weeks.reduce((m, w) => m + (feature.cells[w]?.entries.length ?? 0), 0)
  return (
    <Popover x={x} y={y} onClose={onClose} overlay={false}>
      <div className="cellpop">
        <div className="pop-label">
          <b>{feature.key ?? ''}</b> {feature.name}
          <div className="hint">
            {label} · {n} weeks · {booked} allocation{booked === 1 ? '' : 's'}
          </div>
        </div>
        {readOnly ? (
          <p className="hint">Read-only.</p>
        ) : (
          <>
            <div className="pop-section">
              <div className="pop-label">Add to all {n} weeks at</div>
              <span className="pct-mini">
                {PCTS.map((p) => (
                  <button key={p} className={pct === p ? 'on' : ''} onClick={() => setPct(p)}>
                    {p}%
                  </button>
                ))}
              </span>
            </div>
            <PersonPicker
              db={db}
              weeks={weeks}
              exclude={empty}
              hideResigned={hideResigned}
              today={today}
              onPick={(p) => {
                ops.addEntry(feature.id, weeks, { personId: p.id, pct, kind: defaultKindFor(p) })
                onClose()
              }}
            />
            <SlotButtons
              onAdd={(k) => {
                ops.addEntry(feature.id, weeks, { personId: null, label: KIND_LABEL[k], pct, kind: k })
                onClose()
              }}
            />
            <div className="pop-actions">
              <button
                className="btn small"
                title="Copy these weeks (paste with ⌘V on another cell)"
                onClick={() => {
                  ops.copyCells(feature.id, weeks)
                  onClose()
                }}
              >
                Copy
              </button>
              <button
                className="btn small"
                disabled={!feature.cells[weeks[0]]?.entries.length}
                title="Repeat the first week's people across the rest of the range"
                onClick={() => {
                  for (const w of weeks.slice(1)) ops.fillFromPrevious(feature.id, w)
                  onClose()
                }}
              >
                Repeat first week
              </button>
              <span className="spacer" />
              <button
                className="btn small danger"
                disabled={!booked}
                onClick={() => {
                  ops.clearCells(feature.id, weeks)
                  onClose()
                }}
              >
                Clear {n} weeks
              </button>
            </div>
          </>
        )}
      </div>
    </Popover>
  )
}

export function PersonWeekPopover({
  x,
  y,
  db,
  person,
  week,
  readOnly,
  onClose,
  onFocusFeature,
  onMarkAway,
  onEdit,
}: {
  x: number
  y: number
  db: DB
  person: Person
  week: string
  readOnly: boolean
  onClose: () => void
  onFocusFeature: (featureId: string) => void
  onMarkAway: (entry: AwayEntry) => void
  onEdit: () => void
}) {
  const [type, setType] = useState<AwayType>('Vacation')
  const load = personLoad(db, person.id, week)
  const avail = availablePct(person, week)
  const lines = db.features
    .map((f) => ({ f, entries: (f.cells[week]?.entries ?? []).filter((e) => e.personId === person.id) }))
    .filter((x) => x.entries.length)
  return (
    <Popover x={x} y={y} onClose={onClose} overlay={false}>
      <div className="cellpop">
        <div className="pop-label">
          <b>{person.name}</b> · {weekTag(week)} ({weekLabel(week)})
          <div className={`hint${load.pct > avail ? ' err' : ''}`}>
            Booked {Math.round(load.pct)}% of {avail}% available{awayPct(person, week) ? ` · away ${awayPct(person, week)}%` : ''}
          </div>
        </div>
        {lines.length === 0 && <p className="hint">Not on any feature this week.</p>}
        <div className="pick-list">
          {lines.map(({ f, entries }) => (
            <button key={f.id} className="pick-item" title="Show this feature in the grid" onClick={() => onFocusFeature(f.id)}>
              <span className="jira-key">{f.key ?? ''}</span>
              <span className="pick-name">{f.name}</span>
              <span className="spacer" />
              {entries.map((e) => (
                <span key={e.id} className={`chip-p k-${e.kind}`}>
                  {KIND_LABEL[e.kind]}
                  {e.pct !== 100 ? ` ${e.pct}%` : ''}
                </span>
              ))}
            </button>
          ))}
        </div>
        {!readOnly && (
          <div className="pop-section">
            <div className="pop-label">Away time</div>
            <div className="pop-away">
              <select value={type} onChange={(e) => setType(e.target.value as AwayType)}>
                {AWAY_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              <button className="btn small" onClick={() => onMarkAway({ start: week, end: fridayOf(week), type })}>
                Mark away this week
              </button>
              <button className="btn small" onClick={onEdit}>Edit person…</button>
            </div>
          </div>
        )}
      </div>
    </Popover>
  )
}
