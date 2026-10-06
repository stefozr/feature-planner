import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { DB, Epic, Feature, FeatureTracking, Story, Trackable, isBlockedStatus } from '../types'
import { fmtNum, peopleById, uid, weekLabel, weekTag } from '../logic'
import { PersonCell, PersonPicker, StatusPicker, StatusTag } from '../ui/pickers'
import type { FeatureOps } from '../grid/FeatureGrid'
import Popover from '../ui/Popover'
import { NumberInput, TextInput, WeekInput } from '../ui/fields'
import { useTip } from '../ui/useTip'
import { useConfirm } from '../ui/ConfirmDialog'
import { HOUR_COLUMNS, TEXT_COLUMNS, budgetHours, sumHours, type HourKey, type HourTotals, type TextKey } from './tracking'
import './status.css'

interface Props {
  db: DB
  /** the features to list — already through the app's filters; a package shows only when one of its features does */
  features: Feature[]
  /** a search is on: everything opens, so a hit inside a collapsed row is never hidden */
  searching: boolean
  todayISO: string
  hideResigned: boolean
  readOnly: boolean
  ops: FeatureOps
  /** the feature's dialog (the ⓘ button) */
  onOpenFeature: (id: string) => void
  /** the row in the planner — a history entry, so Back returns here */
  onGoFeature: (id: string) => void
  onGoEpic: (id: string) => void
  /** the packages and features folded shut (App keeps it, so the toolbar stepper and the carets share one state) */
  closed: string[]
  onSetClosed: (id: string, closed: boolean) => void
}

/** which record a cell belongs to: a feature row or a story row */
type Kind = 'feature' | 'story'
type PopCol = 'status' | 'lead' | 'deadline' | TextKey
type Pop = { x: number; y: number; kind: Kind; id: string; col: PopCol }

const anchor = (e: React.MouseEvent): { x: number; y: number } => {
  const r = e.currentTarget.getBoundingClientRect()
  return { x: r.left, y: r.bottom - 8 }
}

const hours = (v: number | null | undefined) => (v == null ? '—' : fmtNum(v))
const negClass = (v: number | null | undefined) => (v != null && v < 0 ? 'neg' : '')
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export default function StatusView({ db, features, searching, todayISO, hideResigned, readOnly, ops, onOpenFeature, onGoFeature, onGoEpic, closed, onSetClosed }: Props) {
  const s = db.settings
  const people = peopleById(db)
  const { attach, hide: hideTip, element: tipEl } = useTip()
  const { ask: confirm, ui: confirmUI } = useConfirm()
  const closedSet = useMemo(() => new Set(closed), [closed])
  const [pop, setPop] = useState<Pop | null>(null)
  const closePop = () => setPop(null)
  /** the feature whose "new story" row is open */
  const [adding, setAdding] = useState<string | null>(null)

  const groups = useMemo(() => {
    const byEpic = new Map<string, Feature[]>()
    for (const f of features) (byEpic.get(f.epicId) ?? byEpic.set(f.epicId, []).get(f.epicId)!).push(f)
    return db.epics.map((e) => ({ e, fs: byEpic.get(e.id) ?? [] })).filter((g) => g.fs.length)
  }, [db.epics, features])
  const storiesByFeature = useMemo(() => {
    const m = new Map<string, Story[]>()
    for (const st of db.stories) (m.get(st.featureId) ?? m.set(st.featureId, []).get(st.featureId)!).push(st)
    return m
  }, [db.stories])
  const storiesOf = (f: Feature) => storiesByFeature.get(f.id) ?? []
  const total = sumHours(features)

  const openPop = (kind: Kind, id: string, col: PopCol) => (e: React.MouseEvent) => {
    hideTip()
    setPop({ ...anchor(e), kind, id, col })
  }

  // ----- cells -----
  // a feature row and a story row edit the same columns; only the op they go through differs
  const patchOf = (kind: Kind, id: string) => (p: Partial<Trackable>) => (kind === 'story' ? ops.patchStory(id, p) : ops.patchFeature(id, p))
  const patchTrackingOf = (kind: Kind, id: string) => (p: Partial<FeatureTracking>) => (kind === 'story' ? ops.patchStoryTracking(id, p) : ops.patchTracking(id, p))
  // the planner's own fields render through src/ui/pickers.tsx, the same as in the Planner tab
  const pick = (kind: Kind, t: Trackable, col: PopCol) => (readOnly ? undefined : openPop(kind, t.id, col))
  const statusCell = (kind: Kind, t: Trackable) => <StatusTag status={t.status} colors={s.optionColors} onClick={pick(kind, t, 'status')} />
  const leadCell = (kind: Kind, t: Trackable) => (
    <PersonCell person={t.leadId ? people.get(t.leadId) : undefined} setLabel={`Set the assignee (${kind} lead)`} onClick={pick(kind, t, 'lead')} />
  )
  /** `lockedBy` > 0: the figure is the sum of that many stories and cannot be typed over */
  const hourCell = (kind: Kind, t: Trackable, key: HourKey, lockedBy = 0) => {
    const col = HOUR_COLUMNS.find((c) => c.key === key)!
    if (lockedBy) {
      return (
        <span className="sv-sum" title={`Sum of ${plural(lockedBy, 'story', 'stories')} — edit the stories below`}>
          {hours(t[key])}
        </span>
      )
    }
    return readOnly ? <span>{hours(t[key])}</span> : <NumberInput value={t[key]} title={`${col.label} — click to update`} onCommit={(v) => patchOf(kind, t.id)({ [key]: v })} />
  }
  const budgetCell = (t: Trackable) => {
    const b = budgetHours(t)
    return (
      <span className={negClass(b)} title="Original estimate − logged − remaining">
        {hours(b)}
      </span>
    )
  }
  const deadlineText = (w: string | undefined) => (w ? `${weekTag(w)} · ${weekLabel(w)}` : undefined)
  const deadlineCell = (kind: Kind, t: Trackable) => {
    const text = deadlineText(t.deadline)
    if (readOnly) return <span className="sv-week">{text ?? '—'}</span>
    return (
      <button className="cell-btn sv-week" title={t.deadline ? `Due the week of ${t.deadline} — click to change` : 'Set a deadline'} onClick={openPop(kind, t.id, 'deadline')}>
        {text ?? <span className="muted-dash">—</span>}
      </button>
    )
  }
  const textCell = (kind: Kind, t: Trackable, key: TextKey) => {
    const v = t.tracking?.[key] ?? ''
    const tip = v ? attach(<span style={{ whiteSpace: 'pre-line' }}>{v}</span>) : {}
    if (readOnly) return v ? <span className="sv-text" {...tip}>{v}</span> : <span className="muted-dash">—</span>
    return (
      <button className={`sv-text${v ? '' : ' empty'}`} {...tip} onClick={openPop(kind, t.id, key)}>
        {v || '—'}
      </button>
    )
  }
  /** the columns after the description: status, assignee, hours, budget, deadline, notes */
  const valueCells = (kind: Kind, t: Trackable, lockedBy = 0) => (
    <>
      <td {...pin(1)}>{statusCell(kind, t)}</td>
      <td {...pin(2)}>{leadCell(kind, t)}</td>
      {HOUR_COLUMNS.map((c) => (
        <td key={c.key} className="num">
          {hourCell(kind, t, c.key, lockedBy)}
        </td>
      ))}
      <td className="num">{budgetCell(t)}</td>
      <td>{deadlineCell(kind, t)}</td>
      {TEXT_COLUMNS.map((c) => (
        <td key={c.key}>{textCell(kind, t, c.key)}</td>
      ))}
    </>
  )

  // ----- the open popover -----
  const renderPop = () => {
    if (!pop) return null
    const t: Trackable | undefined = pop.kind === 'story' ? db.stories.find((x) => x.id === pop.id) : db.features.find((x) => x.id === pop.id)
    if (!t) return null
    const who = t.key ?? t.name
    const patch = patchOf(pop.kind, t.id)
    // the planner's own fields: the same pickers the Planner tab opens (src/ui/pickers.tsx)
    const base = { x: pop.x, y: pop.y, db, feature: t, onClose: closePop }
    if (pop.col === 'status') return <StatusPicker {...base} onPick={(status) => patch({ status })} />
    if (pop.col === 'lead')
      return <PersonPicker {...base} field="leadId" label={`Assignee (${pop.kind} lead)`} hideResigned={hideResigned} today={todayISO} onPick={(leadId) => patch({ leadId })} />
    if (pop.col === 'deadline')
      return (
        <Popover x={pop.x} y={pop.y} onClose={closePop}>
          <div className="pop-label">Deadline · {who}</div>
          <WeekInput
            value={t.deadline}
            onChange={(v) => {
              patch({ deadline: v })
              if (v) closePop()
            }}
          />
          {t.deadline && (
            <button
              className="btn small ghost"
              onClick={() => {
                patch({ deadline: undefined })
                closePop()
              }}
            >
              Clear
            </button>
          )}
        </Popover>
      )
    const textCol = TEXT_COLUMNS.find((c) => c.key === pop.col)
    if (!textCol) return null
    return (
      <TextPopover
        x={pop.x}
        y={pop.y}
        label={`${textCol.label} · ${who}`}
        value={t.tracking?.[textCol.key] ?? ''}
        onCommit={(v) => patchTrackingOf(pop.kind, t.id)({ [textCol.key]: v || undefined } as Partial<FeatureTracking>)}
        onClose={closePop}
      />
    )
  }

  // Description, Status and Assignee stay put while the rest scrolls: each pinned cell's `left` is
  // the width of the pinned cells before it, so the offsets follow the column widths.
  const HOUR_W: Record<HourKey, number> = { estimate: 120, logged: 80, remaining: 96 }
  const widths = [380, 120, 100, ...HOUR_COLUMNS.map((c) => HOUR_W[c.key]), 80, 120, ...TEXT_COLUMNS.map((c) => (c.wide ? 300 : 210))]
  const PINNED = 3
  const pin = (i: number): { className: string; style: React.CSSProperties } => ({
    className: `sv-pin${i === PINNED - 1 ? ' last' : ''}`,
    style: { left: widths.slice(0, i).reduce((a, b) => a + b, 0) },
  })

  /** the four hour cells of a total row: `—` while nothing is filled in, the budget red when negative */
  const totalCells = (t: HourTotals, title: string) =>
    (['estimate', 'logged', 'remaining', 'budget'] as const).map((k) => (
      <td key={k} className={`num ${k === 'budget' && t.n ? negClass(t.budget) : ''}`} title={title}>
        {t.n ? fmtNum(t[k]) : '—'}
      </td>
    ))

  const caret = (id: string, open: boolean) => (
    <button className="caret" aria-label={open ? 'Collapse' : 'Expand'} onClick={() => onSetClosed(id, open)}>
      {open ? '▾' : '▸'}
    </button>
  )

  const epicRow = (e: Epic, fs: Feature[], open: boolean) => {
    const t = sumHours(fs)
    return (
      <tr key={e.id} className="sv-epic">
        <td {...pin(0)}>
          <span className="sv-desc">
            {caret(e.id, open)}
            {e.key && <span className="jira-key">{e.key}</span>}
            <button className="sv-link sv-name" title="Show this package in the planner" onClick={() => onGoEpic(e.id)}>
              {e.name}
            </button>
            <span className="sv-count">{plural(fs.length, 'feature', 'features')}</span>
          </span>
        </td>
        <td {...pin(1)} />
        <td {...pin(2)} />
        {totalCells(t, t.n ? `Sum over ${t.n} of ${plural(fs.length, 'feature', 'features')} with hours` : 'No feature has hours yet')}
        <td colSpan={1 + TEXT_COLUMNS.length} />
      </tr>
    )
  }

  const startAdding = (f: Feature) => {
    onSetClosed(f.id, false)
    setAdding(f.id)
  }

  const featureRow = (f: Feature, stories: Story[], open: boolean) => (
    <tr key={f.id} className={`sv-feature${isBlockedStatus(f.status) ? ' blocked' : ''}`}>
      <td {...pin(0)}>
        <span className="sv-desc">
          {stories.length ? caret(f.id, open) : <span className="caret-spacer" />}
          {f.key && <span className="jira-key">{f.key}</span>}
          <button className="sv-link sv-name" title={`${f.name}\nClick to see it in the planner`} onClick={() => onGoFeature(f.id)}>
            {f.name}
          </button>
          {stories.length > 0 && <span className="sv-count">{plural(stories.length, 'story', 'stories')}</span>}
          <button className="sv-info" title="Details" onClick={() => onOpenFeature(f.id)}>
            ⓘ
          </button>
          {!readOnly && (
            <button className="mini-btn sv-add" title="Add a story under this feature" onClick={() => startAdding(f)}>
              + Story
            </button>
          )}
        </span>
      </td>
      {valueCells('feature', f, stories.length)}
    </tr>
  )

  const deleteStory = async (st: Story, f: Feature) => {
    const ok = await confirm({
      title: 'Delete story',
      message: `Delete “${st.name}”?\nIt leaves ${f.key ?? f.name}, and its hours leave the feature's total.`,
      confirmLabel: 'Delete',
    })
    if (ok) ops.removeStory(st.id)
  }

  const storyRow = (st: Story, f: Feature) => (
    <tr key={st.id} className={`sv-story${isBlockedStatus(st.status) ? ' blocked' : ''}`}>
      <td {...pin(0)}>
        <span className="sv-desc">
          {readOnly ? (
            <>
              {st.key && <span className="jira-key">{st.key}</span>}
              <span className="sv-name" title={st.name}>
                {st.name}
              </span>
            </>
          ) : (
            <>
              <TextInput className="jira-key sv-key" value={st.key} title="Jira key — click to change" placeholder="key" onCommit={(v) => ops.patchStory(st.id, { key: v })} />
              <TextInput className="sv-name" value={st.name} title={`${st.name}\nClick to rename`} onCommit={(v) => v && ops.patchStory(st.id, { name: v })} />
              <button className="sv-del" title="Delete this story" onClick={() => deleteStory(st, f)}>
                ✕
              </button>
            </>
          )}
        </span>
      </td>
      {valueCells('story', st)}
    </tr>
  )

  const newStoryRow = (f: Feature) => (
    <tr key={`${f.id}:new`} className="sv-story sv-new">
      <td {...pin(0)}>
        <span className="sv-desc">
          <NewStoryInput
            onAdd={(name) => ops.addStory({ id: uid(), featureId: f.id, name })}
            onClose={() => setAdding((cur) => (cur === f.id ? null : cur))}
          />
        </span>
      </td>
      <td {...pin(1)} />
      <td {...pin(2)} />
      <td colSpan={widths.length - PINNED} className="hint">
        Enter adds the story and keeps the box open for the next · Esc closes it
      </td>
    </tr>
  )

  return (
    <div className="sv">
      <div className="sv-bar">
        <h2>Status</h2>
        <span className="hint">
          Hours, budget, deadline and notes per feature, as in the tracking sheet, with stories under a feature when it has them. Click a value to change it; click a name to see it in the planner, Back
          brings you here.
        </span>
        <span className="spacer" />
        <span className="sv-total" title={`Sums over all ${features.length} listed features (${total.n} with hours). Budget = estimate − logged − remaining.`}>
          Total project · Estimate <b>{fmtNum(total.estimate)}h</b> · Logged <b>{fmtNum(total.logged)}h</b> · Remaining <b>{fmtNum(total.remaining)}h</b> · Budget{' '}
          <b className={negClass(total.budget)}>{fmtNum(total.budget)}h</b>
        </span>
      </div>
      <div className="sv-wrap">
        {groups.length === 0 ? (
          <div className="sv-empty">No features match the current filters.</div>
        ) : (
          <table className="sv-table" style={{ width: widths.reduce((a, b) => a + b, 0) }}>
            <colgroup>
              {widths.map((w, i) => (
                <col key={i} style={{ width: w }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th {...pin(0)}>Description</th>
                <th {...pin(1)}>Status</th>
                <th {...pin(2)}>Assignee</th>
                {HOUR_COLUMNS.map((c) => (
                  <th key={c.key} className="num" title={c.hint}>
                    {c.label}
                  </th>
                ))}
                <th className="num" title="Original estimate − logged − remaining; red when over budget">
                  Budget (h)
                </th>
                <th title="The week the feature or story is due by">Deadline</th>
                {TEXT_COLUMNS.map((c) => (
                  <th key={c.key} title={c.hint}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map(({ e, fs }) => {
                const open = searching || !closedSet.has(e.id)
                return (
                  <Fragment key={e.id}>
                    {epicRow(e, fs, open)}
                    {open &&
                      fs.map((f) => {
                        const stories = storiesOf(f)
                        const fOpen = searching || !closedSet.has(f.id)
                        return (
                          <Fragment key={f.id}>
                            {featureRow(f, stories, fOpen)}
                            {fOpen && stories.map((st) => storyRow(st, f))}
                            {fOpen && adding === f.id && !readOnly && newStoryRow(f)}
                          </Fragment>
                        )
                      })}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
      {renderPop()}
      {tipEl}
      {confirmUI}
    </div>
  )
}

/** The "new story" box: Enter adds and clears for the next name, Esc or leaving it empty closes it. */
function NewStoryInput({ onAdd, onClose }: { onAdd: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState('')
  return (
    <input
      className="sv-new-input"
      autoFocus
      value={name}
      placeholder="Story name"
      onChange={(e) => setName(e.target.value)}
      onBlur={() => {
        if (!name.trim()) onClose()
      }}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter' && name.trim()) {
          onAdd(name.trim())
          setName('')
        }
        if (e.key === 'Escape') onClose()
      }}
    />
  )
}

/**
 * The free-text editor: Save / Enter / clicking outside commit, Esc cancels. Esc reaches this
 * window listener before the Popover's own (a child's effect subscribes first), so the close that
 * follows knows not to save.
 */
function TextPopover({ x, y, label, value, onCommit, onClose }: { x: number; y: number; label: string; value: string; onCommit: (v: string) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(value)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const cancelled = useRef(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelled.current = true
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  const save = () => {
    if (draftRef.current.trim() !== value.trim()) onCommit(draftRef.current.trim())
    onClose()
  }
  const close = () => (cancelled.current ? onClose() : save())
  return (
    <Popover x={x} y={y} onClose={close}>
      <div className="sv-textpop">
        <div className="pop-label">{label}</div>
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              save()
            }
            if (e.key !== 'Escape') e.stopPropagation()
          }}
        />
        <div className="sv-textpop-foot">
          <span className="hint">Enter saves · Shift+Enter for a new line · Esc cancels</span>
          <span className="spacer" />
          <button
            className="btn small"
            onClick={() => {
              cancelled.current = true
              onClose()
            }}
          >
            Cancel
          </button>
          <button className="btn small primary" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </Popover>
  )
}
