import { useCallback, useEffect, useRef, useState } from 'react'
import type { Auth } from './auth'
import type { DB } from './types'

export type SaveState = 'saved' | 'saving' | 'error'

interface Options {
  auth: Auth
  /** the team's API prefix: `/api/teams/<id>` */
  api: string
  /** may this user write this team? (shared/auth.mjs canEditTeam); false makes update() a toast */
  canEdit: boolean
  /** the server answered 404 for this team: someone deleted it */
  onGone: () => void
  /** a short message for the user (the toast) */
  notify: (msg: string) => void
  /** the shell awaits this before switching teams, so the last half-second of edits lands first */
  settleRef: React.MutableRefObject<(() => Promise<void>) | null>
}

/**
 * One team document and its autosave: load it, edit it through `update`, and keep the server in
 * step. Edits are debounced into single-flight PUTs guarded by the document version
 * (X-Data-Version); a 409 refetches the other editor's document, replays every still-unsaved edit
 * onto it and PUTs the merge. A pending save is pushed through on unmount and the browser warns
 * before a tab with one closes. Shared by a team's plan and the Program's.
 */
export function useAutosave({ auth, api, canEdit, onGone, notify, settleRef }: Options) {
  const [db, setDb] = useState<DB | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Optimistic-concurrency version last seen from the server; echoed on every PUT so a stale write
  // is rejected (409) instead of silently clobbering another editor's save.
  const versionRef = useRef<string | null>(null)
  // Single-flight autosave: only one PUT is ever in flight; edits during a save coalesce here.
  const savingRef = useRef(false)
  const pendingRef = useRef<DB | null>(null)
  // Mutations applied since the last confirmed save, in order — replayed onto the server's document
  // on a 409 (rebase), so two people editing different things never lose work.
  const unsavedOps = useRef<((d: DB) => void)[]>([])

  useEffect(() => {
    auth
      .fetch(`${api}/data`)
      .then(async (r) => {
        if (r.status === 404) return onGone()
        if (!r.ok) throw new Error(String(r.status))
        versionRef.current = r.headers.get('X-Data-Version')
        setDb(await r.json())
      })
      .catch(() => setSaveState('error'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth, api])

  /**
   * Adopt the server's current document: take its version, replay every still-unsaved local
   * intent onto it, and show the result. Ops that no longer apply (someone deleted the row we
   * edited) are skipped, not fatal — the count comes back so the caller can say so. Shared by the
   * 409 rebase and by the vacation sync, which changes the document server-side.
   */
  const adoptServerDoc = async (): Promise<{ merged: DB; dropped: number } | null> => {
    const fresh = await auth.fetch(`${api}/data`)
    if (fresh.status === 404) {
      onGone()
      return null
    }
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
        const res = await auth.fetch(`${api}/data`, {
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
          notify(adopted.dropped ? `Merged another editor's change; ${adopted.dropped} of your edits no longer applied` : "Merged another editor's change")
          continue
        }
        if (res.status === 404) {
          onGone() // the team was deleted under us; nothing to save it into
          return
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
      if (!canEdit) {
        notify('Read-only — you cannot edit this team')
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canEdit],
  )

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

  /** a save is pending or in flight */
  const busy = () => !!pendingRef.current || savingRef.current

  /**
   * Replace the whole document with `next` (a file import): the pending autosave and its replay
   * buffer are dropped — a whole-document replace has nothing to rebase — and the server snapshots
   * the plan first (`reason=import`). Throws with the server's reason when it refuses the file.
   */
  const replace = async (next: DB) => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    pendingRef.current = null
    unsavedOps.current = []
    setSaveState('saving')
    try {
      const res = await auth.fetch(`${api}/data?reason=import`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      })
      if (!res.ok) {
        const why = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(why?.error ?? String(res.status))
      }
      // re-fetch: server may normalize old-format exports on write, and the version has advanced
      const fresh = await auth.fetch(`${api}/data`)
      if (fresh.ok) {
        versionRef.current = fresh.headers.get('X-Data-Version')
        setDb(await fresh.json())
      }
      setSaveState('saved')
    } catch (e) {
      setSaveState('error')
      throw e
    }
  }

  // The shell awaits settle() before switching teams. Back/Forward and a delete unmount this plan
  // without asking, so the cleanup pushes whatever is pending through on its own: the closure still
  // holds this team's URL and version, and React ignores the state updates of an unmounted
  // component. (StrictMode's mount-unmount-mount at start finds nothing pending.)
  const flushRef = useRef(flush)
  flushRef.current = flush
  useEffect(() => {
    settleRef.current = settle
    return () => {
      settleRef.current = null
    }
  })
  useEffect(
    () => () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current)
        saveTimer.current = null
        void flushRef.current()
      }
    },
    [],
  )
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (pendingRef.current || savingRef.current) e.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])

  return { db, setDb, update, saveState, settle, busy, adoptServerDoc, replace }
}
