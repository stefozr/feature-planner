import { useState } from 'react'
import { mondayOf, weekTag } from '../logic'

/** An hours figure edited in place (estimate, logged, remaining). */
export function NumberInput({ value, title, onCommit }: { value: number | undefined; title: string; onCommit: (v: number | undefined) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  if (draft == null)
    return (
      <button className="cell-btn num" title={title} onClick={() => setDraft(value == null ? '' : String(value))}>
        {value ?? '—'}
      </button>
    )
  const commit = () => {
    const t = draft.trim().replace(',', '.')
    const n = t === '' ? undefined : Number(t)
    if (n === undefined || (Number.isFinite(n) && n >= 0)) onCommit(n)
    setDraft(null)
  }
  return (
    <input
      className="rem-input"
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') setDraft(null)
      }}
    />
  )
}

/** A short text edited in place (a story's key or name): the value as a button, an input while editing. */
export function TextInput({ value, title, placeholder, className, onCommit }: { value: string | undefined; title: string; placeholder?: string; className?: string; onCommit: (v: string | undefined) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  if (draft == null)
    return (
      <button className={`cell-btn${className ? ` ${className}` : ''}${value ? '' : ' empty'}`} title={title} onClick={() => setDraft(value ?? '')}>
        {value || placeholder || '—'}
      </button>
    )
  const commit = () => {
    const t = draft.trim()
    if (t !== (value ?? '')) onCommit(t || undefined)
    setDraft(null)
  }
  return (
    <input
      className="rem-input text"
      autoFocus
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') setDraft(null)
      }}
    />
  )
}

/** A note field that commits on blur / Enter, so typing isn't a write per keystroke. */
export function NoteInput({ value, placeholder, onCommit, multiline }: { value: string; placeholder: string; onCommit: (v: string) => void; multiline?: boolean }) {
  const [draft, setDraft] = useState(value)
  const commit = () => draft.trim() !== value.trim() && onCommit(draft.trim())
  const common = {
    value: draft,
    placeholder,
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onBlur: commit,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !(multiline && e.shiftKey)) {
        e.preventDefault()
        commit()
      }
      if (e.key !== 'Escape') e.stopPropagation()
    },
  }
  return multiline ? <textarea className="cell-note-input" rows={2} {...common} /> : <input className="entry-note" {...common} />
}

/** A week field: a date input snapped to its Monday, with the ISO week beside it. */
export function WeekInput({ value, onChange }: { value: string | undefined; onChange: (v: string | undefined) => void }) {
  return (
    <span className="people-inline week-input">
      <input type="date" value={value ?? ''} onChange={(e) => onChange(e.target.value ? mondayOf(e.target.value) : undefined)} />
      <span className="hint">{value ? weekTag(value) : ''}</span>
    </span>
  )
}

/** A thin progress bar; `pct` is a fraction (0..1), null draws an empty bar. */
export function Bar({ pct }: { pct: number | null }) {
  return (
    <span className="cv-bar">
      <span className="cv-bar-fill" style={{ width: `${Math.round((pct ?? 0) * 100)}%` }} />
    </span>
  )
}
