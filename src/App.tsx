import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ExpandedState } from '@tanstack/react-table'
import { ClipboardData, DB, Epic, Feature, FeatureTracking, GroupBy, Settings, VacationSyncStatus, WeekCell, isFinishedStatus } from './types'
import { addWeeks, cloneCell, deleteUndefined, fmtDate, gridWeeks, peopleById, uid } from './logic'
import FeatureGrid, { FeatureCallbacks, FeatureOps } from './grid/FeatureGrid'
import CapacityView from './capacity/CapacityView'
import StatusView from './status/StatusView'
import ImportDialog from './status/ImportDialog'
import { applyPlan } from './status/importSheet'
import GanttView from './gantt/GanttView'
import { PeopleDialog, SettingsDialog } from './ui/Dialogs'
import { EpicDialog, FeatureDialog, ReleasesDialog, newFeatureDraft } from './ui/FeatureDialogs'
import FilterBar from './ui/FilterBar'
import SettingsMenu from './ui/SettingsMenu'
import { buildFeatureTree, expandAll, expandToDepth, featureSearchText, groupKey, sameExpansion, treeLevels } from './rows'
import type { Auth } from './auth'
import { usePersisted } from './ui/usePersisted'
import { useHashRoute, type JumpTarget, type Route, type View } from './ui/useHashRoute'
import { useConfirm } from './ui/ConfirmDialog'
import { paletteColor, paletteOptionColors } from './theme'
import { payloadProblem } from '../shared/db.mjs'
import { syncFeatureHours } from '../shared/stories.mjs'

type DialogState =
  | { kind: 'feature'; featureId: string }
  | { kind: 'newFeature'; epicId: string }
  | { kind: 'epic'; epicId: string }
  | { kind: 'newEpic' }
  | { kind: 'people'; personId?: string }
  | { kind: 'settings' }
  | { kind: 'releases' }

/** The tabs, in header order. */
const VIEWS: { id: View; label: string; hint: string }[] = [
  { id: 'planner', label: 'Planner', hint: 'Features × weeks: who works on what, and progress' },
  { id: 'capacity', label: 'Capacity', hint: 'Progress per release and package, availability vs booked, overbooking' },
  { id: 'status', label: 'Status', hint: 'Hours, budget, deadline, risks and blockers per feature' },
  { id: 'roadmap', label: 'Roadmap', hint: 'The high-level plan: workstreams, activities and milestones' },
]

const GROUP_OPTIONS: { id: GroupBy; label: string }[] = [
  { id: 'none', label: 'Package' },
  { id: 'release', label: 'Release' },
  { id: 'status', label: 'Status' },
  { id: 'lead', label: 'Lead' },
  { id: 'customer', label: 'Customer' },
]

const toggleIn = (v: string) => (prev: string[]) => (prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v])

export default function App({ auth }: { auth: Auth }) {
  const [db, setDb] = useState<DB | null>(null)
  const [theme, setTheme] = usePersisted<'light' | 'dark' | 'system'>('feature-planner:theme', 'system')
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
  // The URL hash is the view's source of truth (#/planner, #/capacity?at=attention, #/planner?feature=…),
  // so the tabs and the Needs-attention jump are browser history. The persisted view only seeds a
  // hash-less load, and is kept current so the next one lands where the user last was.
  const { route, navigate } = useHashRoute()
  const [savedView, setSavedView] = usePersisted<View>('feature-planner:view', 'planner')
  const view: View = route?.view ?? (VIEWS.some((v) => v.id === savedView) ? savedView : 'planner')
  useEffect(() => {
    if (!route) navigate({ view }, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => setSavedView(view), [view, setSavedView])
  const todayISO = fmtDate(new Date())
  const [groupBy, setGroupBy] = usePersisted<GroupBy>('feature-planner:groupBy', 'none')
  const [statusFilter, setStatusFilter] = usePersisted<string[]>('feature-planner:statusFilter', [])
  const [releaseFilter, setReleaseFilter] = usePersisted<string[]>('feature-planner:releaseFilter', [])
  const [leadFilter, setLeadFilter] = usePersisted<string[]>('feature-planner:leadFilter', [])
  const [customerFilter, setCustomerFilter] = usePersisted<string[]>('feature-planner:customerFilter', [])
  const [personFilter, setPersonFilter] = usePersisted<string[]>('feature-planner:personFilter', [])
  const [hideDone, setHideDone] = usePersisted<boolean>('feature-planner:hideDone', false)
  // Leavers stay out of the way by default: the People list, the Team load rows and every person
  // picker read this one switch, so the roster looks the same from every door.
  const [hideResigned, setHideResigned] = usePersisted<boolean>('feature-planner:hideResigned', true)
  const [compactTimeline, setCompactTimeline] = usePersisted<boolean>('feature-planner:compactTimeline', false)
  const [compactFields, setCompactFields] = usePersisted<boolean>('feature-planner:compactFields', false)
  const [dense, setDense] = usePersisted<boolean>('feature-planner:dense', false)
  // the Status tab's folded packages — the same key the tab stored them under before the stepper
  const [statusClosed, setStatusClosed] = usePersisted<string[]>('feature-planner:statusClosed', [])
  // the simplified gantt: planned vs booked weeks as bars, no names in the cells
  const [bars, setBars] = usePersisted<boolean>('feature-planner:bars', false)
  // the dotted planned bar above the actual one — one switch for the Gantt view and the Roadmap
  const [showPlanned, setShowPlanned] = usePersisted<boolean>('feature-planner:showPlanned', true)
  const [search, setSearch] = useState('')
  const q = search.trim().toLowerCase()
  const [expandedByKey, setExpandedByKey] = usePersisted<Record<string, ExpandedState>>('feature-planner:expanded', {})
  const savedExpanded = expandedByKey[groupBy] ?? true
  const setSavedExpanded = useCallback<React.Dispatch<React.SetStateAction<ExpandedState>>>(
    (updater) =>
      setExpandedByKey((prev) => ({
        ...prev,
        [groupBy]: typeof updater === 'function' ? updater(prev[groupBy] ?? true) : updater,
      })),
    [groupBy, setExpandedByKey],
  )
  const [searchExp, setSearchExp] = useState<{ key: string; state: ExpandedState } | null>(null)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const { ask: confirm, ui: confirmUI } = useConfirm()
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved')
  const [toast, setToast] = useState<string | null>(null)
  const clipboardRef = useRef<ClipboardData | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Optimistic-concurrency version last seen from the server; echoed on every PUT so a stale write
  // is rejected (409) instead of silently clobbering another editor's save.
  const versionRef = useRef<string | null>(null)
  // Single-flight autosave: only one PUT is ever in flight; edits during a save coalesce here.
  const savingRef = useRef(false)
  const pendingRef = useRef<DB | null>(null)
  // Mutations applied since the last confirmed save, in order — replayed onto the server's document
  // on a 409 (rebase), so two people editing different things never lose work.
  const unsavedOps = useRef<((d: DB) => void)[]>([])

  // What the server's last pull of the shared vacation calendar did; the People dialog uses it to
  // say who the calendar does not know. null until answered — the sync item stays offered until
  // the server says no calendar link is configured.
  const [calendar, setCalendar] = useState<VacationSyncStatus | null>(null)
  const loadCalendarStatus = useCallback(async () => {
    try {
      const r = await auth.fetch('/api/vacations/status')
      if (r.ok) setCalendar(await r.json())
    } catch {
      /* purely informational — the dialog just shows no calendar hints */
    }
  }, [auth])

  useEffect(() => {
    auth
      .fetch('/api/data')
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status))
        versionRef.current = r.headers.get('X-Data-Version')
        setDb(await r.json())
      })
      .catch(() => setSaveState('error'))
    void loadCalendarStatus()
  }, [auth, loadCalendarStatus])

  const showToast = (msg: string) => {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2500)
  }

  /**
   * Adopt the server's current document: take its version, replay every still-unsaved local
   * intent onto it, and show the result. Ops that no longer apply (someone deleted the row we
   * edited) are skipped, not fatal — the count comes back so the caller can say so. Shared by the
   * 409 rebase and by the vacation sync, which changes the document server-side.
   */
  const adoptServerDoc = async (): Promise<{ merged: DB; dropped: number } | null> => {
    const fresh = await auth.fetch('/api/data')
    if (!fresh.ok) return null
    versionRef.current = fresh.headers.get('X-Data-Version')
    const merged = (await fresh.json()) as DB
    let dropped = 0
    for (const op of unsavedOps.current) {
      try {
        op(merged)
      } catch {
        dropped++
      }
    }
    setDb(merged) // raw: reconcile local view with the rebased doc without re-arming the loop
    return { merged, dropped }
  }

  const flush = async () => {
    if (savingRef.current) return
    savingRef.current = true
    try {
      while (pendingRef.current) {
        const next = pendingRef.current
        pendingRef.current = null
        // How many buffered ops this PUT accounts for. Edits arriving mid-flight push past this
        // marker and stay buffered for the next iteration; only the ones folded into `next` clear.
        const sentOps = unsavedOps.current.length
        const res = await auth.fetch('/api/data', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            ...(versionRef.current ? { 'X-Data-Version': versionRef.current } : {}),
          },
          body: JSON.stringify(next),
        })
        if (res.status === 409) {
          // Another editor's write landed first. Rebase: refetch their document and replay every
          // still-unsaved intent onto it, then re-PUT the merged result at their version.
          const adopted = await adoptServerDoc()
          if (!adopted) {
            setSaveState('error')
            return
          }
          pendingRef.current = adopted.merged // re-PUT the merge on the next iteration
          showToast(
            adopted.dropped
              ? `Merged another editor's change; ${adopted.dropped} of your edits no longer applied`
              : "Merged another editor's change",
          )
          continue
        }
        if (!res.ok) {
          setSaveState('error')
          return
        }
        versionRef.current = res.headers.get('X-Data-Version')
        unsavedOps.current.splice(0, sentOps) // these intents are now persisted
      }
      setSaveState('saved')
    } catch {
      setSaveState('error')
    } finally {
      savingRef.current = false
      if (pendingRef.current) flush() // an edit landed during the last PUT
    }
  }

  const scheduleSave = (next: DB) => {
    setSaveState('saving')
    pendingRef.current = next
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(flush, 500)
  }

  const update = useCallback(
    (fn: (d: DB) => void) => {
      if (!auth.canEdit) {
        showToast('Read-only — editor role required')
        return
      }
      setDb((prev) => {
        if (!prev) return prev
        const next = structuredClone(prev)
        fn(next)
        unsavedOps.current.push(fn) // buffered for replay if a 409 forces a rebase
        scheduleSave(next)
        return next
      })
    },
    [auth.canEdit],
  )

  /** Hand a blob to the browser as a download. Shared by every export on this screen. */
  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  const stamp = () => new Date().toISOString().slice(0, 10)

  /** Wait for the autosave to land, so what is fetched next includes the last edit. */
  const settle = async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    for (let i = 0; i < 100 && (pendingRef.current || savingRef.current); i++) {
      if (savingRef.current) await new Promise((r) => setTimeout(r, 50))
      else await flush()
    }
  }

  const exportDb = async () => {
    try {
      await settle() // an edit made in the last half second would otherwise be missing from the file
      const res = await auth.fetch('/api/data')
      if (!res.ok) throw new Error(String(res.status))
      const blob = new Blob([JSON.stringify(await res.json(), null, 2)], { type: 'application/json' })
      downloadBlob(blob, `feature-planner-${stamp()}.json`)
    } catch {
      showToast('Export failed')
    }
  }

  /**
   * Pull the shared vacation calendar now. The server does the fetch and the write (the feed has
   * no CORS headers, and it owns the merge), so afterwards we adopt its document — but only while
   * no autosave is pending or in flight: a PUT prepared against the old version would otherwise be
   * sent with the new one and overwrite the sync. With a save outstanding, that PUT simply 409s and
   * the rebase brings the imported periods in.
   */
  const syncVacations = async () => {
    try {
      const res = await auth.fetch('/api/vacations/sync', { method: 'POST' })
      const body = (await res.json().catch(() => null)) as NonNullable<VacationSyncStatus['lastSync']> | { error?: string } | null
      if (!res.ok || !body || !('ok' in body)) throw new Error((body && 'error' in body && body.error) || String(res.status))
      if (body.changed && !pendingRef.current && !savingRef.current) await adoptServerDoc()
      void loadCalendarStatus()
      showToast(
        `Vacations synced — ${body.matched} people matched, ${body.imported} period${body.imported === 1 ? '' : 's'}` +
          (body.holidayOnly ? `, ${body.holidayOnly} not in the calendar given company holidays` : '') +
          (body.replacedManual ? ` (${body.replacedManual} manual replaced)` : ''),
      )
    } catch (e) {
      showToast(`Vacation sync failed — ${e instanceof Error ? e.message : 'server error'}`)
    }
  }

  /** Sync after the pending settings save has landed, so the server reads the link just entered. */
  const syncVacationsAfterSave = async () => {
    await settle()
    await syncVacations()
  }

  const [backups, setBackups] = useState<{ name: string; size: number }[] | null>(null)

  const loadBackups = async () => {
    try {
      const res = await auth.fetch('/api/backups')
      if (!res.ok) throw new Error(String(res.status))
      setBackups(await res.json())
    } catch {
      showToast('Could not load backups')
    }
  }

  const downloadBackup = async (name: string) => {
    try {
      const res = await auth.fetch(`/api/backups/${encodeURIComponent(name)}`)
      if (!res.ok) throw new Error(String(res.status))
      downloadBlob(await res.blob(), name)
    } catch {
      showToast('Download failed')
    }
  }

  const importFileRef = useRef<HTMLInputElement | null>(null)
  // the Status tab's sheet import: the picked file opens ImportDialog
  const sheetFileRef = useRef<HTMLInputElement | null>(null)
  const [sheetFile, setSheetFile] = useState<File | null>(null)

  const importDb = async (file: File) => {
    let next: DB
    try {
      next = JSON.parse(await file.text())
    } catch {
      showToast('Import failed — not valid JSON')
      return
    }
    // the server runs the same check (shared/db.mjs); doing it here too rejects a bad file before the
    // confirm prompt, with the path that is wrong
    const problem = payloadProblem(next)
    if (problem) {
      showToast(`Import failed — ${problem}`)
      return
    }
    // Counts up front: a truncated or wrong-app file is obvious here, not after it has landed.
    const ok = await confirm({
      title: 'Replace database',
      message:
        `Replace the entire database with "${file.name}"?\n` +
        `${db?.features.length ?? 0} features / ${db?.people.length ?? 0} people → ` +
        `${next.features.length} features / ${next.people.length} people.\n` +
        'The server snapshots the current database to its backups first.',
      confirmLabel: 'Replace',
    })
    if (!ok) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    pendingRef.current = null // discard any coalesced autosave; the import supersedes it
    unsavedOps.current = [] // ...and its replay buffer — a whole-DB replace has nothing to rebase
    setSaveState('saving')
    try {
      // reason=import makes the server snapshot unconditionally, bypassing the once-a-day rule
      const res = await auth.fetch('/api/data?reason=import', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      })
      if (!res.ok) {
        const why = await res.json().catch(() => null)
        throw new Error(why?.error ?? String(res.status))
      }
      // re-fetch: server may normalize old-format exports on write, and the version has advanced
      const fresh = await auth.fetch('/api/data')
      if (fresh.ok) {
        versionRef.current = fresh.headers.get('X-Data-Version')
        setDb(await fresh.json())
      }
      setSaveState('saved')
      showToast('Database imported')
    } catch (e) {
      setSaveState('error')
      showToast(`Import failed — ${e instanceof Error ? e.message : 'server rejected upload'}`)
    }
  }

  // ----- feature edits: every closure looks things up by id, so a 409 replay lands -----
  const findFeature = (d: DB, id: string) => d.features.find((f) => f.id === id)
  const cellOf = (f: Feature, week: string): WeekCell => (f.cells[week] ??= { entries: [] })
  const tidy = (f: Feature, week: string) => {
    const c = f.cells[week]
    if (c && !c.entries.length && !c.note) delete f.cells[week]
  }

  const ops: FeatureOps = useMemo(
    () => ({
      addEntry: (featureId, weeks, entry) =>
        update((d) => {
          const f = findFeature(d, featureId)
          if (!f) return
          for (const w of weeks) {
            const cell = cellOf(f, w)
            const same = entry.personId ? cell.entries.find((e) => e.personId === entry.personId) : null
            if (same) Object.assign(same, { pct: entry.pct, kind: entry.kind })
            else cell.entries.push({ ...entry, id: uid() })
          }
        }),
      patchEntry: (featureId, week, entryId, patch) =>
        update((d) => {
          const e = findFeature(d, featureId)?.cells[week]?.entries.find((x) => x.id === entryId)
          if (!e) return
          Object.assign(e, patch)
          if (!e.note) delete e.note
        }),
      removeEntry: (featureId, week, entryId) =>
        update((d) => {
          const f = findFeature(d, featureId)
          const c = f?.cells[week]
          if (!f || !c) return
          c.entries = c.entries.filter((e) => e.id !== entryId)
          tidy(f, week)
        }),
      setCellNote: (featureId, week, note) =>
        update((d) => {
          const f = findFeature(d, featureId)
          if (!f) return
          const c = cellOf(f, week)
          if (note) c.note = note
          else delete c.note
          tidy(f, week)
        }),
      clearCells: (featureId, weeks) =>
        update((d) => {
          const f = findFeature(d, featureId)
          if (f) for (const w of weeks) delete f.cells[w]
        }),
      fillFromPrevious: (featureId, week) =>
        update((d) => {
          const f = findFeature(d, featureId)
          const prev = f?.cells[addWeeks(week, -1)]
          if (!f || !prev?.entries.length) return
          f.cells[week] = { entries: cloneCell(prev).entries, ...(f.cells[week]?.note ? { note: f.cells[week].note } : {}) }
        }),
      copyCells: (featureId, weeks) => {
        const f = db?.features.find((x) => x.id === featureId)
        if (!f) return
        clipboardRef.current = { sourceLabel: f.key ?? f.name, cells: weeks.map((w) => (f.cells[w] ? structuredClone(f.cells[w]) : null)) }
        showToast(`Copied ${weeks.length} week${weeks.length === 1 ? '' : 's'} of ${f.key ?? f.name}`)
      },
      pasteCells: (featureId, startWeek) => {
        const clip = clipboardRef.current
        if (!clip) return showToast('Nothing copied yet — select cells and press ⌘C')
        update((d) => {
          const f = findFeature(d, featureId)
          if (!f) return
          clip.cells.forEach((c, i) => {
            const w = addWeeks(startWeek, i)
            if (c) f.cells[w] = cloneCell(c)
            else delete f.cells[w]
          })
        })
        showToast(`Pasted ${clip.cells.length} week${clip.cells.length === 1 ? '' : 's'} from ${clip.sourceLabel}`)
      },
      clipboard: () => clipboardRef.current,
      patchFeature: (featureId, patch) =>
        update((d) => {
          const f = findFeature(d, featureId)
          if (!f) return
          deleteUndefined(Object.assign(f, patch)) // a cleared field is no key at all
        }),
      // merges into whatever the feature holds when the op runs (also on a 409 replay), never a snapshot
      patchTracking: (featureId, patch) =>
        update((d) => {
          const f = findFeature(d, featureId)
          if (!f) return
          const t: FeatureTracking = deleteUndefined({ ...f.tracking, ...patch }, true)
          if (Object.keys(t).length) f.tracking = t
          else delete f.tracking
        }),
      addAway: (personId, entry) =>
        update((d) => {
          const p = d.people.find((pe) => pe.id === personId)
          if (p) (p.away ??= []).push(entry)
        }),
      // stories: the caller makes the record with uid(), so a double-run of the updater (StrictMode)
      // or a 409 replay adds it once; every op ends by rolling the hours up into the feature
      addStory: (story) =>
        update((d) => {
          const f = findFeature(d, story.featureId)
          if (!f || d.stories.some((s) => s.id === story.id)) return
          const last = d.stories.map((s) => s.featureId).lastIndexOf(story.featureId)
          // the first story of an estimated feature takes the feature's figures with it, so the
          // hours move down a level instead of vanishing (the roll-up replaces them right after)
          if (last < 0 && story.estimate == null && story.logged == null && story.remaining == null) {
            const { estimate, logged, remaining } = f
            Object.assign(story, deleteUndefined({ estimate, logged, remaining }))
          }
          d.stories.splice(last < 0 ? d.stories.length : last + 1, 0, story)
          syncFeatureHours(d, story.featureId)
        }),
      patchStory: (storyId, patch) =>
        update((d) => {
          const s = d.stories.find((x) => x.id === storyId)
          if (!s) return
          deleteUndefined(Object.assign(s, patch))
          syncFeatureHours(d, s.featureId)
        }),
      patchStoryTracking: (storyId, patch) =>
        update((d) => {
          const s = d.stories.find((x) => x.id === storyId)
          if (!s) return
          const t: FeatureTracking = deleteUndefined({ ...s.tracking, ...patch }, true)
          if (Object.keys(t).length) s.tracking = t
          else delete s.tracking
        }),
      removeStory: (storyId) =>
        update((d) => {
          const s = d.stories.find((x) => x.id === storyId)
          if (!s) return
          d.stories = d.stories.filter((x) => x.id !== storyId)
          syncFeatureHours(d, s.featureId)
        }),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, update],
  )

  const cb: FeatureCallbacks = useMemo(
    () => ({
      openFeature: (featureId) => setDialog({ kind: 'feature', featureId }),
      openEpic: (epicId) => setDialog({ kind: 'epic', epicId }),
      newFeature: (epicId) => auth.canEdit && setDialog({ kind: 'newFeature', epicId }),
      openPerson: (personId) => setDialog({ kind: 'people', personId }),
    }),
    [auth.canEdit],
  )
  // a dialog left open on one view must not reappear over the next after a tab switch or Back
  useEffect(() => setDialog(null), [route?.view])

  const weeks = useMemo(() => (db ? gridWeeks(db, todayISO, compactTimeline) : []), [db, todayISO, compactTimeline])

  // ----- filtering -----
  const featurePeople = (f: Feature): Set<string> => {
    const ids = new Set<string>()
    if (f.leadId) ids.add(f.leadId)
    if (f.buddyId) ids.add(f.buddyId)
    if (f.testLeadId) ids.add(f.testLeadId)
    for (const c of Object.values(f.cells)) for (const e of c.entries) if (e.personId) ids.add(e.personId)
    return ids
  }
  const passStatus = (f: Feature) => !statusFilter.length || statusFilter.includes(f.status ?? '')
  const passRelease = (f: Feature) => !releaseFilter.length || releaseFilter.includes(f.releaseId ?? '')
  const passLead = (f: Feature) => !leadFilter.length || leadFilter.includes(f.leadId ?? '')
  const passCustomer = (f: Feature) => !customerFilter.length || customerFilter.includes(f.customer ?? '')
  const passPerson = (f: Feature) => {
    if (!personFilter.length) return true
    const ids = featurePeople(f)
    return personFilter.some((p) => ids.has(p))
  }
  const passDone = (f: Feature) => !hideDone || !isFinishedStatus(f.status)
  const passSearch = useCallback((f: Feature) => !q || (db ? featureSearchText(db, f).includes(q) : true), [db, q])

  const filteredFeatures = useMemo(
    () => (db ? db.features.filter((f) => passStatus(f) && passRelease(f) && passLead(f) && passCustomer(f) && passPerson(f) && passDone(f) && passSearch(f)) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, statusFilter, releaseFilter, leadFilter, customerFilter, personFilter, hideDone, passSearch],
  )

  /** The db the views paint from: tag colours snapped onto the app's palette; storage untouched. */
  const paintDb = useMemo(() => {
    if (!db) return null
    return { ...db, settings: { ...db.settings, optionColors: paletteOptionColors(db.settings?.optionColors, isDark) } }
  }, [db, isDark])
  const colorOf = useCallback((hex: string | undefined) => paletteColor(hex, isDark), [isDark])

  /** the packages the Status tab lists, and the listed features that have stories, for its Collapse All / Features / Stories stepper */
  const statusEpicIds = useMemo(() => (db ? db.epics.filter((e) => filteredFeatures.some((f) => f.epicId === e.id)).map((e) => e.id) : []), [db, filteredFeatures])
  const statusStoryFeatureIds = useMemo(() => (db ? filteredFeatures.filter((f) => db.stories.some((s) => s.featureId === f.id)).map((f) => f.id) : []), [db, filteredFeatures])
  const statusAllClosed = statusEpicIds.length > 0 && statusEpicIds.every((id) => statusClosed.includes(id))
  const statusNoEpicClosed = !statusEpicIds.some((id) => statusClosed.includes(id))
  const statusNoFeatureClosed = !statusStoryFeatureIds.some((id) => statusClosed.includes(id))
  // "Features": packages open, every feature with stories folded; with no stories listed it is simply "all open"
  const statusFeaturesLevel = statusNoEpicClosed && (statusStoryFeatureIds.length === 0 || statusStoryFeatureIds.every((id) => statusClosed.includes(id)))
  const statusStoriesLevel = statusNoEpicClosed && statusNoFeatureClosed
  const filtering = !!q || !!statusFilter.length || !!releaseFilter.length || !!leadFilter.length || !!customerFilter.length || !!personFilter.length || hideDone
  const tree = useMemo(
    () => (paintDb ? buildFeatureTree(paintDb, filteredFeatures, groupBy, { filtering, query: q }) : []),
    [paintDb, filteredFeatures, groupBy, filtering, q],
  )
  const expandLevels = treeLevels(groupBy)
  const searchKey = q ? `${groupBy}\u0000${q}` : ''
  const searchSeed = useMemo<ExpandedState>(() => expandAll(tree), [tree])
  const searchExpanded = searchExp?.key === searchKey ? searchExp.state : searchSeed
  const setSearchExpanded = useCallback<React.Dispatch<React.SetStateAction<ExpandedState>>>(
    (updater) =>
      setSearchExp((prev) => {
        const base = prev?.key === searchKey ? prev.state : searchSeed
        return { key: searchKey, state: typeof updater === 'function' ? updater(base) : updater }
      }),
    [searchKey, searchSeed],
  )
  useEffect(() => {
    if (!q) setSearchExp(null)
  }, [q])
  const searching = !!q
  const gridExpanded = searching ? searchExpanded : savedExpanded
  const setGridExpanded = searching ? setSearchExpanded : setSavedExpanded

  const clearFilters = () => {
    setStatusFilter([])
    setReleaseFilter([])
    setLeadFilter([])
    setCustomerFilter([])
    setPersonFilter([])
    setHideDone(false)
  }

  // ----- landing on a row from a link (Needs attention / Scope Overview / Status → planner) -----
  /** Rewrite the current entry so Back returns to where the click came from, then push the row. */
  const jumpToPlanner = useCallback(
    (target: JumpTarget, back: Route) => {
      navigate(back, { replace: true })
      navigate({ view: 'planner', ...target })
    },
    [navigate],
  )
  const [focusRequest, setFocusRequest] = useState<{ target: JumpTarget; nonce: number } | null>(null)
  const nonceRef = useRef(0)
  const dbReady = !!db
  // Route → request. Deps are the route and data readiness only: a later filter or edit must not
  // re-land the grid. The grid consumes the request by nonce, so Back/Forward or a second click on
  // the same item (each a fresh route object) land again.
  useEffect(() => {
    const d = db
    if (!d) return
    if (route?.view !== 'planner' || (!route.feature && !route.epic)) {
      setFocusRequest(null)
      return
    }
    // the group a feature sits under, by rows.ts's id scheme (`g:<key>`); null when not grouped
    const keyOf = (f: Feature) => groupKey(f, groupBy)
    let ids: string[]
    let target: JumpTarget
    if (route.feature) {
      const f = d.features.find((x) => x.id === route.feature)
      if (!f) {
        showToast('That feature no longer exists')
        navigate({ view: 'planner' }, { replace: true })
        return
      }
      // only clear what actually hides the target; the user's filters otherwise stay
      if (!filteredFeatures.some((x) => x.id === f.id)) {
        clearFilters()
        setSearch('')
      }
      const key = keyOf(f)
      ids = key == null ? [`e:${f.epicId}`] : [`g:${key}`, `g:${key}|e:${f.epicId}`]
      target = { feature: f.id }
    } else {
      const e = d.epics.find((x) => x.id === route.epic)
      if (!e) {
        showToast('That package no longer exists')
        navigate({ view: 'planner' }, { replace: true })
        return
      }
      // the epic row survives filtering only while one of its features passes
      if (filtering && !filteredFeatures.some((f) => f.epicId === e.id)) {
        clearFilters()
        setSearch('')
      }
      // grouped, the epic appears once per group its features fall in: open every one, land on the first
      const keys = groupBy === 'none' ? null : [...new Set(d.features.filter((f) => f.epicId === e.id).map(keyOf))]
      ids = keys == null ? [`e:${e.id}`] : keys.flatMap((k) => [`g:${k}`, `g:${k}|e:${e.id}`])
      target = { epic: e.id }
    }
    // expand the ancestors (and the epic itself, so a landed epic shows its features)
    setSavedExpanded((prev) => (prev === true ? true : { ...prev, ...Object.fromEntries(ids.map((id) => [id, true])) }))
    setFocusRequest({ target, nonce: ++nonceRef.current })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route, dbReady])

  if (!db || !paintDb) {
    return <div className="loading">{saveState === 'error' ? 'Failed to load data — is the storage server running? (npm run dev)' : 'Loading…'}</div>
  }
  const settings: Settings = db.settings
  const people = peopleById(db)

  // ----- facets -----
  const facetCount = (getVals: (f: Feature) => string[], others: ((f: Feature) => boolean)[]) => (value: string) =>
    db.features.filter((f) => others.every((o) => o(f)) && getVals(f).includes(value)).length
  const opts = (values: { value: string; label: string }[], counter: (v: string) => number) =>
    values.filter((v, i, a) => a.findIndex((x) => x.value === v.value) === i).map((v) => ({ value: v.value, label: v.label, count: counter(v.value) }))
  const personLabel = (id: string) => people.get(id)?.short ?? people.get(id)?.name ?? id
  const facets = [
    {
      key: 'status',
      label: 'Status',
      selected: statusFilter,
      onToggle: (v: string) => setStatusFilter(toggleIn(v)),
      options: opts(
        [...settings.featureStatuses, ...statusFilter].map((v) => ({ value: v, label: v })),
        facetCount((f) => [f.status ?? ''], [passRelease, passLead, passCustomer, passPerson, passDone, passSearch]),
      ),
    },
    {
      key: 'release',
      label: 'Release',
      selected: releaseFilter,
      onToggle: (v: string) => setReleaseFilter(toggleIn(v)),
      options: opts(
        [...db.releases.map((r) => ({ value: r.id, label: r.name })), { value: '', label: 'No release' }],
        facetCount((f) => [f.releaseId ?? ''], [passStatus, passLead, passCustomer, passPerson, passDone, passSearch]),
      ),
    },
    {
      key: 'lead',
      label: 'Lead',
      selected: leadFilter,
      onToggle: (v: string) => setLeadFilter(toggleIn(v)),
      options: opts(
        [...new Set(db.features.map((f) => f.leadId ?? ''))].map((id) => ({ value: id, label: id ? personLabel(id) : 'No lead' })),
        facetCount((f) => [f.leadId ?? ''], [passStatus, passRelease, passCustomer, passPerson, passDone, passSearch]),
      ),
    },
    {
      key: 'customer',
      label: 'Customer',
      selected: customerFilter,
      onToggle: (v: string) => setCustomerFilter(toggleIn(v)),
      options: opts(
        [...settings.customers, ...customerFilter, ...db.features.map((f) => f.customer ?? '')].map((v) => ({ value: v, label: v || 'No customer' })),
        facetCount((f) => [f.customer ?? ''], [passStatus, passRelease, passLead, passPerson, passDone, passSearch]),
      ),
    },
    {
      key: 'person',
      label: 'Person involved',
      selected: personFilter,
      onToggle: (v: string) => setPersonFilter(toggleIn(v)),
      options: opts(
        [...db.people].sort((a, b) => personLabel(a.id).localeCompare(personLabel(b.id))).map((p) => ({ value: p.id, label: personLabel(p.id) })),
        facetCount((f) => [...featurePeople(f)], [passStatus, passRelease, passLead, passCustomer, passDone, passSearch]),
      ),
    },
  ]
  const lastStop = expandLevels.length - 1
  const depthFor = (i: number) => Math.max(0, i - 1)
  const stopMatches = (i: number) =>
    gridExpanded === true ? i === lastStop : sameExpansion(expandToDepth(tree, depthFor(i)), gridExpanded)
  const setStop = (i: number) => setGridExpanded(!searching && i >= lastStop ? true : expandToDepth(tree, depthFor(i)))

  /** The planner's filters, shared with the Status tab (its search box sits next to it; the grid's is in its header). */
  const filterBar = () => (
    <FilterBar
      facets={facets}
      toggles={[
        {
          key: 'hideDone',
          label: 'Hide finished features',
          on: hideDone,
          count: db.features.filter((f) => !isFinishedStatus(f.status) && passStatus(f) && passRelease(f) && passLead(f) && passCustomer(f) && passPerson(f) && passSearch(f)).length,
          onChange: () => setHideDone((v) => !v),
        },
      ]}
      resultCount={filteredFeatures.length}
      totalCount={db.features.length}
      search={search}
      noun="features"
      onClearAll={() => {
        clearFilters()
        setSearch('')
      }}
    />
  )

  const renderDialog = () => {
    if (!dialog) return null
    switch (dialog.kind) {
      case 'feature':
      case 'newFeature': {
        const create = dialog.kind === 'newFeature'
        const feature = create ? newFeatureDraft(db, dialog.epicId) : db.features.find((f) => f.id === dialog.featureId)
        if (!feature) return null
        return (
          <FeatureDialog
            key={feature.id}
            db={db}
            feature={feature}
            create={create}
            readOnly={!auth.canEdit}
            hideResigned={hideResigned}
            onClose={() => setDialog(null)}
            onSave={(next) =>
              update((d) => {
                const i = d.features.findIndex((f) => f.id === next.id)
                if (i < 0) {
                  // new features go after the last feature of their epic, so they land inside it
                  const last = d.features.map((f) => f.epicId).lastIndexOf(next.epicId)
                  d.features.splice(last < 0 ? d.features.length : last + 1, 0, next)
                  return
                }
                // cells are edited in the grid, not the dialog — keep whatever is stored now
                d.features[i] = { ...next, cells: d.features[i].cells }
                // the dialog may have been open while a story changed: the stories win
                syncFeatureHours(d, next.id)
              })
            }
            onDelete={() =>
              update((d) => {
                d.features = d.features.filter((f) => f.id !== feature.id)
                d.stories = d.stories.filter((s) => s.featureId !== feature.id)
              })
            }
          />
        )
      }
      case 'epic':
      case 'newEpic': {
        const create = dialog.kind === 'newEpic'
        const epic: Epic | undefined = create ? { id: uid(), name: '' } : db.epics.find((e) => e.id === dialog.epicId)
        if (!epic) return null
        return (
          <EpicDialog
            epic={epic}
            create={create}
            readOnly={!auth.canEdit}
            featureCount={db.features.filter((f) => f.epicId === epic.id).length}
            storyCount={db.stories.filter((s) => db.features.some((f) => f.id === s.featureId && f.epicId === epic.id)).length}
            onClose={() => setDialog(null)}
            onSave={(next) =>
              update((d) => {
                const i = d.epics.findIndex((e) => e.id === next.id)
                if (i < 0) d.epics.push(next)
                else d.epics[i] = next
              })
            }
            onDelete={() =>
              update((d) => {
                const gone = new Set(d.features.filter((f) => f.epicId === epic.id).map((f) => f.id))
                d.epics = d.epics.filter((e) => e.id !== epic.id)
                d.features = d.features.filter((f) => !gone.has(f.id))
                d.stories = d.stories.filter((s) => !gone.has(s.featureId))
              })
            }
          />
        )
      }
      case 'people':
        return (
          <PeopleDialog
            db={db}
            profiles={settings.profiles}
            initialPersonId={dialog.personId}
            readOnly={!auth.canEdit}
            calendar={calendar}
            today={todayISO}
            hideResigned={hideResigned}
            onHideResigned={setHideResigned}
            onClose={() => setDialog(null)}
            onSave={(next) =>
              update((d) => {
                d.people = next
                const ids = new Set(next.map((p) => p.id))
                for (const f of d.features) {
                  if (f.leadId && !ids.has(f.leadId)) delete f.leadId
                  if (f.buddyId && !ids.has(f.buddyId)) delete f.buddyId
                  if (f.testLeadId && !ids.has(f.testLeadId)) delete f.testLeadId
                  for (const [w, c] of Object.entries(f.cells)) {
                    c.entries = c.entries.filter((e) => !e.personId || ids.has(e.personId))
                    if (!c.entries.length && !c.note) delete f.cells[w]
                  }
                }
              })
            }
          />
        )
      case 'settings':
        return (
          <SettingsDialog
            settings={settings}
            onClose={() => setDialog(null)}
            onSave={(edited) => {
              const linkChanged = 'calendarUrl' in edited && (edited.calendarUrl ?? '') !== (settings.calendarUrl ?? '')
              update((d) => {
                d.settings = { ...d.settings, ...edited }
                if (!d.settings.calendarUrl) delete d.settings.calendarUrl
              })
              // a new link is pulled right away, once the save has landed; a cleared one just updates the menu
              if (linkChanged) void (edited.calendarUrl ? syncVacationsAfterSave() : settle().then(loadCalendarStatus))
            }}
          />
        )
      case 'releases':
        return (
          <ReleasesDialog
            db={db}
            onClose={() => setDialog(null)}
            onSave={(releases, milestones) =>
              update((d) => {
                d.releases = releases
                d.milestones = milestones
                const ids = new Set(releases.map((r) => r.id))
                for (const f of d.features) if (f.releaseId && !ids.has(f.releaseId)) delete f.releaseId
                for (const m of d.milestones) if (m.releaseId && !ids.has(m.releaseId)) delete m.releaseId
              })
            }
          />
        )
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-row topbar-main">
          <h1 className="brand">
            <img className="brand-mark" src="/favicon.png" alt="" width={22} height={22} />
            Feature Planner
          </h1>
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
            <span className={`save-state ${saveState}`}>
              {saveState === 'saved' ? 'Saved' : saveState === 'saving' ? 'Saving…' : 'Save failed'}
            </span>
          ) : (
            <span className="save-state" title="You have the viewer role — editing is disabled">
              Read-only
            </span>
          )}
          {auth.canEdit && (
            <>
              <input
                ref={importFileRef}
                type="file"
                accept="application/json,.json"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  e.target.value = ''
                  if (f) importDb(f)
                }}
              />
              <input
                ref={sheetFileRef}
                type="file"
                accept=".xlsx,.xls,.xlsm,.csv,.tsv"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  e.target.value = ''
                  if (f) setSheetFile(f)
                }}
              />
              <button className="btn primary" onClick={() => setDialog({ kind: 'people' })}>
                ✎ People
              </button>
              <button className="btn primary" onClick={() => setDialog({ kind: 'newEpic' })}>
                + Package
              </button>
            </>
          )}
          <SettingsMenu
            theme={theme}
            onThemeChange={setTheme}
            onExport={exportDb}
            backups={backups}
            onLoadBackups={loadBackups}
            onDownloadBackup={downloadBackup}
            canEdit={auth.canEdit}
            onImport={() => importFileRef.current?.click()}
            onDefaults={() => setDialog({ kind: 'settings' })}
            onReleases={() => setDialog({ kind: 'releases' })}
            onSyncVacations={calendar?.enabled === false ? null : () => void syncVacations()}
            calendarConfigured={calendar?.enabled ?? null}
            authEnabled={auth.enabled}
            userName={auth.userName}
            onLogout={auth.logout}
          />
        </div>
        {view === 'planner' && (
          <div className="topbar-row topbar-tools">
            <div className="view-toggle" title="Group features by">
              {GROUP_OPTIONS.map((g) => (
                <button key={g.id} className={groupBy === g.id ? 'active' : ''} onClick={() => setGroupBy(g.id)}>
                  By {g.label.toLowerCase()}
                </button>
              ))}
            </div>
            <div className="view-toggle expand-stepper" title="Expand depth">
              {expandLevels.map((label, i) => (
                <button key={label + i} className={stopMatches(i) ? 'active' : ''} onClick={() => setStop(i)}>
                  {label}
                </button>
              ))}
            </div>
            {filterBar()}
            <div className="view-toggle">
              <button className={compactFields ? 'active' : ''} title="Hide the field columns except status and lead" onClick={() => setCompactFields((v) => !v)}>
                Compact fields
              </button>
              <button className={dense ? 'active' : ''} title="Narrow week columns" onClick={() => setDense((v) => !v)}>
                Narrow weeks
              </button>
              <button className={compactTimeline ? 'active' : ''} title="Start the timeline 4 weeks before today" onClick={() => setCompactTimeline((v) => !v)}>
                From today
              </button>
              <button className={bars ? 'active' : ''} title="Gantt view: planned vs booked weeks as bars instead of names" onClick={() => setBars((v) => !v)}>
                Gantt view
              </button>
              {bars && (
                <button className={showPlanned ? 'active' : ''} title="Draw the planned weeks as a dotted bar above the booked bar" onClick={() => setShowPlanned((v) => !v)}>
                  Show planned
                </button>
              )}
            </div>
          </div>
        )}
        {view === 'status' && (
          <div className="topbar-row topbar-tools">
            <input className="search-input sv-search" type="search" placeholder="Search packages, features, stories, people…" value={search} onChange={(e) => setSearch(e.target.value)} />
            <div className="view-toggle expand-stepper" title={searching ? 'A search opens everything' : 'Expand depth'}>
              <button className={!searching && statusAllClosed ? 'active' : ''} disabled={searching || !statusEpicIds.length} onClick={() => setStatusClosed([...statusEpicIds, ...statusStoryFeatureIds])}>
                Collapse All
              </button>
              <button
                className={!searching && statusFeaturesLevel ? 'active' : ''}
                disabled={searching || !statusEpicIds.length}
                onClick={() => setStatusClosed(statusStoryFeatureIds)}
              >
                Features
              </button>
              {statusStoryFeatureIds.length > 0 && (
                <button className={searching || statusStoriesLevel ? 'active' : ''} disabled={searching || !statusEpicIds.length} onClick={() => setStatusClosed([])}>
                  Stories
                </button>
              )}
            </div>
            {filterBar()}
            {auth.canEdit && (
              <button className="btn small" title="Import a Jira export (Excel or CSV) into these columns" onClick={() => sheetFileRef.current?.click()}>
                Import sheet…
              </button>
            )}
          </div>
        )}
      </header>
      {view === 'capacity' ? (
        <CapacityView
          db={paintDb}
          todayISO={todayISO}
          hideResigned={hideResigned}
          colorOf={colorOf}
          onOpenFeature={cb.openFeature}
          onFocusFeature={(id) => jumpToPlanner({ feature: id }, { view: 'capacity', at: 'attention' })}
          onScopeFeature={(id) => jumpToPlanner({ feature: id }, { view: 'capacity', at: 'scope' })}
          onScopeEpic={(id) => jumpToPlanner({ epic: id }, { view: 'capacity', at: 'scope' })}
          scrollTo={route?.view === 'capacity' ? route.at ?? null : null}
          readOnly={!auth.canEdit}
          onMarkAway={ops.addAway}
          onEditPerson={cb.openPerson}
        />
      ) : view === 'status' ? (
        <StatusView
          db={paintDb}
          features={filteredFeatures}
          searching={searching}
          todayISO={todayISO}
          hideResigned={hideResigned}
          readOnly={!auth.canEdit}
          ops={ops}
          onOpenFeature={cb.openFeature}
          onGoFeature={(id) => jumpToPlanner({ feature: id }, { view: 'status' })}
          onGoEpic={(id) => jumpToPlanner({ epic: id }, { view: 'status' })}
          closed={statusClosed}
          onSetClosed={(id, fold) => setStatusClosed((prev) => (fold ? (prev.includes(id) ? prev : [...prev, id]) : prev.filter((x) => x !== id)))}
        />
      ) : view === 'roadmap' ? (
        <GanttView db={paintDb} todayISO={todayISO} colorOf={colorOf} readOnly={!auth.canEdit} showPlanned={showPlanned} onShowPlanned={setShowPlanned} update={update} />
      ) : (
        <>
          <FeatureGrid
            db={paintDb}
            fullDb={paintDb}
            hideResigned={hideResigned}
            weeks={weeks}
            treeRows={tree}
            expanded={gridExpanded}
            onExpandedChange={setGridExpanded}
            search={search}
            onSearchChange={setSearch}
            compactFields={compactFields}
            dense={dense}
            bars={bars}
            showPlanned={showPlanned}
            scrollToStart={compactTimeline}
            focusRequest={focusRequest}
            ops={ops}
            cb={cb}
            readOnly={!auth.canEdit}
            colorOf={colorOf}
          />
          <footer className="statusbar">
            {bars && (
              <span className="hint bars-legend">
                {showPlanned && <><span className="gbar-key plan" /> planned · </>}<span className="gbar-key act k-dev" /> dev · <span className="gbar-key act k-test" /> test ·{' '}
                <span className="gbar-key act k-buffer" /> buffer · <span className="gbar-key act stated" /> in progress, nobody booked ·{' '}
                <span className="gbar-key gap slip" /> past the planned end · <span className="gbar-key gap early" /> finished early · ✓ finished
              </span>
            )}
            {auth.canEdit ? (
              <>
                <span className="hint">Click a cell to select it, click it again (or double-click) to add people — drag across weeks to select a range</span>
                <span className="hint">
                  <kbd>↑↓←→</kbd> move · <kbd>Shift</kbd>+<kbd>←→</kbd> select · <kbd>Enter</kbd> edit · <kbd>R</kbd> same as last week · <kbd>⌫</kbd> clear · <kbd>⌘C</kbd>/<kbd>⌘V</kbd> copy/paste
                </span>
                <span className="hint">Click Status, Customer, Release, Lead, Buddy, Test lead, Estimate or Remaining to change them in place</span>
              </>
            ) : (
              <span className="hint">Read-only view — hover a cell for who and why, click a feature for its details</span>
            )}
          </footer>
        </>
      )}
      {renderDialog()}
      {confirmUI}
      {sheetFile && db && (
        <ImportDialog
          db={db}
          file={sheetFile}
          onClose={() => setSheetFile(null)}
          onApply={(plan, mapping) => {
            // one update: the rows and the remembered mapping land in one autosave and replay together
            update((d) => {
              applyPlan(d, plan)
              if (mapping) d.settings.importMapping = mapping
            })
            const t = plan.summary
            showToast(`Imported — ${t.featuresUpdated + t.storiesUpdated} updated, ${t.storiesCreated} stor${t.storiesCreated === 1 ? 'y' : 'ies'} added, ${t.skipped} skipped`)
            setSheetFile(null)
          }}
        />
      )}
    </div>
  )
}
