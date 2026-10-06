import React, { useCallback, useEffect, useRef, useState } from 'react'

export interface ConfirmOptions {
  title: string
  /** body text; '\n' renders as a line break */
  message: string
  /** label on the confirming button; defaults to 'Confirm' */
  confirmLabel?: string
  /** label on the declining button; defaults to 'Cancel' */
  cancelLabel?: string
  /** false for a choice that destroys nothing: the confirming button is the primary one and takes the focus */
  danger?: boolean
}

function ConfirmDialog({ opts, onDone }: { opts: ConfirmOptions; onDone: (ok: boolean) => void }) {
  const danger = opts.danger ?? true
  // Capture phase + stopPropagation so Esc closes only this dialog, not the modal underneath it
  // (Modal's own Esc handler is bubble-phase and would otherwise fire too).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onDone(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onDone])

  return (
    <div className="modal-overlay confirm-overlay" onMouseDown={(e) => e.target === e.currentTarget && onDone(false)}>
      <div className="modal confirm-modal">
        <div className="modal-head">
          <h3>{opts.title}</h3>
        </div>
        <div className="modal-body">
          <p className="confirm-message">{opts.message}</p>
          <div className="modal-actions">
            {/* a destructive button is never the focus target — a stray Enter must not confirm */}
            <button className="btn" autoFocus={danger} onClick={() => onDone(false)}>{opts.cancelLabel ?? 'Cancel'}</button>
            <button className={`btn ${danger ? 'danger-solid' : 'primary'}`} autoFocus={!danger} onClick={() => onDone(true)}>{opts.confirmLabel ?? 'Confirm'}</button>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * App-styled replacement for window.confirm. `ask()` resolves true/false; render
 * `ui` anywhere inside the component that owns the action.
 */
export function useConfirm(): { ask: (o: ConfirmOptions) => Promise<boolean>; ui: React.ReactNode } {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null)
  const resolveRef = useRef<((ok: boolean) => void) | null>(null)

  // both are stable: callers put `ask` in useMemo/useCallback dep arrays
  const ask = useCallback(
    (o: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        resolveRef.current = resolve
        setOpts(o)
      }),
    [],
  )

  const done = useCallback((ok: boolean) => {
    resolveRef.current?.(ok)
    resolveRef.current = null
    setOpts(null)
  }, [])

  return { ask, ui: opts ? <ConfirmDialog opts={opts} onDone={done} /> : null }
}
