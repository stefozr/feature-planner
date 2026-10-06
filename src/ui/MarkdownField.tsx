import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** Rendered Markdown, read-only. HTML in the source stays escaped (react-markdown default). */
export function Markdown({ source }: { source: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{source}</ReactMarkdown>
    </div>
  )
}

/**
 * Full-width Markdown editor with Write / Preview tabs.
 * Editing is raw Markdown in a textarea, so pasting Markdown just works.
 */
export function MarkdownField({
  label = 'Description',
  value,
  onChange,
  placeholder = 'Notes in Markdown — headings, - lists, 1. numbered lists, **bold**, [links](…)…',
  readOnly = false,
}: {
  label?: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  /** preview only, no tabs — the viewer role's version of the field */
  readOnly?: boolean
}) {
  const [tabState, setTab] = useState<'write' | 'preview'>('preview')
  const tab = readOnly ? 'preview' : tabState
  const empty = !value.trim()

  return (
    <div className="field markdown-field">
      <div className="markdown-field-head">
        <span>{label}</span>
        {!readOnly && (
        <div className="markdown-tabs">
          <button
            type="button"
            className={`btn small ${tab === 'write' ? 'primary' : ''}`}
            onClick={() => setTab('write')}
          >
            Write
          </button>
          <button
            type="button"
            className={`btn small ${tab === 'preview' ? 'primary' : ''}`}
            onClick={() => setTab('preview')}
          >
            Preview
          </button>
        </div>
        )}
      </div>
      {tab === 'write' ? (
        <textarea
          className="markdown-input"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          rows={12}
        />
      ) : empty ? (
        <div className="markdown-body markdown-preview empty">Nothing to preview.</div>
      ) : (
        <div className="markdown-body markdown-preview">
          <Markdown source={value} />
        </div>
      )}
    </div>
  )
}
