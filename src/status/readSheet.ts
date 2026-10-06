import type { Cell, Row } from './importSheet'

/*
 * The reading half of the sheet import: a File → the sheets' cells. The only place SheetJS is
 * used, loaded on demand so it stays out of the main bundle until someone imports.
 */

export interface SheetData {
  name: string
  rows: Row[]
}

const CSV = /\.(csv|tsv|txt)$/i

export async function readWorkbook(file: File): Promise<SheetData[]> {
  const XLSX = await import('xlsx')
  // a CSV is decoded here (UTF-8, BOM dropped) and parsed from text; everything else from bytes
  const wb = CSV.test(file.name)
    ? XLSX.read(new TextDecoder('utf-8').decode(await file.arrayBuffer()), { type: 'string', raw: true, cellDates: true })
    : XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true, cellNF: true })
  return wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name]
    const rows: Row[] = []
    if (!ws['!ref']) return { name, rows }
    const range = XLSX.utils.decode_range(ws['!ref'])
    for (let r = range.s.r; r <= range.e.r; r++) {
      const row: Row = []
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })]
        const v = cell?.v
        const out: Cell = { v: v == null ? null : v instanceof Date || typeof v === 'number' || typeof v === 'boolean' ? v : String(v) }
        if (cell?.z) out.z = String(cell.z)
        row.push(out)
      }
      rows.push(row)
    }
    // trailing empty rows are noise
    while (rows.length && rows[rows.length - 1].every((c) => c.v == null || c.v === '')) rows.pop()
    return { name, rows }
  })
}
