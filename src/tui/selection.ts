/**
 * Mouse selection over a painted frame — the alt-screen (fullscreen) mode's
 * answer to "I want to copy that".
 *
 * Everything here is pure and cell-based: a frame line is a string carrying
 * SGR sequences, so the walker tracks BOTH the byte offset (to splice paint
 * in and out) and the terminal column (to compare against mouse coordinates,
 * which the terminal reports in cells). Wide clusters count 2 cells, combining
 * marks 0 — the same table `width.ts` uses everywhere else.
 *
 * Selection points are 1-based, matching the SGR mouse report verbatim.
 */

import { charWidth } from './width.js'

export interface SelectionPoint {
  /** 1-based frame row (line index + 1). */
  readonly row: number
  /** 1-based terminal column. */
  readonly col: number
}

export interface Selection {
  /** Where the drag started. */
  readonly anchor: SelectionPoint
  /** Where the pointer is now. */
  readonly focus: SelectionPoint
}

export interface OrderedSelection {
  readonly start: SelectionPoint
  readonly end: SelectionPoint
}

/** Reading order, so a right-to-left / bottom-to-top drag behaves the same. */
export function normalizeSelection(selection: Selection): OrderedSelection {
  const { anchor, focus } = selection
  if (focus.row < anchor.row || (focus.row === anchor.row && focus.col < anchor.col)) {
    return { start: focus, end: anchor }
  }
  return { start: anchor, end: focus }
}

/** One printable cluster of a painted line. */
interface LineCell {
  readonly text: string
  /** 0-based cell column of the cluster's first cell. */
  readonly col: number
  /** Byte index of the cluster in the raw line. */
  readonly at: number
  /** Byte index just past the cluster. */
  readonly end: number
  readonly width: number
}

/** Skip one escape sequence (CSI or OSC) starting at `i`; returns the next index. */
function skipEscape(line: string, i: number): number {
  const next = line[i + 1]
  if (next === '[') {
    let j = i + 2
    while (j < line.length && !/[@-~]/.test(line[j] as string)) j++
    return Math.min(line.length, j + 1)
  }
  if (next === ']') {
    let j = i + 2
    while (j < line.length && line[j] !== '\x07' && !(line[j] === '\x1b' && line[j + 1] === '\\')) j++
    return Math.min(line.length, line[j] === '\x07' ? j + 1 : j + 2)
  }
  return Math.min(line.length, i + 2)
}

/** Walk a painted line into printable clusters (escapes contribute nothing). */
function lineCells(line: string): LineCell[] {
  const cells: LineCell[] = []
  let col = 0
  let i = 0
  while (i < line.length) {
    if (line[i] === '\x1b') {
      i = skipEscape(line, i)
      continue
    }
    const code = line.codePointAt(i) ?? 0
    const text = String.fromCodePoint(code)
    const width = charWidth(code)
    if (width > 0) cells.push({ text, col, at: i, end: i + text.length, width })
    col += width
    i += text.length
  }
  return cells
}

/**
 * Column window of a row inside the selection: `from`/`to` are 1-based and
 * INCLUSIVE; rows between the first and last are selected end to end.
 */
function rowRange(selection: OrderedSelection, row: number): { from: number; to: number } | null {
  const { start, end } = selection
  if (row < start.row || row > end.row) return null
  return {
    from: row === start.row ? start.col : 1,
    to: row === end.row ? end.col : Number.MAX_SAFE_INTEGER,
  }
}

function cellSelected(cell: LineCell, from: number, to: number): boolean {
  const first = cell.col + 1
  const last = cell.col + cell.width
  return first <= to && last >= from
}

/**
 * Plain text of the selection, one frame line per row, trailing blanks
 * trimmed (a selected row should not paste a screen's worth of padding).
 * Returns '' for an empty selection.
 */
export function selectionText(lines: readonly string[], selection: Selection | null): string {
  if (selection === null) return ''
  const ordered = normalizeSelection(selection)
  const out: string[] = []
  for (let row = ordered.start.row; row <= ordered.end.row; row++) {
    const line = lines[row - 1]
    if (line === undefined) continue
    const range = rowRange(ordered, row)
    if (range === null) continue
    let text = ''
    for (const cell of lineCells(line)) {
      if (cellSelected(cell, range.from, range.to)) text += cell.text
    }
    out.push(text.replace(/\s+$/, ''))
  }
  // A drag that ends on a blank row must not append empty lines to the copy.
  while (out.length > 1 && out[out.length - 1] === '') out.pop()
  return out.join('\n').replace(/\n+$/, '')
}

/**
 * Paint the selection into frame lines. `paint` decorates ONE cluster (the
 * theme token emits reverse video and turns it back off, so the surrounding
 * colors survive). Lines outside the selection are returned untouched.
 */
export function paintSelection(
  lines: readonly string[],
  selection: Selection | null,
  paint: (text: string) => string,
): string[] {
  if (selection === null) return [...lines]
  const ordered = normalizeSelection(selection)
  return lines.map((line, index) => {
    const range = rowRange(ordered, index + 1)
    if (range === null) return line
    let out = ''
    let cursor = 0
    for (const cell of lineCells(line)) {
      if (cell.col + 1 > range.to) break
      if (!cellSelected(cell, range.from, range.to)) continue
      if (cell.at > cursor) out += line.slice(cursor, cell.at)
      out += paint(cell.text)
      cursor = cell.end
    }
    if (cursor === 0) return line
    return out + line.slice(cursor)
  })
}
