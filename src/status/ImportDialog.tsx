import { useEffect, useMemo, useState } from 'react'
import { DB, ImportField, ImportMapping, ImportUnit } from '../types'
import { fmtNum, uid } from '../logic'
import { Modal } from '../ui/Dialogs'
import { readWorkbook, type SheetData } from './readSheet'
import {
  DEFAULT_HOURS_PER_DAY,
  HOUR_FIELDS,
  TARGET_FIELDS,
  UNIT_LABEL,
  buildPlan,
  columnIndex,
  detectHeaderRow,
  fold,
  headersOf,
  isNone,
  personIndex,
  resolvePerson,
  resolveStatus,
  suggestMapping,
  type Cell,
  type ImportPlan,
  type RowPlan,
} from './importSheet'
import './import.css'

/*
 * The sheet import's dialog: two steps. "Columns" — which header feeds which field (suggested,
 * then validated or re-mapped by hand), how the hour columns are written. "Review" — what the
 * import would do, the status and assignee values the app does not know, and the Import button.
 * The thinking is in importSheet.ts; this file only asks and shows.
 */

interface Props {
  db: DB
  file: File
  onClose: () => void
  /** apply the plan; `mapping` is the default to remember, null to leave the saved one as it is */
  onApply: (plan: ImportPlan, mapping: ImportMapping | null) => void
}

type Step = 'columns' | 'review'
type Filter = 'all' | 'updated' | 'created' | 'skipped' | 'unchanged'

const NEW_STATUS = '\u0000new'
const PREVIEW_CAP = 300
const SAMPLE_N = 3

const sample = (v: Cell['v']): string => (v == null ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v))
const fieldLabel = (f: ImportField) => TARGET_FIELDS.find((t) => t.key === f)?.label ?? f
const show = (v: unknown): string => (v == null || v === '' ? '—' : typeof v === 'number' ? fmtNum(v) : String(v))

export default function ImportDialog({ db, file, onClose, onApply }: Props) {
  const saved = db.settings.importMapping
  const [sheets, setSheets] = useState<SheetData[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sheetIdx, setSheetIdx] = useState(0)
  const [headerRow, setHeaderRow] = useState(0)
  const [mapping, setMapping] = useState<ImportMapping>({ columns: {} })
  const [step, setStep] = useState<Step>('columns')
  const [filter, setFilter] = useState<Filter>('all')
  const [saveDefault, setSaveDefault] = useState(true)

  // read the file once; pick the saved sheet when the workbook has it, and suggest the columns
  useEffect(() => {
    let live = true
    readWorkbook(file)
      .then((ss) => {
        if (!live) return
        if (!ss.length || ss.every((s) => !s.rows.length)) {
          setError('The file has no rows.')
          return
        }
        const idx = Math.max(0, saved?.sheet ? ss.findIndex((s) => s.name === saved.sheet) : ss.findIndex((s) => s.rows.length))
        setSheets(ss)
        pickSheet(ss, idx)
      })
      .catch((e: unknown) => live && setError(`Could not read the file — ${e instanceof Error ? e.message : String(e)}`))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file])

  const pickSheet = (ss: SheetData[], idx: number) => {
    const rows = ss[idx].rows
    const hr = detectHeaderRow(rows)
    setSheetIdx(idx)
    setHeaderRow(hr)
    setMapping(suggestMapping(headersOf(rows, hr), rows.slice(hr + 1), saved))
  }
  const pickHeaderRow = (hr: number) => {
    if (!sheets) return
    const rows = sheets[sheetIdx].rows
    setHeaderRow(hr)
    setMapping(suggestMapping(headersOf(rows, hr), rows.slice(hr + 1), saved))
  }

  const rows = sheets?.[sheetIdx].rows ?? []
  const headers = useMemo(() => headersOf(rows, headerRow), [rows, headerRow])
  const body = useMemo(() => rows.slice(headerRow + 1), [rows, headerRow])
  const plan = useMemo(() => (sheets ? buildPlan(db, rows, headerRow, mapping, uid) : null), [db, sheets, rows, headerRow, mapping])

  const setColumn = (f: ImportField, header: string) =>
    setMapping((m) => {
      const columns = { ...m.columns }
      if (header) columns[f] = header
      else delete columns[f]
      return { ...m, columns }
    })
  const setUnit = (f: (typeof HOUR_FIELDS)[number], unit: ImportUnit) => setMapping((m) => ({ ...m, units: { ...m.units, [f]: unit } }))
  const setStatusMap = (raw: string, to: string | undefined) =>
    setMapping((m) => {
      const statusMap = { ...m.statusMap }
      if (to === undefined) delete statusMap[fold(raw)]
      else statusMap[fold(raw)] = to
      return { ...m, statusMap }
    })
  const setPersonMap = (raw: string, to: string | undefined) =>
    setMapping((m) => {
      const personMap = { ...m.personMap }
      if (to === undefined) delete personMap[fold(raw)]
      else personMap[fold(raw)] = to
      return { ...m, personMap }
    })

  // the sheet's status and assignee values the app cannot place on its own — mapped here, remembered with the default
  const statuses = db.settings.featureStatuses
  const people = useMemo(() => personIndex(db.people), [db.people])
  const distinct = (f: ImportField): { value: string; rows: number }[] => {
    const i = columnIndex(headers, mapping.columns[f])
    if (i < 0) return []
    const m = new Map<string, number>()
    for (const r of body) {
      const v = sample(r[i]?.v ?? null).trim()
      if (v && !isNone(v)) m.set(v, (m.get(v) ?? 0) + 1)
    }
    return [...m].map(([value, rows]) => ({ value, rows }))
  }
  const statusDecisions = useMemo(() => distinct('status').filter(({ value }) => resolveStatus(value, statuses) === undefined), [headers, body, mapping.columns.status, statuses])
  const personDecisions = useMemo(() => distinct('leadId').filter(({ value }) => resolvePerson(value, people) === undefined), [headers, body, mapping.columns.leadId, people])

  const samplesOf = (header: string | undefined): string[] => {
    const i = columnIndex(headers, header)
    if (i < 0) return []
    const out: string[] = []
    for (const r of body) {
      const s = sample(r[i]?.v ?? null).trim()
      if (s) out.push(s)
      if (out.length === SAMPLE_N) break
    }
    return out
  }

  const canReview = !!mapping.columns.key && !!plan
  const s = plan?.summary
  const todo = s ? s.featuresUpdated + s.storiesUpdated + s.storiesCreated : 0

  const rowsShown = useMemo(() => {
    if (!plan) return []
    const pass = (p: RowPlan) =>
      filter === 'all' ||
      (filter === 'skipped' && p.outcome.kind === 'skip') ||
      (filter === 'created' && p.outcome.kind === 'new-story') ||
      (filter === 'updated' && (p.outcome.kind === 'feature' || p.outcome.kind === 'story') && p.changes.length > 0) ||
      (filter === 'unchanged' && (p.outcome.kind === 'feature' || p.outcome.kind === 'story') && !p.changes.length)
    return plan.rows.filter(pass)
  }, [plan, filter])

  // a change is shown in the sheet's words: the person's name, not their id
  const showValue = (field: ImportField, v: unknown): string => (field === 'leadId' && typeof v === 'string' ? (db.people.find((p) => p.id === v)?.name ?? v) : show(v))

  const outcomeText = (p: RowPlan): string => {
    const o = p.outcome
    if (o.kind === 'skip') return `skipped — ${o.detail ?? o.reason}`
    if (o.kind === 'new-story') return 'new story'
    return p.changes.length ? `${o.kind} updated` : `${o.kind} unchanged`
  }

  const apply = () => {
    if (!plan || !sheets) return
    const toSave: ImportMapping | null = saveDefault ? { ...mapping, sheet: sheets[sheetIdx].name } : null
    onApply(plan, toSave)
  }

  // ----- the steps -----
  const columnsStep = () => (
    <>
      <div className="form-grid imp-top">
        {sheets && sheets.length > 1 && (
          <label className="field">
            Sheet
            <select value={sheetIdx} onChange={(e) => pickSheet(sheets, Number(e.target.value))}>
              {sheets.map((sh, i) => (
                <option key={sh.name} value={i}>
                  {sh.name} ({Math.max(0, sh.rows.length - 1)} rows)
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          Header row
          <input type="number" min={1} max={Math.max(1, rows.length)} value={headerRow + 1} onChange={(e) => pickHeaderRow(Math.min(rows.length, Math.max(1, Number(e.target.value) || 1)) - 1)} />
        </label>
        <label className="field">
          Hours in a Jira day
          <input type="number" min={1} max={24} step={0.5} value={mapping.hoursPerDay ?? DEFAULT_HOURS_PER_DAY} onChange={(e) => setMapping((m) => ({ ...m, hoursPerDay: Number(e.target.value) || DEFAULT_HOURS_PER_DAY }))} />
        </label>
      </div>
      <p className="hint">
        Each Status-tab field takes one column of the sheet. The suggestions come from the headers{saved ? ' and the saved default mapping' : ''}; change any of them. Rows are matched by the
        Jira key; a row no feature or story carries becomes a story under the feature in the parent column.
      </p>
      <table className="edit-table imp-table">
        <thead>
          <tr>
            <th>Field</th>
            <th>Column in the sheet</th>
            <th>Written as</th>
            <th>Sample values</th>
          </tr>
        </thead>
        <tbody>
          {TARGET_FIELDS.map((t) => {
            const header = mapping.columns[t.key]
            const isHours = t.kind === 'hours'
            return (
              <tr key={t.key} className={t.key === 'key' && !header ? 'imp-missing' : ''}>
                <td>
                  <span title={t.hint}>
                    {t.label}
                    {t.key === 'key' && <span className="hint"> · required</span>}
                  </span>
                  {isHours && t.key === 'estimate' && <div className="hint imp-fieldhint">{t.hint}</div>}
                  {t.kind === 'parent' && t.key === 'parentKey' && <div className="hint imp-fieldhint">{t.hint}</div>}
                </td>
                <td>
                  <select value={header ?? ''} onChange={(e) => setColumn(t.key, e.target.value)}>
                    <option value="">— not imported —</option>
                    {headers.map((h, i) => (h ? <option key={i} value={h}>{h}</option> : null))}
                  </select>
                </td>
                <td>
                  {isHours && header && (
                    <select value={mapping.units?.[t.key as (typeof HOUR_FIELDS)[number]] ?? 'hours'} onChange={(e) => setUnit(t.key as (typeof HOUR_FIELDS)[number], e.target.value as ImportUnit)}>
                      {(Object.keys(UNIT_LABEL) as ImportUnit[]).map((u) => (
                        <option key={u} value={u}>
                          {UNIT_LABEL[u]}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
                <td className="imp-sample">{samplesOf(header).join(' · ')}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </>
  )

  const reviewStep = () =>
    plan && s ? (
      <>
        <div className="imp-summary">
          <b>{s.featuresUpdated}</b> feature{s.featuresUpdated === 1 ? '' : 's'} updated · <b>{s.storiesUpdated}</b> stor{s.storiesUpdated === 1 ? 'y' : 'ies'} updated · <b>{s.storiesCreated}</b> stor
          {s.storiesCreated === 1 ? 'y' : 'ies'} created · {s.unchanged} unchanged · {s.skipped} skipped
          {s.noKey > 0 && ` · ${s.noKey} row${s.noKey === 1 ? '' : 's'} without a key ignored`}
        </div>

        {(statusDecisions.length > 0 || personDecisions.length > 0) && (
          <div className="imp-values">
            {statusDecisions.length > 0 && (
              <div>
                <div className="section-title">Statuses the app does not know</div>
                <table className="edit-table">
                  <tbody>
                    {statusDecisions.map(({ value, rows: n }) => {
                      const cur = mapping.statusMap?.[fold(value)]
                      const sel = cur === undefined || cur === '' ? '' : statuses.includes(cur) ? cur : NEW_STATUS
                      return (
                        <tr key={value}>
                          <td>
                            {value} <span className="hint">· {n} row{n === 1 ? '' : 's'}</span>
                          </td>
                          <td>
                            <select value={sel} onChange={(e) => setStatusMap(value, e.target.value === '' ? '' : e.target.value === NEW_STATUS ? value : e.target.value)}>
                              <option value="">Leave the status as it is</option>
                              {statuses.map((st) => (
                                <option key={st} value={st}>
                                  {st}
                                </option>
                              ))}
                              <option value={NEW_STATUS}>Add “{value}” as a new status</option>
                            </select>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {personDecisions.length > 0 && (
              <div>
                <div className="section-title">Assignees no person matches</div>
                <table className="edit-table">
                  <tbody>
                    {personDecisions.map(({ value, rows: n }) => (
                      <tr key={value}>
                        <td>
                          {value} <span className="hint">· {n} row{n === 1 ? '' : 's'}</span>
                        </td>
                        <td>
                          <select value={mapping.personMap?.[fold(value)] ?? ''} onChange={(e) => setPersonMap(value, e.target.value)}>
                            <option value="">Leave the assignee as it is</option>
                            {db.people.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {(s.hoursReplaced.length > 0 || s.hoursSkipped.length > 0 || s.unresolvedParents.length > 0 || s.invalid.length > 0) && (
          <ul className="imp-notes">
            {s.hoursReplaced.map((h) => (
              <li key={h.featureId} className="warn">
                <b>{h.key || h.name}</b> has its own hours ({show(h.from.estimate)} / {show(h.from.logged)} / {show(h.from.remaining)}) and gains its first {h.stories} stor{h.stories === 1 ? 'y' : 'ies'}: from now on it reads
                their sum ({show(h.to.estimate)} / {show(h.to.logged)} / {show(h.to.remaining)}).
              </li>
            ))}
            {s.hoursSkipped.length > 0 && (
              <li>
                Hours on {s.hoursSkipped.map((h) => h.key).join(', ')} are not written: a feature with stories carries their sum. Import the stories' rows instead.
              </li>
            )}
            {s.unresolvedParents.length > 0 && <li>No feature is named by the parent column for: {s.unresolvedParents.map((p) => `${p.value} (${p.rows})`).join(', ')}. Those rows are skipped.</li>}
            {s.invalid.length > 0 && (
              <li>
                {s.invalid.length} cell{s.invalid.length === 1 ? '' : 's'} could not be read and are left alone, e.g. row {s.invalid[0].row} {fieldLabel(s.invalid[0].field)} “{s.invalid[0].value}”.
              </li>
            )}
          </ul>
        )}

        <div className="imp-rowsbar">
          <div className="view-toggle">
            {(['all', 'updated', 'created', 'skipped', 'unchanged'] as Filter[]).map((f) => (
              <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
                {f[0].toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
          <span className="hint">
            {rowsShown.length} row{rowsShown.length === 1 ? '' : 's'}
            {rowsShown.length > PREVIEW_CAP ? `, the first ${PREVIEW_CAP} shown` : ''}
          </span>
        </div>
        <div className="imp-rows">
          <table className="edit-table">
            <thead>
              <tr>
                <th>Row</th>
                <th>Key</th>
                <th>Name</th>
                <th>Outcome</th>
                <th>Changes</th>
              </tr>
            </thead>
            <tbody>
              {rowsShown.slice(0, PREVIEW_CAP).map((p) => (
                <tr key={p.row} className={p.outcome.kind === 'skip' ? 'imp-skip' : ''}>
                  <td className="num">{p.row}</td>
                  <td className="jira-key">{p.key}</td>
                  <td className="imp-name">{p.name}</td>
                  <td>{outcomeText(p)}</td>
                  <td className="imp-changes">
                    {p.changes.map((ch) => (
                      <span key={ch.field} className="imp-change">
                        {fieldLabel(ch.field)}: {showValue(ch.field, ch.from)} → <b>{showValue(ch.field, ch.to)}</b>
                      </span>
                    ))}
                    {p.notes.map((n) => (
                      <span key={n} className="imp-change hint">
                        {n}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    ) : null

  return (
    <Modal title={`Import ${file.name} into the Status tab`} onClose={onClose} wide className="import-modal" storageKey="importSheet">
      <div className="imp-steps">
        <span className={step === 'columns' ? 'on' : ''}>1 · Columns</span>
        <span className={step === 'review' ? 'on' : ''}>2 · Review</span>
      </div>
      {error ? <p className="hint err">{error}</p> : !sheets ? <p className="hint">Reading {file.name}…</p> : step === 'columns' ? columnsStep() : reviewStep()}
      <div className="modal-actions">
        {step === 'review' && (
          <label className="imp-save">
            <input type="checkbox" checked={saveDefault} onChange={(e) => setSaveDefault(e.target.checked)} /> Save as the default mapping
          </label>
        )}
        <span className="spacer" />
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        {step === 'review' && (
          <button className="btn" onClick={() => setStep('columns')}>
            Back
          </button>
        )}
        {step === 'columns' ? (
          <button className="btn primary" disabled={!canReview} title={canReview ? undefined : 'Map the Jira key column first'} onClick={() => setStep('review')}>
            Next
          </button>
        ) : (
          <button className="btn primary" disabled={!todo} title={todo ? undefined : 'Nothing to import'} onClick={apply}>
            Import {todo ? `${todo} row${todo === 1 ? '' : 's'}` : ''}
          </button>
        )}
      </div>
    </Modal>
  )
}
