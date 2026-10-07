import React, { useLayoutEffect, useRef } from 'react'
import { isoWeekNum, weekLabel, weekTag } from '../logic'
import type { TimelineBands } from './useTimelineBands'

/** A timeline label that shrinks (11px → 8px, up to two lines) until it fits its phase's weeks. */
function FitLabel({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const fit = () => {
      let size = 11
      el.style.fontSize = `${size}px`
      while (size > 8 && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)) {
        size -= 0.5
        el.style.fontSize = `${size}px`
      }
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el.parentElement ?? el)
    return () => ro.disconnect()
  }, [text])
  return (
    <div ref={ref} className="phase-name">
      {text}
    </div>
  )
}

interface Props {
  weeks: string[]
  todayWeek: string
  /** from useTimelineBands — the table's body cells share the same instance */
  bands: TimelineBands
  /** what goes in the label column's header cell */
  label: React.ReactNode
  /** the table's own label-column class (sticky left / width rules), added to `tl-lbl` */
  labelClassName?: string
}

/**
 * The three-row week header shared by the planner and the roadmap: the months, the phases and
 * one-day events named across their weeks, and the weeks themselves (W## with the date, or the
 * "today" chip). Styled by `.tl-head` in styles.css; the column widths come from the table's colgroup.
 */
export function TimelineHead({ weeks, todayWeek, bands, label, labelClassName }: Props) {
  const { months, phaseCells, timelineClass, weekClass, weekStyle, msWeeks, relWeeks } = bands
  return (
    <thead className="tl-head">
      <tr className="month-row">
        <th className={`tl-lbl${labelClassName ? ` ${labelClassName}` : ''}`} rowSpan={3}>
          {label}
        </th>
        {months.map((g, i) => (
          <th key={g.key} colSpan={g.weeks.length} className={`month-head${i % 2 ? ' alt' : ''}`}>
            {g.label}
          </th>
        ))}
      </tr>
      <tr className="timeline-row">
        {phaseCells.map((c) =>
          c.kind === 'phase' ? (
            <th
              key={c.key}
              colSpan={c.span}
              className={timelineClass(c.key, c.span, c.edges)}
              title={c.title}
              style={{ ...weekStyle(c.key), ...(c.color ? { '--ph': c.color } : {}) } as React.CSSProperties}
            >
              {c.label && <FitLabel text={c.name} />}
            </th>
          ) : (
            <th key={c.key} colSpan={c.span} className={timelineClass(c.key, c.span, null)} style={weekStyle(c.key)} />
          ),
        )}
      </tr>
      <tr className="week-row">
        {weeks.map((w) => {
          const ms = msWeeks.get(w) ?? []
          const rel = relWeeks.get(w) ?? []
          // the phase row names these; the week header keeps W## + date
          const tip = [
            `ISO week ${isoWeekNum(w)} · week of ${w}`,
            ...rel.map((r) => `🏁 ${r.name} release · ${r.date}`),
            ...ms.map((m) => `◆ ${m.name} · ${m.date}${m.end ? ` → ${m.end}` : ''}`),
          ].join('\n')
          return (
            <th key={w} title={tip} className={weekClass(w)} style={weekStyle(w)}>
              <div className="week-head">
                <div>{weekTag(w)}</div>
                {w === todayWeek ? (
                  <div className="week-head-chip"><span className="today-chip">today</span></div>
                ) : (
                  <div className="week-head-date">{weekLabel(w)}</div>
                )}
              </div>
            </th>
          )
        })}
      </tr>
    </thead>
  )
}
