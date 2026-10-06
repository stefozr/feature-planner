import { useEffect, useState } from 'react'
import { useDropdown } from './useDropdown'

type Theme = 'light' | 'dark' | 'system'

interface Props {
  theme: Theme
  onThemeChange: (t: Theme) => void
  onExport: () => void
  /** null = not loaded yet */
  backups: { name: string; size: number }[] | null
  onLoadBackups: () => void
  onDownloadBackup: (name: string) => void
  canEdit: boolean
  onImport: () => void
  onDefaults: () => void
  onReleases: () => void
  /** null = the server has no vacation calendar link; the item is then not offered */
  onSyncVacations: (() => void) | null
  /** what the server last said about the link: true / false, or null while unknown */
  calendarConfigured: boolean | null
  authEnabled: boolean
  userName: string | null
  onLogout: () => void
}

/** Top-right ⚙ Settings dropdown: theme, data import/export/backups, settings, releases, log out. */
export default function SettingsMenu({
  theme,
  onThemeChange,
  onExport,
  backups,
  onLoadBackups,
  onDownloadBackup,
  canEdit,
  onImport,
  onDefaults,
  onReleases,
  onSyncVacations,
  calendarConfigured,
  authEnabled,
  userName,
  onLogout,
}: Props) {
  const { open, setOpen, ref } = useDropdown()
  const [backupsOpen, setBackupsOpen] = useState(false)

  useEffect(() => {
    if (!open) setBackupsOpen(false)
  }, [open])

  const pick = (action: () => void) => () => {
    action()
    setOpen(false)
  }

  return (
    <div className="filter-dd-wrap" ref={ref}>
      <button className="filter-dd" title="Settings" onClick={() => setOpen((o) => !o)}>
        ⚙ Settings
        <span className="filter-caret">▾</span>
      </button>
      {open && (
        <div className="filter-panel settings-panel">
          <div className="menu-row">
            <span className="menu-row-label">Theme</span>
            <div className="view-toggle">
              {(['system', 'light', 'dark'] as const).map((t) => (
                <button key={t} className={theme === t ? 'active' : ''} onClick={() => onThemeChange(t)}>
                  {t === 'system' ? '🖥' : t === 'light' ? '☀' : '🌙'} {t}
                </button>
              ))}
            </div>
          </div>
          <div className="menu-sep" />
          <button className="menu-item" title="Download the database as JSON" onClick={pick(onExport)}>
            Export…
          </button>
          <button
            className="menu-item"
            title="Download a saved backup snapshot"
            onClick={() => {
              if (backupsOpen) {
                setBackupsOpen(false)
              } else {
                onLoadBackups()
                setBackupsOpen(true)
              }
            }}
          >
            Backups {backupsOpen ? '▴' : '▾'}
          </button>
          {backupsOpen && (
            <div className="menu-sublist">
              {backups == null ? (
                <span className="hint menu-hint">Loading…</span>
              ) : backups.length === 0 ? (
                <span className="hint menu-hint">No backups yet</span>
              ) : (
                backups.map((b) => (
                  <button
                    key={b.name}
                    className="menu-item sub"
                    title={`${(b.size / 1024).toFixed(1)} KB — click to download`}
                    onClick={() => onDownloadBackup(b.name)}
                  >
                    {b.name.replace(/^db-/, '').replace(/\.json$/, '')}
                  </button>
                ))
              )}
            </div>
          )}
          {canEdit && (
            <button className="menu-item" title="Replace the database from a JSON export" onClick={pick(onImport)}>
              Import…
            </button>
          )}
          {canEdit && (
            <button className="menu-item" title="Project start, hours per week, statuses, customers, profiles, vacation calendar link" onClick={pick(onDefaults)}>
              Settings…
            </button>
          )}
          {canEdit && (
            <button className="menu-item" title="Releases and milestones such as code freezes and system test windows" onClick={pick(onReleases)}>
              Releases &amp; milestones…
            </button>
          )}
          {canEdit && onSyncVacations && (
            <button
              className="menu-item"
              title={calendarConfigured === false ? 'Add the calendar link under Settings… first' : 'Pull away periods from the shared vacation calendar now (it also runs by itself every few hours)'}
              disabled={calendarConfigured === false}
              onClick={pick(onSyncVacations)}
            >
              Sync vacations now
            </button>
          )}
          {authEnabled && (
            <>
              <div className="menu-sep" />
              <button className="menu-item" title={userName ?? undefined} onClick={pick(onLogout)}>
                Log out{userName ? ` (${userName})` : ''}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
