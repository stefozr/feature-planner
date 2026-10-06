import type { Team } from '../types'
import { useDropdown } from './useDropdown'

interface Props {
  team: Team
  teams: Team[]
  /** admins: create, rename and delete teams from here */
  canManage: boolean
  onSwitch: (id: string) => void
  /** the list is refreshed every time the menu opens, so a team created elsewhere shows up */
  onOpen: () => void
  onNew: () => void
  onManage: () => void
}

/** The header's team switcher: the Program first, then every team, the current one marked; admins also create and manage teams here. */
export default function TeamMenu({ team, teams, canManage, onSwitch, onOpen, onNew, onManage }: Props) {
  const { open, setOpen, ref } = useDropdown()
  const pick = (action: () => void) => () => {
    action()
    setOpen(false)
  }
  const program = teams.find((t) => t.builtin)
  const others = teams.filter((t) => !t.builtin)
  const row = (t: Team, hint: string, title: string) => (
    <button key={t.id} className={`menu-item${t.id === team.id ? ' active' : ''}`} title={title} onClick={pick(() => t.id !== team.id && onSwitch(t.id))}>
      <span>{t.builtin ? 'Σ ' : ''}{t.name}</span>
      <span className="hint">{hint}</span>
    </button>
  )
  return (
    <div className="filter-dd-wrap" ref={ref}>
      <button
        className="filter-dd team-dd"
        title="Switch team — every team has its own plan, people, settings and milestones"
        onClick={() => {
          if (!open) onOpen()
          setOpen((o) => !o)
        }}
      >
        {team.builtin ? 'Σ' : '👥'} {team.name}
        <span className="filter-caret">▾</span>
      </button>
      {open && (
        <div className="filter-panel team-panel">
          {program && (
            <>
              {row(program, 'all teams', `#/${program.id} — every team's plan at a glance: capacity per team, every feature, each team's critical path`)}
              <div className="menu-sep" />
            </>
          )}
          {others.map((t) => row(t, `${t.features} feature${t.features === 1 ? '' : 's'} · ${t.people} ${t.people === 1 ? 'person' : 'people'}`, `#/${t.id}`))}
          {canManage && (
            <>
              <div className="menu-sep" />
              <button className="menu-item" title="A new team with an empty plan; its settings can be copied from an existing team" onClick={pick(onNew)}>
                + New team…
              </button>
              <button className="menu-item" title="Rename or delete teams" onClick={pick(onManage)}>
                Manage teams…
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
