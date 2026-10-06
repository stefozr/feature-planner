import { Fragment, useMemo } from 'react'
import { DB, Feature, Person } from '../types'
import { SCHEDULE_LABEL, featureProgress, fmtNum, isoWeekNum, monthGroups, mondayOf, peopleById, scheduleDelta, scheduleStatus, weekLabel, weekTag } from '../logic'
import { PersonCell, ReleaseCell, StatusTag } from '../ui/pickers'
import { Bar } from '../ui/fields'
import { usePersisted } from '../ui/usePersisted'
import { useTip } from '../ui/useTip'
import type { View } from '../ui/useHashRoute'
import { ProgramFeature, TeamDoc, featureFte } from './aggregate'

interface Props {
  teams: TeamDoc[]
  /** the features to list — already through the Program's filters */
  features: ProgramFeature[]
  program: DB
  weeks: string[]
  todayISO: string
  colorOf: (hex: string | undefined) => string | undefined
  onGoFeature: (teamId: string, featureId: string) => void
  onGoTeam: (teamId: string, view: View) => void
  storageKey: string
}

const LABEL_W = 360
const FIELD_W = [110, 110, 100, 80, 80, 110, 90]
const WEEK_W = 54
const FIELDS = ['Status', 'Lead', 'Release', 'Est. (h)', 'Rem. (h)', 'Progress', 'Schedule']

/**
 * The Program's Planner tab, read-only: every team's features as rows (team → package →
 * feature) and the FTE each books per week in the cells, where a team's planner shows who.
 */
export default function ProgramGrid({ teams, features, program, weeks, todayISO, colorOf, onGoFeature, onGoTeam, storageKey }: Props) {
  const today = mondayOf(todayISO)
  const { attach, element: tipEl } = useTip()
  const [closed, setClosed] = usePersisted<string[]>(storageKey, [])
  const closedSet = useMemo(() => new Set(closed), [closed])
  const toggle = (id: string) => setClosed((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))

  const groups = useMemo(() => {
    const byTeam = new Map<string, Map<string, Feature[]>>()
    for (const x of features) {
      const t = byTeam.get(x.team.id) ?? byTeam.set(x.team.id, new Map()).get(x.team.id)!
      ;(t.get(x.feature.epicId) ?? t.set(x.feature.epicId, []).get(x.feature.epicId)!).push(x.feature)
    }
    return teams
      .map((team) => {
        const m = byTeam.get(team.id)
        const epics = m ? team.db.epics.map((e) => ({ e, fs: m.get(e.id) ?? [] })).filter((g) => g.fs.length) : []
        return { team, epics, all: epics.flatMap((g) => g.fs), people: peopleById(team.db), releases: new Map(team.db.releases.map((r) => [r.id, r])) }
      })
      .filter((g) => g.all.length)
  }, [teams, features])

  const months = monthGroups(weeks)
  const monthStarts = new Set(months.slice(1).map((m) => m.weeks[0]))
  const weekClass = (w: string) => `pg-week${monthStarts.has(w) ? ' month-start' : ''}${w === today ? ' today' : ''}`
  // the Program's own releases and milestones in the week header, as the team planners show theirs
  const relByWeek = new Map(program.releases.filter((r) => r.date).map((r) => [mondayOf(r.date!), r]))
  const msByWeek = new Map<string, string[]>()
  for (const m of program.milestones) msByWeek.set(mondayOf(m.date), [...(msByWeek.get(mondayOf(m.date)) ?? []), m.name])

  const pin = (i: number, extra = ''): { className: string; style: React.CSSProperties } => ({
    className: `pg-pin${i === FIELD_W.length ? ' last' : ''}${extra ? ` ${extra}` : ''}`,
    style: { left: i === 0 ? 0 : LABEL_W + FIELD_W.slice(0, i - 1).reduce((a, b) => a + b, 0) },
  })
  const heat = (fte: number, cls = '') => (
    <span className={`pg-fte${cls ? ` ${cls}` : ''}`} style={{ '--heat': Math.min(1, fte / 4) } as React.CSSProperties}>
      {fmtNum(fte)}
    </span>
  )
  const sumCells = (fs: Feature[], team: TeamDoc) =>
    weeks.map((w) => {
      let total = 0
      for (const f of fs) total += featureFte(f, w)
      return (
        <td key={w} className={weekClass(w)} {...attach(<><b>{team.name} · {weekTag(w)} · {weekLabel(w)}</b><div>{fmtNum(total)} FTE booked on {fs.length} feature{fs.length === 1 ? '' : 's'}</div></>)}>
          {total > 0 ? heat(total) : ''}
        </td>
      )
    })
  const featureCells = (people: Map<string, Person>, f: Feature) =>
    weeks.map((w) => {
      const fte = featureFte(f, w)
      const cell = f.cells[w]
      const who = cell?.entries.map((e) => `${e.personId ? (people.get(e.personId)?.name ?? '?') : (e.label ?? 'slot')} ${e.pct}% ${e.kind}`) ?? []
      return (
        <td key={w} className={weekClass(w)} {...(fte > 0 ? attach(<><b>{f.key ?? f.name} · {weekTag(w)}</b>{who.map((s, i) => <div key={i}>{s}</div>)}{cell?.note && <div className="tip-muted">{cell.note}</div>}</>) : {})}>
          {fte > 0 ? heat(fte) : ''}
        </td>
      )
    })

  const schedCell = (f: Feature) => {
    const sc = scheduleStatus(f, todayISO)
    if (!sc) return <span className="muted-dash">—</span>
    return (
      <span className={`sched ${sc.status}`} title={`Planned ${weekTag(sc.plannedStart)} → ${weekTag(sc.plannedEnd)}`}>
        {SCHEDULE_LABEL[sc.status]} {scheduleDelta(sc.weeks)}
      </span>
    )
  }

  return (
    <div className="pg">
      <div className="pg-wrap">
        {groups.length === 0 ? (
          <div className="pg-empty">No features match the current filters.</div>
        ) : (
          <table className="pg-table" style={{ width: LABEL_W + FIELD_W.reduce((a, b) => a + b, 0) + weeks.length * WEEK_W }}>
            <colgroup>
              <col style={{ width: LABEL_W }} />
              {FIELD_W.map((w, i) => (
                <col key={i} style={{ width: w }} />
              ))}
              {weeks.map((w) => (
                <col key={w} style={{ width: WEEK_W }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th {...pin(0)} rowSpan={2}>
                  Team / package / feature
                </th>
                {FIELDS.map((f, i) => (
                  <th key={f} {...pin(i + 1, i >= 3 && i <= 4 ? 'num' : '')} rowSpan={2}>
                    {f}
                  </th>
                ))}
                {months.map((g, i) => (
                  <th key={g.key} colSpan={g.weeks.length} className={`pg-month${i % 2 ? ' alt' : ''}`}>
                    {g.label}
                  </th>
                ))}
              </tr>
              <tr className="pg-week-row">
                {weeks.map((w) => {
                  const rel = relByWeek.get(w)
                  const ms = msByWeek.get(w)
                  return (
                    <th key={w} className={`${monthStarts.has(w) ? 'month-start' : ''}${w === today ? ' today' : ''}`} title={[`ISO week ${isoWeekNum(w)} · ${weekLabel(w)}`, rel ? `⚑ ${rel.name} release ${rel.date}` : '', ...(ms ?? []).map((m) => `◆ ${m}`)].filter(Boolean).join('\n')}>
                      <div>{weekTag(w)}</div>
                      <div className="pg-date">{rel ? <span style={{ color: colorOf(rel.color) }}>⚑</span> : ms ? <span style={{ color: 'var(--danger)' }}>◆</span> : weekLabel(w).split(' ')[0]}</div>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {groups.map(({ team, epics, all, people, releases }) => {
                const tOpen = !closedSet.has(team.id)
                return (
                  <Fragment key={team.id}>
                    <tr className="pg-team">
                      <td {...pin(0)}>
                        <span className="pg-desc">
                          <button className="caret" aria-label={tOpen ? 'Collapse' : 'Expand'} onClick={() => toggle(team.id)}>
                            {tOpen ? '▾' : '▸'}
                          </button>
                          <button className="pg-link pg-name" title={`Open ${team.name}'s planner`} onClick={() => onGoTeam(team.id, 'planner')}>
                            {team.name}
                          </button>
                          <span className="hint">{all.length} feature{all.length === 1 ? '' : 's'}</span>
                        </span>
                      </td>
                      {FIELD_W.map((_, i) => (
                        <td key={i} {...pin(i + 1)} />
                      ))}
                      {sumCells(all, team)}
                    </tr>
                    {tOpen &&
                      epics.map(({ e, fs }) => {
                        const k = `${team.id}:${e.id}`
                        const open = !closedSet.has(k)
                        return (
                          <Fragment key={k}>
                            <tr className="pg-epic">
                              <td {...pin(0)}>
                                <span className="pg-desc" style={{ paddingLeft: 16 }}>
                                  <button className="caret" aria-label={open ? 'Collapse' : 'Expand'} onClick={() => toggle(k)}>
                                    {open ? '▾' : '▸'}
                                  </button>
                                  {e.key && <span className="jira-key">{e.key}</span>}
                                  <span className="pg-name" title={e.name}>
                                    {e.name}
                                  </span>
                                  <span className="hint">{fs.length}</span>
                                </span>
                              </td>
                              {FIELD_W.map((_, i) => (
                                <td key={i} {...pin(i + 1)} />
                              ))}
                              {sumCells(fs, team)}
                            </tr>
                            {open &&
                              fs.map((f) => {
                                const prog = featureProgress(f)
                                return (
                                  <tr key={f.id} className="pg-feature">
                                    <td {...pin(0)}>
                                      <span className="pg-desc" style={{ paddingLeft: 32 }}>
                                        <span className="caret-spacer" />
                                        {f.key && <span className="jira-key">{f.key}</span>}
                                        <button className="pg-link pg-name" title={`${f.name}\nClick to see it in ${team.name}'s planner`} onClick={() => onGoFeature(team.id, f.id)}>
                                          {f.name}
                                        </button>
                                      </span>
                                    </td>
                                    <td {...pin(1)}>
                                      <StatusTag status={f.status} colors={team.db.settings.optionColors} />
                                    </td>
                                    <td {...pin(2)}>
                                      <PersonCell person={f.leadId ? people.get(f.leadId) : undefined} setLabel="Lead" />
                                    </td>
                                    <td {...pin(3)}>
                                      <ReleaseCell release={f.releaseId ? releases.get(f.releaseId) : undefined} variant="version" colorOf={colorOf} />
                                    </td>
                                    <td {...pin(4, 'num')}>{f.estimate != null ? fmtNum(f.estimate) : '—'}</td>
                                    <td {...pin(5, 'num')}>{f.remaining != null ? fmtNum(f.remaining) : '—'}</td>
                                    <td {...pin(6)}>
                                      <span className="cv-prog">
                                        <Bar pct={prog} />
                                        <span>{prog == null ? '—' : `${Math.round(prog * 100)}%`}</span>
                                      </span>
                                    </td>
                                    <td {...pin(7)}>{schedCell(f)}</td>
                                    {featureCells(people, f)}
                                  </tr>
                                )
                              })}
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
      <footer className="statusbar">
        <span className="hint">Read-only — the FTE each feature books per week, every team. Hover a cell for who; click a feature to open it in its team's planner, Back returns here.</span>
      </footer>
      {tipEl}
    </div>
  )
}
