import { useState } from 'react'
import { DB, Epic, Feature, GanttItem, isFinishedStatus, isResigned, Milestone, Release, ROADMAP_STATUSES, RoadmapBar, RoadmapStatus } from '../types'
import { addWeeks, deleteUndefined, derivedEndWeek, derivedStartWeek, featureBalance, featureHours, featureProgress, fmtDate, fmtNum, mondayOf, personShort, pickablePeople, SCHEDULE_LABEL, scheduleDelta, scheduleStatus, uid, weekTag, workedWeeks } from '../logic'
import { budgetHours } from '../status/tracking'
import { WeekInput } from './fields'
import { barShape, statusColor } from '../gantt/bars'
import { LinksEditor, Modal, OptionSelect } from './Dialogs'
import { MarkdownField } from './MarkdownField'
import { useConfirm } from './ConfirmDialog'
import { PRESET_COLORS } from '../theme'

/**
 * Four preset swatches (yellow, red, green, blue) plus a custom one that opens the native colour
 * picker; `fallback` is what an unset colour paints as.
 */
function ColorSwatches({ value, fallback, onChange, title }: { value: string | undefined; fallback: string; onChange: (hex: string) => void; title?: string }) {
  const cur = (value ?? fallback).toLowerCase()
  const preset = PRESET_COLORS.some((c) => c.hex === cur)
  return (
    <span className="swatches" title={title}>
      {PRESET_COLORS.map((c) => (
        <button
          key={c.hex}
          type="button"
          className={`swatch${cur === c.hex ? ' sel' : ''}`}
          style={{ background: c.hex }}
          title={c.name}
          aria-label={c.name}
          aria-pressed={cur === c.hex}
          onClick={() => onChange(c.hex)}
        />
      ))}
      <label className={`swatch custom${preset ? '' : ' sel'}`} style={preset ? undefined : { background: cur }} title="Custom colour…">
        <input type="color" value={cur} onChange={(e) => onChange(e.target.value)} />
      </label>
    </span>
  )
}

const numOrUndef = (s: string): number | undefined => {
  const t = s.trim().replace(',', '.')
  if (!t) return undefined
  const n = Number(t)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

export function newFeatureDraft(db: DB, epicId: string): Feature {
  return { id: uid(), epicId, name: '', status: db.settings.featureStatuses[0] ?? 'New', cells: {} }
}

export function FeatureDialog({
  db,
  feature,
  create,
  readOnly,
  hideResigned = false,
  onSave,
  onDelete,
  onClose,
}: {
  db: DB
  feature: Feature
  create?: boolean
  readOnly?: boolean
  /** the app-wide switch: leavers already gone are not offered as lead, buddy or test lead (the current one stays) */
  hideResigned?: boolean
  onSave: (f: Feature) => void
  onDelete?: () => void
  onClose: () => void
}) {
  const { ask: confirm, ui: confirmUI } = useConfirm()
  const [d, setD] = useState<Feature>(() => structuredClone(feature))
  const [est, setEst] = useState(feature.estimate == null ? '' : String(feature.estimate))
  const [rem, setRem] = useState(feature.remaining == null ? '' : String(feature.remaining))
  const [log, setLog] = useState(feature.logged == null ? '' : String(feature.logged))
  const patch = (p: Partial<Feature>) => setD((x) => ({ ...x, ...p }))
  const s = db.settings
  const today = fmtDate(new Date())
  const people = pickablePeople(db.people, { hideResigned, today, keep: [d.leadId, d.buddyId, d.testLeadId] })
  const merged: Feature = { ...d, estimate: numOrUndef(est), logged: numOrUndef(log), remaining: numOrUndef(rem) }
  const hrs = featureHours(merged, s)
  const prog = featureProgress(merged)
  const bal = featureBalance(merged, s)
  const budget = budgetHours(merged)
  const worked = workedWeeks(merged)
  const sched = scheduleStatus(merged, today)
  const schedSentence = !sched
    ? 'Set the planned start and end to track the schedule.'
    : sched.overdue
      ? `Planned to end ${weekTag(sched.plannedEnd)}; still open, ${sched.weeks} week${sched.weeks === 1 ? '' : 's'} past it.`
      : `Planned to end ${weekTag(sched.plannedEnd)}, ${sched.finished ? 'finished' : 'now expected'} ${weekTag(sched.actualEnd)}.`
  const storyCount = db.stories.filter((st) => st.featureId === feature.id).length
  const valid = !!d.name.trim() && !!d.epicId
  const personSelect = (value: string | undefined, onChange: (v: string | undefined) => void) => (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
      <option value="">—</option>
      {people.map((p) => (
        <option key={p.id} value={p.id}>
          {personShort(p)} · {p.name}{isResigned(p) ? ' (resigned)' : ''}
        </option>
      ))}
    </select>
  )
  const save = () => {
    onSave(deleteUndefined({ ...merged, name: d.name.trim(), key: d.key?.trim() || undefined }))
    onClose()
  }
  return (
    <Modal title={create ? 'New feature' : `${d.key ? d.key + ' · ' : ''}${feature.name}`} onClose={onClose} wide storageKey="feature">
      <fieldset disabled={readOnly} className="ro-body">
        <div className="form-grid">
          <label className="field">
            Jira key
            <input value={d.key ?? ''} placeholder="PROJ-123" onChange={(e) => patch({ key: e.target.value })} />
          </label>
          <label className="field span2">
            Name
            <input value={d.name} autoFocus={create} placeholder="Feature name" onChange={(e) => patch({ name: e.target.value })} />
          </label>
          <label className="field">
            Package
            <select value={d.epicId} onChange={(e) => patch({ epicId: e.target.value })}>
              {db.epics.map((ep) => (
                <option key={ep.id} value={ep.id}>
                  {ep.key ? `${ep.key} · ` : ''}
                  {ep.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Status
            <OptionSelect value={d.status ?? ''} options={s.featureStatuses} onChange={(v) => patch({ status: v })} />
          </label>
          <label className="field">
            Target release
            <select value={d.releaseId ?? ''} onChange={(e) => patch({ releaseId: e.target.value || undefined })}>
              <option value="">—</option>
              {db.releases.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                  {r.label ? ` (${r.label})` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Feature lead
            {personSelect(d.leadId, (v) => patch({ leadId: v }))}
          </label>
          <label className="field">
            Feature buddy
            {personSelect(d.buddyId, (v) => patch({ buddyId: v }))}
          </label>
          <label className="field">
            Test lead
            {personSelect(d.testLeadId, (v) => patch({ testLeadId: v }))}
          </label>
          <label className="field">
            Customer
            <select value={d.customer ?? ''} onChange={(e) => patch({ customer: e.target.value || undefined })}>
              <option value="">—</option>
              {[...s.customers, ...(d.customer && !s.customers.includes(d.customer) ? [d.customer] : [])].map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Deadline
            <WeekInput value={d.deadline} onChange={(v) => patch({ deadline: v })} />
          </label>
          <label className="field">
            Estimate (h)
            <input value={est} inputMode="decimal" disabled={storyCount > 0} onChange={(e) => setEst(e.target.value)} />
          </label>
          <label className="field">
            Logged (h)
            <input value={log} inputMode="decimal" disabled={storyCount > 0} onChange={(e) => setLog(e.target.value)} />
          </label>
          <label className="field">
            Remaining (h)
            <input value={rem} inputMode="decimal" disabled={storyCount > 0} onChange={(e) => setRem(e.target.value)} />
          </label>
          {storyCount > 0 && (
            <div className="hint span3">
              The hours are the sum of its {storyCount} stor{storyCount === 1 ? 'y' : 'ies'} — edit them in the Status tab.
            </div>
          )}
        </div>
        <div className="sched-block">
          <div className="sched-head">
            <span className="section-title">Schedule</span>
            {sched ? (
              <span className={`sched ${sched.status}`}>
                {SCHEDULE_LABEL[sched.status]}
                {sched.weeks !== 0 && <b>&nbsp;{scheduleDelta(sched.weeks)}</b>}
              </span>
            ) : (
              <span className="hint">no planned end yet</span>
            )}
            <span className="hint">{schedSentence}</span>
          </div>
          <div className="sched-rows">
            <span className="sched-row-label">Original plan</span>
            <label className="field">
              Planned start
              <WeekInput value={d.planStart} onChange={(v) => patch({ planStart: v })} />
            </label>
            <label className="field">
              Planned end
              <WeekInput value={d.planEnd} onChange={(v) => patch({ planEnd: v })} />
            </label>
            {!readOnly && (
              <button
                type="button"
                className="btn small ghost"
                disabled={!derivedStartWeek(merged) && !derivedEndWeek(merged)}
                title="Copy the current start / end into the plan"
                onClick={() => patch({ planStart: derivedStartWeek(merged), planEnd: derivedEndWeek(merged) })}
              >
                Set plan from current
              </button>
            )}
          </div>
          <div className="sched-rows">
            <span className="sched-row-label">Actual</span>
            <label className="field">
              Start
              <WeekInput value={d.startWeek} onChange={(v) => patch({ startWeek: v })} />
            </label>
            <label className="field">
              End
              <WeekInput value={d.endWeek} onChange={(v) => patch({ endWeek: v })} />
            </label>
          </div>
          {(!d.startWeek || !d.endWeek) && worked[0] && (
            <p className="hint">
              Empty actual start / end follow the booked weeks (now {weekTag(worked[0])}–{weekTag(worked[worked.length - 1])}).
            </p>
          )}
        </div>
        <div className="feature-stats">
          <span>
            Progress <b>{prog == null ? '—' : `${Math.round(prog * 100)}%`}</b>
            {isFinishedStatus(d.status) && <span className="hint"> (Finished)</span>}
          </span>
          <span>
            Estimate <b>{merged.estimate ?? '—'}h</b>
          </span>
          <span title={`dev ${fmtNum(hrs.dev)}h · test ${fmtNum(hrs.test)}h · buffer ${fmtNum(hrs.buffer)}h`}>
            Booked <b>{fmtNum(hrs.total)}h</b> over {worked.length} week{worked.length === 1 ? '' : 's'}
          </span>
          <span title="Estimate − booked hours">
            Balance <b className={bal != null && bal < 0 ? 'neg' : ''}>{bal == null ? '—' : `${Math.round(bal)}h`}</b>
          </span>
          <span title="Estimate − logged − remaining">
            Budget <b className={budget != null && budget < 0 ? 'neg' : ''}>{budget == null ? '—' : `${fmtNum(budget)}h`}</b>
          </span>
        </div>
        <MarkdownField label="Description" value={d.description ?? ''} onChange={(v) => patch({ description: v || undefined })} readOnly={readOnly} />
        <LinksEditor links={d.links ?? []} categories={s.linkCategories} onChange={(links) => patch({ links })} />
      </fieldset>
      <div className="modal-actions">
        {!create && onDelete && !readOnly && (
          <button
            className="btn danger"
            onClick={async () => {
              const n = Object.values(feature.cells).reduce((m, c) => m + c.entries.length, 0)
              const parts = [n ? `${n} week allocation${n === 1 ? '' : 's'}` : '', storyCount ? `${storyCount} stor${storyCount === 1 ? 'y' : 'ies'}` : ''].filter(Boolean)
              const ok = await confirm({
                title: 'Delete feature',
                message: `Delete “${feature.name}”?${parts.length ? `\nRemoves ${parts.join(' and ')}.` : ''}`,
                confirmLabel: 'Delete',
              })
              if (!ok) return
              onDelete()
              onClose()
            }}
          >
            Delete
          </button>
        )}
        <span className="spacer" />
        <button className="btn" onClick={onClose}>{readOnly ? 'Close' : 'Cancel'}</button>
        {!readOnly && (
          <button className="btn primary" disabled={!valid} onClick={save}>
            {create ? 'Add feature' : 'Save'}
          </button>
        )}
      </div>
      {confirmUI}
    </Modal>
  )
}

export function EpicDialog({
  epic,
  create,
  featureCount,
  storyCount = 0,
  readOnly,
  onSave,
  onDelete,
  onClose,
}: {
  epic: Epic
  create?: boolean
  featureCount: number
  storyCount?: number
  readOnly?: boolean
  onSave: (e: Epic) => void
  onDelete?: () => void
  onClose: () => void
}) {
  const { ask: confirm, ui: confirmUI } = useConfirm()
  const [d, setD] = useState<Epic>(() => structuredClone(epic))
  return (
    <Modal title={create ? 'New package' : `${epic.key ? epic.key + ' · ' : ''}${epic.name}`} onClose={onClose} storageKey="epic">
      <fieldset disabled={readOnly} className="ro-body">
        <div className="meta-row">
          <label className="field">
            Jira key
            <input value={d.key ?? ''} placeholder="PKG-100" onChange={(e) => setD({ ...d, key: e.target.value || undefined })} />
          </label>
          <label className="field">
            Name
            <input value={d.name} autoFocus={create} onChange={(e) => setD({ ...d, name: e.target.value })} />
          </label>
        </div>
        <MarkdownField label="Description" value={d.description ?? ''} onChange={(v) => setD({ ...d, description: v || undefined })} readOnly={readOnly} />
      </fieldset>
      <div className="modal-actions">
        {!create && onDelete && !readOnly && (
          <button
            className="btn danger"
            onClick={async () => {
              const ok = await confirm({
                title: 'Delete package',
                message: `Delete “${epic.name}”${featureCount ? ` and its ${featureCount} feature${featureCount === 1 ? '' : 's'}` : ''}${storyCount ? ` (${storyCount} stor${storyCount === 1 ? 'y' : 'ies'})` : ''}?`,
                confirmLabel: 'Delete',
              })
              if (!ok) return
              onDelete()
              onClose()
            }}
          >
            Delete
          </button>
        )}
        <span className="spacer" />
        <button className="btn" onClick={onClose}>{readOnly ? 'Close' : 'Cancel'}</button>
        {!readOnly && (
          <button
            className="btn primary"
            disabled={!d.name.trim()}
            onClick={() => {
              onSave({ ...d, name: d.name.trim() })
              onClose()
            }}
          >
            {create ? 'Add package' : 'Save'}
          </button>
        )}
      </div>
      {confirmUI}
    </Modal>
  )
}

export function ReleasesDialog({
  db,
  onSave,
  onClose,
}: {
  db: DB
  onSave: (releases: Release[], milestones: Milestone[]) => void
  onClose: () => void
}) {
  const [releases, setReleases] = useState<Release[]>(() => structuredClone(db.releases))
  // sorted by date once, on open — re-sorting while editing would move the row under an open date picker
  const [milestones, setMilestones] = useState<Milestone[]>(() => structuredClone(db.milestones).sort((a, b) => a.date.localeCompare(b.date)))
  const setR = (i: number, p: Partial<Release>) => setReleases((rs) => rs.map((r, k) => (k === i ? { ...r, ...p } : r)))
  const setM = (i: number, p: Partial<Milestone>) => setMilestones((ms) => ms.map((m, k) => (k === i ? { ...m, ...p } : m)))
  const used = (id: string) => db.features.filter((f) => f.releaseId === id).length
  const valid = releases.every((r) => r.name.trim()) && milestones.every((m) => m.name.trim() && m.date && (!m.end || m.end >= m.date))
  return (
    <Modal title="Releases & milestones" onClose={onClose} className="releases-modal" storageKey="releases2">
      <div className="section-head lead">
        <span>Releases</span>
        <button className="btn small ghost" onClick={() => setReleases([...releases, { id: uid(), name: '', color: '#006bd8' }])}>+ Add</button>
      </div>
      <table className="edit-table">
        <thead>
          <tr><th>Name</th><th>Label</th><th>Release date</th><th>Colour</th><th>Features</th><th /></tr>
        </thead>
        <tbody>
          {releases.map((r, i) => (
            <tr key={r.id}>
              <td><input value={r.name} placeholder="Release 1.1" onChange={(e) => setR(i, { name: e.target.value })} /></td>
              <td><input value={r.label ?? ''} placeholder="August" onChange={(e) => setR(i, { label: e.target.value || undefined })} /></td>
              <td><input type="date" value={r.date ?? ''} onChange={(e) => setR(i, { date: e.target.value || undefined })} /></td>
              <td><ColorSwatches value={r.color} fallback="#006bd8" onChange={(hex) => setR(i, { color: hex })} /></td>
              <td className="num">{used(r.id)}</td>
              <td>
                <button className="icon-btn" title={used(r.id) ? 'Features still target this release — they will show no release' : 'Remove'} onClick={() => setReleases(releases.filter((_, k) => k !== i))}>✕</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="section-head lead">
        <span>Milestones</span>
        <button className="btn small ghost" onClick={() => setMilestones([...milestones, { id: uid(), name: '', date: new Date().toISOString().slice(0, 10) }])}>+ Add</button>
      </div>
      <p className="section-desc">Give a milestone an end date to make it a window (e.g. system test); the planner shades those weeks.</p>
      <table className="edit-table">
        <thead>
          <tr><th>Name</th><th>Date</th><th>End (optional)</th><th>Release</th><th>Colour</th><th /></tr>
        </thead>
        <tbody>
          {milestones.map((m, i) => {
            return (
              <tr key={m.id}>
                <td><input value={m.name} placeholder="Code stop" onChange={(e) => setM(i, { name: e.target.value })} /></td>
                <td><input type="date" value={m.date} onChange={(e) => setM(i, { date: e.target.value })} /></td>
                <td><input type="date" value={m.end ?? ''} min={m.date} onChange={(e) => setM(i, { end: e.target.value || undefined })} /></td>
                <td>
                  <select value={m.releaseId ?? ''} onChange={(e) => setM(i, { releaseId: e.target.value || undefined })}>
                    <option value="">—</option>
                    {releases.map((r) => <option key={r.id} value={r.id}>{r.name || '(unnamed)'}</option>)}
                  </select>
                </td>
                <td><ColorSwatches value={m.color} fallback="#e62200" title="Timeline label, week headers and lines" onChange={(hex) => setM(i, { color: hex })} /></td>
                <td><button className="icon-btn" title="Remove" onClick={() => setMilestones(milestones.filter((_, k) => k !== i))}>✕</button></td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="modal-actions">
        <span className="spacer" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button
          className="btn primary"
          disabled={!valid}
          onClick={() => {
            onSave(
              releases.map((r) => ({ ...r, name: r.name.trim() })),
              milestones.map((m) => ({ ...m, name: m.name.trim() })),
            )
            onClose()
          }}
        >
          Save
        </button>
      </div>
    </Modal>
  )
}

export function GanttItemDialog({
  db,
  item,
  create,
  onSave,
  onDelete,
  onClose,
}: {
  db: DB
  item: GanttItem
  create?: boolean
  onSave: (g: GanttItem) => void
  onDelete?: () => void
  onClose: () => void
}) {
  const { ask: confirm, ui: confirmUI } = useConfirm()
  const [d, setD] = useState<GanttItem>(() => structuredClone(item))
  // a row can't become its own descendant
  const descendants = new Set<string>([item.id])
  let grew = true
  while (grew) {
    grew = false
    for (const w of db.workstreams) if (w.parentId && descendants.has(w.parentId) && !descendants.has(w.id)) descendants.add(w.id), (grew = true)
  }
  const depthOf = (id: string | null): number => {
    let n = 0
    let cur = db.workstreams.find((w) => w.id === id)
    while (cur?.parentId) {
      n++
      cur = db.workstreams.find((w) => w.id === cur!.parentId)
    }
    return cur ? n : -1
  }
  const setSeg = (i: number, p: Partial<RoadmapBar>) => setD({ ...d, segments: d.segments.map((s, k) => (k === i ? { ...s, ...p } : s)) })
  const childCount = db.workstreams.filter((w) => descendants.has(w.id)).length - 1
  return (
    <Modal title={create ? 'New roadmap row' : d.name} onClose={onClose} storageKey="gantt">
      <div className="meta-row">
        <label className="field">
          Name
          <input value={d.name} autoFocus={create} onChange={(e) => setD({ ...d, name: e.target.value })} />
        </label>
        <label className="field">
          Parent
          <select value={d.parentId ?? ''} onChange={(e) => setD({ ...d, parentId: e.target.value || null })}>
            <option value="">— top level (workstream)</option>
            {db.workstreams
              .filter((w) => !descendants.has(w.id))
              .map((w) => (
                <option key={w.id} value={w.id}>
                  {'  '.repeat(Math.max(0, depthOf(w.id)))}
                  {w.name}
                </option>
              ))}
          </select>
        </label>
      </div>
      {!d.parentId && (
        <label className="field">
          Workstream colour
          <input type="color" value={d.color ?? '#64748b'} onChange={(e) => setD({ ...d, color: e.target.value })} />
        </label>
      )}
      <div className="section-head">
        <span>Bars (planned start · weeks · ◆ milestone)</span>
        <button className="btn small ghost" onClick={() => setD({ ...d, segments: [...d.segments, { start: mondayOf(new Date().toISOString().slice(0, 10)), weeks: 1 }] })}>+ Add</button>
      </div>
      {d.segments.map((s, i) => (
        <div key={i} className="period-row">
          <input type="date" value={s.start} onChange={(e) => e.target.value && setSeg(i, { start: mondayOf(e.target.value) })} />
          <span className="hint">{weekTag(s.start)}</span>
          <input type="number" min={1} value={s.weeks} disabled={!!s.milestone} style={{ width: 70 }} onChange={(e) => setSeg(i, { weeks: Math.max(1, Number(e.target.value) || 1) })} />
          <span className="hint">weeks</span>
          <label className="cv-check" title="A milestone: one week, drawn as ◆">
            <input type="checkbox" checked={!!s.milestone} onChange={(e) => setSeg(i, e.target.checked ? { milestone: true, weeks: 1 } : { milestone: undefined })} /> ◆
          </label>
          {s.status && s.status !== 'Planned' && <span className="hint">{s.status}</span>}
          <button className="icon-btn" onClick={() => setD({ ...d, segments: d.segments.filter((_, k) => k !== i) })}>✕</button>
        </div>
      ))}
      <p className="hint">A bar's status, actual dates, progress and colour are edited by clicking the bar in the grid.</p>
      <div className="modal-actions">
        {!create && onDelete && (
          <button
            className="btn danger"
            onClick={async () => {
              const ok = await confirm({
                title: 'Delete row',
                message: `Delete “${item.name}”${childCount ? ` and its ${childCount} sub-row${childCount === 1 ? '' : 's'}` : ''}?`,
                confirmLabel: 'Delete',
              })
              if (!ok) return
              onDelete()
              onClose()
            }}
          >
            Delete
          </button>
        )}
        <span className="spacer" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button
          className="btn primary"
          disabled={!d.name.trim()}
          onClick={() => {
            onSave({ ...d, name: d.name.trim(), segments: d.segments.map((s) => deleteUndefined({ ...s })) })
            onClose()
          }}
        >
          {create ? 'Add' : 'Save'}
        </button>
      </div>
      {confirmUI}
    </Modal>
  )
}

/**
 * One bar of a roadmap row: the plan (start week and length), the actual side (dates, status,
 * progress, colour, reason) and a delete that removes only this bar. Clicking the row's name opens
 * GanttItemDialog for the row itself; this one is for the bar clicked in the grid, so its Delete
 * cannot take the whole row with it.
 */
export function GanttBarDialog({
  db,
  item,
  index,
  todayISO,
  onSave,
  onDelete,
  onClose,
}: {
  db: DB
  item: GanttItem
  index: number
  todayISO: string
  onSave: (seg: RoadmapBar) => void
  onDelete: () => void
  onClose: () => void
}) {
  const { ask: confirm, ui: confirmUI } = useConfirm()
  const [seg, setSeg] = useState<RoadmapBar>(() => ({ ...item.segments[index] }))
  const patch = (p: Partial<RoadmapBar>) => setSeg((s) => ({ ...s, ...p }))
  const today = mondayOf(todayISO)
  const end = addWeeks(seg.start, seg.weeks - 1)
  const span = `${weekTag(seg.start)}${seg.weeks > 1 ? `–${weekTag(end)}` : ''}`
  const status: RoadmapStatus = seg.status ?? 'Planned'
  const shape = barShape(seg, todayISO)
  const stuck = status === 'Blocked' || status === 'On hold'
  const dot = (st: RoadmapStatus) => ({ background: statusColor(db, st) })

  /** a status change fills in what it implies — never over a value already there */
  const setStatus = (st: RoadmapStatus) => {
    const p: Partial<RoadmapBar> = { status: st === 'Planned' ? undefined : st }
    if (st !== 'Planned' && !seg.actualStart) p.actualStart = today
    if (st === 'Complete') {
      p.progress = 100
      if (!seg.actualEnd) p.actualEnd = today
    }
    patch(p)
  }

  return (
    <Modal title={`Bar · ${item.name}`} onClose={onClose} storageKey="ganttbar">
      <div className="section-head"><span>Planned</span></div>
      <div className="meta-row">
        <label className="field">
          Start week
          <WeekInput value={seg.start} onChange={(v) => v && patch({ start: v })} />
        </label>
        <label className="field">
          Weeks
          <input type="number" min={1} value={seg.weeks} disabled={!!seg.milestone} onChange={(e) => patch({ weeks: Math.max(1, Number(e.target.value) || 1) })} />
        </label>
      </div>
      <div className="hint">
        {weekTag(seg.start)} → {weekTag(end)} · {seg.weeks} week{seg.weeks === 1 ? '' : 's'}
      </div>
      <div className="section-head"><span>Actual</span></div>
      <div className="meta-row">
        <label className="field">
          Actual start
          <WeekInput value={seg.actualStart} onChange={(v) => patch({ actualStart: v })} />
        </label>
        <label className="field">
          Actual end
          <WeekInput value={seg.actualEnd} onChange={(v) => patch({ actualEnd: v })} />
        </label>
      </div>
      <div className="meta-row">
        <label className="field">
          Status
          <span className="people-inline">
            <span className="tag-dot" style={dot(status)} />
            <select value={status} onChange={(e) => setStatus(e.target.value as RoadmapStatus)}>
              {ROADMAP_STATUSES.map((st) => <option key={st} value={st}>{st}</option>)}
            </select>
          </span>
        </label>
        <label className="field">
          Progress %
          <input type="number" min={0} max={100} step={5} value={seg.progress ?? ''} placeholder="0" onChange={(e) => patch({ progress: e.target.value === '' ? undefined : Math.max(0, Math.min(100, Number(e.target.value) || 0)) })} />
        </label>
      </div>
      <div className="meta-row">
        <label className="field">
          Colour
          <span className="people-inline">
            <select value={seg.color ? 'custom' : 'auto'} onChange={(e) => patch({ color: e.target.value === 'custom' ? statusColor(db, status) : undefined })}>
              <option value="auto">Auto (by status)</option>
              <option value="custom">Custom</option>
            </select>
            {seg.color && <input type="color" value={seg.color} onChange={(e) => patch({ color: e.target.value })} />}
          </span>
        </label>
        {stuck ? (
          <label className="field">
            Reason / Jira
            <input value={seg.reason ?? ''} placeholder="e.g. PROJ-142, waiting for test environment" onChange={(e) => patch({ reason: e.target.value || undefined })} />
          </label>
        ) : (
          <label className="cv-check" style={{ alignSelf: 'end', marginLeft: 0, paddingBottom: 8 }} title="A milestone: one week, drawn as ◆">
            <input type="checkbox" checked={!!seg.milestone} onChange={(e) => patch(e.target.checked ? { milestone: true, weeks: 1 } : { milestone: undefined })} /> Milestone ◆
          </label>
        )}
      </div>
      {stuck && (
        <label className="cv-check" title="A milestone: one week, drawn as ◆">
          <input type="checkbox" checked={!!seg.milestone} onChange={(e) => patch(e.target.checked ? { milestone: true, weeks: 1 } : { milestone: undefined })} /> Milestone ◆
        </label>
      )}
      {shape.started && shape.delayWeeks > 0 && (
        <div className="hint warn-note">
          ⚠ Actual end {shape.status === 'Complete' ? 'exceeded' : 'is expected to exceed'} Planned by <b>+{shape.delayWeeks} week{shape.delayWeeks === 1 ? '' : 's'}</b> ({weekTag(shape.plannedEnd)} → {weekTag(shape.end)})
          {shape.forecast ? ', forecast from the progress so far' : ''}. Shown on the bar as <b>+{shape.delayWeeks}w</b>.
        </div>
      )}
      {!shape.started && status !== 'Planned' && <div className="hint">Without an actual start the bar reads “Planned · not started”.</div>}
      <div className="hint" style={{ marginTop: 8 }}>
        The row itself — its name, parent, colour and all its bars — is edited by clicking its name.
      </div>
      <div className="modal-actions">
        <button
          className="btn danger"
          onClick={async () => {
            const ok = await confirm({
              title: 'Delete bar',
              message: `Remove the ${span} bar from “${item.name}”? The row stays.`,
              confirmLabel: 'Delete',
            })
            if (!ok) return
            onDelete()
            onClose()
          }}
        >
          Delete bar
        </button>
        <span className="spacer" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button
          className="btn primary"
          onClick={() => {
            const out: RoadmapBar = { ...seg, reason: seg.reason?.trim() || undefined }
            if (out.status === 'Planned') out.status = undefined
            if (!out.milestone) out.milestone = undefined
            if (!stuck) out.reason = undefined
            onSave(deleteUndefined(out))
            onClose()
          }}
        >
          Save
        </button>
      </div>
      {confirmUI}
    </Modal>
  )
}
