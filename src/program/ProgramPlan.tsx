import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DB, FeatureTracking, isFinishedStatus } from '../types'
import { deleteUndefined, fmtDate } from '../logic'
import type { PlanProps } from '../Plan'
import type { Route, View } from '../ui/useHashRoute'
import { useAutosave } from '../useAutosave'
import { usePersisted } from '../ui/usePersisted'
import { paletteColor, paletteOptionColors } from '../theme'
import { payloadProblem } from '../../shared/db.mjs'
import SettingsMenu from '../ui/SettingsMenu'
import FilterBar from '../ui/FilterBar'
import { SettingsDialog } from '../ui/Dialogs'
import { ReleasesDialog } from '../ui/FeatureDialogs'
import { useConfirm } from '../ui/ConfirmDialog'
import GanttView, { type PinnedRow } from '../gantt/GanttView'
import { ProgramFeature, TeamDoc, flattenFeatures, programWeeks, teamCriticalPath, teamMarkers, unionCustomers, unionStatuses } from './aggregate'
import ProgramCapacity from './ProgramCapacity'
import ProgramStatus from './ProgramStatus'
import ProgramGrid from './ProgramGrid'
import './program.css'

const VIEWS: { id: View; label: string; hint: string }[] = [
  { id: 'planner', label: 'Planner', hint: 'Every team’s features × weeks: the FTE each books, read-only' },
  { id: 'capacity', label: 'Capacity', hint: 'Available vs booked per team and week, progress, overbooking' },
  { id: 'status', label: 'Status', hint: 'Hours and budget per feature across teams, with the Program’s own risks, dependencies and comments' },
  { id: 'roadmap', label: 'Roadmap', hint: 'Each team’s critical path, then the Program’s own workstreams and milestones' },
]

const toggleIn = (v: string) => (prev: string[]) => (prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v])
/** reload the other teams when the tab comes back after this long */
const STALE_MS = 60_000

interface Props extends PlanProps {
  /** a link into another team's plan (a history entry, so Back returns here) */
  navigateTeam: (r: Route) => void
}

/**
 * The Program team: its own document (workstreams, releases, milestones, notes on the other
 * teams' features) with the same autosave as a team's plan, plus a snapshot of every other team
 * from GET /api/program/teams that the four tabs aggregate. Nothing of the other teams is edited
 * here; links lead into their plans.
 */
export default function ProgramPlan({ auth, team, route, navigate, navigateTeam, theme, onThemeChange, isDark, teamSwitcher, settleRef, onTeamGone, notice }: Props) {
  const api = `/api/teams/${team.id}`
  const key = (k: string) => `feature-planner:${team.id}:${k}`
  const view: View = route.view
  const todayISO = fmtDate(new Date())
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showToast = (msg: string) => {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2500)
  }
  const { db, update, saveState, settle, replace } = useAutosave({ auth, api, onGone: onTeamGone, notify: showToast, settleRef })
  const { ask: confirm, ui: confirmUI } = useConfirm()
  const [dialog, setDialog] = useState<'settings' | 'releases' | null>(null)

  // ----- the other teams -----
  const [teams, setTeams] = useState<TeamDoc[] | null>(null)
  const [asOf, setAsOf] = useState<Date | null>(null)
  const [snapshotError, setSnapshotError] = useState(false)
  const loadSnapshot = useCallback(async () => {
    try {
      const r = await auth.fetch('/api/program/teams')
      if (!r.ok) throw new Error(String(r.status))
      const body = (await r.json()) as { asOf: string; teams: { id: string; name: string; position: number; version: number; doc: DB }[] }
      setTeams(body.teams.map(({ doc, ...t }) => ({ ...t, db: doc })))
      setAsOf(new Date(body.asOf))
      setSnapshotError(false)
    } catch {
      setSnapshotError(true)
    }
  }, [auth])
  useEffect(() => {
    void loadSnapshot()
  }, [loadSnapshot])
  // a tab left open comes back with fresh teams, without anyone clicking
  const asOfRef = useRef(asOf)
  asOfRef.current = asOf
  useEffect(() => {
    const on = () => {
      if (document.visibilityState === 'visible' && asOfRef.current && Date.now() - asOfRef.current.getTime() > STALE_MS) void loadSnapshot()
    }
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [loadSnapshot])
  useEffect(() => {
    const msg = notice.current
    if (msg) {
      notice.current = null
      showToast(msg)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // the documents with their colours snapped onto the palette, as every team tab paints its own
  const painted = useMemo(
    () => (teams ?? []).map((t) => ({ ...t, db: { ...t.db, settings: { ...t.db.settings, optionColors: paletteOptionColors(t.db.settings.optionColors, isDark) } } })),
    [teams, isDark],
  )
  const paintDb = useMemo(() => (db ? { ...db, settings: { ...db.settings, optionColors: paletteOptionColors(db.settings.optionColors, isDark) } } : null), [db, isDark])
  const colorOf = useCallback((hex: string | undefined) => paletteColor(hex, isDark), [isDark])

  // ----- filters (the Planner and Status tabs) -----
  const [teamFilter, setTeamFilter] = usePersisted<string[]>(key('teamFilter'), [])
  const [statusFilter, setStatusFilter] = usePersisted<string[]>(key('statusFilter'), [])
  const [customerFilter, setCustomerFilter] = usePersisted<string[]>(key('customerFilter'), [])
  const [hideDone, setHideDone] = usePersisted<boolean>(key('hideDone'), false)
  const [search, setSearch] = useState('')
  const q = search.trim().toLowerCase()
  const allFeatures = useMemo(() => flattenFeatures(painted), [painted])
  const filtered = useMemo(
    () =>
      allFeatures.filter(
        ({ team: t, feature: f, epic }) =>
          (!teamFilter.length || teamFilter.includes(t.id)) &&
          (!statusFilter.length || statusFilter.includes(f.status ?? '')) &&
          (!customerFilter.length || customerFilter.includes(f.customer ?? '')) &&
          (!hideDone || !isFinishedStatus(f.status)) &&
          (!q || `${f.key ?? ''} ${f.name} ${epic?.name ?? ''} ${t.name}`.toLowerCase().includes(q)),
      ),
    [allFeatures, teamFilter, statusFilter, customerFilter, hideDone, q],
  )
  const counts = (pick: (x: ProgramFeature) => string | undefined) => {
    const m = new Map<string, number>()
    for (const x of allFeatures) {
      const v = pick(x) ?? ''
      m.set(v, (m.get(v) ?? 0) + 1)
    }
    return m
  }
  const filterBar = () => {
    const byTeam = counts((x) => x.team.id)
    const byStatus = counts((x) => x.feature.status)
    const byCustomer = counts((x) => x.feature.customer)
    return (
      <FilterBar
        noun="features"
        resultCount={filtered.length}
        totalCount={allFeatures.length}
        search={search}
        onClearAll={() => {
          setTeamFilter([])
          setStatusFilter([])
          setCustomerFilter([])
          setHideDone(false)
          setSearch('')
        }}
        toggles={[{ key: 'hideDone', label: 'Hide finished', on: hideDone, count: allFeatures.filter((x) => isFinishedStatus(x.feature.status)).length, onChange: () => setHideDone((v) => !v) }]}
        facets={[
          { key: 'team', label: 'Team', options: painted.map((t) => ({ value: t.id, label: t.name, count: byTeam.get(t.id) ?? 0 })), selected: teamFilter, onToggle: (v) => setTeamFilter(toggleIn(v)) },
          { key: 'status', label: 'Status', options: unionStatuses(painted).map((s) => ({ value: s, count: byStatus.get(s) ?? 0 })), selected: statusFilter, onToggle: (v) => setStatusFilter(toggleIn(v)) },
          { key: 'customer', label: 'Customer', options: unionCustomers(painted).map((c) => ({ value: c, count: byCustomer.get(c) ?? 0 })), selected: customerFilter, onToggle: (v) => setCustomerFilter(toggleIn(v)) },
        ]}
      />
    )
  }

  // ----- the Program's own edits -----
  /** the Program's note on one feature: merged per key, so a 409 replay lands; an empty note is dropped */
  const patchTracking = useCallback(
    (k: string, patch: Partial<FeatureTracking>) =>
      update((d) => {
        const tracking = (d.program ??= { tracking: {} }).tracking
        const next = deleteUndefined({ ...tracking[k], ...patch }, true)
        if (Object.keys(next).length) tracking[k] = next
        else delete tracking[k]
      }),
    [update],
  )

  // ----- links into the teams -----
  const goToFeature = (teamId: string, featureId: string) => navigateTeam({ team: teamId, view: 'planner', feature: featureId })
  const goToTeam = (teamId: string, v: View) => navigateTeam({ team: teamId, view: v })

  // ----- the roadmap's pinned rows -----
  const [showPlanned, setShowPlanned] = usePersisted<boolean>(key('showPlanned'), true)
  const weeks = useMemo(() => (paintDb ? programWeeks(painted, paintDb, todayISO) : []), [painted, paintDb, todayISO])
  const pinned = useMemo<PinnedRow[]>(
    () =>
      painted.map((t) => ({
        id: t.id,
        name: t.name,
        shape: teamCriticalPath(t, todayISO),
        ...teamMarkers(t),
        title: `${t.name} — from its earliest roadmap bar to its latest, planned and actual. Click to open the team's roadmap.`,
        onClick: () => goToTeam(t.id, 'roadmap'),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [painted, todayISO],
  )

  // ----- export / import / backups: the Program's own document -----
  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }
  const exportDb = async () => {
    try {
      await settle()
      const res = await auth.fetch(`${api}/data`)
      if (!res.ok) throw new Error(String(res.status))
      downloadBlob(new Blob([JSON.stringify(await res.json(), null, 2)], { type: 'application/json' }), `feature-planner-${team.id}-${new Date().toISOString().slice(0, 10)}.json`)
    } catch {
      showToast('Export failed')
    }
  }
  const [backups, setBackups] = useState<{ name: string; size: number }[] | null>(null)
  const loadBackups = async () => {
    try {
      const res = await auth.fetch(`${api}/backups`)
      if (!res.ok) throw new Error(String(res.status))
      setBackups(await res.json())
    } catch {
      showToast('Could not load backups')
    }
  }
  const downloadBackup = async (name: string) => {
    try {
      const res = await auth.fetch(`${api}/backups/${encodeURIComponent(name)}`)
      if (!res.ok) throw new Error(String(res.status))
      downloadBlob(await res.blob(), name)
    } catch {
      showToast('Download failed')
    }
  }
  const importFileRef = useRef<HTMLInputElement | null>(null)
  const importDb = async (file: File) => {
    let next: DB
    try {
      next = JSON.parse(await file.text())
    } catch {
      showToast('Import failed — not valid JSON')
      return
    }
    const problem = payloadProblem(next)
    if (problem) {
      showToast(`Import failed — ${problem}`)
      return
    }
    const ok = await confirm({
      title: 'Replace the Program',
      message:
        `Replace the Program's own roadmap, releases, milestones and notes with "${file.name}"?\n` +
        `${db?.workstreams.length ?? 0} roadmap rows / ${Object.keys(db?.program?.tracking ?? {}).length} notes → ${next.workstreams?.length ?? 0} rows / ${Object.keys(next.program?.tracking ?? {}).length} notes.\n` +
        'The teams are not touched. The server snapshots the Program to its backups first.',
      confirmLabel: 'Replace',
    })
    if (!ok) return
    try {
      await replace(next)
      showToast('Program imported')
    } catch (e) {
      showToast(`Import failed — ${e instanceof Error ? e.message : 'server rejected upload'}`)
    }
  }

  if (!db || !paintDb) return <div className="loading">{saveState === 'error' ? 'Failed to load the Program — is the storage server running? (npm run dev)' : 'Loading…'}</div>
  const asOfText = asOf ? `as of ${asOf.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''
  const refresh = (
    <>
      <button className="btn small" title="Reload every team's plan — the Program reads them when it opens and when this tab comes back after a minute" onClick={() => void loadSnapshot()}>
        ↻ Refresh
      </button>
      <span className="pg-asof">{snapshotError ? 'Could not load the teams' : asOfText}</span>
    </>
  )
  const readOnly = !auth.canEdit

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-row topbar-main">
          <h1 className="brand">
            <img className="brand-mark" src="/favicon.png" alt="" width={22} height={22} />
            Feature Planner
          </h1>
          {teamSwitcher}
          <div className="view-toggle">
            {VIEWS.map((v) => (
              <button key={v.id} className={view === v.id ? 'active' : ''} title={v.hint} onClick={() => navigate({ view: v.id })}>
                {v.label}
              </button>
            ))}
          </div>
          <span style={{ flex: 1 }} />
          {toast && <span className="toast">{toast}</span>}
          {auth.canEdit ? (
            <span className={`save-state ${saveState}`}>{saveState === 'saved' ? 'Saved' : saveState === 'saving' ? 'Saving…' : 'Save failed'}</span>
          ) : (
            <span className="save-state" title="You have the viewer role — editing is disabled">
              Read-only
            </span>
          )}
          {auth.canEdit && (
            <input
              ref={importFileRef}
              type="file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (f) void importDb(f)
              }}
            />
          )}
          <SettingsMenu
            theme={theme}
            onThemeChange={onThemeChange}
            onExport={exportDb}
            backups={backups}
            onLoadBackups={loadBackups}
            onDownloadBackup={downloadBackup}
            canEdit={auth.canEdit}
            onImport={() => importFileRef.current?.click()}
            onDefaults={() => setDialog('settings')}
            onReleases={() => setDialog('releases')}
            onSyncVacations={null}
            calendarConfigured={false}
            authEnabled={auth.enabled}
            userName={auth.userName}
            onLogout={auth.logout}
          />
        </div>
        {(view === 'planner' || view === 'status') && (
          <div className="topbar-row topbar-tools">
            <input className="search-input sv-search" type="search" placeholder="Search teams, packages, features…" value={search} onChange={(e) => setSearch(e.target.value)} />
            {filterBar()}
            <span style={{ flex: 1 }} />
            {refresh}
          </div>
        )}
        {(view === 'capacity' || view === 'roadmap') && (
          <div className="topbar-row topbar-tools">
            <span className="hint">
              {view === 'capacity'
                ? 'Every team’s availability against what its plan books, in FTE (person-weeks), plus every feature. Click a team or a feature to open it in its own plan; Back returns here.'
                : 'The top rows are read-only: each team’s roadmap as one bar, with its releases ⚑ and milestones ◆. Below them the Program’s own workstreams, editable.'}
            </span>
            <span style={{ flex: 1 }} />
            {refresh}
          </div>
        )}
      </header>
      {!teams ? (
        <div className="loading">{snapshotError ? 'Could not load the teams — is the storage server running?' : 'Loading the teams…'}</div>
      ) : view === 'capacity' ? (
        <ProgramCapacity teams={painted} program={paintDb} todayISO={todayISO} colorOf={colorOf} scrollTo={route.view === 'capacity' ? route.at ?? null : null} onGoFeature={goToFeature} onGoTeam={goToTeam} />
      ) : view === 'status' ? (
        <ProgramStatus
          teams={painted}
          features={filtered}
          tracking={db.program?.tracking ?? {}}
          searching={!!q}
          readOnly={readOnly}
          onPatch={patchTracking}
          onGoFeature={goToFeature}
          onGoTeam={goToTeam}
          storageKey={key('statusClosed')}
        />
      ) : view === 'roadmap' ? (
        <GanttView
          db={paintDb}
          todayISO={todayISO}
          colorOf={colorOf}
          readOnly={readOnly}
          showPlanned={showPlanned}
          onShowPlanned={setShowPlanned}
          update={update}
          pinned={pinned}
          pinnedLabel="Critical path per team"
          extraWeeks={weeks}
        />
      ) : (
        <ProgramGrid teams={painted} features={filtered} program={paintDb} weeks={weeks} todayISO={todayISO} colorOf={colorOf} onGoFeature={goToFeature} onGoTeam={goToTeam} storageKey={key('gridClosed')} />
      )}
      {dialog === 'settings' && (
        <SettingsDialog
          settings={db.settings}
          program
          onClose={() => setDialog(null)}
          onSave={(edited) =>
            update((d) => {
              d.settings = { ...d.settings, ...edited }
            })
          }
        />
      )}
      {dialog === 'releases' && (
        <ReleasesDialog
          db={db}
          onClose={() => setDialog(null)}
          onSave={(releases, milestones) =>
            update((d) => {
              d.releases = releases
              d.milestones = milestones
              const ids = new Set(releases.map((r) => r.id))
              for (const m of d.milestones) if (m.releaseId && !ids.has(m.releaseId)) delete m.releaseId
            })
          }
        />
      )}
      {confirmUI}
    </div>
  )
}
