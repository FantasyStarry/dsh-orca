/**
 * Model picker — pure state and rendering for the `/model` selector.
 *
 * Three stages walked in order: provider → model → reasoning effort (the
 * effort stage is skipped when the resolved route advertises none). The app
 * owns async loading between stages; this module only holds navigable state
 * and paints lines, so it stays unit-testable inside the smoke harness.
 *
 * Layout follows the kimi-code dialog spec (`.agents/skills/write-tui/
 * DESIGN.md`): flat `─` borders (primary) top and bottom only, title
 * (primary + bold), hint (textMuted) hugging the title, listed rows with the
 * `❯ ` pointer on the selected row, a ` ← current` success marker appended
 * to the row that holds the live route value, and a `▼ N more` scroll
 * indicator for long lists.
 */

import { theme } from './theme.js'
import { stringWidth, truncateWidth } from './width.js'
import { cleanLine } from './sanitize.js'

export interface PickerItem {
  /** Value carried out on selection (id / effort id). */
  readonly value: string
  /** Primary display label. */
  readonly label: string
  /** Optional secondary hint rendered dim beside the label. */
  readonly hint?: string
  /** Non-selectable row (e.g. the loading placeholder) — confirm() skips it. */
  readonly disabled?: boolean
  /**
   * Optional grouping header. A header row is emitted whenever the section
   * changes between adjacent items (so callers list items grouped by
   * section). Headers occupy window slots like items: the panel keeps its
   * fixed height and never moves the transcript around it.
   */
  readonly section?: string
}

export interface PickerState {
  readonly title: string
  readonly items: readonly PickerItem[]
  index: number
  /** The live route value at this stage — its row gets ` ← current`. */
  readonly current?: string
  /** Multi-select mode: Space toggles rows, Enter confirms the checked set. */
  multi?: boolean
  /** Checked values in multi-select mode (mutable by togglePicker). */
  checked?: Set<string>
}

export function openPicker(title: string, items: readonly PickerItem[], current?: string): PickerState {
  const base = { title, items, index: 0 }
  return current === undefined ? base : { ...base, current }
}

/** Move the cursor by ±delta, clamped to the item range. */
export function movePicker(state: PickerState, delta: number): void {
  if (state.items.length === 0) return
  const next = state.index + delta
  state.index = Math.max(0, Math.min(state.items.length - 1, next))
}

/** The item under the cursor, or undefined for an empty list. */
export function pickedItem(state: PickerState): PickerItem | undefined {
  return state.items[state.index]
}

/** Toggle a value in multi-select mode. */
export function togglePicker(state: PickerState, value: string): void {
  if (!state.multi) return
  const checked = state.checked ?? new Set<string>()
  if (checked.has(value)) checked.delete(value)
  else checked.add(value)
  state.checked = checked
}

/** Whether a value is checked in multi-select mode. */
export function isPickerChecked(state: PickerState, value: string): boolean {
  return state.checked?.has(value) ?? false
}

/** kimi SELECT_POINTER / CURRENT_MARK, per DESIGN.md: indents align. */
const POINTER_W = 2
const HINT = '↑/↓ 选择 · Enter 确认 · Esc 取消'
const MULTI_HINT = '↑/↓ 选择 · Space 多选 · Enter 确认 · Esc 取消'

/** Render the picker as a flat-bordered overlay block (already themed). */
export function renderPicker(state: PickerState, width: number, maxItems = 17): string[] {
  const lines: string[] = []
  lines.push(theme.primary('─'.repeat(width)))
  lines.push(' ' + theme.title(cleanLine(state.title)))
  lines.push(theme.subtle(' ' + (state.multi ? MULTI_HINT : HINT)))
  lines.push('')

  // Fixed item window: the panel ALWAYS occupies 4 chrome + itemWindow + 1
  // rows on a given terminal, so opening/closing/filtering/switching stages
  // never moves the surrounding transcript. Short lists blank-pad; long
  // lists scroll inside the window (▲/▼ markers take item slots). The
  // window clamps to the caller viewport budget — it only shrinks on very
  // short terminals.
  const itemWindow = Math.max(3, Math.min(9, Math.floor(maxItems)))
  // Rows = section headers + items, windowed TOGETHER so a header can never
  // be cut off from its first item by the scroll window.
  type Row = { readonly kind: 'header'; readonly label: string } | { readonly kind: 'item'; readonly index: number }
  const rows: Row[] = []
  let lastSection: string | undefined
  for (let index = 0; index < state.items.length; index++) {
    const item = state.items[index]
    if (!item) continue
    if (item.section !== undefined && item.section !== lastSection) {
      rows.push({ kind: 'header', label: item.section })
      lastSection = item.section
    }
    rows.push({ kind: 'item', index })
  }
  const selectedRow = Math.max(0, rows.findIndex((row) => row.kind === 'item' && row.index === state.index))
  const rowLimit = rows.length <= itemWindow ? rows.length : Math.max(1, itemWindow - 2)
  const before = Math.floor((rowLimit - 1) / 2)
  const from = Math.max(0, Math.min(Math.max(0, rows.length - rowLimit), selectedRow - before))
  const visible = rows.slice(from, from + rowLimit)
  const area: string[] = []
  const above = from
  if (above > 0) area.push(theme.subtle(` ▲ ${above} more`))
  for (let i = 0; i < visible.length; i++) {
    const row = visible[i]
    if (!row) continue
    if (row.kind === 'header') {
      area.push(theme.subtle(` ${cleanLine(row.label)}`))
      continue
    }
    const item = state.items[row.index]
    if (!item) continue
    const actual = row.index
    const selected = actual === state.index
    const pointer = selected ? theme.title('❯ ') : ' '.repeat(POINTER_W)
    const cleanLabel = cleanLine(item.label)
    const label = selected ? theme.title(cleanLabel) : cleanLabel
    const check = state.multi ? (isPickerChecked(state, item.value) ? theme.ok('☑ ') : '☐ ') : ''
    const current = state.current !== undefined && item.value === state.current ? theme.ok('  ← current') : ''
    const hint = item.hint ? theme.subtle('  ' + cleanLine(item.hint)) : ''
    const budget = Math.max(8, width - 4)
    const content = `  ${pointer}${check}${label}${hint}${current}`
    // Focus state: the selected row gets a full-row panel background so the
    // cursor row reads at a glance (the pointer + bold title stay too). The
    // fill pads by CELLS — string.length would mispad CJK labels.
    const cut = truncateWidth(content, budget)
    if (selected) {
      const fill = ' '.repeat(Math.max(0, budget - stringWidth(cut)))
      area.push(theme.panel(cut + fill))
    } else {
      area.push(cut)
    }
  }
  const remaining = rows.length - (from + visible.length)
  if (remaining > 0) {
    area.push(theme.subtle(` ▼ ${remaining} more`))
  }
  while (area.length < itemWindow) area.push('')
  lines.push(...area.slice(0, itemWindow))
  lines.push(theme.primary('─'.repeat(width)))
  return lines
}
