import { ReactNode, forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'

interface TipState {
  content: ReactNode
  /** the point to hang the plate off: the cursor, or (anchored) the element's bottom-left */
  cx: number
  cy: number
  anchored: boolean
}

/** Where a plate of size w×h goes for a cursor / anchor point, flipped so it stays in the viewport. */
function placePlate(t: TipState, w: number, h: number): { x: number; y: number } {
  let x = t.anchored ? t.cx : t.cx + 14
  let y = t.anchored ? t.cy + 8 : t.cy + 14
  if (x + w > window.innerWidth - 8) x = t.anchored ? Math.max(8, window.innerWidth - 8 - w) : t.cx - w - 10
  if (y + h > window.innerHeight - 8) y = t.anchored ? t.cy - h - 8 : t.cy - h - 10
  return { x: Math.max(0, x), y: Math.max(0, y) }
}

/** The plate itself: measured after its content renders, so placement never uses a previous tip's size. */
function usePlate() {
  const [tip, setTip] = useState<TipState | null>(null)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const ref = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    if (!tip) return
    const r = ref.current?.getBoundingClientRect()
    setPos(placePlate(tip, r?.width ?? 0, r?.height ?? 0))
  }, [tip])
  const element = (
    <div ref={ref} className="dash-tip" role="tooltip" style={{ left: pos.x, top: pos.y, opacity: tip ? 1 : 0 }}>
      {tip?.content}
    </div>
  )
  return { tip, setTip, element }
}

export interface TipHandlers {
  onMouseEnter: (e: React.MouseEvent) => void
  onMouseMove: (e: React.MouseEvent) => void
  onMouseLeave: () => void
  onFocus: (e: React.FocusEvent) => void
  onBlur: () => void
  tabIndex: number
}

/** Spread onto any element to give it a tooltip. */
export type TipAttach = (content: ReactNode) => TipHandlers

/**
 * One floating tooltip plate for a view (styled by `.dash-tip` in styles.css). `attach(content)` returns the handlers + tabIndex to spread onto any
 * element; content is a ReactNode, so tips are built as JSX. The plate follows the cursor at +14px
 * and flips when it would overflow the viewport; keyboard focus anchors it under the element.
 * Right for a few dozen elements (the capacity chart); a grid of thousands of cells uses TipLayer.
 */
export function useTip(): { attach: TipAttach; hide: () => void; element: ReactNode } {
  const { setTip, element } = usePlate()
  const attach = useCallback(
    (content: ReactNode) => ({
      onMouseEnter: (e: React.MouseEvent) => setTip({ content, cx: e.clientX, cy: e.clientY, anchored: false }),
      onMouseMove: (e: React.MouseEvent) => setTip((prev) => (prev ? { ...prev, cx: e.clientX, cy: e.clientY } : prev)),
      onMouseLeave: () => setTip(null),
      onFocus: (e: React.FocusEvent) => {
        const r = e.currentTarget.getBoundingClientRect()
        setTip({ content, cx: r.left, cy: r.bottom, anchored: true })
      },
      onBlur: () => setTip(null),
      tabIndex: 0,
    }),
    [setTip],
  )
  // For a click that opens something over the tip: the element's mouseleave never fires once its
  // handlers are gone, so the plate would otherwise stay frozen where the cursor last was.
  const hide = useCallback(() => setTip(null), [setTip])
  return { attach, hide, element }
}

export interface TipHandle {
  show(content: ReactNode, x: number, y: number): void
  move(x: number, y: number): void
  hide(): void
}

/**
 * The same plate as an imperative layer, for a component that drives it from one delegated
 * mouse handler (the planner grid): the tooltip state lives here, so moving the mouse re-renders
 * this small element and not the grid that owns the ref.
 */
export const TipLayer = forwardRef<TipHandle>(function TipLayer(_props, ref) {
  const { setTip, element } = usePlate()
  useImperativeHandle(
    ref,
    () => ({
      show: (content, x, y) => setTip({ content, cx: x, cy: y, anchored: false }),
      move: (x, y) => setTip((prev) => (prev ? { ...prev, cx: x, cy: y } : prev)),
      hide: () => setTip(null),
    }),
    [setTip],
  )
  return element
})
