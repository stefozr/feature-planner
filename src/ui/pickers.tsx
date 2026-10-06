import React from 'react'
import { DB, Feature, OptionColors, Person, Release, optionColor, tagStyle } from '../types'
import { personShort, pickablePeople, resignedTitle } from '../logic'
import Popover from './Popover'

/*
 * The feature's own fields — status, customer, target release, lead, buddy and test lead — as a
 * clickable cell and as the picker that opens from it. The Planner's label column and the Status tab's first columns
 * both show and edit these, so they share one rendering here; a change in one is a change in both.
 * Cells are read-only spans when `onClick` is not given.
 */

/** what a picker needs of the record it edits — a Feature, or a Story (which lacks the planner-only keys) */
export type PickTarget = Pick<Feature, 'key' | 'name' | 'status' | 'customer' | 'releaseId' | 'leadId' | 'buddyId' | 'testLeadId'>

const who = (f: PickTarget) => f.key ?? f.name

/** The status as a coloured tag; a button when editable. */
export function StatusTag({ status, colors, onClick }: { status: string | undefined; colors: OptionColors | undefined; onClick?: (e: React.MouseEvent) => void }) {
  const style = tagStyle(optionColor(colors, 'featureStatuses', status ?? ''))
  return onClick ? (
    <button className="tag tag-btn" style={style} title="Click to change" onClick={onClick}>
      {status ?? '—'}
    </button>
  ) : (
    <span className="tag" style={style}>{status ?? '—'}</span>
  )
}

/**
 * How a release is named in a chip. The Planner's narrow column shows the version ("1.0", the
 * name without a leading "Release"); a `label` variant shows the release's short label ("Oct")
 * when it has one.
 */
export type ReleaseVariant = 'version' | 'label'
export const releaseText = (r: Release, variant: ReleaseVariant): string =>
  variant === 'label' ? (r.label ?? r.name) : r.name.replace(/^release\s*/i, '')

/** The target release as a chip in the release's colour; a button when editable. */
export function ReleaseCell({
  release,
  variant,
  colorOf,
  onClick,
}: {
  release: Release | undefined
  variant: ReleaseVariant
  colorOf: (hex: string | undefined) => string | undefined
  onClick?: (e: React.MouseEvent) => void
}) {
  const chip = release ? (
    <span className="rel-chip" style={{ '--rel': colorOf(release.color) ?? 'var(--muted)' } as React.CSSProperties}>
      {releaseText(release, variant)}
    </span>
  ) : (
    <span className="muted-dash">—</span>
  )
  const tip = release ? `${release.name}${release.date ? ` · ${release.date}` : ''}` : 'No target release'
  return onClick ? (
    <button className="cell-btn" title={`${tip} — click to change`} onClick={onClick}>
      {chip}
    </button>
  ) : (
    <span title={tip}>{chip}</span>
  )
}

/** The customer as a coloured tag; a button when editable. */
export function CustomerTag({ customer, colors, onClick }: { customer: string | undefined; colors: OptionColors | undefined; onClick?: (e: React.MouseEvent) => void }) {
  const style = tagStyle(customer ? optionColor(colors, 'customers', customer) : undefined)
  const text = customer ?? <span className="muted-dash">—</span>
  return onClick ? (
    <button className="tag tag-btn" style={style} title={customer ? `${customer} — click to change` : 'Set the customer'} onClick={onClick}>
      {text}
    </button>
  ) : (
    <span className="tag" style={style}>{text}</span>
  )
}

/** A person by short name; a button when editable. `setLabel` is the tooltip while nobody is set. */
export function PersonCell({ person, setLabel, onClick }: { person: Person | undefined; setLabel: string; onClick?: (e: React.MouseEvent) => void }) {
  return onClick ? (
    <button className="cell-btn" title={person ? `${person.name} — click to change` : setLabel} onClick={onClick}>
      {person ? personShort(person) : <span className="muted-dash">—</span>}
    </button>
  ) : (
    <span title={person?.name}>{person ? personShort(person) : '—'}</span>
  )
}

// ----- pickers: a popover anchored at (x, y); every choice patches the feature, then closes -----

type PickerBase = {
  x: number
  y: number
  db: DB
  feature: PickTarget
  onClose: () => void
}

/** The "Clear" row at the bottom of a pick list, shown only while something is set. */
function ClearItem({ show, onClick }: { show: unknown; onClick: () => void }) {
  return show ? (
    <button className="pick-item" onClick={onClick}>
      <span className="hint">Clear</span>
    </button>
  ) : null
}

export function StatusPicker({ x, y, db, feature, onPick, onClose }: PickerBase & { onPick: (status: string) => void }) {
  return (
    <Popover x={x} y={y} onClose={onClose}>
      <div className="pop-label">Status · {who(feature)}</div>
      <div className="pick-list">
        {db.settings.featureStatuses.map((st) => (
          <button
            key={st}
            className={`pick-item${feature.status === st ? ' on' : ''}`}
            onClick={() => {
              onPick(st)
              onClose()
            }}
          >
            <StatusTag status={st} colors={db.settings.optionColors} />
          </button>
        ))}
      </div>
    </Popover>
  )
}

export function CustomerPicker({ x, y, db, feature, onPick, onClose }: PickerBase & { onPick: (customer: string | undefined) => void }) {
  const pick = (c: string | undefined) => {
    onPick(c)
    onClose()
  }
  // a value the Settings list no longer names stays offered on the feature that holds it
  const options = [...db.settings.customers, ...(feature.customer && !db.settings.customers.includes(feature.customer) ? [feature.customer] : [])]
  return (
    <Popover x={x} y={y} onClose={onClose}>
      <div className="pop-label">Customer · {who(feature)}</div>
      <div className="pick-list">
        {options.map((c) => (
          <button key={c} className={`pick-item${feature.customer === c ? ' on' : ''}`} onClick={() => pick(c)}>
            <CustomerTag customer={c} colors={db.settings.optionColors} />
          </button>
        ))}
        <ClearItem show={feature.customer} onClick={() => pick(undefined)} />
      </div>
    </Popover>
  )
}

export function ReleasePicker({
  x,
  y,
  db,
  feature,
  colorOf,
  onPick,
  onClose,
}: PickerBase & { colorOf: (hex: string | undefined) => string | undefined; onPick: (releaseId: string | undefined) => void }) {
  const pick = (id: string | undefined) => {
    onPick(id)
    onClose()
  }
  return (
    <Popover x={x} y={y} onClose={onClose}>
      <div className="pop-label">Target release · {who(feature)}</div>
      <div className="pick-list">
        {db.releases.map((r) => (
          <button key={r.id} className={`pick-item${feature.releaseId === r.id ? ' on' : ''}`} onClick={() => pick(r.id)}>
            <span className="rel-chip" style={{ '--rel': colorOf(r.color) ?? 'var(--muted)' } as React.CSSProperties}>{r.name}</span>
            {r.date && <span className="hint">&nbsp;{r.date}</span>}
          </button>
        ))}
        <ClearItem show={feature.releaseId} onClick={() => pick(undefined)} />
      </div>
    </Popover>
  )
}

/** Lead, buddy or test lead. Leavers already gone are out of the running when the app-wide switch says so; the one holding the role stays listed so the choice can be read and undone. */
export function PersonPicker({
  x,
  y,
  db,
  feature,
  field,
  label,
  hideResigned,
  today,
  onPick,
  onClose,
}: PickerBase & {
  field: 'leadId' | 'buddyId' | 'testLeadId'
  /** the popover's caption, e.g. "Feature lead" */
  label: string
  hideResigned: boolean
  today: string
  onPick: (personId: string | undefined) => void
}) {
  const current = feature[field]
  const pick = (id: string | undefined) => {
    onPick(id)
    onClose()
  }
  return (
    <Popover x={x} y={y} onClose={onClose}>
      <div className="pop-label">{label} · {who(feature)}</div>
      <div className="pick-list">
        {pickablePeople(db.people, { hideResigned, today, keep: [current] }).map((pe) => (
          <button key={pe.id} className={`pick-item${current === pe.id ? ' on' : ''}`} title={resignedTitle(pe) || undefined} onClick={() => pick(pe.id)}>
            <b className={pe.resignedFrom ? 'resigned' : undefined}>{personShort(pe)}</b> <span className="hint">{pe.name}</span>
          </button>
        ))}
        <ClearItem show={current} onClick={() => pick(undefined)} />
      </div>
    </Popover>
  )
}
