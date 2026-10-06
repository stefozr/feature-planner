import { useState } from 'react'
import type { Team } from '../types'
import { Modal } from './Dialogs'

/** what the server copies when a new team takes its settings from another (server/store.mjs COPIED_SETTINGS) */
const COPIED = 'project start, horizon, hours per person-week, statuses, customers, colours, profiles and link categories'

export function NewTeamDialog({
  teams,
  current,
  onCreate,
  onClose,
}: {
  teams: Team[]
  current: Team
  /** resolves to an error message, or null when the team was created (the caller navigates to it) */
  onCreate: (name: string, copySettingsFrom: string | null) => Promise<string | null>
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [copyFrom, setCopyFrom] = useState(current.builtin ? '' : current.id)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const valid = !!name.trim() && !busy

  const submit = async () => {
    if (!valid) return
    setBusy(true)
    setError(null)
    const problem = await onCreate(name.trim(), copyFrom || null)
    setBusy(false)
    if (problem) setError(problem)
    else onClose()
  }

  return (
    <Modal title="New team" onClose={onClose} className="team-modal" storageKey="newTeam">
      <label className="field">
        Name
        <input autoFocus value={name} placeholder="Platform, Mobile, Data…" maxLength={60} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void submit()} />
      </label>
      <label className="field">
        Copy settings from
        <select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
          <option value="">None — start from the defaults</option>
          {teams.filter((t) => !t.builtin).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <p className="hint">The new team starts with no people, packages, releases or roadmap. Copying takes the {COPIED}; the vacation calendar link and the sheet-import mapping stay with their team.</p>
      {error && <p className="hint err">{error}</p>}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!valid} onClick={() => void submit()}>
          {busy ? 'Creating…' : 'Create'}
        </button>
      </div>
    </Modal>
  )
}

function TeamRow({ team, last, onRename, onDelete }: { team: Team; last: boolean; onRename: (name: string) => Promise<string | null>; onDelete: () => void }) {
  const [name, setName] = useState(team.name)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    const next = name.trim()
    if (!next || next === team.name) {
      setName(team.name)
      setError(null)
      return
    }
    const problem = await onRename(next)
    setError(problem)
    if (problem) setName(team.name)
  }
  return (
    <tr>
      <td>
        <input value={name} maxLength={60} title={`#/${team.id}`} onChange={(e) => setName(e.target.value)} onBlur={() => void save()} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
        {error && <div className="hint err">{error}</div>}
      </td>
      <td className="hint" style={{ whiteSpace: 'nowrap' }}>
        {team.builtin ? 'all teams' : `${team.features} feature${team.features === 1 ? '' : 's'} · ${team.people} ${team.people === 1 ? 'person' : 'people'}`}
      </td>
      <td>
        <button
          className="btn small danger"
          disabled={last || team.builtin}
          title={team.builtin ? 'Built in — it aggregates every team and cannot be deleted' : last ? 'The last team cannot be deleted' : 'Delete this team and its whole plan (a backup snapshot is taken first)'}
          onClick={onDelete}
        >
          Delete
        </button>
      </td>
    </tr>
  )
}

export function ManageTeamsDialog({
  teams,
  onRename,
  onDelete,
  onClose,
}: {
  teams: Team[]
  /** resolves to an error message, or null when renamed */
  onRename: (id: string, name: string) => Promise<string | null>
  onDelete: (team: Team) => void
  onClose: () => void
}) {
  return (
    <Modal title="Teams" onClose={onClose} className="team-modal" storageKey="teams">
      <p className="hint">Rename a team here (Enter or click away saves); its link stays the same. Deleting a team removes its whole plan — the server snapshots it to the team's backups first.</p>
      <table className="team-table">
        <tbody>
          {teams.map((t) => (
            <TeamRow key={t.id} team={t} last={teams.filter((x) => !x.builtin).length <= 1} onRename={(name) => onRename(t.id, name)} onDelete={() => onDelete(t)} />
          ))}
        </tbody>
      </table>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  )
}
