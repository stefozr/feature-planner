import { useCallback, useEffect, useRef, useState } from 'react'
import type { Auth } from './auth'
import type { Team } from './types'
import Plan from './Plan'
import ProgramPlan from './program/ProgramPlan'
import TeamMenu from './ui/TeamMenu'
import { ManageTeamsDialog, NewTeamDialog } from './ui/TeamDialogs'
import { useConfirm } from './ui/ConfirmDialog'
import { usePersisted } from './ui/usePersisted'
import { useHashRoute, type Route, type View, type ViewRoute } from './ui/useHashRoute'

type Theme = 'light' | 'dark' | 'system'
const VIEW_IDS: View[] = ['planner', 'capacity', 'status', 'roadmap']

/** what the server says when it refuses a team operation */
const errorOf = async (res: Response, fallback: string) => {
  const body = (await res.json().catch(() => null)) as { error?: string } | null
  return body?.error || `${fallback} (HTTP ${res.status})`
}

/**
 * The shell around a team's plan: the theme, the team list, which team the URL names, and the
 * switcher with its dialogs. The plan itself — data, autosave, tabs — is <Plan>, remounted on every
 * switch (key={team.id}) so nothing of one team's state survives into the next.
 */
export default function App({ auth }: { auth: Auth }) {
  const [theme, setTheme] = usePersisted<Theme>('feature-planner:theme', 'system')
  const [isDark, setIsDark] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = theme === 'system' ? mq.matches : theme === 'dark'
      document.documentElement.dataset.theme = dark ? 'dark' : 'light'
      setIsDark(dark)
    }
    apply()
    if (theme === 'system') {
      mq.addEventListener('change', apply)
      return () => mq.removeEventListener('change', apply)
    }
  }, [theme])

  // The URL hash is the source of truth for the team and the view (#/<team>/planner,
  // #/<team>/capacity?at=attention, …), so tab switches and team switches are browser history.
  // The persisted view and team only seed a hash that lacks them, and are kept current so the
  // next hash-less load lands where the user last was.
  const { route, navigate } = useHashRoute()
  const [savedView, setSavedView] = usePersisted<View>('feature-planner:view', 'planner')
  const [savedTeam, setSavedTeam] = usePersisted<string>('feature-planner:team', '')
  const [teams, setTeams] = useState<Team[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const { ask: confirm, ui: confirmUI } = useConfirm()
  const [dialog, setDialog] = useState<'new' | 'manage' | null>(null)
  // handed to Plan, which shows it once it is up (a redirect away from a team that no longer exists)
  const notice = useRef<string | null>(null)
  // Plan's settle(): the switcher waits for a pending autosave before changing teams
  const settleRef = useRef<(() => Promise<void>) | null>(null)

  const loadTeams = useCallback(async (): Promise<Team[] | null> => {
    try {
      const r = await auth.fetch('/api/teams')
      if (!r.ok) throw new Error(String(r.status))
      const list = (await r.json()) as Team[]
      setTeams(list)
      return list
    } catch {
      setLoadError(true)
      return null
    }
  }, [auth])
  useEffect(() => {
    void loadTeams()
  }, [loadTeams])

  // the team to show: the hash's, else the one used last, else the first real team (the built-in
  // Program is a view over the others, not where a first visit should land)
  const team = teams ? (teams.find((t) => t.id === route?.team) ?? teams.find((t) => t.id === savedTeam) ?? teams.find((t) => !t.builtin) ?? teams[0] ?? null) : null
  const view: View = route?.view ?? (VIEW_IDS.includes(savedView) ? savedView : 'planner')
  // a hash without a team (a link from before teams), with an unknown team, or none at all is
  // rewritten in place; the effect is idempotent, since afterwards the hash names `team`
  useEffect(() => {
    if (!team) return
    if (route?.team === team.id) return
    if (route?.team && !notice.current) notice.current = `Team “${route.team}” no longer exists`
    navigate({ ...(route ?? { view }), team: team.id }, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team, route])
  useEffect(() => {
    if (team) setSavedTeam(team.id)
  }, [team, setSavedTeam])
  useEffect(() => setSavedView(view), [view, setSavedView])
  useEffect(() => {
    document.title = team ? `${team.name} · Feature Planner` : 'Feature Planner'
  }, [team])

  const teamId = team?.id
  /** navigate inside the current team: Plan's calls carry no team */
  const planNavigate = useCallback(
    (r: ViewRoute, opts?: { replace?: boolean }) => {
      if (teamId) navigate({ ...r, team: teamId }, opts)
    },
    [navigate, teamId],
  )

  const switchTeam = async (id: string) => {
    await settleRef.current?.()
    navigate({ view, team: id }) // a push: Back returns to the previous team
  }

  /** the Program's links into a team's plan: a push, so Back returns to the Program */
  const navigateTeam = useCallback(
    async (r: Route) => {
      await settleRef.current?.()
      navigate(r)
    },
    [navigate],
  )

  /** the server no longer knows the current team: reload the list, which redirects to another one */
  const onTeamGone = useCallback(() => {
    notice.current = 'This team was deleted'
    void loadTeams()
  }, [loadTeams])

  const createTeam = async (name: string, copySettingsFrom: string | null): Promise<string | null> => {
    try {
      const res = await auth.fetch('/api/teams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, ...(copySettingsFrom ? { copySettingsFrom } : {}) }),
      })
      if (!res.ok) return await errorOf(res, 'Could not create the team')
      const created = (await res.json()) as Team
      await settleRef.current?.()
      await loadTeams()
      navigate({ view: 'planner', team: created.id })
      return null
    } catch {
      return 'Could not create the team — is the storage server running?'
    }
  }

  const renameTeam = async (id: string, name: string): Promise<string | null> => {
    try {
      const res = await auth.fetch(`/api/teams/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) return await errorOf(res, 'Could not rename the team')
      await loadTeams()
      return null
    } catch {
      return 'Could not rename the team — is the storage server running?'
    }
  }

  const deleteTeam = async (t: Team) => {
    if (!teams || t.builtin || teams.filter((x) => !x.builtin).length <= 1) return
    const ok = await confirm({
      title: 'Delete team',
      message:
        `Delete team “${t.name}” with ${t.features} feature${t.features === 1 ? '' : 's'} and ${t.people} ${t.people === 1 ? 'person' : 'people'}?\n` +
        "Its whole plan goes with it. The server snapshots it to the team's backups first; the app cannot restore it by itself.",
      confirmLabel: 'Delete',
    })
    if (!ok) return
    try {
      const res = await auth.fetch(`/api/teams/${encodeURIComponent(t.id)}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(await errorOf(res, 'Could not delete the team'))
    } catch (e) {
      notice.current = e instanceof Error ? e.message : 'Could not delete the team'
    }
    // land somewhere else before the list drops the deleted team, so the redirect effect has
    // nothing to complain about
    if (t.id === teamId) {
      const next = teams.find((x) => x.id !== t.id)
      if (next) navigate({ view, team: next.id }, { replace: true })
    }
    await loadTeams()
  }

  if (loadError) return <div className="loading">Failed to load the teams — is the storage server running? (npm run dev)</div>
  if (!teams || !team || !route || route.team !== team.id) return <div className="loading">Loading…</div>

  const teamSwitcher = (
    <TeamMenu
      team={team}
      teams={teams}
      canEdit={auth.canEdit}
      onSwitch={(id) => void switchTeam(id)}
      onOpen={() => void loadTeams()}
      onNew={() => setDialog('new')}
      onManage={() => setDialog('manage')}
    />
  )
  const shared = { auth, team, navigate: planNavigate, theme, onThemeChange: setTheme, isDark, settleRef, onTeamGone, notice, teamSwitcher }

  return (
    <>
      {team.builtin ? (
        <ProgramPlan key={team.id} {...shared} route={{ ...route, team: team.id }} navigateTeam={(r) => void navigateTeam(r)} />
      ) : (
        <Plan key={team.id} {...shared} route={{ ...route, team: team.id }} />
      )}
      {dialog === 'new' && <NewTeamDialog teams={teams} current={team} onCreate={createTeam} onClose={() => setDialog(null)} />}
      {dialog === 'manage' && <ManageTeamsDialog teams={teams} onRename={renameTeam} onDelete={(t) => void deleteTeam(t)} onClose={() => setDialog(null)} />}
      {confirmUI}
    </>
  )
}
