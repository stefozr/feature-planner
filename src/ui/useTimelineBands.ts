import type React from 'react'
import { useMemo } from 'react'
import { Milestone, Release } from '../types'
import { addWeeks, mondayOf, monthGroups, weekLabel, weekRange } from '../logic'

export type PhaseEdges = { start: boolean; end: boolean }
export type PhaseCell =
  | { kind: 'phase'; span: number; key: string; name: string; color?: string; title: string; label: boolean; edges: PhaseEdges }
  | { kind: 'empty'; span: number; key: string }

/**
 * Everything a week timeline needs to draw its months, phases (milestones with an end date),
 * one-day events (milestones without one, release dates) and the today column — shared by the
 * planner and the roadmap, whose header is one component (TimelineHead) and whose body cells
 * take the same classes and tints.
 */
export interface TimelineBands {
  months: { key: string; label: string; weeks: string[] }[]
  /** the first week of every month but the first: a 2px line goes on its left */
  monthStarts: Set<string>
  msWeeks: Map<string, Milestone[]>
  relWeeks: Map<string, Release[]>
  /** week → ' band[ band-start][ band-end]' for every week a phase or event covers */
  bandWeeks: Map<string, string>
  /** week → the colour its tint / edge lines use (a one-day event wins over the phase around it) */
  weekTint: Map<string, string>
  phaseCells: PhaseCell[]
  /** 'cell-week[ month-start][ today-col]<band>[ next-month][ after-band]' */
  weekClass: (w: string) => string
  /** { '--ph', '--ph-prev' } for the band tints, or undefined */
  weekStyle: (w: string) => React.CSSProperties | undefined
  /** the phase row's cells: the same edge / month-line classes as the week columns below them */
  timelineClass: (first: string, span: number, edges: PhaseEdges | null) => string
}

export function timelineBands(
  weeks: string[],
  todayWeek: string,
  milestones: Milestone[],
  releases: Release[],
  colorOf: (hex: string | undefined) => string | undefined,
): TimelineBands {
  const months = monthGroups(weeks)
  const monthStarts = new Set(months.slice(1).map((m) => m.weeks[0]))

  // milestones by the week they fall in; bands mark every week they cover
  const msWeeks = new Map<string, Milestone[]>()
  const bandWeeks = new Map<string, string>()
  const weekTint = new Map<string, string>()
  for (const m of milestones) {
    const w = mondayOf(m.date)
    msWeeks.set(w, [...(msWeeks.get(w) ?? []), m])
    if (!m.end) continue
    // a milestone's colour is used as picked (the theme palette has no purple, so snapping would grey it)
    const color = m.color
    const ws = weekRange(w, mondayOf(m.end))
    ws.forEach((x, i) => {
      bandWeeks.set(x, ` band${i === 0 ? ' band-start' : ''}${i === ws.length - 1 ? ' band-end' : ''}`)
      if (color) weekTint.set(x, color)
    })
  }
  const relWeeks = new Map<string, Release[]>()
  for (const r of releases) if (r.date) relWeeks.set(mondayOf(r.date), [...(relWeeks.get(mondayOf(r.date)) ?? []), r])
  // one-day events (milestones without an end, release dates) are one-week phases of their own, drawn
  // on top of any phase they fall in (a code stop mid system-test keeps its own colour and edges); the
  // earliest event in a week sets its colour
  const oneDay = [
    ...milestones.filter((m) => !m.end).map((m) => ({ date: m.date, color: m.color })),
    ...releases.filter((r) => r.date).map((r) => ({ date: r.date!, color: colorOf(r.color) })),
  ].sort((a, b) => a.date.localeCompare(b.date))
  const owned = new Set<string>()
  for (const ev of oneDay) {
    const w = mondayOf(ev.date)
    if (owned.has(w)) continue
    owned.add(w)
    bandWeeks.set(w, ' band band-start band-end')
    if (ev.color) weekTint.set(w, ev.color)
    else weekTint.delete(w)
  }

  /*
   * The phase row under the months: one centred name per phase (a milestone with an end date) across
   * its weeks, and per one-day event (milestone without an end, release date) on its week. A one-day
   * event inside a phase cuts it: the event gets its own cell and the phase continues either side of it,
   * named on its widest segment; the gaps merge into empty cells.
   */
  type Point = { week: string; date: string; name: string; text: string; color?: string }
  type Phase = { start: number; end: number; names: string[]; dates: string[]; color?: string }
  const idx = new Map(weeks.map((w, i) => [w, i]))
  const clampIdx = (w: string, side: 'start' | 'end') => {
    if (idx.has(w)) return idx.get(w)!
    return side === 'start' ? (w < weeks[0] ? 0 : -1) : w > weeks[weeks.length - 1] ? weeks.length - 1 : -1
  }
  const phases: Phase[] = []
  for (const m of milestones) {
    if (!m.end) continue
    const a = clampIdx(mondayOf(m.date), 'start')
    const b = clampIdx(mondayOf(m.end), 'end')
    if (a < 0 || b < 0 || a > b) continue
    phases.push({ start: a, end: b, names: [m.name], dates: [`${weekLabel(m.date)} – ${weekLabel(m.end)}`], color: m.color })
  }
  phases.sort((x, y) => x.start - y.start)
  const merged: Phase[] = []
  for (const ph of phases) {
    const last = merged[merged.length - 1]
    if (last && ph.start <= last.end) {
      last.end = Math.max(last.end, ph.end)
      last.names.push(...ph.names)
      last.dates.push(...ph.dates)
    } else merged.push(ph)
  }
  const points: Point[] = [
    ...milestones
      .filter((m) => !m.end)
      .map((m) => ({ week: mondayOf(m.date), date: m.date, name: m.name, text: `${m.name} ${weekLabel(m.date)}`, color: m.color })),
    ...releases
      .filter((r) => r.date)
      .map((r) => ({ week: mondayOf(r.date!), date: r.date!, name: `${r.name} release`, text: `${r.name} release ${weekLabel(r.date!)}`, color: colorOf(r.color) })),
  ]
  const loose = new Map<number, Point[]>()
  for (const pt of points) {
    const i = idx.get(pt.week)
    if (i == null) continue
    loose.set(i, [...(loose.get(i) ?? []), pt])
  }
  // the phase's segments between the one-day events inside it; the name goes on the widest
  const labelAt = new Map<Phase, number>()
  for (const ph of merged) {
    let best: { start: number; end: number } | undefined
    let s = ph.start
    for (let k = ph.start; k <= ph.end + 1; k++) {
      if (k <= ph.end && !loose.has(k)) continue
      if (k > s && (!best || k - 1 - s > best.end - best.start)) best = { start: s, end: k - 1 }
      s = k + 1
    }
    if (best) labelAt.set(ph, best.start)
  }
  const phaseCells: PhaseCell[] = []
  let i = 0
  while (i < weeks.length) {
    const pts = loose.get(i)
    if (pts) {
      const sorted = [...pts].sort((a, b) => a.date.localeCompare(b.date))
      const name = sorted.map((x) => x.name).join(' · ')
      phaseCells.push({ kind: 'phase', span: 1, key: weeks[i], name, color: sorted.find((x) => x.color)?.color, title: sorted.map((x) => x.text).join('\n'), label: true, edges: { start: true, end: true } })
      i++
      continue
    }
    const ph = merged.find((x) => i >= x.start && i <= x.end)
    if (ph) {
      let j = i
      while (j < ph.end && !loose.has(j + 1)) j++
      const name = ph.names.join(' · ')
      // title only on the label; the dates are in the tooltip
      phaseCells.push({
        kind: 'phase', span: j - i + 1, key: weeks[i], name, color: ph.color, title: `${name}\n${ph.dates.join('\n')}`,
        label: labelAt.get(ph) === i, edges: { start: i === ph.start, end: j === ph.end },
      })
      i = j + 1
      continue
    }
    let j = i
    // an empty run also stops at a month start, so the month line runs through this row too
    while (j < weeks.length && !loose.has(j) && !merged.some((x) => x.start === j) && !(j > i && monthStarts.has(weeks[j]))) j++
    phaseCells.push({ kind: 'empty', span: j - i, key: weeks[i] })
    i = j
  }

  // A phase edge on a month boundary replaces the month line: `next-month` drops a phase's right
  // edge when the next week starts a month, `after-band` colours that month border instead.
  const endsBand = (w: string | undefined) => !!w && !!bandWeeks.get(w)?.includes('band-end')
  const weekClass = (w: string) => {
    const band = bandWeeks.get(w) ?? ''
    const next = addWeeks(w, 1)
    const prev = addWeeks(w, -1)
    return `cell-week${monthStarts.has(w) ? ' month-start' : ''}${w === todayWeek ? ' today-col' : ''}${band}${
      band.includes('band-end') && monthStarts.has(next) ? ' next-month' : ''
    }${monthStarts.has(w) && endsBand(prev) ? ' after-band' : ''}`
  }
  const timelineClass = (first: string, span: number, edges: PhaseEdges | null) => {
    const last = addWeeks(first, span - 1)
    const monthStart = monthStarts.has(first)
    return `${edges ? `phase-cell band${edges.start ? ' band-start' : ''}${edges.end ? ' band-end' : ''}` : 'phase-empty'}${monthStart ? ' month-start' : ''}${
      edges?.end && monthStarts.has(addWeeks(last, 1)) ? ' next-month' : ''
    }${monthStart && endsBand(addWeeks(first, -1)) ? ' after-band' : ''}`
  }
  const weekStyle = (w: string) => {
    const own = weekTint.get(w)
    const prev = addWeeks(w, -1)
    const prevTint = monthStarts.has(w) && endsBand(prev) ? weekTint.get(prev) : undefined
    if (!own && !prevTint) return undefined
    return { ...(own ? { '--ph': own } : {}), ...(prevTint ? { '--ph-prev': prevTint } : {}) } as React.CSSProperties
  }

  return { months, monthStarts, msWeeks, relWeeks, bandWeeks, weekTint, phaseCells, weekClass, weekStyle, timelineClass }
}

export function useTimelineBands(
  weeks: string[],
  todayWeek: string,
  milestones: Milestone[],
  releases: Release[],
  colorOf: (hex: string | undefined) => string | undefined,
): TimelineBands {
  return useMemo(() => timelineBands(weeks, todayWeek, milestones, releases, colorOf), [weeks, todayWeek, milestones, releases, colorOf])
}
