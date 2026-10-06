import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'

interface Props {
  x: number
  y: number
  onClose: () => void
  /**
   * Render the click-blocking backdrop (default). Pass false where the click that dismisses the
   * popover should still reach what's underneath — the grid needs one click, not two, to move
   * from an open cell popover to another cell.
   */
  overlay?: boolean
  children: React.ReactNode
}

/** Fixed-position popover anchored at (x, y), clamped to the viewport. Esc / outside click closes. */
export default function Popover({ x, y, onClose, overlay = true, children }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  // Clamp into the viewport on open and again whenever the content changes size (a picker that
  // expands inside the popover must not push it off-screen).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const place = () => {
      const r = el.getBoundingClientRect()
      let left = x
      let top = y + 8
      if (left + r.width > window.innerWidth - 8) left = window.innerWidth - r.width - 8
      if (top + r.height > window.innerHeight - 8) top = Math.max(8, Math.min(y - r.height - 8, window.innerHeight - r.height - 8))
      setPos({ left: Math.max(8, left), top: Math.max(8, top) })
    }
    place()
    const ro = new ResizeObserver(place)
    ro.observe(el)
    return () => ro.disconnect()
  }, [x, y])

  useEffect(() => {
    // Capture phase + stopPropagation so Esc closes only this popover, not an enclosing modal.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  // Overlay-less mode: close on an outside mousedown without swallowing it. Subscribing in a
  // timeout skips the very mousedown that opened us (the need popover opens on mousedown).
  useEffect(() => {
    if (overlay) return
    let down: ((e: MouseEvent) => void) | null = null
    const t = setTimeout(() => {
      down = (e: MouseEvent) => {
        if (!ref.current?.contains(e.target as Node)) onClose()
      }
      document.addEventListener('mousedown', down, true)
    }, 0)
    return () => {
      clearTimeout(t)
      if (down) document.removeEventListener('mousedown', down, true)
    }
  }, [overlay, onClose])

  return (
    <>
      {overlay && <div className="popover-overlay" onMouseDown={onClose} />}
      <div className="popover" ref={ref} style={{ left: pos.left, top: pos.top }}>
        {children}
      </div>
    </>
  )
}

/** Allocation presets: the day-fractions (20/40/60/80), the quarters (25/50/75) and 30 — the values that actually get typed. */
export const PCT_OPTIONS = [0, 20, 25, 30, 40, 50, 60, 75, 80, 100]

export function PctButtons({
  current,
  onPick,
  options = PCT_OPTIONS,
}: {
  current?: number | null
  onPick: (pct: number) => void
  options?: number[]
}) {
  const [custom, setCustom] = useState('')
  return (
    <div className="pct-buttons">
      {options.map((p) => (
        <button key={p} className={current === p ? 'pct active' : 'pct'} onClick={() => onPick(p)}>
          {p}%
        </button>
      ))}
      <input
        className="pct-custom"
        placeholder="Custom…"
        value={custom}
        onChange={(e) => setCustom(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            const v = Number(custom.replace(',', '.'))
            if (!Number.isNaN(v) && v >= 0) onPick(v)
          }
          if (e.key !== 'Escape') e.stopPropagation() // let Esc bubble to close the popover
        }}
      />
    </div>
  )
}
