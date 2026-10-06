import { KIND_LABEL } from '../types'
import { weekTag } from '../logic'
import type { TipAttach } from '../ui/useTip'

/** one column of the chart: a week's available FTE against what is booked, by kind */
export interface FteColumn {
  w: string
  available: number
  dev: number
  test: number
  buffer: number
}

interface Props<C extends FteColumn> {
  title: string
  hint: string
  columns: C[]
  today: string
  /** the hover plate of a column */
  tip: (c: C) => React.ReactNode
  attach: TipAttach
  fromToday: boolean
  onFromToday: (v: boolean) => void
  /** extra legend entries after the kinds (the Program adds "Available" twice over) */
  legendExtra?: React.ReactNode
}

/**
 * "Booked vs available, per week": a column per week stacked by dev / test / buffer FTE, the
 * available line over it and a "!" where the column rises above the line. The Capacity tab draws
 * one team with it; the Program draws every team summed.
 */
export default function FteChart<C extends FteColumn>({ title, hint, columns, today, tip, attach, fromToday, onFromToday, legendExtra }: Props<C>) {
  const maxY = Math.max(1, ...columns.map((f) => Math.max(f.available, f.dev + f.test + f.buffer)))
  const yMax = Math.ceil(maxY)
  // deduplicated: a plan with nothing booked has yMax 1, where the middle tick equals the top one
  const ticks = [...new Set([0, Math.round(yMax / 2), yMax])]
  return (
    <section className="cv-card">
      <div className="cv-head">
        <h2>{title}</h2>
        <div className="cv-legend">
          {(['dev', 'test', 'buffer'] as const).map((k) => (
            <span key={k} className="cv-key"><span className={`cv-sw k-${k}`} />{KIND_LABEL[k]}</span>
          ))}
          <span className="cv-key"><span className="cv-sw line" />Available</span>
          {legendExtra}
        </div>
        <label className="cv-check" title="Start this chart 4 weeks before today">
          <input type="checkbox" checked={fromToday} onChange={() => onFromToday(!fromToday)} /> From today
        </label>
      </div>
      <p className="hint">{hint}</p>
      <div className="cv-chart">
        <div className="cv-yaxis">
          {[...ticks].reverse().map((t) => (
            <span key={t}>{t}</span>
          ))}
        </div>
        <div className="cv-plot">
          {ticks.map((t) => (
            <div key={t} className="cv-grid" style={{ bottom: `${(t / yMax) * 100}%` }} />
          ))}
          <div className="cv-cols">
            {columns.map((f) => {
              const booked = f.dev + f.test + f.buffer
              const over = booked > f.available + 0.05
              return (
                <div key={f.w} className={`cv-col${f.w === today ? ' today' : ''}`} {...attach(tip(f))}>
                  <div className="cv-stack" style={{ height: `${(booked / yMax) * 100}%` }}>
                    {f.buffer > 0 && <div className="cv-seg k-buffer" style={{ flexGrow: f.buffer }} />}
                    {f.test > 0 && <div className="cv-seg k-test" style={{ flexGrow: f.test }} />}
                    {f.dev > 0 && <div className="cv-seg k-dev" style={{ flexGrow: f.dev }} />}
                  </div>
                  <div className="cv-avail" style={{ bottom: `${(f.available / yMax) * 100}%` }} />
                  {over && <div className="cv-over-dot" style={{ bottom: `calc(${(booked / yMax) * 100}% + 3px)` }}>!</div>}
                </div>
              )
            })}
          </div>
          <div className="cv-xaxis">
            {columns.map((f, i) => (
              <span key={f.w} className={f.w === today ? 'today' : ''}>{i % 2 === 0 || columns.length < 16 ? weekTag(f.w) : ''}</span>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
