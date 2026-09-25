/** 把 unified diff 解析成左右对照的行模型。 */

export type CellType = 'context' | 'add' | 'del' | 'gap'

export interface DiffCell {
  no: number | null
  text: string
  type: CellType
}

export interface SideRow {
  left: DiffCell | null
  right: DiffCell | null
  /** 原始行（hunk 头等整行展示用） */
  raw?: string
  isHunkHeader?: boolean
}

const GAP: DiffCell = { no: null, text: '', type: 'gap' }

export function parseUnifiedDiff(diff: string): SideRow[] {
  const rows: SideRow[] = []
  let oldNo = 0
  let newNo = 0
  let pendingDel: DiffCell[] = []
  let pendingAdd: DiffCell[] = []

  const flush = () => {
    const n = Math.max(pendingDel.length, pendingAdd.length)
    for (let i = 0; i < n; i++) {
      rows.push({
        left: pendingDel[i] ?? (pendingAdd[i] ? GAP : null),
        right: pendingAdd[i] ?? (pendingDel[i] ? GAP : null),
      })
    }
    pendingDel = []
    pendingAdd = []
  }

  for (const line of diff.split('\n')) {
    if (line.startsWith('---') || line.startsWith('+++')) {
      flush()
      rows.push({ left: null, right: null, raw: line })
      continue
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      flush()
      oldNo = parseInt(hunk[1], 10)
      newNo = parseInt(hunk[2], 10)
      rows.push({ left: null, right: null, raw: line, isHunkHeader: true })
      continue
    }
    if (line.startsWith('-')) {
      pendingDel.push({ no: oldNo++, text: line.slice(1), type: 'del' })
    } else if (line.startsWith('+')) {
      pendingAdd.push({ no: newNo++, text: line.slice(1), type: 'add' })
    } else {
      flush()
      const text = line.startsWith(' ') ? line.slice(1) : line
      const cell: DiffCell = { no: oldNo, text, type: 'context' }
      rows.push({ left: { ...cell, no: oldNo++ }, right: { ...cell, no: newNo++ } })
    }
  }
  flush()
  return rows
}

export function diffStats(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++
    if (line.startsWith('-') && !line.startsWith('---')) removed++
  }
  return { added, removed }
}
