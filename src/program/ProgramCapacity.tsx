import { Fragment, useEffect, useMemo } from 'react'
import { DB, Feature, isBlockedStatus, isFinishedStatus, optionColor, tagStyle } from '../types'
import { availablePct, featureBalance, featureHours, featureProgress, fmtNum, isoWeekNum, monthGroups, mondayOf, personLoad, personShort, personWeekState, rollupProgress, scheduleDelta, scheduleStatus, weekLabel, weekTag, weeksBetween, derivedEndWeek } from '../logic'
import { Bar } from '../ui/fields'
import { usePersisted } from '../ui/usePersisted'
import { useTip } from '../ui/useTip'
import type { CapacityCard, View } from '../ui/useHashRoute'
import FteChart from '../capacity/FteChart'
import { ProgramFeature, TeamDoc, TeamLoad, flattenFeatures, programWeeks, teamLoad } from './aggregate'
import '../capacity/capacity.css'

interface Props {
  teams: TeamDoc[]
  program: DB
  todayISO: string
  colorOf: (hex: string | undefined) => string | undefined
  scrollTo: CapacityCard | null
  onGoFeature: (teamId: string, featureId: string) => void
  onGoTeam: (teamId: string, view: View) => void
}

const TEAM_LABEL_W = 260
const TEAM_COL_W = 72
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

/** The Program's Capacity tab: the teams instead of the people, every team's features below. */
export default function ProgramCapacity({ teams, program, todayISO, colorOf, scrollTo, onGoFeature, onGoTeam }: Props) {
  const today = mondayOf(todayISO)
  const { attach, element: tipEl } = useTip()
  const [fteFromToday, setFteFromToday] = usePersisted<boolean>('feature-planner:program:cvFteFromToday', false)
  const [teamFromToday, setTeamFromToday] = usePersisted<boolean>('feature-planner:program:cvTeamFromToday', false)
  const [scopeOpen, setScopeOpen] = usePersisted<string[]>('feature-planner:program:scopeOpen', [])
  const openSet = useMemo(() => new Set(scopeOpen), [scopeOpen])
  const toggle = (id: string) => setScopeOpen((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  const weeks = useMemo(() => programWeeks(teams, program, todayISO, false), [teams, program, todayISO])
  const fteWeeks = useMemo(() => programWeeks(teams, program, todayISO, fteFromToday), [teams, program, todayISO, fteFromToday])
  const teamWeeks = useMemo(() => programWeeks(teams, program, todayISO, teamFromToday), [teams, program, todayISO, teamFromToday])
  useEffect(() => {
    if (!scrollTo) return
    const raf = requestAnimationFrame(() => document.getElementById(scrollTo)?.scrollIntoView({ block: 'start' }))
    return () => cancelAnimationFrame(raf)
  }, [scrollTo])

  const all = useMemo(() => flattenFeatures(teams), [teams])
  const teamTag = (t: TeamDoc) => (
    <span className="pg-team-tag" title={t.name}>
      {t.name}
    </span>
  )

  // ----- headline numbers -----
  const overall = rollupProgress(all.map((x) => x.feature))
  const overbooked = useMemo(() => {
    const out: { team: TeamDoc; person: string; week: string; load: number; avail: number }[] = []
    for (const t of teams) {
      for (const w of weeks) {
        if (w < today) continue
        for (const p of t.db.people) {
          if (personWeekState(t.db, p, w) === 'over') out.push({ team: t, person: personShort(p), week: w, load: personLoad(t.db, p.id, w).pct, avail: availablePct(p, w) })
        }
      }
    }
    return out
  }, [teams, weeks, today])
  const teamTiles = teams.map((t) => {
    const fs = t.db.features
    const roll = rollupProgress(fs)
    const open = fs.filter((f) => !isFinishedStatus(f.status))
    const delayed = open.filter((f) => scheduleStatus(f, todayISO)?.status === 'delayed').length
    const blocked = open.filter((f) => isBlockedStatus(f.status)).length
    const over = overbooked.filter((o) => o.team.id === t.id).length
    const nextRelease = t.db.releases.filter((r) => r.date && r.date >= todayISO).sort((a, b) => a.date!.localeCompare(b.date!))[0]
    return { t, fs, roll, delayed, blocked, over, nextRelease }
  })

  // ----- weekly load, every team summed -----
  const loads = useMemo(() => {
    const m = new Map<string, Map<string, TeamLoad>>()
    for (const t of teams) m.set(t.id, new Map(weeks.map((w) => [w, teamLoad(t, w)])))
    return m
  }, [teams, weeks])
  const loadOf = (t: TeamDoc, w: string): TeamLoad => loads.get(t.id)?.get(w) ?? teamLoad(t, w)
  const sum = (w: string) => {
    const s = { w, available: 0, dev: 0, test: 0, buffer: 0, slots: 0 }
    for (const t of teams) {
      const l = loadOf(t, w)
      s.available += l.available
      s.dev += l.dev
      s.test += l.test
      s.buffer += l.buffer
      s.slots += l.slots
    }
    return s
  }
  const fte = fteWeeks.map(sum)
  const tableFte = teamWeeks.map(sum)
  const colTip = (f: (typeof fte)[number]) => {
    const booked = f.dev + f.test + f.buffer
    return (
      <>
        <b>
          {weekTag(f.w)} · {weekLabel(f.w)}
        </b>
        <div>Available {fmtNum(f.available)} FTE</div>
        <div>
          Booked {fmtNum(booked)} (dev {fmtNum(f.dev)} · test {fmtNum(f.test)} · buffer {fmtNum(f.buffer)})
        </div>
        {booked > f.available + 0.05 && <div className="tip-over">Over by {fmtNum(booked - f.available)}</div>}
        <div className="cv-tip-people">
          {teams.map((t) => {
            const l = loadOf(t, f.w)
            return (
              <Fragment key={t.id}>
                <span>{t.name}</span>
                <span className={`num${l.over ? ' tip-over' : ''}`}>
                  {fmtNum(l.booked)} of {fmtNum(l.available)}
                </span>
              </Fragment>
            )
          })}
          {f.slots > 0 && (
            <>
              <span className="tip-muted">Unnamed slots</span>
              <span className="num tip-muted">{fmtNum(f.slots)}</span>
            </>
          )}
        </div>
      </>
    )
  }

  // ----- scope: team → package → feature -----
  const scope = teams.map((t) => {
    const s = t.db.settings
    const epics = t.db.epics
      .map((e) => {
        const fs = t.db.features.filter((f) => f.epicId === e.id)
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
    const roll = rollupProgress(t.db.features)
    const booked = epics.reduce((a, x) => a + x.booked, 0)
    const bal = epics.some((x) => x.bal != null) ? epics.reduce((a, x) => a + (x.bal ?? 0), 0) : null
    return { t, epics, roll, booked, bal }
  })
  const allKeys = scope.flatMap((x) => [x.t.id, ...x.epics.map((e) => `${x.t.id}:${e.e.id}`)])
  const allOpen = allKeys.length > 0 && allKeys.every((k) => openSet.has(k))

  // ----- needs attention, across teams -----
  const openFs = all.filter((x) => !isFinishedStatus(x.feature.status))
  const balanceOf = (x: ProgramFeature) => featureBalance(x.feature, x.team.db.settings)
  const negative = openFs.filter((x) => (balanceOf(x) ?? 0) < 0).sort((a, b) => (balanceOf(a) ?? 0) - (balanceOf(b) ?? 0))
  const unstaffed = openFs.filter(({ feature: f }) => (f.remaining ?? f.estimate ?? 0) > 0 && !Object.entries(f.cells).some(([w, c]) => w >= today && c.entries.length > 0))
  const blocked = openFs.filter((x) => isBlockedStatus(x.feature.status))
  const delayed = openFs
    .map((x) => ({ x, sc: scheduleStatus(x.feature, todayISO) }))
    .filter((y) => y.sc?.status === 'delayed')
    .sort((a, b) => (b.sc?.weeks ?? 0) - (a.sc?.weeks ?? 0))
  const featureLine = (x: ProgramFeature, extra: React.ReactNode) => (
    <button key={x.key} className="cv-risk-item" title={`Show this feature in ${x.team.name}'s planner`} onClick={() => onGoFeature(x.team.id, x.feature.id)}>
      {teamTag(x.team)}
      <span className="jira-key">{x.feature.key ?? ''}</span>
      <span className="cv-risk-name">{x.feature.name}</span>
      <span className="spacer" />
      {extra}
    </button>
  )

  const months = monthGroups(teamWeeks)
  const monthStarts = new Set(months.slice(1).map((m) => m.weeks[0]))
  const weekClass = (w: string) => `${monthStarts.has(w) ? 'month-start' : ''}${w === today ? ' today-col' : ''}`
  const loadCell = (t: TeamDoc, w: string) => {
    const l = loadOf(t, w)
    const state = l.over ? 'st-over' : l.booked > 0 ? 'st-used' : l.available > 0 ? 'st-unused' : 'st-off'
    const tip = (
      <>
        <b>
          {t.name} · {weekTag(w)} · {weekLabel(w)}
        </b>
        <div>
          Booked <span className={l.over ? 'tip-over' : undefined}>{fmtNum(l.booked)}</span> of {fmtNum(l.available)} FTE available
        </div>
        <div className="tip-muted">
          dev {fmtNum(l.dev)} · test {fmtNum(l.test)} · buffer {fmtNum(l.buffer)}
          {l.slots > 0 ? ` · ${fmtNum(l.slots)} on unnamed slots` : ''}
        </div>
        <div className="tip-muted">Click to open the team's Capacity tab</div>
      </>
    )
    return (
      <td key={w} className={`${weekClass(w)} pg-load ${state}`} {...attach(tip)} onClick={() => onGoTeam(t.id, 'capacity')}>
        {l.available === 0 && l.booked === 0 ? '' : (
          <>
            {fmtNum(l.booked)}
            <span className="pg-avail"> / {fmtNum(l.available)}</span>
          </>
        )}
      </td>
    )
  }

  const featureRow = (t: TeamDoc, f: Feature) => {
    const s = t.db.settings
    const prog = featureProgress(f)
    const fBal = featureBalance(f, s)
    const remaining = isFinishedStatus(f.status) ? 0 : f.remaining ?? f.estimate
    return (
      <tr key={`${t.id}:${f.id}`} className="cv-sub">
        <td>
          <span className="cv-desc" style={{ paddingLeft: 22 }}>
            {f.key && <span className="jira-key">{f.key}</span>}
            <button className="cv-link cv-desc-name" title={`Show this feature in ${t.name}'s planner`} onClick={() => onGoFeature(t.id, f.id)}>
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
  }
  const sumRow = (key: string, open: boolean, onToggle: () => void, name: React.ReactNode, n: number, roll: ReturnType<typeof rollupProgress>, booked: number, bal: number | null, cls: string, indent = 0) => (
    <tr key={key} className={cls}>
      <td>
        <span className="cv-desc" style={{ paddingLeft: indent }}>
          <button className="caret" aria-label={open ? 'Collapse' : 'Expand'} onClick={onToggle}>
            {open ? '▾' : '▸'}
          </button>
          {name}
        </span>
      </td>
      <td className="num">{n}</td>
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
  )

  return (
    <div className="cv">
      <div className="cv-wrap">
        <div className="cv-tiles">
          <div className="cv-tile">
            <div className="cv-q">Overall progress · {plural(teams.length, 'team')}</div>
            <div className="cv-a">{overall.pct == null ? '—' : `${Math.round(overall.pct * 100)}%`}</div>
            <Bar pct={overall.pct} />
            <div className="cv-m">
              {fmtNum(overall.estimate - overall.remaining)} of {fmtNum(overall.estimate)} h done · {overall.estimated} of {plural(overall.total, 'feature')} estimated
            </div>
          </div>
          {teamTiles.map(({ t, fs, roll, delayed, blocked, over, nextRelease }) => (
            <div key={t.id} className="cv-tile" style={{ cursor: 'pointer', borderTopColor: colorOf(nextRelease?.color) }} title={`Open ${t.name}'s Capacity tab`} onClick={() => onGoTeam(t.id, 'capacity')}>
              <div className="cv-q">{t.name}</div>
              <div className="cv-a">{roll.pct == null ? '—' : `${Math.round(roll.pct * 100)}%`}</div>
              <Bar pct={roll.pct} />
              <div className="cv-m">
                {plural(fs.length, 'feature')} · {plural(t.db.people.length, 'person').replace('persons', 'people')} ·{' '}
                {roll.estimated === 0 ? 'none estimated yet' : `${fmtNum(roll.remaining)}h left`}
              </div>
              {nextRelease && (
                <div className="cv-m">
                  ⚑ {nextRelease.name} in {plural(Math.max(0, weeksBetween(today, mondayOf(nextRelease.date!))), 'week')}
                </div>
              )}
              {(delayed > 0 || blocked > 0 || over > 0) && (
                <div className="cv-m err">
                  {[delayed ? `${delayed} delayed` : '', blocked ? `${blocked} blocked` : '', over ? `${over} overbooked person-week${over === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')}
                </div>
              )}
            </div>
          ))}
          <div className={`cv-tile${overbooked.length ? ' bad' : ' good'}`}>
            <div className="cv-q">Overbooking from today</div>
            <div className="cv-a">{overbooked.length}</div>
            <div className="cv-m">{overbooked.length ? 'person-weeks booked beyond availability, all teams' : 'no one is booked beyond their availability'}</div>
            {overbooked.slice(0, 6).map((o) => (
              <div key={o.team.id + o.person + o.week} className="cv-m">
                {o.team.name} · {o.person} {weekTag(o.week)} — {Math.round(o.load)}% of {o.avail}%
              </div>
            ))}
            {overbooked.length > 6 && <div className="cv-m">…and {overbooked.length - 6} more</div>}
          </div>
        </div>

        <FteChart
          title="Booked vs available, per week — all teams"
          hint="FTE per week, every team summed. A column above the line means more is booked than the teams have that week. Hover a column for the split per team."
          columns={fte}
          today={today}
          tip={colTip}
          attach={attach}
          fromToday={fteFromToday}
          onFromToday={setFteFromToday}
        />

        <section className="cv-card">
          <div className="cv-head">
            <h2>Team load</h2>
            <div className="cv-legend">
              <span className="cv-key"><span className="cv-sw st-unused" />nothing booked</span>
              <span className="cv-key"><span className="cv-sw st-used" />booked</span>
              <span className="cv-key"><span className="cv-sw st-over" />over</span>
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
                    <span className="hint">booked / available FTE per team</span>
                  </th>
                  {months.map((g, i) => (
                    <th key={g.key} colSpan={g.weeks.length} className={`cvt-month${i % 2 ? ' alt' : ''}${i > 0 ? ' month-start' : ''}`}>
                      {g.label}
                    </th>
                  ))}
                </tr>
                <tr className="cvt-week-row">
                  {teamWeeks.map((w) => (
                    <th key={w} className={weekClass(w)} title={`ISO week ${isoWeekNum(w)} · week of ${w}`}>
                      <div>{weekTag(w)}</div>
                      <div className="cvt-date">{w === today ? <span className="today-chip">today</span> : weekLabel(w)}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {teams.map((t) => (
                  <tr key={t.id} className="cvt-person">
                    <th className="cvt-lbl">
                      <span className="lbl-link cvt-name" title={`${t.name} · ${plural(t.db.people.length, 'person').replace('persons', 'people')}\nClick to open its Capacity tab`} onClick={() => onGoTeam(t.id, 'capacity')}>
                        {t.name}
                      </span>
                      <span className="hint">&nbsp;{plural(t.db.people.length, 'person').replace('persons', 'people')}</span>
                    </th>
                    {teamWeeks.map((w) => loadCell(t, w))}
                  </tr>
                ))}
                {teams.length === 0 && (
                  <tr>
                    <td className="hint" colSpan={teamWeeks.length + 1} style={{ padding: 12 }}>
                      No teams yet.
                    </td>
                  </tr>
                )}
                <tr className="cvt-sum">
                  <th className="cvt-lbl">
                    Available FTE<span className="hint">&nbsp;all teams</span>
                  </th>
                  {tableFte.map((f) => (
                    <td key={f.w} className={weekClass(f.w)}>
                      <span className="sum-num">{fmtNum(f.available)}</span>
                    </td>
                  ))}
                </tr>
                <tr className="cvt-sum">
                  <th className="cvt-lbl">
                    Booked FTE<span className="hint">&nbsp;dev · test · buffer</span>
                  </th>
                  {tableFte.map((f) => (
                    <td key={f.w} className={weekClass(f.w)}>
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
                  {tableFte.map((f) => {
                    const free = f.available - (f.dev + f.test + f.buffer)
                    return (
                      <td key={f.w} className={weekClass(f.w)}>
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
            <span className="hint">Every team's packages and features. Progress = hours done / hours estimated · Balance = estimate − booked hours (at that team's hours per week) · Click a name to open it in its team.</span>
            <span className="spacer" />
            <button className="btn small ghost" onClick={() => setScopeOpen(allOpen ? [] : allKeys)}>
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
              {scope.map(({ t, epics, roll, booked, bal }) => {
                const tOpen = openSet.has(t.id)
                return (
                  <Fragment key={t.id}>
                    {sumRow(
                      t.id,
                      tOpen,
                      () => toggle(t.id),
                      <button className="cv-link cv-desc-name" title={`Open ${t.name}'s Capacity tab`} onClick={() => onGoTeam(t.id, 'capacity')}>
                        {t.name}
                      </button>,
                      t.db.features.length,
                      roll,
                      booked,
                      bal,
                      'cv-epic pg-scope-team',
                    )}
                    {tOpen &&
                      epics.map((x) => {
                        const k = `${t.id}:${x.e.id}`
                        const open = openSet.has(k)
                        return (
                          <Fragment key={k}>
                            {sumRow(
                              k,
                              open,
                              () => toggle(k),
                              <>
                                {x.e.key && <span className="jira-key">{x.e.key}</span>}
                                <button className="cv-link cv-desc-name" title={`Show this package in ${t.name}'s planner`} onClick={() => onGoTeam(t.id, 'planner')}>
                                  {x.e.name}
                                </button>
                              </>,
                              x.fs.length,
                              x.roll,
                              x.booked,
                              x.bal,
                              'cv-epic',
                              16,
                            )}
                            {open && x.fs.map((f) => featureRow(t, f))}
                          </Fragment>
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
            <span className="hint">Across every team. Click an item to see it in its team's planner; Back brings you here.</span>
          </div>
          <div className="cv-risks">
            <div>
              <h3>Booked beyond estimate · {negative.length}</h3>
              {negative.length === 0 && <p className="hint">None.</p>}
              {negative.map((x) => featureLine(x, <span className="bal neg">{Math.round(balanceOf(x) ?? 0)}h</span>))}
            </div>
            <div>
              <h3>Work left, nobody booked from today · {unstaffed.length}</h3>
              {unstaffed.length === 0 && <p className="hint">None.</p>}
              {unstaffed.map((x) => featureLine(x, <span className="hint">{fmtNum(x.feature.remaining ?? x.feature.estimate ?? 0)}h</span>))}
            </div>
            <div>
              <h3>Delayed · {delayed.length}</h3>
              {delayed.length === 0 && <p className="hint">None — every open feature with a plan is on or ahead of it.</p>}
              {delayed.map(({ x, sc }) =>
                featureLine(
                  x,
                  <span className="sched delayed" title={sc?.overdue ? 'Past its planned end with work still open' : `Expected to end ${derivedEndWeek(x.feature) ? weekTag(derivedEndWeek(x.feature)) : 'late'}, after its planned end`}>
                    {scheduleDelta(sc?.weeks ?? 0)}
                  </span>,
                ),
              )}
            </div>
            <div>
              <h3>Blocked · {blocked.length}</h3>
              {blocked.length === 0 && <p className="hint">None.</p>}
              {blocked.map((x) => featureLine(x, <span className="hint">{x.feature.remaining != null ? `${fmtNum(x.feature.remaining)}h left` : ''}</span>))}
            </div>
          </div>
        </section>
      </div>
      {tipEl}
    </div>
  )
}
