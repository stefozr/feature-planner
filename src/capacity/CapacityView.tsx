import { Fragment, useEffect, useMemo, useState } from 'react'
import { AwayEntry, DB, Feature, KIND_LABEL, Person, hasLeft, isBlockedStatus, isFinishedStatus, isResigned, optionColor, tagStyle } from '../types'
import {
  availablePct,
  awayPct,
  defaultKindFor,
  derivedEndWeek,
  featureBalance,
  featureHours,
  featureProgress,
  fmtNum,
  gridWeeks,
  isoWeekNum,
  mondayOf,
  monthGroups,
  personLoad,
  personShort,
  personWeekState,
  resignedTitle,
  rollupProgress,
  scheduleDelta,
  scheduleStatus,
  weekFte,
  weekLabel,
  weeksBetween,
  weekTag,
} from '../logic'
import { PersonWeekPopover } from '../grid/CellPopover'
import { Bar } from '../ui/fields'
import { usePersisted } from '../ui/usePersisted'
import { useTip, type TipAttach } from '../ui/useTip'
import type { CapacityCard } from '../ui/useHashRoute'
import './capacity.css'

interface Props {
  db: DB
  todayISO: string
  /** the app-wide switch: a leaver already gone with nothing booked in the shown weeks gets no row */
  hideResigned: boolean
  colorOf: (hex: string | undefined) => string | undefined
  /** open the feature's dialog (Team load popover, Scope Overview rows) */
  onOpenFeature: (id: string) => void
  /** go to the feature's row in the planner (Needs attention) — a history entry, so Back returns to that card */
  onFocusFeature: (id: string) => void
  /** the same, from a Scope Overview feature or epic name — Back returns to the Scope Overview */
  onScopeFeature: (id: string) => void
  onScopeEpic: (id: string) => void
  /** where the route says to land: one of the cards, or nowhere */
  scrollTo: CapacityCard | null
  readOnly: boolean
  onMarkAway: (personId: string, entry: AwayEntry) => void
  onEditPerson: (personId: string) => void
}

const TEAM_LABEL_W = 260
const TEAM_COL_W = 64

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

/**
 * One person-week of Team load: % of the week booked, coloured by state (as in the Excel's block).
 * Hovering shows the view's plate (`attach`, from useTip) with the load against the availability;
 * a click hides it first, so it never sits frozen over the features popover.
 */
function PersonCell({
  db,
  person,
  week,
  className,
  attach,
  onHide,
  onClick,
}: {
  db: DB
  person: Person
  week: string
  className: string
  attach: TipAttach
  onHide: () => void
  onClick: (e: React.MouseEvent) => void
}) {
  const state = personWeekState(db, person, week)
  const load = personLoad(db, person.id, week)
  const avail = availablePct(person, week)
  const away = awayPct(person, week)
  const tip = (
    <>
      <b>
        {person.name} · {weekTag(week)} · {weekLabel(week)}
      </b>
      <div>
        Booked <span className={state === 'over' ? 'tip-over' : undefined}>{Math.round(load.pct)}%</span> of {Math.round(avail)}% available
      </div>
      {away > 0 && <div>Away {away}% of the week</div>}
      {load.featureIds.length > 0 ? (
        <div className="tip-muted">{plural(load.featureIds.length, 'feature')} — click for details</div>
      ) : (
        <div className="tip-muted">{state === 'off' ? 'Not on the project this week' : 'Nobody booked'}</div>
      )}
    </>
  )
  return (
    <td
      className={`${className} pcell st-${state}${away > 0 && state !== 'away' ? ' part-away' : ''}`}
      {...attach(tip)}
      onClick={(e) => {
        onHide()
        onClick(e)
      }}
    >
      {state === 'away' ? 'away' : state === 'off' ? '' : load.pct > 0 ? `${Math.round(load.pct)}%` : '·'}
    </td>
  )
}

export default function CapacityView({
  db,
  todayISO,
  hideResigned,
  colorOf,
  onOpenFeature,
  onFocusFeature,
  onScopeFeature,
  onScopeEpic,
  scrollTo,
  readOnly,
  onMarkAway,
  onEditPerson,
}: Props) {
  const s = db.settings
  const today = mondayOf(todayISO)
  // the view's one hover plate: the chart columns and the Team load cells share it
  const { attach, hide: hideTip, element: tipEl } = useTip()
  // The planner's week axis. Each chart has its own "From today" checkbox (remembered per browser)
  // that trims its axis to start 4 weeks before today, like the planner's toggle; the headline
  // tiles always read the full span.
  const weeks = useMemo(() => gridWeeks(db, todayISO, false), [db, todayISO])
  const [fteFromToday, setFteFromToday] = usePersisted<boolean>('feature-planner:cvFteFromToday', false)
  const [teamFromToday, setTeamFromToday] = usePersisted<boolean>('feature-planner:cvTeamFromToday', false)
  const fteWeeks = useMemo(() => gridWeeks(db, todayISO, fteFromToday), [db, todayISO, fteFromToday])
  const teamWeeks = useMemo(() => gridWeeks(db, todayISO, teamFromToday), [db, todayISO, teamFromToday])
  // Scope Overview: epics opened to show their features. Persisted like the grid's expansion, so a
  // jump to the planner and Back (which remounts this view) finds the table as it was left.
  const [scopeOpen, setScopeOpen] = usePersisted<string[]>('feature-planner:scopeOpen', [])
  const openEpics = useMemo(() => new Set(scopeOpen), [scopeOpen])
  const toggleEpic = (id: string) => setScopeOpen((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  // Back from the planner remounts this view with the route still pointing at a card
  useEffect(() => {
    if (!scrollTo) return
    const raf = requestAnimationFrame(() => document.getElementById(scrollTo)?.scrollIntoView({ block: 'start' }))
    return () => cancelAnimationFrame(raf)
  }, [scrollTo])
  /** the Team load cell whose features / away popover is open */
  const [pw, setPw] = useState<{ x: number; y: number; personId: string; week: string } | null>(null)
  const pwPerson = pw ? db.people.find((p) => p.id === pw.personId) : undefined

  // ----- headline numbers -----
  const overall = rollupProgress(db.features)
  const overbooked = useMemo(() => {
    const out: { person: string; week: string; load: number; avail: number }[] = []
    for (const w of weeks) {
      if (w < today) continue
      for (const p of db.people) {
        if (personWeekState(db, p, w) === 'over') out.push({ person: personShort(p), week: w, load: personLoad(db, p.id, w).pct, avail: availablePct(p, w) })
      }
    }
    return out
  }, [db, weeks, today])

  const releases = db.releases.map((r) => {
    const fs = db.features.filter((f) => f.releaseId === r.id)
    const roll = rollupProgress(fs)
    const byStatus = new Map<string, number>()
    for (const f of fs) byStatus.set(f.status ?? '—', (byStatus.get(f.status ?? '—') ?? 0) + 1)
    const nextMs = db.milestones
      .filter((m) => m.releaseId === r.id && m.date >= todayISO)
      .sort((a, b) => a.date.localeCompare(b.date))[0]
    const late = fs.filter((f) => !isFinishedStatus(f.status) && r.date && (derivedEndWeek(f) ?? '') > mondayOf(r.date))
    return { r, fs, roll, byStatus, nextMs, late }
  })

  // ----- weekly load -----
  const fte = fteWeeks.map((w) => ({ w, ...weekFte(db, w) }))
  /** the hover plate for one chart column: the week's totals, then everyone booked with their load vs availability */
  const colTip = (f: (typeof fte)[number]) => {
    const booked = f.dev + f.test + f.buffer
    const over = booked > f.available + 0.05
    const people = db.people
      .map((p) => ({ p, load: personLoad(db, p.id, f.w).pct, avail: availablePct(p, f.w), state: personWeekState(db, p, f.w) }))
      .filter((x) => x.load > 0)
      .sort((a, b) => b.load - a.load || personShort(a.p).localeCompare(personShort(b.p)))
    return (
      <>
        <b>
          {weekTag(f.w)} · {weekLabel(f.w)}
        </b>
        <div>Available {fmtNum(f.available)} FTE</div>
        <div>
          Booked {fmtNum(booked)} (dev {fmtNum(f.dev)} · test {fmtNum(f.test)} · buffer {fmtNum(f.buffer)})
        </div>
        {over && <div className="tip-over">Over by {fmtNum(booked - f.available)}</div>}
        {people.length === 0 && f.slots === 0 ? (
          <div className="tip-muted">Nobody booked.</div>
        ) : (
          <div className="cv-tip-people">
            {people.map(({ p, load, avail, state }) => (
              <Fragment key={p.id}>
                <span>{personShort(p)}</span>
                <span className={`num${state === 'over' ? ' tip-over' : ''}`}>
                  {Math.round(load)}% of {Math.round(avail)}%{avail <= 0 && awayPct(p, f.w) > 0 ? ' · away' : ''}
                </span>
              </Fragment>
            ))}
            {f.slots > 0 && (
              <>
                <span className="tip-muted">Unnamed slots</span>
                <span className="num tip-muted">{Math.round(f.slots * 100)}%</span>
              </>
            )}
          </div>
        )}
      </>
    )
  }
  const maxY = Math.max(1, ...fte.map((f) => Math.max(f.available, f.dev + f.test + f.buffer)))
  const yMax = Math.ceil(maxY)
  const ticks = [0, Math.round(yMax / 2), yMax]

  // ----- epics -----
  const epicRows = db.epics
    .map((e) => {
      const fs = db.features.filter((f) => f.epicId === e.id)
      const roll = rollupProgress(fs)
      let booked = 0
      let bal = 0
      let anyEst = false
      for (const f of fs) {
        booked += featureHours(f, s).total
        const b = featureBalance(f, s)
        if (b != null) {
          bal += b
          anyEst = true
        }
      }
      return { e, fs, roll, booked, bal: anyEst ? bal : null }
    })
    .filter((x) => x.fs.length)
  const allOpen = epicRows.length > 0 && epicRows.every((x) => openEpics.has(x.e.id))

  // ----- at risk -----
  const openFs = db.features.filter((f) => !isFinishedStatus(f.status))
  const negative = openFs.filter((f) => (featureBalance(f, s) ?? 0) < 0).sort((a, b) => (featureBalance(a, s) ?? 0) - (featureBalance(b, s) ?? 0))
  const unstaffed = openFs.filter(
    (f) => (f.remaining ?? f.estimate ?? 0) > 0 && !Object.entries(f.cells).some(([w, c]) => w >= today && c.entries.length > 0),
  )
  const blocked = openFs.filter((f) => isBlockedStatus(f.status))
  const delayed = openFs
    .map((f) => ({ f, sc: scheduleStatus(f, todayISO) }))
    .filter((x) => x.sc?.status === 'delayed')
    .sort((a, b) => (b.sc?.weeks ?? 0) - (a.sc?.weeks ?? 0))
  const featureLine = (f: Feature, extra: React.ReactNode) => (
    <button key={f.id} className="cv-risk-item" title="Show this feature in the planner" onClick={() => onFocusFeature(f.id)}>
      <span className="jira-key">{f.key ?? ''}</span>
      <span className="cv-risk-name">{f.name}</span>
      <span className="spacer" />
      {extra}
    </button>
  )

  // Team load: the planner's old capacity block — developers / testers, a month + week header
  const byShort = (a: Person, b: Person) => personShort(a).localeCompare(personShort(b))
  // a leaver who has already gone gets no row when hidden — unless they still hold bookings in the
  // shown weeks, which someone has to reassign; those rows stay, with the name struck through
  const shownPeople = db.people.filter(
    (p) => !(hideResigned && hasLeft(p, todayISO) && teamWeeks.every((w) => personLoad(db, p.id, w).pct === 0)),
  )
  const teamGroups = [
    // tester or developer as the cell popover decides it: the stored preference, else the profile
    { key: 'dev', label: 'Developers', people: shownPeople.filter((p) => defaultKindFor(p) !== 'test').sort(byShort) },
    { key: 'test', label: 'Testers', people: shownPeople.filter((p) => defaultKindFor(p) === 'test').sort(byShort) },
  ].filter((g) => g.people.length)
  const teamMonths = monthGroups(teamWeeks)
  const monthStarts = new Set(teamMonths.slice(1).map((m) => m.weeks[0]))
  const teamWeekClass = (w: string) => `${monthStarts.has(w) ? 'month-start' : ''}${w === today ? ' today-col' : ''}`

  return (
    <div className="cv">
      <div className="cv-wrap">
        <div className="cv-tiles">
          <div className="cv-tile">
            <div className="cv-q">Overall progress</div>
            <div className="cv-a">{overall.pct == null ? '—' : `${Math.round(overall.pct * 100)}%`}</div>
            <Bar pct={overall.pct} />
            <div className="cv-m">
              {fmtNum(overall.estimate - overall.remaining)} of {fmtNum(overall.estimate)} h done · {overall.estimated} of {plural(overall.total, 'feature')} estimated
            </div>
          </div>
          {releases.map(({ r, fs, roll, byStatus, nextMs, late }) => (
            <div key={r.id} className="cv-tile" style={{ borderTopColor: colorOf(r.color) }}>
              <div className="cv-q">
                {r.name}
                {r.label && <span className="hint"> · {r.label}</span>}
                {r.date && <span className="hint"> · {weekLabel(r.date)}</span>}
              </div>
              <div className="cv-a">{roll.pct == null ? '—' : `${Math.round(roll.pct * 100)}%`}</div>
              <Bar pct={roll.pct} />
              <div className="cv-m">
                {plural(fs.length, 'feature')} ·{' '}
                {roll.estimated === 0 ? 'none estimated yet' : `${fmtNum(roll.remaining)}h left${roll.estimated < fs.length ? ` · ${fs.length - roll.estimated} unestimated` : ''}`}
              </div>
              {nextMs && (
                <div className="cv-m">
                  ◆ {nextMs.name} in {plural(Math.max(0, weeksBetween(today, mondayOf(nextMs.date))), 'week')}
                </div>
              )}
              {late.length > 0 && <div className="cv-m err">{plural(late.length, 'open feature')} scheduled past the release date</div>}
              <div className="cv-statuses">
                {[...byStatus].map(([st, n]) => (
                  <span key={st} className="tag" style={tagStyle(optionColor(s.optionColors, 'featureStatuses', st))}>
                    {st} {n}
                  </span>
                ))}
              </div>
            </div>
          ))}
          <div className={`cv-tile${overbooked.length ? ' bad' : ' good'}`}>
            <div className="cv-q">Overbooking from today</div>
            <div className="cv-a">{overbooked.length}</div>
            <div className="cv-m">{overbooked.length ? 'person-weeks booked beyond availability' : 'no one is booked beyond their availability'}</div>
            {overbooked.slice(0, 6).map((o) => (
              <div key={o.person + o.week} className="cv-m">
                {o.person} {weekTag(o.week)} — {Math.round(o.load)}% of {o.avail}%
              </div>
            ))}
            {overbooked.length > 6 && <div className="cv-m">…and {overbooked.length - 6} more</div>}
          </div>
        </div>

        <section className="cv-card">
          <div className="cv-head">
            <h2>Booked vs available, per week</h2>
            <div className="cv-legend">
              {(['dev', 'test', 'buffer'] as const).map((k) => (
                <span key={k} className="cv-key"><span className={`cv-sw k-${k}`} />{KIND_LABEL[k]}</span>
              ))}
              <span className="cv-key"><span className="cv-sw line" />Available</span>
            </div>
            <label className="cv-check" title="Start this chart 4 weeks before today">
              <input type="checkbox" checked={fteFromToday} onChange={() => setFteFromToday((v) => !v)} /> From today
            </label>
          </div>
          <p className="hint">FTE per week. A column above the line means more is booked than the team has that week (after away time and time outside the project).</p>
          <div className="cv-chart">
            <div className="cv-yaxis">
              {[...ticks].reverse().map((t) => (
                <span key={t}>{t}</span>
              ))}
            </div>
            <div className="cv-plot">
              {ticks.map((t) => (
                <div key={t} className="cv-grid" style={{ bottom: `${(t / yMax) * 100}%` }} />
              ))}
              <div className="cv-cols">
                {fte.map((f) => {
                  const booked = f.dev + f.test + f.buffer
                  const over = booked > f.available + 0.05
                  return (
                    <div key={f.w} className={`cv-col${f.w === today ? ' today' : ''}`} {...attach(colTip(f))}>
                      <div className="cv-stack" style={{ height: `${(booked / yMax) * 100}%` }}>
                        {f.buffer > 0 && <div className="cv-seg k-buffer" style={{ flexGrow: f.buffer }} />}
                        {f.test > 0 && <div className="cv-seg k-test" style={{ flexGrow: f.test }} />}
                        {f.dev > 0 && <div className="cv-seg k-dev" style={{ flexGrow: f.dev }} />}
                      </div>
                      <div className="cv-avail" style={{ bottom: `${(f.available / yMax) * 100}%` }} />
                      {over && <div className="cv-over-dot" style={{ bottom: `calc(${(booked / yMax) * 100}% + 3px)` }}>!</div>}
                    </div>
                  )
                })}
              </div>
              <div className="cv-xaxis">
                {fte.map((f, i) => (
                  <span key={f.w} className={f.w === today ? 'today' : ''}>{i % 2 === 0 || fte.length < 16 ? weekTag(f.w) : ''}</span>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="cv-card">
          <div className="cv-head">
            <h2>Team load</h2>
            <div className="cv-legend">
              <span className="cv-key"><span className="cv-sw st-unused" />free</span>
              <span className="cv-key"><span className="cv-sw st-used" />booked</span>
              <span className="cv-key"><span className="cv-sw st-over" />over</span>
              <span className="cv-key"><span className="cv-sw st-away" />away</span>
              <span className="cv-key"><span className="cv-sw st-off" />not on the project</span>
            </div>
            <label className="cv-check" title="Start this table 4 weeks before today">
              <input type="checkbox" checked={teamFromToday} onChange={() => setTeamFromToday((v) => !v)} /> From today
            </label>
          </div>
          <div className="cv-team-wrap">
            <table className="cv-team" style={{ width: TEAM_LABEL_W + teamWeeks.length * TEAM_COL_W }}>
              <colgroup>
                <col style={{ width: TEAM_LABEL_W }} />
                {teamWeeks.map((w) => (
                  <col key={w} style={{ width: TEAM_COL_W }} />
                ))}
              </colgroup>
              <thead>
                <tr className="cvt-month-row">
                  <th className="cvt-lbl" rowSpan={2}>
                    <span className="hint">% of each person&apos;s week booked</span>
                  </th>
                  {teamMonths.map((g, i) => (
                    <th key={g.key} colSpan={g.weeks.length} className={`cvt-month${i % 2 ? ' alt' : ''}${i > 0 ? ' month-start' : ''}`}>
                      {g.label}
                    </th>
                  ))}
                </tr>
                <tr className="cvt-week-row">
                  {teamWeeks.map((w) => (
                    <th key={w} className={teamWeekClass(w)} title={`ISO week ${isoWeekNum(w)} · week of ${w}`}>
                      <div>{weekTag(w)}</div>
                      <div className="cvt-date">{w === today ? <span className="today-chip">today</span> : weekLabel(w)}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {teamGroups.map((g) => (
                  <Fragment key={g.key}>
                    <tr className="cvt-group">
                      <th className="cvt-lbl">
                        <span className="cvt-group-label">{g.label}</span>
                        <span className="hint count">{g.people.length}</span>
                      </th>
                      {teamWeeks.map((w) => (
                        <td key={w} className={teamWeekClass(w)} />
                      ))}
                    </tr>
                    {g.people.map((pe) => (
                      <tr key={pe.id} className="cvt-person">
                        <th className="cvt-lbl">
                          <span
                            className={`lbl-link cvt-name${isResigned(pe) ? ' resigned' : ''}`}
                            title={`${pe.name} · ${pe.profile}${isResigned(pe) ? `\n${resignedTitle(pe)}` : ''}\nClick to edit`}
                            onClick={() => onEditPerson(pe.id)}
                          >
                            {personShort(pe)}
                          </span>
                          <span className="hint">&nbsp;{pe.name !== personShort(pe) ? pe.name : ''}</span>
                        </th>
                        {teamWeeks.map((w) => (
                          <PersonCell
                            key={w}
                            db={db}
                            person={pe}
                            week={w}
                            className={teamWeekClass(w)}
                            attach={attach}
                            onHide={hideTip}
                            onClick={(e) => setPw({ x: e.clientX, y: e.clientY, personId: pe.id, week: w })}
                          />
                        ))}
                      </tr>
                    ))}
                  </Fragment>
                ))}
                <tr className="cvt-sum">
                  <th className="cvt-lbl">
                    Available FTE<span className="hint">&nbsp;capacity − away − outside the project</span>
                  </th>
                  {fte.map((f) => (
                    <td key={f.w} className={teamWeekClass(f.w)}>
                      <span className="sum-num">{fmtNum(f.available)}</span>
                    </td>
                  ))}
                </tr>
                <tr className="cvt-sum">
                  <th className="cvt-lbl">
                    Booked FTE<span className="hint">&nbsp;dev · test · buffer</span>
                  </th>
                  {fte.map((f) => (
                    <td
                      key={f.w}
                      className={teamWeekClass(f.w)}
                      {...attach(
                        <>
                          <b>
                            {weekTag(f.w)} · {weekLabel(f.w)} · Booked FTE
                          </b>
                          <div>
                            <span className="k-dev">Dev {fmtNum(f.dev)}</span> · <span className="k-test">Test {fmtNum(f.test)}</span> ·{' '}
                            <span className="k-buffer">Buffer {fmtNum(f.buffer)}</span>
                          </div>
                          {f.slots > 0 && <div className="tip-muted">{fmtNum(f.slots)} FTE on unnamed slots</div>}
                        </>,
                      )}
                    >
                      <span className="sum-stack">
                        {f.dev > 0 && <span className="k-dev">{fmtNum(f.dev)}</span>}
                        {f.test > 0 && <span className="k-test">{fmtNum(f.test)}</span>}
                        {f.buffer > 0 && <span className="k-buffer">{fmtNum(f.buffer)}</span>}
                      </span>
                    </td>
                  ))}
                </tr>
                <tr className="cvt-sum">
                  <th className="cvt-lbl">
                    Free FTE<span className="hint">&nbsp;available − booked</span>
                  </th>
                  {fte.map((f) => {
                    const free = f.available - (f.dev + f.test + f.buffer)
                    return (
                      <td key={f.w} className={teamWeekClass(f.w)}>
                        <span className={`sum-num ${free < -0.05 ? 'neg' : free > 0.05 ? 'pos' : ''}`}>{fmtNum(free)}</span>
                      </td>
                    )
                  })}
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section className="cv-card" id="scope">
          <div className="cv-head">
            <h2>Scope Overview</h2>
            <span className="hint">Progress = hours done / hours estimated · Balance = estimate − booked hours · Click a name to see it in the planner; Back brings you here.</span>
            <span className="spacer" />
            <button className="btn small ghost" onClick={() => setScopeOpen(allOpen ? [] : epicRows.map((x) => x.e.id))}>
              {allOpen ? 'Collapse all' : 'Expand all'}
            </button>
          </div>
          <table className="cv-table cv-scope">
            <thead>
              <tr>
                <th>Description</th>
                <th className="num">Features</th>
                <th className="num">Estimate (h)</th>
                <th className="num">Remaining (h)</th>
                <th>Progress</th>
                <th className="num">Booked (h)</th>
                <th className="num">Balance (h)</th>
              </tr>
            </thead>
            <tbody>
              {epicRows.map(({ e, fs, roll, booked, bal }) => {
                const open = openEpics.has(e.id)
                return (
                  <Fragment key={e.id}>
                    <tr className="cv-epic">
                      <td>
                        <span className="cv-desc">
                          <button className="caret" aria-label={open ? 'Collapse' : 'Expand'} onClick={() => toggleEpic(e.id)}>
                            {open ? '▾' : '▸'}
                          </button>
                          {e.key && <span className="jira-key">{e.key}</span>}
                          <button className="cv-link cv-desc-name" title="Show this package in the planner" onClick={() => onScopeEpic(e.id)}>
                            {e.name}
                          </button>
                        </span>
                      </td>
                      <td className="num">{fs.length}</td>
                      <td className="num">{roll.estimated ? fmtNum(roll.estimate) : '—'}</td>
                      <td className="num">{roll.estimated ? fmtNum(roll.remaining) : '—'}</td>
                      <td>
                        <span className="cv-prog">
                          <Bar pct={roll.pct} />
                          <span>{roll.pct == null ? '—' : `${Math.round(roll.pct * 100)}%`}</span>
                        </span>
                      </td>
                      <td className="num">{fmtNum(booked)}</td>
                      <td className={`num ${bal != null && bal < 0 ? 'neg' : ''}`}>{bal == null ? '—' : Math.round(bal)}</td>
                    </tr>
                    {open &&
                      fs.map((f) => {
                        const prog = featureProgress(f)
                        const fBal = featureBalance(f, s)
                        const remaining = isFinishedStatus(f.status) ? 0 : f.remaining ?? f.estimate
                        return (
                          <tr key={f.id} className="cv-sub">
                            <td>
                              <span className="cv-desc">
                                {f.key && <span className="jira-key">{f.key}</span>}
                                <button className="cv-link cv-desc-name" title="Show this feature in the planner" onClick={() => onScopeFeature(f.id)}>
                                  {f.name}
                                </button>
                              </span>
                            </td>
                            <td className="num">
                              <span className="cv-tags">
                                <span className="tag" style={tagStyle(optionColor(s.optionColors, 'featureStatuses', f.status ?? ''))}>
                                  {f.status ?? '—'}
                                </span>
                                {f.customer && (
                                  <span className="tag" style={tagStyle(optionColor(s.optionColors, 'customers', f.customer))}>
                                    {f.customer}
                                  </span>
                                )}
                              </span>
                            </td>
                            <td className="num">{f.estimate != null ? fmtNum(f.estimate) : '—'}</td>
                            <td className="num">{remaining != null ? fmtNum(remaining) : '—'}</td>
                            <td>
                              <span className="cv-prog">
                                <Bar pct={prog} />
                                <span>{prog == null ? '—' : `${Math.round(prog * 100)}%`}</span>
                              </span>
                            </td>
                            <td className="num">{fmtNum(featureHours(f, s).total)}</td>
                            <td className={`num ${fBal != null && fBal < 0 ? 'neg' : ''}`}>{fBal == null ? '—' : Math.round(fBal)}</td>
                          </tr>
                        )
                      })}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </section>

        <section className="cv-card" id="attention">
          <div className="cv-head">
            <h2>Needs attention</h2>
            <span className="hint">Click an item to see it in the planner; Back brings you here.</span>
          </div>
          <div className="cv-risks">
            <div>
              <h3>Booked beyond estimate · {negative.length}</h3>
              {negative.length === 0 && <p className="hint">None.</p>}
              {negative.map((f) => featureLine(f, <span className="bal neg">{Math.round(featureBalance(f, s) ?? 0)}h</span>))}
            </div>
            <div>
              <h3>Work left, nobody booked from today · {unstaffed.length}</h3>
              {unstaffed.length === 0 && <p className="hint">None.</p>}
              {unstaffed.map((f) => featureLine(f, <span className="hint">{fmtNum(f.remaining ?? f.estimate ?? 0)}h</span>))}
            </div>
            <div>
              <h3>Delayed · {delayed.length}</h3>
              {delayed.length === 0 && <p className="hint">None — every open feature with a plan is on or ahead of it.</p>}
              {delayed.map(({ f, sc }) =>
                featureLine(
                  f,
                  <span className="sched delayed" title={sc?.overdue ? 'Past its planned end with work still open' : 'Expected to end after its planned end'}>
                    {scheduleDelta(sc?.weeks ?? 0)}
                  </span>,
                ),
              )}
            </div>
            <div>
              <h3>Blocked · {blocked.length}</h3>
              {blocked.length === 0 && <p className="hint">None.</p>}
              {blocked.map((f) => featureLine(f, <span className="hint">{f.remaining != null ? `${fmtNum(f.remaining)}h left` : ''}</span>))}
            </div>
          </div>
        </section>
      </div>
      {tipEl}
      {pw && pwPerson && (
        <PersonWeekPopover
          x={pw.x}
          y={pw.y}
          db={db}
          person={pwPerson}
          week={pw.week}
          readOnly={readOnly}
          onClose={() => setPw(null)}
          onFocusFeature={(fid) => {
            setPw(null)
            onOpenFeature(fid)
          }}
          onMarkAway={(entry) => {
            onMarkAway(pwPerson.id, entry)
            setPw(null)
          }}
          onEdit={() => {
            setPw(null)
            onEditPerson(pwPerson.id)
          }}
        />
      )}
    </div>
  )
}
