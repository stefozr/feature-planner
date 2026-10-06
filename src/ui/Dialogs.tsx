import React, { useEffect, useState } from 'react'
import { AWAY_TYPES, AwayEntry, AwayType, DB, ExternalEntry, hasLeft, isResigned, optionColor, OptionColors, OptionListKey, Person, ProjectLink, ROADMAP_STATUSES, Settings, tagStyle, VacationSyncStatus } from '../types'
import { mondayOf, parseISO, isoWeekNum, uid, weekLabel, resignedTitle } from '../logic'
import Popover, { PCT_OPTIONS, PctButtons } from './Popover'
import FilterBar, { Facet } from './FilterBar'
import { useConfirm } from './ConfirmDialog'
import { isCalendarUrl } from '../../shared/db.mjs'

function loadModalPref(key: string): { w?: number; h?: number; max?: boolean } {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}')
  } catch {
    return {}
  }
}

export function Modal({
  title,
  onClose,
  wide,
  className,
  storageKey,
  children,
}: {
  title: string
  onClose: () => void
  wide?: boolean
  /** extra class on the modal box, for per-dialog sizing */
  className?: string
  /** persists user-resized dimensions per dialog kind in localStorage */
  storageKey?: string
  children: React.ReactNode
}) {
  const key = `feature-planner:modal:${storageKey ?? 'default'}`
  const ref = React.useRef<HTMLDivElement>(null)
  const saveTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const [max, setMax] = useState<boolean>(() => !!loadModalPref(key).max)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // apply saved size; persist user resizes (drag corner) while not maximized.
  // The box has no explicit height of its own, so it also grows and shrinks with its content —
  // a search that matches nobody, a section that unmounts. The browser's resize handle is the
  // only thing that writes inline width/height onto the element, so a change to the inline style
  // is the signal for a user resize; comparing the box's size to its first layout is not, and
  // used to save the collapsed "no results" height as if the user had asked for it.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (max) {
      el.style.width = ''
      el.style.height = ''
      return
    }
    const saved = loadModalPref(key)
    if (saved.w) el.style.width = `${saved.w}px`
    if (saved.h) el.style.height = `${saved.h}px`
    const applied = { w: el.style.width, h: el.style.height }
    const ro = new ResizeObserver(() => {
      if (el.style.width === applied.w && el.style.height === applied.h) return // content reflow
      const r = el.getBoundingClientRect()
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        localStorage.setItem(key, JSON.stringify({ ...loadModalPref(key), w: Math.round(r.width), h: Math.round(r.height) }))
      }, 300)
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [key, max])

  const toggleMax = () =>
    setMax((m) => {
      const next = !m
      localStorage.setItem(key, JSON.stringify({ ...loadModalPref(key), max: next }))
      return next
    })

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={['modal', wide ? 'wide' : '', className ?? '', max ? 'max' : ''].filter(Boolean).join(' ')}>
        <div className="modal-head">
          <h3>{title}</h3>
          <span className="modal-head-btns">
            <button className="icon-btn" title={max ? 'Restore size' : 'Maximize'} onClick={toggleMax}>
              {max ? '❐' : '⛶'}
            </button>
            <button className="icon-btn" onClick={onClose}>✕</button>
          </span>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  )
}

/** A weekly % (capacity ceiling, external allocation): button shows the value, click opens the PctButtons popover. */
function CapacityPicker({
  value,
  onChange,
  label = 'Weekly capacity',
  title = 'Set weekly capacity ceiling %',
}: {
  value: number
  onChange: (v: number) => void
  label?: string
  title?: string
}) {
  const [pop, setPop] = useState<{ x: number; y: number } | null>(null)
  return (
    <>
      <button type="button" className="fte-btn" title={title} onClick={(e) => setPop({ x: e.clientX, y: e.clientY })}>
        {value}%
      </button>
      {pop && (
        <Popover x={pop.x} y={pop.y} onClose={() => setPop(null)}>
          <div className="pop-section">
            <div className="pop-label">{label}</div>
            <PctButtons
              current={value}
              options={PCT_OPTIONS}
              onPick={(pct) => {
                onChange(pct)
                setPop(null)
              }}
            />
          </div>
        </Popover>
      )}
    </>
  )
}

/** Dropdown over an editable option list; keeps a legacy value visible even if it left the canonical list. */
export function OptionSelect({
  value,
  options,
  onChange,
  placeholder = 'Select…',
}: {
  value: string
  options: string[]
  onChange: (v: string) => void
  placeholder?: string
}) {
  const opts = value && !options.includes(value) ? [value, ...options] : options
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {!value && (
        <option value="" disabled>
          {placeholder}
        </option>
      )}
      {opts.map((p) => (
        <option key={p} value={p}>
          {p}
        </option>
      ))}
    </select>
  )
}

function ProfileSelect(props: { value: string; options: string[]; onChange: (v: string) => void }) {
  return <OptionSelect {...props} placeholder="Select profile…" />
}

/**
 * A period as a line of text: kind · dates · note · origin chip. The People dialog's view mode
 * shows every away and external period this way, and calendar-imported away periods look like
 * this even while editing, since the sync owns them.
 */
function PeriodText({ kind, range, note, chip, title }: { kind: string; range: string; note?: string; chip?: string; title?: string }) {
  return (
    <div className="period-row static" title={title}>
      <span className="period-kind">{kind}</span>
      <span className="period-dates">{range}</span>
      <span className="period-note hint">{note ?? ''}</span>
      {chip && <span className="people-chip">{chip}</span>}
    </div>
  )
}

/** "10–21 Aug", "28 Sep–2 Oct", "5 Aug", or "31 Mar →" for an open end — short enough to sit beside a name. */
function shortRange(start: string, end?: string): string {
  if (!end) return `${weekLabel(start)} →`
  if (start === end) return weekLabel(start)
  const a = parseISO(start)
  const b = parseISO(end)
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth()
    ? `${a.getUTCDate()}–${weekLabel(end)}`
    : `${weekLabel(start)}–${weekLabel(end)}`
}

/**
 * The roster: who exists, what they are, and when they aren't available.
 *
 * Master–detail. The left pane is the list — searchable, grouped by profile, each row carrying
 * what matters about a person *here* (a reduced capacity, an external commitment, the next away
 * period) rather than how many allocations they hold, which the grid already answers. The right
 * pane edits one person in the same form language as the project dialog. Nothing expands inline
 * and the box never changes height, so the eye always knows where the editor is.
 *
 * Save is per person and explicit: the draft is validated as a whole (a half-typed date range
 * would otherwise reach the availability maths), and one Save = one write to the database.
 *
 * The pane opens read-only — the same rendering the viewer role gets — and Edit unlocks it. Most
 * visits are to look someone up; the form should read as information until asked to be a form.
 *
 * Away periods the shared vacation calendar imported are shown, not edited: the server replaces
 * them on every pull, so a change here would not survive the afternoon. What the dialog can do
 * about the calendar is name the person the way the calendar does (Calendar name), for the few
 * whose spelling differs.
 */
export function PeopleDialog({
  db,
  profiles,
  initialPersonId,
  readOnly = false,
  calendar,
  today,
  hideResigned,
  onHideResigned,
  onSave,
  onClose,
}: {
  db: DB
  profiles: string[]
  /** open with this person selected — the grid's name links pass it */
  initialPersonId?: string
  /** viewer role: browse and read, nothing to add, change or delete */
  readOnly?: boolean
  /** the server's last vacation-calendar pull; null while unknown */
  calendar?: VacationSyncStatus | null
  /** the app's one clock (ISO date): new periods start here, and "has left" is judged against it */
  today: string
  /** the app-wide switch (see App): leavers whose date has passed stay off the list */
  hideResigned: boolean
  onHideResigned: (v: boolean) => void
  onSave: (people: Person[]) => void
  onClose: () => void
}) {
  const { ask: confirm, ui: confirmUI } = useConfirm()
  const [people, setPeople] = useState<Person[]>(() => structuredClone(db.people))
  const [query, setQuery] = useState('')

  /** order-stable signature of every field the editor can change, for the dirty check */
  const sig = (p: Person) =>
    JSON.stringify([
      p.name,
      p.profile,
      p.short ?? null,
      p.defaultKind ?? null,
      p.capacity ?? null,
      p.calendarName ?? null,
      p.resignedFrom ?? null,
      (p.away ?? []).map((o) => [o.start, o.end, o.type ?? null, o.note ?? null, o.source ?? null, o.uid ?? null]),
      (p.external ?? []).map((x) => [x.start, x.end ?? null, x.pct, x.note ?? null]),
    ])

  // The selection and its editable draft travel together so they can't drift apart. `base` is
  // the draft's signature when editing began; `isNew` marks a ＋-created person the list doesn't
  // hold yet (Cancel drops them, Save adds them).
  type Sel = { id: string; draft: Person; base: string; isNew: boolean }
  const openPerson = (p: Person, isNew = false): Sel => ({ id: p.id, draft: structuredClone(p), base: sig(p), isNew })
  /** list order: profile groups in the given order (unknown profiles last), names within */
  const listOrder = (ps: Person[]) => {
    const rank = new Map(profiles.map((pr, i) => [pr, i]))
    return [...ps].sort((a, b) => (rank.get(a.profile) ?? Infinity) - (rank.get(b.profile) ?? Infinity) || a.name.localeCompare(b.name))
  }
  /** the first person the list would show — a hidden leaver is never the silent default */
  const firstVisible = (ps: Person[]) => listOrder(ps).find((x) => !(hideResigned && hasLeft(x, today)))
  const [sel, setSel] = useState<Sel | null>(() => {
    const p = db.people.find((x) => x.id === initialPersonId) ?? firstVisible(db.people)
    return p ? openPerson(p) : null
  })
  const dirty = !!sel && sig(sel.draft) !== sel.base
  // Whether the selected person is unlocked for editing. `readOnly` (viewer role) means never;
  // otherwise selecting someone lands in view mode and Edit flips this. Everything the pane does
  // with "can I change this" reads `view`, so the viewer look and the locked look are one look.
  const [editing, setEditing] = useState(false)
  const view = readOnly || !editing
  const nameRef = React.useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (editing && !readOnly) nameRef.current?.focus()
  }, [editing, readOnly])

  const patch = (f: Partial<Person>) => setSel((s) => s && { ...s, draft: { ...s.draft, ...f } })
  const setAway = (i: number, f: Partial<AwayEntry>) =>
    setSel((s) => s && { ...s, draft: { ...s.draft, away: (s.draft.away ?? []).map((o, k) => (k === i ? { ...o, ...f } : o)) } })
  const setExt = (i: number, f: Partial<ExternalEntry>) =>
    setSel((s) => s && { ...s, draft: { ...s.draft, external: (s.draft.external ?? []).map((x, k) => (k === i ? { ...x, ...f } : x)) } })

  /** week allocations across all features for a person — what a delete takes with it */
  const allocCount = (personId: string) =>
    db.features.reduce(
      (n, f) => n + Object.values(f.cells).reduce((m, c) => m + c.entries.filter((e) => e.personId === personId).length, 0),
      0,
    )

  /** the one write path to the database: trim, update the working copy, persist */
  const commit = (next: Person[]) => {
    const clean = next.map((p) => ({ ...p, name: p.name.trim(), profile: p.profile.trim() }))
    setPeople(clean)
    onSave(clean)
    return clean
  }

  const validAway = (o: AwayEntry) => !!o.start && !!o.end && o.start <= o.end
  const validExt = (x: ExternalEntry) =>
    !!x.start && (!x.end || x.start <= x.end) && Number.isFinite(x.pct) && x.pct >= 0 && x.pct <= 100
  /** what Save enforces before a person can reach the database */
  const personValid = (p: Person) =>
    !!p.name.trim() &&
    !!p.profile.trim() &&
    (p.away ?? []).every(validAway) &&
    (p.external ?? []).every(validExt) &&
    (p.capacity == null || (p.capacity >= 0 && p.capacity <= 100)) &&
    (p.resignedFrom == null || /^\d{4}-\d{2}-\d{2}$/.test(p.resignedFrom))

  // Leaving a dirty draft — for another person, a new one, or the door — asks first. The confirm
  // covers the screen, so nothing below can change while it is up; `closing` only stops a second
  // Esc in the gap before it mounts from orphaning the first promise.
  const closing = React.useRef(false)
  const guard = async (): Promise<boolean> => {
    if (!sel || !dirty) return true
    if (closing.current) return false
    closing.current = true
    const ok = await confirm({
      title: 'Unsaved changes',
      message: `${sel.draft.name.trim() || 'This person'} has unsaved changes.\nDiscard them?`,
      confirmLabel: 'Discard',
    })
    closing.current = false
    return ok
  }
  const requestClose = async () => { if (await guard()) onClose() }

  const select = async (id: string) => {
    if (id === sel?.id) return
    if (!(await guard())) return
    const p = people.find((x) => x.id === id)
    setSel(p ? openPerson(p) : null)
    setEditing(false)
  }

  const groupProfiles = [...new Set([...profiles, ...people.map((p) => p.profile)])]
  const byName = (a: Person, b: Person) => a.name.localeCompare(b.name)
  const q = query.trim().toLowerCase()
  const matches = (p: Person) =>
    !q || p.name.toLowerCase().includes(q) || p.profile.toLowerCase().includes(q) || (p.short ?? '').toLowerCase().includes(q)
  // "Hide resigned" hides only those already gone — someone leaving next month still needs their
  // handover planned. The selected person always stays listed, so ticking the box never empties
  // the editor beside it; and the count on the box says how many the rule is holding back.
  const hidden = hideResigned ? people.filter((p) => hasLeft(p, today) && p.id !== sel?.id) : []
  const hiddenIds = new Set(hidden.map((p) => p.id))
  // a pending new person is listed too — under their profile and regardless of the search, so
  // the selection is visible while they are being named
  const listed = sel?.isNew ? [...people, sel.draft] : people
  const groups = groupProfiles
    .map((prof) => ({
      prof,
      members: listed
        .filter((p) => p.profile === prof && !hiddenIds.has(p.id) && (matches(p) || (sel?.isNew && p.id === sel.id)))
        .sort(byName),
    }))
    .filter((g) => g.members.length > 0)
  const ordered = groups.flatMap((g) => g.members)

  const addPerson = async () => {
    if (!(await guard())) return
    const blank: Person = { id: uid(), name: '', profile: sel?.draft.profile || profiles[0] || '' }
    setSel(openPerson(blank, true))
    setEditing(true) // nothing to view yet
  }

  const save = () => {
    if (!sel || !personValid(sel.draft)) return
    if (!dirty && !sel.isNew) return // nothing changed: no write
    const next = sel.isNew ? [...people, sel.draft] : people.map((p) => (p.id === sel.id ? sel.draft : p))
    const saved = commit(next).find((p) => p.id === sel.id)
    setSel(saved ? openPerson(saved) : null)
    setEditing(false) // back to reading what was just saved
  }

  const cancel = () => {
    if (!sel) return
    setEditing(false)
    if (!sel.isNew) {
      const p = people.find((x) => x.id === sel.id)
      setSel(p ? openPerson(p) : null)
      return
    }
    const p = firstVisible(people)
    setSel(p ? openPerson(p) : null)
  }

  const remove = async () => {
    if (!sel || sel.isNew) return
    const p = people.find((x) => x.id === sel.id)
    if (!p) return
    const n = allocCount(p.id)
    if (n > 0) {
      const ok = await confirm({
        title: 'Delete person',
        message: `Delete ${p.name}?\nRemoves ${n} week allocation${n === 1 ? '' : 's'} across features (lead/buddy roles are cleared too).`,
        confirmLabel: 'Delete',
      })
      if (!ok) return
    }
    // the neighbour in list order takes the selection, so deleting several in a row is one hand
    const i = ordered.findIndex((x) => x.id === p.id)
    const next = ordered[i + 1] ?? ordered[i - 1]
    commit(people.filter((x) => x.id !== p.id))
    setSel(next && next.id !== p.id ? openPerson(next) : null)
    setEditing(false)
  }

  /** ↑/↓ in the list walk the selection; the guard still applies */
  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const i = ordered.findIndex((x) => x.id === sel?.id)
    const next = ordered[i + (e.key === 'ArrowDown' ? 1 : -1)]
    if (next) void select(next.id)
  }

  /**
   * The availability facts worth a glance in the list, as chips: reduced capacity, external
   * commitment, next away period. External is warn-toned (the same exception colour it has in the
   * assign dialog); the other two are neutral, like the grid's grey away hatch.
   */
  const hints = (p: Person) => {
    const out: React.ReactNode[] = []
    if (p.resignedFrom)
      out.push(
        <span key="res" className="people-chip" title={`${resignedTitle(p)}${hasLeft(p, today) ? '' : ' (still here)'}`}>
          Resigned {shortRange(p.resignedFrom)}
        </span>,
      )
    if (p.capacity != null && p.capacity !== 100)
      out.push(<span key="cap" className="people-chip" title="Weekly capacity ceiling">cap {p.capacity}%</span>)
    const ext = (p.external ?? []).filter((x) => !x.end || x.end >= today).sort((a, b) => a.start.localeCompare(b.start))[0]
    if (ext)
      out.push(
        <span key="ext" className="assign-badge" title={`External ${ext.pct}% · ${shortRange(ext.start, ext.end)}${ext.note ? ` · ${ext.note}` : ''}`}>
          ext {ext.pct}%
        </span>,
      )
    const away = (p.away ?? []).filter((o) => o.end >= today).sort((a, b) => a.start.localeCompare(b.start))[0]
    if (away)
      out.push(
        <span key="away" className="people-chip" title={`${away.type ?? 'Away'}${away.note ? ` · ${away.note}` : ''} — ${away.start <= today ? 'now' : 'upcoming'}`}>
          Away {shortRange(away.start, away.end)}
        </span>,
      )
    return out
  }

  const d = sel?.draft
  const away = d?.away ?? []
  const ext = d?.external ?? []
  const valid = !!d && personValid(d)
  // Calendar facts for the hints: the integration is on unless the server said otherwise, and a
  // person is "not in the calendar" only on the word of a successful pull. Matching happens
  // server-side by id, so a renamed draft keeps its verdict until the next sync.
  const calendarOn = calendar?.enabled !== false
  const lastPull = calendar?.lastSync?.ok ? calendar.lastSync : null
  const notInCalendar = !!d && !!lastPull && !sel?.isNew && (lastPull.unmatchedPeople ?? []).some((u) => u.id === d.id)
  // matched by the near-miss rule ("Alex" for "Alexandru"): worth saying, since a second Alex
  // arriving would make the guess ambiguous and the match would silently stop
  const approxAs = d && lastPull && !sel?.isNew ? (lastPull.approxPeople ?? []).find((u) => u.id === d.id)?.calendarName : undefined
  const saveTitle = !d ? '' : !d.name.trim() || !d.profile.trim() ? 'Give this person a name and a profile first' : !valid ? 'Fix the highlighted period first' : dirty ? 'Save person' : 'Nothing changed'

  return (
    <Modal title="People" onClose={requestClose} storageKey="people3" className={view ? 'people-modal readonly' : 'people-modal'}>
      <div className="people-list">
        {/* Escape clears a live query before it closes the dialog (see AssignDialog) */}
        <input
          className="search-input people-search"
          type="search"
          placeholder="Search people…"
          value={query}
          autoFocus={!sel?.isNew}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery('') } }}
        />
        <label className="people-filter" title="Leave out people whose resignation date has passed; they keep any allocations they hold">
          <input type="checkbox" checked={hideResigned} onChange={(e) => onHideResigned(e.target.checked)} />
          Hide resigned
          {hidden.length > 0 && <span className="assign-section-count">· {hidden.length}</span>}
        </label>
        <div className="people-scroll" onKeyDown={onListKey}>
          {ordered.length === 0 && (
            <p className="hint">
              {q
                ? `No one matches “${query.trim()}”.`
                : hidden.length > 0
                  ? 'Everyone here has resigned — untick “Hide resigned” to see them.'
                  : readOnly
                    ? 'No people yet.'
                    : 'No people yet — add the first one below.'}
            </p>
          )}
          {groups.map(({ prof, members }) => (
            <React.Fragment key={prof || '__none'}>
              <div className="assign-section-head">
                <span>{prof || 'No profile'}</span>
                <span className="assign-section-count">· {members.filter((m) => !(sel?.isNew && m.id === sel.id)).length}</span>
              </div>
              {members.map((p) => {
                const pending = sel?.isNew && p.id === sel.id
                const tags = pending ? [] : hints(p)
                return (
                  <button
                    key={p.id}
                    className={`people-item${p.id === sel?.id ? ' selected' : ''}${pending ? ' pending' : ''}`}
                    onClick={() => void select(p.id)}
                  >
                    <span className={`assign-name${isResigned(p) ? ' resigned' : ''}`} title={p.name.trim()}>
                      {p.name.trim() || (pending ? 'New person' : 'Unnamed')}
                      {p.short && <span className="hint"> · {p.short}</span>}
                    </span>
                    {tags.length > 0 && <span className="people-tags">{tags}</span>}
                  </button>
                )
              })}
            </React.Fragment>
          ))}
        </div>
        {!readOnly && <button className="btn ghost people-new" onClick={() => void addPerson()}>+ New person…</button>}
      </div>

      {sel && d ? (
        // keyed on the person so autoFocus and any half-typed native date state reset on switch
        <div className="people-detail" key={sel.id}>
          <fieldset disabled={view} className="ro-body">
          {view ? (
            // information, not a locked form: the same grid of labels, values as text
            <>
              <div className="meta-row">
                <div className="field">
                  Name
                  <span className="field-value">{d.name.trim() || 'Unnamed'}</span>
                </div>
                <div className="field">
                  Profile
                  <span className="field-value">{d.profile || '—'}</span>
                </div>
              </div>
              <div className="meta-row">
                <div className="field">
                  Short name
                  <span className="field-value">{d.short || '—'}</span>
                </div>
                <div className="field">
                  Usually works as
                  <span className="field-value">{d.defaultKind === 'test' ? 'Tester' : 'Developer'}</span>
                </div>
              </div>
              <div className="meta-row">
                <div className="field">
                  Capacity
                  <div className="people-inline">
                    <span className="field-value">{d.capacity ?? 100}%</span>
                    <span className="hint">of a full working week</span>
                  </div>
                </div>
                {calendarOn && d.calendarName && (
                  <div className="field">
                    Calendar name
                    <span className="field-value">{d.calendarName}</span>
                  </div>
                )}
              </div>
              {d.resignedFrom && (
                <div className="meta-row">
                  <div className="field">
                    Resigned
                    <div className="people-inline">
                      <span className="field-value">from {weekLabel(d.resignedFrom)}</span>
                      <span className="hint">{hasLeft(d, today) ? 'no capacity since then' : 'no capacity from that day on'}</span>
                    </div>
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="meta-row">
                <label className="field">
                  Name
                  <input ref={nameRef} value={d.name} placeholder="Full name" autoFocus={sel.isNew} onChange={(e) => patch({ name: e.target.value })} />
                </label>
                <label className="field">
                  Profile
                  <ProfileSelect value={d.profile} options={profiles} onChange={(v) => patch({ profile: v })} />
                </label>
              </div>
              <div className="meta-row">
                <label className="field">
                  Short name
                  <input
                    value={d.short ?? ''}
                    placeholder={d.name.split(' ')[0] || 'e.g. Alice'}
                    title="The label on this person's chips in the grid"
                    onChange={(e) => patch({ short: e.target.value || undefined })}
                  />
                </label>
                <label className="field">
                  Usually works as
                  <select
                    value={d.defaultKind ?? 'dev'}
                    title="The kind a new week allocation for this person starts as"
                    onChange={(e) => patch({ defaultKind: e.target.value === 'test' ? 'test' : undefined })}
                  >
                    <option value="dev">Developer</option>
                    <option value="test">Tester</option>
                  </select>
                </label>
              </div>
              <div className="meta-row">
                <div className="field">
                  Capacity
                  <div className="people-inline">
                    <CapacityPicker value={d.capacity ?? 100} onChange={(v) => patch({ capacity: v === 100 ? undefined : v })} />
                    <span className="hint">of a full working week</span>
                  </div>
                </div>
                {calendarOn && (
                  <label className="field">
                    Calendar name
                    <input
                      value={d.calendarName ?? ''}
                      placeholder="Same as name"
                      title="How the shared vacation calendar spells this person, if not like the name here"
                      onChange={(e) => patch({ calendarName: e.target.value || undefined })}
                    />
                  </label>
                )}
              </div>
              <div className="meta-row">
                <div className="field">
                  Resigned
                  <div className="people-inline">
                    <label className="people-filter" title="Mark this person as leaving the company">
                      <input
                        type="checkbox"
                        checked={d.resignedFrom != null}
                        onChange={(e) => patch({ resignedFrom: e.target.checked ? today : undefined })}
                      />
                      {d.resignedFrom != null ? 'unavailable from' : 'mark as resigned'}
                    </label>
                    {d.resignedFrom != null && (
                      <input
                        type="date"
                        value={d.resignedFrom}
                        title="First day this person is no longer available"
                        onChange={(e) => patch({ resignedFrom: e.target.value || today })}
                      />
                    )}
                    {d.resignedFrom != null && (
                      <span className="hint">capacity is 0 from that day; any booking after it shows as overbooked</span>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}

          <div className="people-section-head">
            <span>Away <span className="assign-section-count">· {away.length}</span></span>
            {!view && (
              <button
                className="btn small ghost"
                onClick={() => patch({ away: [...away, { start: today, end: today, type: 'Vacation' }] })}
              >
                + Add
              </button>
            )}
          </div>
          {calendarOn && (
            <p className={`hint people-section-sub${notInCalendar ? ' err' : ''}`}>
              {notInCalendar
                ? `Not found in the vacation calendar at the last sync${lastPull ? ` (${weekLabel(lastPull.at.slice(0, 10))})` : ''} — company-wide holidays still apply, vacations don't. If it spells the name differently, ${view ? 'press Edit and set Calendar name' : 'set Calendar name above and save'}.`
                : approxAs
                  ? `Matched in the vacation calendar as “${approxAs}” — ${view ? 'press Edit and set Calendar name' : 'set Calendar name above'} to pin it.`
                  : 'Vacation and public holidays come from the shared calendar; add anything else here.'}
            </p>
          )}
          {away.length === 0 && <p className="hint people-section-sub">No away time planned.</p>}
          {away.map((o, i) => o.source === 'calendar' ? (
            <PeriodText
              key={o.uid ?? i}
              kind={o.type ?? 'Vacation'}
              range={shortRange(o.start, o.end)}
              note={o.note}
              chip="calendar"
              title="From the shared vacation calendar — change it there; the next sync would undo an edit made here"
            />
          ) : view ? (
            <PeriodText key={i} kind={o.type ?? 'Vacation'} range={shortRange(o.start, o.end)} note={o.note} chip="manual" />
          ) : (
            <div key={i} className={`period-row${validAway(o) ? '' : ' invalid'}`}>
              <select value={o.type ?? 'Vacation'} onChange={(e) => setAway(i, { type: e.target.value as AwayType })}>
                {AWAY_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              <input type="date" value={o.start} onChange={(e) => setAway(i, { start: e.target.value })} />
              <span className="period-arrow">→</span>
              <input type="date" value={o.end} min={o.start || undefined} onChange={(e) => setAway(i, { end: e.target.value })} />
              <input
                className="period-note"
                value={o.note ?? ''}
                placeholder="Note (optional)"
                onChange={(e) => setAway(i, { note: e.target.value || undefined })}
              />
              <button className="icon-btn" title="Remove period" onClick={() => patch({ away: away.filter((_, k) => k !== i) })}>✕</button>
            </div>
          ))}
          {away.some((o) => !validAway(o)) && <p className="hint err">Each period needs a start and an end on or after it.</p>}

          <div className="people-section-head">
            <span>External allocation <span className="assign-section-count">· {ext.length}</span></span>
            {!view && (
              <button className="btn small ghost" onClick={() => patch({ external: [...ext, { start: today, pct: 100 }] })}>
                + Add
              </button>
            )}
          </div>
          <p className="hint people-section-sub">
            Time committed outside this project (another engagement, not on the project yet, left it), deducted from this person's week.
            Someone leaving the company is marked Resigned above instead.
            {!view && ' Leave the end empty for an open-ended commitment.'}
          </p>
          {ext.map((x, i) => view ? (
            <PeriodText key={i} kind={`${x.pct}%`} range={shortRange(x.start, x.end)} note={x.note} />
          ) : (
            <div key={i} className={`period-row${validExt(x) ? '' : ' invalid'}`}>
              <CapacityPicker
                value={x.pct}
                label="Deducted from capacity"
                title="% of the working week committed externally"
                onChange={(v) => setExt(i, { pct: v })}
              />
              <input type="date" value={x.start} onChange={(e) => setExt(i, { start: e.target.value })} />
              <span className="period-arrow">→</span>
              <input
                type="date"
                value={x.end ?? ''}
                min={x.start || undefined}
                title={x.end ? 'Last day' : 'No end date — open-ended'}
                onChange={(e) => setExt(i, { end: e.target.value || undefined })}
              />
              {!x.end && <span className="period-onwards">onwards</span>}
              <input
                className="period-note"
                value={x.note ?? ''}
                placeholder="Note (optional)"
                onChange={(e) => setExt(i, { note: e.target.value || undefined })}
              />
              <button className="icon-btn" title="Remove period" onClick={() => patch({ external: ext.filter((_, k) => k !== i) })}>✕</button>
            </div>
          ))}
          {ext.some((x) => !validExt(x)) && <p className="hint err">Each commitment needs a start; an end must be on or after it.</p>}
          </fieldset>

          {readOnly ? (
            <div className="modal-actions people-actions">
              <span className="spacer" />
              <button className="btn" onClick={onClose}>Close</button>
            </div>
          ) : view ? (
            <div className="modal-actions people-actions">
              <span className="spacer" />
              <button className="btn primary" title="Edit this person" onClick={() => setEditing(true)}>
                Edit
              </button>
            </div>
          ) : (
          <div className="modal-actions people-actions">
            {!sel.isNew && (
              <button className="btn danger" title="Delete this person and every allocation they hold" onClick={() => void remove()}>
                Delete
              </button>
            )}
            <span className="spacer" />
            <button className="btn" onClick={cancel}>Cancel</button>
            <button className="btn primary" disabled={!valid} title={saveTitle} onClick={save}>
              {sel.isNew ? 'Add person' : 'Save'}
            </button>
          </div>
          )}
        </div>
      ) : (
        <div className="people-detail">
          <p className="hint people-empty">{readOnly ? 'Select a person to see their details.' : 'Select a person to see their details, or add one.'}</p>
        </div>
      )}
      {confirmUI}
    </Modal>
  )
}

/** Ensure a user-typed URL is absolute so the anchor doesn't resolve relative to the app. */
function normalizeUrl(url: string): string {
  const u = url.trim()
  if (!u) return ''
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(u) || u.startsWith('mailto:') ? u : `https://${u}`
}

/** Accent color per phase (category), mirrors the link-review palette; unknown => neutral. */
const PHASE_COLOR: Record<string, string> = {
  Sales: '#be185d',
  Discovery: '#7c3aed',
  Demo: '#0891b2',
  Implementation: '#0369a1',
  Docs: '#15803d',
  Design: '#db2777',
  Other: '#64748b',
}
const phaseColor = (c: string) => PHASE_COLOR[c] ?? '#64748b'

/** The host/tool a link points at, inferred from its URL (no stored field). */
function linkSource(url: string): string {
  const u = url.toLowerCase()
  if (u.includes('fathom.video')) return 'Fathom'
  if (u.includes('figma.com')) return 'Figma'
  if (u.includes('miro.com')) return 'Miro'
  if (u.includes('excalidraw')) return 'Excalidraw'
  if (u.includes('lucid')) return 'Lucid'
  if (u.includes('notion.')) return 'Notion'
  if (u.includes('drive.google') || u.includes('docs.google')) return 'Docs'
  if (u.includes('slack.com')) return 'Slack'
  return 'Link'
}

/**
 * Project links: usable (clickable) by default, with per-row edit + delete.
 * Filterable by source and phase (category); ordered by phase then source.
 */
export function LinksEditor({
  links,
  categories,
  onChange,
}: {
  links: ProjectLink[]
  categories: string[]
  onChange: (links: ProjectLink[]) => void
}) {
  const [editing, setEditing] = useState<number | null>(null)
  const [fSources, setFSources] = useState<string[]>([])
  const [fPhases, setFPhases] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const toggle = (set: (fn: (v: string[]) => string[]) => void, v: string) =>
    set((cur) => (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]))

  const patch = (i: number, p: Partial<ProjectLink>) =>
    onChange(links.map((l, j) => (j === i ? { ...l, ...p } : l)))
  const remove = (i: number) => {
    onChange(links.filter((_, j) => j !== i))
    setEditing(null)
  }
  const add = () => {
    setFSources([])
    setFPhases([])
    setSearch('')
    setEditing(links.length)
    onChange([...links, { label: '', url: '', category: categories[0] ?? '' }])
  }

  const phaseRank = (c: string) => {
    const i = categories.indexOf(c)
    return i === -1 ? categories.length : i
  }
  const q = search.trim().toLowerCase()
  const matchesQ = (l: ProjectLink) => !q || l.label.toLowerCase().includes(q) || l.url.toLowerCase().includes(q)

  // keep original indices so edit/delete target the right entry after sort+filter
  const rows = links
    .map((l, i) => ({ l, i, src: linkSource(l.url) }))
    .filter((r) => (fPhases.length === 0 || fPhases.includes(r.l.category)) && (fSources.length === 0 || fSources.includes(r.src)) && matchesQ(r.l))
    .sort((a, b) => phaseRank(a.l.category) - phaseRank(b.l.category) || a.src.localeCompare(b.src) || a.l.label.localeCompare(b.l.label))

  // faceted counts respect the OTHER facet + search, mirroring the dashboard FilterBar
  const phaseFacet: Facet = {
    key: 'phase',
    label: 'Category',
    selected: fPhases,
    onToggle: (v) => toggle(setFPhases, v),
    options: [...new Set(links.map((l) => l.category))]
      .sort((a, b) => phaseRank(a) - phaseRank(b))
      .map((v) => ({ value: v, count: links.filter((l) => l.category === v && (fSources.length === 0 || fSources.includes(linkSource(l.url))) && matchesQ(l)).length })),
  }
  const sourceFacet: Facet = {
    key: 'source',
    label: 'Source',
    selected: fSources,
    onToggle: (v) => toggle(setFSources, v),
    options: [...new Set(links.map((l) => linkSource(l.url)))]
      .sort()
      .map((v) => ({ value: v, count: links.filter((l) => linkSource(l.url) === v && (fPhases.length === 0 || fPhases.includes(l.category)) && matchesQ(l)).length })),
  }

  return (
    <div className="field links-field" style={{ gridColumn: '1 / -1' }}>
      <div className="links-head">
        <span>Links</span>
        <div className="links-head-actions">
          {links.length > 0 && (
            <FilterBar
              facets={[phaseFacet, sourceFacet]}
              search={search}
              onSearch={setSearch}
              onClearAll={() => {
                setFPhases([])
                setFSources([])
                setSearch('')
              }}
              resultCount={rows.length}
              totalCount={links.length}
              noun="links"
              searchPlaceholder="Filter by label / url…"
              filterTitle="Filter links"
            />
          )}
          <button type="button" className="btn small ghost" onClick={add}>+ Add link</button>
        </div>
      </div>

      <div className="links-list">
        {rows.map(({ l, i, src }) =>
          editing === i ? (
            <div key={i} className="link-card edit">
              <input autoFocus value={l.label} placeholder="Label (e.g. Sales deck)" onChange={(e) => patch(i, { label: e.target.value })} />
              <input value={l.url} placeholder="https://…" onChange={(e) => patch(i, { url: e.target.value })} />
              <div className="link-card-editrow">
                <OptionSelect value={l.category} options={categories} onChange={(v) => patch(i, { category: v })} placeholder="Category…" />
                <span style={{ flex: 1 }} />
                <button type="button" className="btn small primary" onClick={() => setEditing(null)} title="Done">✓ Done</button>
                <button type="button" className="btn small danger" onClick={() => remove(i)} title="Remove link">Delete</button>
              </div>
            </div>
          ) : (
            <div key={i} className="link-item">
              <div className="lbl-line">
                <span
                  className={`lbl-name${l.url.trim() ? ' lbl-link' : ''}`}
                  title={l.url.trim() ? normalizeUrl(l.url) : undefined}
                  onClick={l.url.trim() ? () => window.open(normalizeUrl(l.url), '_blank', 'noopener,noreferrer') : undefined}
                >
                  {l.label.trim() || l.url || '(no url)'}
                </span>
                <span className="link-item-actions">
                  <button type="button" className="mini-btn" onClick={() => setEditing(i)} title="Edit link">✎</button>
                  <button type="button" className="mini-btn danger" onClick={() => remove(i)} title="Remove link">✕</button>
                </span>
              </div>
              <div className="lbl-line lbl-tags">
                <span className="tag" style={tagStyle(phaseColor(l.category))}>{l.category || '—'}</span>
                <span className="tag">{src}</span>
              </div>
            </div>
          ),
        )}
      </div>
    </div>
  )
}

/** Editable value list rendered as removable chips plus an add box; optional per-value color picker. */
export function ChipListEditor({
  label,
  items,
  onChange,
  placeholder,
  colorOf,
  onColorChange,
  reorderable,
}: {
  /** caption above the chips; omit when the surrounding layout already names the list */
  label?: string
  items: string[]
  onChange: (items: string[]) => void
  placeholder: string
  /** effective color for a value; enables the color swatch when provided */
  colorOf?: (v: string) => string
  onColorChange?: (v: string, color: string) => void
  /** allow drag-and-drop reordering of the chips */
  reorderable?: boolean
}) {
  const [draft, setDraft] = useState('')
  const [dragI, setDragI] = useState<number | null>(null)
  const add = () => {
    const v = draft.trim()
    if (v && !items.includes(v)) onChange([...items, v])
    setDraft('')
  }
  const moveTo = (to: number) => {
    if (dragI === null || dragI === to) return
    const next = [...items]
    const [moved] = next.splice(dragI, 1)
    next.splice(to, 0, moved)
    onChange(next)
    setDragI(null)
  }
  return (
    <>
      {label && (
        <div className="section-head">
          <span>{label}{reorderable && items.length > 1 && <span className="hint"> · drag to reorder</span>}</span>
        </div>
      )}
      <div className="chip-list">
        {items.map((v, i) => (
          <span
            className={`chip${reorderable ? ' draggable' : ''}${dragI === i ? ' dragging' : ''}`}
            key={v}
            style={colorOf ? tagStyle(colorOf(v)) : undefined}
            draggable={reorderable || undefined}
            onDragStart={reorderable ? () => setDragI(i) : undefined}
            onDragOver={reorderable ? (e) => e.preventDefault() : undefined}
            onDrop={reorderable ? () => moveTo(i) : undefined}
            onDragEnd={reorderable ? () => setDragI(null) : undefined}
          >
            {colorOf && onColorChange && (
              <input
                type="color"
                className="chip-color"
                title={`Color for “${v}”`}
                value={colorOf(v)}
                onChange={(e) => onColorChange(v, e.target.value)}
              />
            )}
            {v}
            <button className="icon-btn" title="Remove" onClick={() => onChange(items.filter((x) => x !== v))}>✕</button>
          </span>
        ))}
        <span className="chip add-chip">
          <input
            value={draft}
            placeholder={placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          <button className="icon-btn" disabled={!draft.trim()} title="Add" onClick={add}>＋</button>
        </span>
      </div>
    </>
  )
}

/** One concern of the Settings dialog: title and description on the left, its controls on the right. */
function SettingsRow({ title, desc, children }: { title: string; desc?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-row-label">
        <h4 className="settings-title">{title}</h4>
        {desc && <p className="settings-desc">{desc}</p>}
      </div>
      <div className="settings-row-body">{children}</div>
    </div>
  )
}

export function SettingsDialog({
  settings,
  onSave,
  onClose,
  program = false,
}: {
  settings: Settings
  onSave: (settings: Partial<Settings>) => void
  onClose: () => void
  /** the Program team: no people, features or calendar of its own, so only the timeline and the roadmap colours apply */
  program?: boolean
}) {
  const [projectStart, setProjectStart] = useState(settings.projectStart)
  const [horizonWeeks, setHorizonWeeks] = useState(settings.horizonWeeks)
  const [hoursPerWeek, setHoursPerWeek] = useState(settings.hoursPerWeek)
  const [profiles, setProfiles] = useState<string[]>([...settings.profiles])
  const [statuses, setStatuses] = useState<string[]>([...settings.featureStatuses])
  const [customers, setCustomers] = useState<string[]>([...settings.customers])
  const [linkCategories, setLinkCategories] = useState<string[]>([...settings.linkCategories])
  const [calendarUrl, setCalendarUrl] = useState(settings.calendarUrl ?? '')
  const [colors, setColors] = useState<OptionColors>(() => structuredClone(settings.optionColors ?? {}))

  /** effective color incl. built-in fallbacks; neutral grey for brand-new values */
  const colorOf = (list: OptionListKey) => (v: string) => optionColor(colors, list, v) ?? '#64748b'
  const setColor = (list: OptionListKey) => (v: string, color: string) =>
    setColors((c) => ({ ...c, [list]: { ...c[list], [v]: color } }))

  const calendarOk = !calendarUrl.trim() || isCalendarUrl(calendarUrl.trim())
  const valid = !!projectStart && horizonWeeks > 0 && hoursPerWeek > 0 && calendarOk

  return (
    <Modal title="Settings" onClose={onClose} className="settings-modal" storageKey="settings2">
      <SettingsRow title="Project" desc={program ? "The Program roadmap's first week and how far it runs by default; the axis widens to cover every team." : "The plan's first week, how far it runs, and what one person-week is worth."}>
        <div className="form-grid">
          <label className="field">
            Project start
            <span className="people-inline">
              <input type="date" value={projectStart} onChange={(e) => e.target.value && setProjectStart(mondayOf(e.target.value))} />
              <span className="hint">W{isoWeekNum(projectStart)}</span>
            </span>
            <span className="settings-help">A Monday — the grid's first column.</span>
          </label>
          <label className="field">
            Horizon (weeks)
            <input type="number" min={1} value={horizonWeeks} onChange={(e) => setHorizonWeeks(Number(e.target.value))} />
            <span className="settings-help">Weeks the grid shows; it extends when work is booked later.</span>
          </label>
          {!program && (
            <label className="field">
              Hours per person-week
              <input type="number" min={1} value={hoursPerWeek} onChange={(e) => setHoursPerWeek(Number(e.target.value))} />
              <span className="settings-help">What a person at 100% books on a feature in one week ({hoursPerWeek}h). Balance = estimate − booked hours.</span>
            </label>
          )}
        </div>
      </SettingsRow>
      {!program && (
      <SettingsRow
        title="Feature statuses"
        desc="The workflow a feature moves through. Closed and Rejected count as finished; Blocked feeds the Capacity tab's Needs attention list. Drag to reorder, click a swatch to recolour."
      >
        <ChipListEditor items={statuses} onChange={setStatuses} placeholder="Add status…" reorderable colorOf={colorOf('featureStatuses')} onColorChange={setColor('featureStatuses')} />
      </SettingsRow>
      )}
      {!program && (
      <SettingsRow title="Customers" desc="Who a feature is for — a Group-by option and a filter in the planner. Tags take the colour set here.">
        <ChipListEditor items={customers} onChange={setCustomers} placeholder="Add customer…" reorderable colorOf={colorOf('customers')} onColorChange={setColor('customers')} />
      </SettingsRow>
      )}
      <SettingsRow title="Roadmap status colours" desc="The Roadmap paints its bars and legend in these; a bar can still be given its own colour.">
        <div className="chip-list">
          {ROADMAP_STATUSES.map((v) => (
            <span className="chip" key={v} style={tagStyle(colorOf('roadmapStatuses')(v))}>
              <input type="color" className="chip-color" title={`Colour for “${v}”`} value={colorOf('roadmapStatuses')(v)} onChange={(e) => setColor('roadmapStatuses')(v, e.target.value)} />
              {v}
            </span>
          ))}
        </div>
      </SettingsRow>
      {!program && (
      <SettingsRow title="Profiles" desc="Roles offered in the People dialog.">
        <ChipListEditor items={profiles} onChange={setProfiles} placeholder="Add profile…" />
      </SettingsRow>
      )}
      {!program && (
      <SettingsRow title="Link categories" desc="How a feature's links are grouped in its dialog. Drag to reorder.">
        <ChipListEditor items={linkCategories} onChange={setLinkCategories} placeholder="Add link category…" reorderable />
        <p className="settings-help">Removing a value from any of these lists doesn't touch the features that use it — they keep it, and it stays selectable for them until changed.</p>
      </SettingsRow>
      )}
      {!program && (
      <SettingsRow title="Vacation calendar" desc="The server pulls this public .ics feed on start, every few hours and on ⚙ Settings → Sync vacations now, and writes the away periods.">
        <label className="field">
          Public calendar link (.ics)
          <input
            type="url"
            value={calendarUrl}
            placeholder="https://calendar.google.com/calendar/ical/…/public/basic.ics"
            onChange={(e) => setCalendarUrl(e.target.value)}
          />
        </label>
        {!calendarOk && <p className="hint err">The link must start with https://</p>}
        <p className="settings-help">Events titled “Name - Vacation” (or Sick, Parental, Training, Public holiday, Other) go to that person, matched by name or Calendar name.</p>
        <p className="settings-help">An event with no name, or a National holiday shared by most of the calendar, is a public holiday for everyone.</p>
        <p className="settings-help">Leave empty to switch the sync off.</p>
      </SettingsRow>
      )}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button
          className="btn primary"
          disabled={!valid}
          onClick={() => {
            onSave(
              program
                ? { projectStart, horizonWeeks, optionColors: colors }
                : { projectStart, horizonWeeks, hoursPerWeek, profiles, featureStatuses: statuses, customers, linkCategories, optionColors: colors, calendarUrl: calendarUrl.trim() || undefined },
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
