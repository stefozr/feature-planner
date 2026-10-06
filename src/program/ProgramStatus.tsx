import { Fragment, useMemo, useState } from 'react'
import { Epic, Feature, FeatureTracking, isBlockedStatus } from '../types'
import { fmtNum, peopleById, weekLabel, weekTag } from '../logic'
import { PersonCell, StatusTag } from '../ui/pickers'
import { usePersisted } from '../ui/usePersisted'
import { useTip } from '../ui/useTip'
import type { View } from '../ui/useHashRoute'
import { TextPopover } from '../status/StatusView'
import { HOUR_COLUMNS, TEXT_COLUMNS, budgetHours, sumHours, type HourKey, type HourTotals, type TextKey } from '../status/tracking'
import { ProgramFeature, TeamDoc } from './aggregate'
import '../status/status.css'

interface Props {
  teams: TeamDoc[]
  /** the features to list — already through the Program's filters */
  features: ProgramFeature[]
  /** the Program's own notes, by `<team>:<feature>` */
  tracking: Record<string, FeatureTracking>
  searching: boolean
  readOnly: boolean
  onPatch: (key: string, patch: Partial<FeatureTracking>) => void
  onGoFeature: (teamId: string, featureId: string) => void
  onGoTeam: (teamId: string, view: View) => void
  /** where the folded rows are remembered */
  storageKey: string
}

type Pop = { x: number; y: number; key: string; col: TextKey; who: string }

const hours = (v: number | null | undefined) => (v == null ? '—' : fmtNum(v))
const negClass = (v: number | null | undefined) => (v != null && v < 0 ? 'neg' : '')
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * The Program's Status tab: every team's features (no stories) with their hours and budget as
 * the team keeps them, and the Program's own risks, dependencies and comment per feature. The
 * team's own note shows under the Program's, read-only.
 */
export default function ProgramStatus({ teams, features, tracking, searching, readOnly, onPatch, onGoFeature, onGoTeam, storageKey }: Props) {
  const { attach, hide: hideTip, element: tipEl } = useTip()
  const [closed, setClosed] = usePersisted<string[]>(storageKey, [])
  const closedSet = useMemo(() => new Set(closed), [closed])
  const setFold = (id: string, fold: boolean) => setClosed((prev) => (fold ? (prev.includes(id) ? prev : [...prev, id]) : prev.filter((x) => x !== id)))
  const [pop, setPop] = useState<Pop | null>(null)

  // team → package → features, in team and package order; a team or a package shows only with features
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
        return { team, epics, all: epics.flatMap((g) => g.fs), people: peopleById(team.db) }
      })
      .filter((g) => g.all.length)
  }, [teams, features])
  const total = sumHours(features.map((x) => x.feature))

  // the pinned columns, as in the team's Status tab
  const HOUR_W: Record<HourKey, number> = { estimate: 120, logged: 80, remaining: 96 }
  const widths = [380, 120, 100, ...HOUR_COLUMNS.map((c) => HOUR_W[c.key]), 80, 120, ...TEXT_COLUMNS.map((c) => (c.wide ? 300 : 230))]
  const PINNED = 3
  const pin = (i: number): { className: string; style: React.CSSProperties } => ({
    className: `sv-pin${i === PINNED - 1 ? ' last' : ''}`,
    style: { left: widths.slice(0, i).reduce((a, b) => a + b, 0) },
  })
  const totalCells = (t: HourTotals, title: string) =>
    (['estimate', 'logged', 'remaining', 'budget'] as const).map((k) => (
      <td key={k} className={`num ${k === 'budget' && t.n ? negClass(t.budget) : ''}`} title={title}>
        {t.n ? fmtNum(t[k]) : '—'}
      </td>
    ))
  const caret = (id: string, open: boolean) => (
    <button className="caret" aria-label={open ? 'Collapse' : 'Expand'} onClick={() => setFold(id, open)}>
      {open ? '▾' : '▸'}
    </button>
  )

  const textCell = (team: TeamDoc, f: Feature, col: TextKey) => {
    const k = `${team.id}:${f.id}`
    const own = tracking[k]?.[col] ?? ''
    const theirs = f.tracking?.[col] ?? ''
    const tipOwn = own ? attach(<span style={{ whiteSpace: 'pre-line' }}>{own}</span>) : {}
    const tipTheirs = theirs ? attach(<span style={{ whiteSpace: 'pre-line' }}>{theirs}</span>) : {}
    return (
      <span className="sv-text-wrap">
        {readOnly ? (
          own ? <span className="sv-text" {...tipOwn}>{own}</span> : <span className="muted-dash">—</span>
        ) : (
          <button
            className={`sv-text${own ? '' : ' empty'}`}
            {...tipOwn}
            onClick={(e) => {
              hideTip()
              const r = e.currentTarget.getBoundingClientRect()
              setPop({ x: r.left, y: r.bottom - 8, key: k, col, who: f.key ?? f.name })
            }}
          >
            {own || '—'}
          </button>
        )}
        {theirs && (
          <span className="sv-text-team" {...tipTheirs}>
            {theirs}
          </span>
        )}
      </span>
    )
  }

  const teamRow = (team: TeamDoc, fs: Feature[], open: boolean) => {
    const t = sumHours(fs)
    return (
      <tr key={team.id} className="pg-team">
        <td {...pin(0)}>
          <span className="sv-desc">
            {caret(team.id, open)}
            <button className="sv-link sv-name" title={`Open ${team.name}'s Status tab`} onClick={() => onGoTeam(team.id, 'status')}>
              {team.name}
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
  const epicRow = (team: TeamDoc, e: Epic, fs: Feature[], open: boolean) => {
    const t = sumHours(fs)
    const k = `${team.id}:${e.id}`
    return (
      <tr key={k} className="sv-epic">
        <td {...pin(0)}>
          <span className="sv-desc" style={{ paddingLeft: 16 }}>
            {caret(k, open)}
            {e.key && <span className="jira-key">{e.key}</span>}
            <button className="sv-link sv-name" title={`Show this package in ${team.name}'s planner`} onClick={() => onGoTeam(team.id, 'planner')}>
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
  const featureRow = (team: TeamDoc, people: Map<string, import('../types').Person>, f: Feature) => {
    const s = team.db.settings
    const b = budgetHours(f)
    return (
      <tr key={`${team.id}:${f.id}`} className={`sv-feature${isBlockedStatus(f.status) ? ' blocked' : ''}`}>
        <td {...pin(0)}>
          <span className="sv-desc" style={{ paddingLeft: 32 }}>
            <span className="caret-spacer" />
            {f.key && <span className="jira-key">{f.key}</span>}
            <button className="sv-link sv-name" title={`${f.name}\nClick to see it in ${team.name}'s planner`} onClick={() => onGoFeature(team.id, f.id)}>
              {f.name}
            </button>
          </span>
        </td>
        <td {...pin(1)}>
          <StatusTag status={f.status} colors={s.optionColors} />
        </td>
        <td {...pin(2)}>
          <PersonCell person={f.leadId ? people.get(f.leadId) : undefined} setLabel="Assignee" />
        </td>
        {HOUR_COLUMNS.map((c) => (
          <td key={c.key} className="num">
            {hours(f[c.key])}
          </td>
        ))}
        <td className={`num ${negClass(b)}`} title="Original estimate − logged − remaining">
          {hours(b)}
        </td>
        <td>
          <span className="sv-week">{f.deadline ? `${weekTag(f.deadline)} · ${weekLabel(f.deadline)}` : '—'}</span>
        </td>
        {TEXT_COLUMNS.map((c) => (
          <td key={c.key}>{textCell(team, f, c.key)}</td>
        ))}
      </tr>
    )
  }

  return (
    <div className="sv">
      <div className="sv-bar">
        <h2>Status · all teams</h2>
        <span className="hint">
          Every team's features with their hours and budget as the team keeps them. Risks, dependencies and comment are the Program's own notes; the team's note shows under them. Click a name to open it in its team.
        </span>
        <span className="spacer" />
        <span className="sv-total" title={`Sums over all ${features.length} listed features (${total.n} with hours). Budget = estimate − logged − remaining.`}>
          Total · Estimate <b>{fmtNum(total.estimate)}h</b> · Logged <b>{fmtNum(total.logged)}h</b> · Remaining <b>{fmtNum(total.remaining)}h</b> · Budget{' '}
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
                <th title="The week the feature is due by">Deadline</th>
                {TEXT_COLUMNS.map((c) => (
                  <th key={c.key} title={`${c.hint} — the Program's own note; the team's shows beneath it`}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map(({ team, epics, all, people }) => {
                const tOpen = searching || !closedSet.has(team.id)
                return (
                  <Fragment key={team.id}>
                    {teamRow(team, all, tOpen)}
                    {tOpen &&
                      epics.map(({ e, fs }) => {
                        const k = `${team.id}:${e.id}`
                        const open = searching || !closedSet.has(k)
                        return (
                          <Fragment key={k}>
                            {epicRow(team, e, fs, open)}
                            {open && fs.map((f) => featureRow(team, people, f))}
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
      {pop && (
        <TextPopover
          x={pop.x}
          y={pop.y}
          label={`${TEXT_COLUMNS.find((c) => c.key === pop.col)?.label} · ${pop.who} · Program note`}
          value={tracking[pop.key]?.[pop.col] ?? ''}
          onCommit={(v) => onPatch(pop.key, { [pop.col]: v || undefined } as Partial<FeatureTracking>)}
          onClose={() => setPop(null)}
        />
      )}
      {tipEl}
    </div>
  )
}
