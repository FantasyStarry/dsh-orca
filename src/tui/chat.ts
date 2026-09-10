/**
 * Chat view: transcript rows → (stream, live) frame lines.
 *
 * Pure function of (channel, editor, width, live UI state) — rebuilt per
 * render tick, never mutating inputs. All color goes through the theme
 * tokens; the frame never embeds raw SGR itself.
 *
 * Visual language — the kimi-code school (MoonshotAI/kimi-code:
 * `src/tui/components/messages`, `components/editor`, `components/chrome`,
 * `constant/symbols.ts`, `constant/rendering.ts`):
 * - user prompts: `🐋` orca role bullet, amber bold text, no bubble;
 * - assistant voice: `● ` body-color bullet + markdown (code as cards);
 * - thinking: braille spinner + dim italic preview, sealed to `● 已思考 Ns`;
 * - tool runs: backgrounded cards, `⠋`/`✓ `/`✗ ` status marks in the frame;
 * - chrome: a boxed `> ` prompt editor (primary border), a two-line plain
 *   status footer (no fill), a boxed welcome card with info rows;
 * - a 1-cell chrome gutter lines transcript/panels up with the editor
 *   interior (kimi CHROME_GUTTER); the editor spans the full width.
 *
 * Frame split (the scrollback-sealing contract, ADR-0001):
 * - `stream` — newly sealed transcript rows (final, immutable) plus the
 *   welcome card / route lines when due. Written once at the top of the
 *   tracked region; overflow scrolls into the terminal's native scrollback.
 * - `live` — open rows of the current turn + editor box + footer. Diffed
 *   in place every tick.
 */

import type { AgentRunState, Channel, SessionRoute, SessionUsage, TranscriptRow } from '../adapter/channel.js'
import { renderMarkdown } from './markdown.js'
import { asciiEllipses } from './width.js'
import { renderPicker, type PickerItem, type PickerState } from './picker.js'
import { boxed, boxLine, boxTop, boxBottom, type BoxStyle } from './box.js'
import { theme } from './theme.js'
import { stringWidth, truncateWidth, wrapWidth } from './width.js'
import { cleanLine, cleanText } from './sanitize.js'
import { formatTokenCount } from './format.js'

export interface FrameContext {
  readonly channel: Channel
  /** First row index not yet flushed to scrollback (the app's cursor). */
  readonly sealedFrom: number
  /**
   * Line offset within `sealedFrom` already streamed (line-level incremental
   * sedimentation). Defaults to 0; reset to a row boundary on width change
   * (rewrap invalidates line offsets — rare, brief duplication acceptable).
   */
  readonly sealedFromLine?: number
  readonly editorText: string
  /** Logical editor cursor as a code-point offset into `editorText`. */
  readonly editorCursor?: number
  /** Pending image attachments — one pre-painted label row each, inside the editor box. */
  readonly attachments?: readonly string[]
  readonly width: number
  /** Terminal rows; used to keep the prompt anchored at the bottom. */
  readonly height?: number
  readonly anchorChrome?: boolean
  readonly cwd: string
  readonly sessionId: string | null
  /** Live selection override (picker result) — wins over the logged route. */
  readonly route: SessionRoute | null
  /** Live agent preset id (`composedPreset`) for the footer slot. */
  readonly preset?: string | null
  readonly usage: SessionUsage
  /** Wall-clock now, for the live thought timer. */
  readonly now: number
  /** Active `/model` picker overlay lines, rendered above the input box. */
  readonly picker: PickerState | null
  /** Inline slash-command completion (kimi `/` menu), above the input box. */
  readonly commandMenu?: { readonly items: readonly PickerItem[]; readonly index: number } | null
  /** Inline `@path` completion (kimi file mention), above the input box. */
  readonly atMenu?: { readonly items: readonly PickerItem[]; readonly index: number } | null
  /** Ctrl+O toggle: show full thinking text instead of the short preview. */
  readonly thoughtExpanded?: boolean
  /** True while the agent is still connecting (footer shows 连接中 badge). */
  readonly connecting?: boolean
  /** Folded session title for the footer (M3). */
  readonly title?: string | null
  /** Effective approval policy for the footer (M4: ask/never). */
  readonly policy?: string
  /** Yolo auto-allow flag for the footer badge (M4). */
  readonly yolo?: boolean
  /** Plan mode flag for the footer badge. */
  readonly planMode?: boolean
  /** One-shot ask mode flag for the footer badge. */
  readonly askMode?: boolean
  /** Git branch for the footer slot (M4 status slot, best-effort). */
  readonly branch?: string | null
  /** Opt-in Nerd Font branch icon (`ORCA_NERD_FONT=1`); off by default so
   *  terminals without the glyph fall back to a plain branch name. */
  readonly nerdFont?: boolean
  /** Alternate-screen mode: whole-viewport window, chrome always pinned. */
  readonly fullscreen?: boolean
}

export interface ChatFrame {
  /** Newly sealed lines + one-time cards — written once, never repainted. */
  readonly stream: readonly string[]
  /** Recent transcript window + editor box + footer — diff-painted in place. */
  readonly live: readonly string[]
  /** Where the terminal cursor belongs (inside the editor box). */
  readonly cursor: { readonly fromEnd: number; readonly col: number }
  /**
   * Next `sealedFrom` cursor for the app: rows `[prevSealedFrom, nextSealedFrom)`
   * just streamed to scrollback. Unflushed sealed rows stay in `live` (visible
   * window) until they age out — this is what keeps the viewport populated
   * instead of blank after each turn.
   */
  readonly nextSealedFrom: number
  /** Line offset within `nextSealedFrom` already streamed (see `sealedFromLine`). */
  readonly nextSealedFromLine: number
  /**
   * Visible transcript rows at the head of `live` (excludes spacer/picker/
   * chrome). The disposer keeps exactly these on exit so recent history is
   * not lost when the live block is cleared.
   */
  readonly transcriptLen: number
}

export const IMAGE_SENTINEL = ''

/**
 * Inline file-attachment token (dsh-llm `FileBlock`). A distinct codepoint
 * from {@link IMAGE_SENTINEL} so the editor, the pending list and the frame
 * builder all agree on the kind without extra plumbing: each sentinel counts
 * only its own kind, in document order.
 */
export const FILE_SENTINEL = ''

/** Visible label of one attachment token, or undefined for an ordinary char. */
function attachmentToken(ch: string, kindIndex: number): string | undefined {
  if (ch === IMAGE_SENTINEL) return `[image #${kindIndex}] `
  if (ch === FILE_SENTINEL) return `[file #${kindIndex}] `
  return undefined
}

const HINT = 'Enter 发送 · /model · @文件 · Ctrl+V/Alt+V 图片 · Ctrl+O 思考 · Esc 取消 · Ctrl+C 退出'

/** Orca brand role bullet: `🐋` is 2 cells + 1 space, so both our cell math
 *  and real emoji rendering agree on 3 (same width as the old `✨` bullet). */
const USER_BULLET = '🐋 '
const STATUS_BULLET = '● '
const SUCCESS_MARK = '✓ '
const FAILURE_MARK = '✗ '
const MESSAGE_INDENT = '  '

/** kimi rendering.ts BRAILLE_SPINNER_FRAMES (80ms per frame). */
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

interface RowSnapshot {
  readonly row: TranscriptRow
  readonly kind: TranscriptRow['kind']
  readonly text: string
  readonly status: TranscriptRow['status']
  readonly tool: string | undefined
  readonly startMs: number | undefined
  readonly seconds: number | undefined
  readonly diffKey: string
  readonly rawLines: readonly string[] | undefined
  readonly pinned: boolean | undefined
  readonly clock: string
}

interface CachedRow extends RowSnapshot {
  readonly lines: readonly string[]
}

interface ChannelLayoutCache {
  width: number
  thoughtExpanded: boolean
  immutableUntil: number
  readonly entries: CachedRow[]
  readonly lineEnds: number[]
}

/** Cache lifetime follows the channel/session projection without retaining it. */
const channelLayouts = new WeakMap<Channel, ChannelLayoutCache>()

export function buildFrame(ctx: FrameContext): ChatFrame {
  const width = Math.max(20, ctx.width)
  const height = Math.max(8, ctx.height ?? 24)
  const fullscreen = ctx.fullscreen ?? false
  const anchorChrome = fullscreen || (ctx.anchorChrome ?? ctx.picker !== null)
  const stream: string[] = []
  const live: string[] = []
  // Content area: transcript + panels sit inside a 1-cell chrome gutter
  // (kimi CHROME_GUTTER) so their left edge aligns with the editor interior;
  // the editor box and welcome card span the full width.
  const inner = Math.max(18, width - 2)
  const gutter = (line: string): string => (line === '' ? '' : ' ' + line + ' ')
  // Diff-painted rows must never depend on terminal-ambiguous cell widths:
  // a row the terminal wraps (its width table disagrees with ours) shifts
  // every row below it and desyncs the painter. Ellipses are the known
  // offender; strip them from tracked rows. Sealed scrollback rows are
  // written once and never tracked, so they keep the verbatim text.
  // Pre-rendered chrome rows (welcome card, route lines) span the FULL
  // width already and bypass the content gutter.
  const editorBox = inputBox(ctx.editorText, width, ctx.editorCursor, ctx.attachments)
  const footer = footerLines(ctx, width)
  const bottom = [...editorBox.lines, ...footer]
  const layout = syncChannelLayout(ctx, width, inner, gutter)
  const cursorPlacement = (liveLength: number, bottomStart: number): ChatFrame['cursor'] => {
    const editorLine = bottomStart + editorBox.cursorLine
    return {
      fromEnd: Math.max(0, Math.min(liveLength - 1, liveLength - 1 - editorLine)),
      col: Math.max(1, Math.min(width, editorBox.cursorCol)),
    }
  }

  // ── fullscreen (alternate screen): pi-tui style whole-viewport mode ────────
  // No native scrollback exists there, so nothing is ever sealed to a
  // stream; the transcript renders as a sliding window over the channel
  // rows, the chrome is pinned to the bottom, and the frame fills EXACTLY
  // the terminal height.
  if (fullscreen) {
    const pickerItemBudget = Math.max(1, height - bottom.length - 7)
    let pickerLines = ctx.picker ? renderPicker(ctx.picker, inner, pickerItemBudget).map(gutter) : []
    if (pickerLines.length > 0) {
      pickerLines = pickerLines.slice(0, Math.max(1, height - bottom.length - 1))
    }
    let menuLines: string[] = []
    if (!ctx.picker && (ctx.commandMenu || ctx.atMenu)) {
      const menu = ctx.commandMenu ?? ctx.atMenu
      if (menu && menu.items.length > 0) {
        const menuBudget = Math.max(1, Math.min(9, height - bottom.length - 7))
        const menuState: PickerState = {
          title: ctx.atMenu && !ctx.commandMenu ? '文件' : '命令',
          items: menu.items,
          index: Math.max(0, Math.min(menu.items.length - 1, menu.index)),
        }
        menuLines = renderPicker(menuState, inner, menuBudget).map(gutter)
        menuLines = menuLines.slice(0, Math.max(1, height - bottom.length - pickerLines.length - 1))
      }
    }
    const pickerReserve = pickerLines.length > 0 ? pickerLines.length + 1 : 0
    const menuReserve = menuLines.length > 0 ? menuLines.length + 1 : 0
    const windowCap = Math.max(1, height - bottom.length - pickerReserve - menuReserve)
    const totalLines = layout.lineEnds.at(-1) ?? 0
    let windowLines: string[]
    if (totalLines > windowCap) {
      const dropped = totalLines - windowCap
      windowLines = [theme.muted(`… 上方还有 ${dropped} 行`), ...layoutTail(layout, Math.max(0, windowCap - 1))]
    } else {
      windowLines = layoutTail(layout, totalLines)
    }
    const spacer = Math.max(0, height - bottom.length - pickerReserve - menuReserve - windowLines.length)
    live.push(...windowLines, ...Array.from({ length: spacer }, () => ''))
    if (pickerLines.length > 0) live.push(...pickerLines, '')
    if (menuLines.length > 0) live.push(...menuLines, '')
    const bottomStart = live.length
    live.push(...bottom)
    const cursor = cursorPlacement(live.length, bottomStart)
    return { stream, live, cursor, nextSealedFrom: ctx.sealedFrom, nextSealedFromLine: ctx.sealedFromLine ?? 0, transcriptLen: windowLines.length }
  }

  // ── inline: sliding window over recent rows + scrollback sedimentation ─────
  // The viewport always shows the recent transcript tail (sealed tail + open)
  // with the chrome pinned to the bottom; only rows that aged out of the
  // viewport window stream to native scrollback. Unflushed sealed rows stay in
  // `live` until they age out — previously every newly sealed row streamed
  // immediately, so after each `turn/start` the live block went blank and the
  // whole history jumped into scrollback (user-visible "all content弹上去").
  const sealedTo = Math.min(ctx.channel.sealedRowCount, ctx.channel.rows.length)
  const rows = ctx.channel.rows
  // Line-level flush cursor: (baseRow, baseLine) is the first unstreamed line.
  // Sealed rows are final (immutable) so a row may split across scrollback /
  // viewport safely; open (growing) rows are never streamed, only collapsed
  // behind a note when a single block outgrows the viewport.
  let baseRow = Math.max(0, Math.min(ctx.sealedFrom, rows.length))
  let baseLine = Math.max(0, ctx.sealedFromLine ?? 0)
  if (baseRow > sealedTo) {
    baseRow = sealedTo
    baseLine = 0
  }

  // A picker is part of the live frame (unlike sealed transcript stream), so
  // its visible rows must fit above the input/footer chrome. Without this
  // budget a long provider/model list makes the terminal scroll mid-frame;
  // the next route stream then repaints against the wrong physical row and
  // leaves a ghost input box at the top of the screen.
  const availableRows = height
  const pickerItemBudget = Math.max(1, availableRows - bottom.length - 7)
  let pickerLines = ctx.picker ? renderPicker(ctx.picker, inner, pickerItemBudget).map(gutter) : []
  if (pickerLines.length > 0) {
    // Keep one row for the separator before the editor. On very short
    // terminals the picker may still have a "more" marker; trim that marker
    // (and any excess items) rather than allowing the terminal to scroll.
    const maxPickerLines = Math.max(1, availableRows - bottom.length - 1)
    pickerLines = pickerLines.slice(0, maxPickerLines)
  }
  // Inline slash-command menu (non-modal, never coexists with a picker).
  // Same height discipline: it must fit above the input/footer chrome.
  let menuLines: string[] = []
  if (!ctx.picker && (ctx.commandMenu || ctx.atMenu)) {
    const menu = ctx.commandMenu ?? ctx.atMenu
    if (menu && menu.items.length > 0) {
      const menuBudget = Math.max(1, Math.min(9, availableRows - bottom.length - 7))
      const menuState: PickerState = {
        title: ctx.atMenu && !ctx.commandMenu ? '文件' : '命令',
        items: menu.items,
        index: Math.max(0, Math.min(menu.items.length - 1, menu.index)),
      }
      menuLines = renderPicker(menuState, inner, menuBudget).map(gutter)
      const maxMenuLines = Math.max(1, availableRows - bottom.length - pickerLines.length - 1)
      menuLines = menuLines.slice(0, maxMenuLines)
    }
  }
  // The open-row window is capped so the frame never outgrows the terminal —
  // the diff painter can only repaint rows that are on screen. Overflow
  // collapses into a note and resumes into scrollback at the next seal.
  const pickerReserve = pickerLines.length > 0 ? pickerLines.length + 1 : 0
  const menuReserve = menuLines.length > 0 ? menuLines.length + 1 : 0
  // Stable window for aging (ignores transient picker/menu so opening /model
  // never permanently flushes history); display window shrinks while the
  // picker is open but those rows stay unflushed and reappear on close.
  const baseCap = Math.max(1, availableRows - bottom.length)
  const displayCap = Math.max(0, availableRows - bottom.length - pickerReserve - menuReserve)

  // Paint sealed remainder (first row sliced by baseLine) + open raw once.
  const sealedEffFlat: string[] = []
  const sealedRemLens: number[] = []
  for (let i = baseRow; i < sealedTo; i++) {
    const row = rows[i]
    if (!row) {
      sealedRemLens.push(0)
      continue
    }
    const painted = layout.entries[i]?.lines ?? []
    const sliceFrom = i === baseRow ? Math.min(baseLine, painted.length) : 0
    // Snap a stale line offset (width rewrap) to the row start / next row.
    if (i === baseRow && sliceFrom >= painted.length) {
      sealedRemLens.push(0)
      continue
    }
    const rest = painted.slice(sliceFrom)
    sealedRemLens.push(rest.length)
    sealedEffFlat.push(...rest)
  }
  // Advance base past fully-skipped rows (stale offset ≥ row length).
  let snappedRow = baseRow
  let snappedLine = baseLine
  while (snappedRow < sealedTo) {
    const row = rows[snappedRow]
    const len = row ? (layout.entries[snappedRow]?.lines.length ?? 0) : 0
    if (snappedLine < len) break
    snappedRow++
    snappedLine = 0
  }
  baseRow = snappedRow
  baseLine = snappedLine
  // Rebuild sealedEffFlat if snapping moved base (rare rewrap path).
  if (baseRow !== Math.max(0, Math.min(ctx.sealedFrom, rows.length)) || baseLine !== Math.max(0, ctx.sealedFromLine ?? 0)) {
    sealedEffFlat.length = 0
    sealedRemLens.length = 0
    for (let i = baseRow; i < sealedTo; i++) {
      const row = rows[i]
      if (!row) {
        sealedRemLens.push(0)
        continue
      }
      const painted = layout.entries[i]?.lines ?? []
      const rest = i === baseRow ? painted.slice(Math.min(baseLine, painted.length)) : painted
      sealedRemLens.push(rest.length)
      sealedEffFlat.push(...rest)
    }
  }
  const openRawLines: string[] = []
  for (let i = sealedTo; i < rows.length; i++) {
    const row = rows[i]
    if (row) openRawLines.push(...(layout.entries[i]?.lines ?? []))
  }
  const sealedEffLen = sealedEffFlat.length
  const openRawLen = openRawLines.length
  const totalEff = sealedEffLen + openRawLen
  const overflowStable = Math.max(0, totalEff - baseCap)
  // Per-frame sediment budget: steady streaming (1–2 lines/tick) sediments
  // immediately (1:1 squeeze); bursts spread over frames (smooth settle);
  // huge catch-ups (remount/replay) settle instantly instead of scrolling
  // for a second.
  const STREAM_BUDGET = 3
  const INSTANT_THRESHOLD = 30
  const maxStream = Math.min(overflowStable, sealedEffLen)
  let toStream = 0
  if (maxStream > 0) {
    toStream = overflowStable > INSTANT_THRESHOLD ? maxStream : Math.min(maxStream, STREAM_BUDGET)
  }
  stream.push(...sealedEffFlat.slice(0, toStream))
  // Advance the line cursor through sealed rows by toStream lines.
  let newBaseRow = baseRow
  let newBaseLine = baseLine
  {
    let left = toStream
    // Re-paint lengths for advance (first row offset aware).
    for (let i = baseRow; i < sealedTo && left > 0; i++) {
      const row = rows[i]
      const paintedLen = row ? (layout.entries[i]?.lines.length ?? 0) : 0
      const start = i === baseRow ? Math.min(baseLine, paintedLen) : 0
      const remaining = Math.max(0, paintedLen - start)
      if (left >= remaining) {
        left -= remaining
        newBaseRow = i + 1
        newBaseLine = 0
      } else {
        newBaseRow = i
        newBaseLine = start + left
        left = 0
      }
    }
  }
  // Remaining sealed after this frame's sediment (gap between cursor and live
  // window stays unflushed: picker clips reappear on close, stable overflow
  // keeps sedimenting on later ticks).
  const sealedRemFlat: string[] = []
  {
    let skip = 0
    // skip = lines already accounted: streamed head (toStream) — sealedEffFlat
    // starts at old base, so remaining starts at toStream.
    for (let k = toStream; k < sealedEffFlat.length; k++) {
      const line = sealedEffFlat[k]
      if (line !== undefined) sealedRemFlat.push(line)
    }
    void skip
  }
  const sealedRemLen = sealedRemFlat.length
  const remainingTotal = sealedRemLen + openRawLen
  let transcriptVisible: string[] = []
  if (remainingTotal <= displayCap) {
    transcriptVisible = [...sealedRemFlat, ...openRawLines]
  } else if (openRawLen > displayCap) {
    // Single growing block outgrows the viewport on its own: collapse its head
    // behind a note (existing contract); sealed remainder keeps sedimenting.
    if (displayCap <= 0) {
      transcriptVisible = []
    } else {
      const dropped = openRawLen - (displayCap - 1)
      transcriptVisible = [theme.muted(`… 本回合前 ${dropped} 行暂省（完成后进历史）`), ...openRawLines.slice(-(displayCap - 1))]
    }
  } else {
    // Sealed + open exceed: show the tail (all open + recent sealed tail);
    // the sealed head stays as queued gap and sediments on later ticks — the
    // per-tick 1:1 squeeze instead of a whole-row jump.
    const combined = [...sealedRemFlat, ...openRawLines]
    transcriptVisible = displayCap > 0 ? combined.slice(-displayCap) : []
  }
  // The chrome is bottom-anchored: consume the remaining viewport with blank
  // rows between transcript/picker content and the input box/footer.
  const spacer = anchorChrome ? Math.max(0, displayCap - transcriptVisible.length) : 0
  live.push(...transcriptVisible, ...Array.from({ length: spacer }, () => ''))

  if (pickerLines.length > 0) {
    live.push(...pickerLines)
    live.push('')
  }
  if (menuLines.length > 0) {
    live.push(...menuLines)
    live.push('')
  }
  const bottomStart = live.length
  live.push(...bottom)
  // Cursor home: the editor content row is 3 above the frame bottom (box
  // bottom + footer L1 + L2); `│ > ` puts the text at column 5.
  const cursor = cursorPlacement(live.length, bottomStart)
  return { stream, live, cursor, nextSealedFrom: newBaseRow, nextSealedFromLine: newBaseLine, transcriptLen: transcriptVisible.length }
}

function syncChannelLayout(
  ctx: FrameContext,
  width: number,
  inner: number,
  gutter: (line: string) => string,
): ChannelLayoutCache {
  const expanded = ctx.thoughtExpanded ?? false
  let cache = channelLayouts.get(ctx.channel)
  if (!cache || cache.width !== width || cache.thoughtExpanded !== expanded) {
    cache = { width, thoughtExpanded: expanded, immutableUntil: 0, entries: [], lineEnds: [] }
    channelLayouts.set(ctx.channel, cache)
  }

  const rows = ctx.channel.rows
  const sealedTo = Math.max(0, Math.min(ctx.channel.sealedRowCount, rows.length))
  let start = Math.min(cache.immutableUntil, sealedTo, cache.entries.length, rows.length)

  // Session switches replace the projection in place. Detect that uncommon
  // structural reset without walking stable history on every 33 ms tick.
  if (start > 0) {
    const firstChanged = cache.entries[0]?.row !== rows[0]
    const boundaryChanged = cache.entries[start - 1]?.row !== rows[start - 1]
    if (firstChanged || boundaryChanged) {
      start = 0
      const common = Math.min(cache.entries.length, rows.length)
      while (start < common && cache.entries[start]?.row === rows[start]) start++
    }
  }

  let lineEnd = start > 0 ? (cache.lineEnds[start - 1] ?? 0) : 0
  for (let i = start; i < rows.length; i++) {
    const row = rows[i]
    if (!row) continue
    const snapshot = rowSnapshot(row, ctx)
    const previous = cache.entries[i]
    const entry = previous && sameSnapshot(previous, snapshot)
      ? previous
      : { ...snapshot, lines: paintTranscriptRow(row, ctx, width, inner, gutter) }
    cache.entries[i] = entry
    lineEnd += entry.lines.length
    cache.lineEnds[i] = lineEnd
  }
  cache.entries.length = rows.length
  cache.lineEnds.length = rows.length
  cache.immutableUntil = sealedTo
  return cache
}

function rowSnapshot(row: TranscriptRow, ctx: FrameContext): RowSnapshot {
  const clock = row.kind === 'thought' && row.seconds === undefined
    ? `${tickOf(row, ctx)}:${row.startMs === undefined ? 0 : Math.round((ctx.now - row.startMs) / 100)}`
    : ''
  return {
    row,
    kind: row.kind,
    text: row.text,
    status: row.status,
    tool: row.tool,
    startMs: row.startMs,
    seconds: row.seconds,
    diffKey: row.diff
      ? `${row.diff.path}\u0000${row.diff.added}\u0000${row.diff.removed}\u0000${row.diff.lines.map((line) => `${line.kind}\u0000${line.text}`).join('\u0001')}`
      : '',
    rawLines: row.rawLines,
    pinned: row.pinned,
    clock,
  }
}

function sameSnapshot(a: RowSnapshot, b: RowSnapshot): boolean {
  return a.row === b.row &&
    a.kind === b.kind &&
    a.text === b.text &&
    a.status === b.status &&
    a.tool === b.tool &&
    a.startMs === b.startMs &&
    a.seconds === b.seconds &&
    a.diffKey === b.diffKey &&
    a.rawLines === b.rawLines &&
    a.pinned === b.pinned &&
    a.clock === b.clock
}

function paintTranscriptRow(
  row: TranscriptRow,
  ctx: FrameContext,
  width: number,
  inner: number,
  gutter: (line: string) => string,
): readonly string[] {
  if (row.rawLines !== undefined) {
    return row.rawLines.map((line) => (line === '' ? '' : truncateWidth(asciiEllipses(line), width)))
  }
  return renderRow(row, ctx, inner).map((line) => (line === '' ? '' : gutter(asciiEllipses(line))))
}

/** Extract a rendered suffix without traversing or flattening stable history. */
function layoutTail(layout: ChannelLayoutCache, count: number): string[] {
  const total = layout.lineEnds.at(-1) ?? 0
  const take = Math.max(0, Math.min(Math.floor(count), total))
  if (take === 0) return []
  const startLine = total - take
  let lo = 0
  let hi = layout.lineEnds.length
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2)
    if ((layout.lineEnds[mid] ?? 0) > startLine) hi = mid
    else lo = mid + 1
  }
  const out: string[] = []
  const before = lo > 0 ? (layout.lineEnds[lo - 1] ?? 0) : 0
  const first = layout.entries[lo]
  if (first) out.push(...first.lines.slice(startLine - before))
  for (let i = lo + 1; i < layout.entries.length; i++) {
    const entry = layout.entries[i]
    if (entry) out.push(...entry.lines)
  }
  return out
}

/** One-time welcome block — kimi-style box with info rows; brand wordmark. */
export function welcomeCard(cwd: string, sessionId: string | null, model: string | null, width: number, version: string): string[] {
  const style: BoxStyle = { bg: (t) => t, border: theme.primary }
  // README 品牌：🐋（U+1F40B，eastAsianWidth = 2，与终端 emoji 渲染一致，
  // 不上色——原生彩色 emoji 就是 logo 本体）。
  const logo = '🐋'
  const logoW = stringWidth(logo)
  const gap = '  '
  const row0 = logo + gap + theme.title('✦ orca')
  const row1 = ' '.repeat(logoW) + gap + theme.subtle('DeepSeek Harness 终端前端')
  const label = (text: string): string => theme.strong(theme.subtle(text))
  const info = [
    label('Directory:') + '  ' + short(cwd),
    label('Session:') + '    ' + (sessionId ? shortSession(sessionId) : '—'),
    label('Model:') + '      ' + (model !== null ? cleanLine(model) : theme.warn('未设置')),
    label('Version:') + '    ' + cleanLine(version),
  ]
  return ['', ...boxed(['', row0, row1, '', ...info, ''], width, style), '']
}

/** Slim in-stream line announcing the active route (on connect / change). */
export function routeLine(route: SessionRoute): string {
  const effort = route.reasoningEffort ? `(${cleanLine(route.reasoningEffort)})` : ''
  return theme.accent(`↳ 模型 ${cleanLine(route.provider)}/${cleanLine(route.model)}${effort}`)
}

export function routeKey(route: SessionRoute): string {
  return `${route.provider}/${route.model}/${route.reasoningEffort ?? ''}`
}

function renderRow(row: TranscriptRow, ctx: FrameContext, width: number): string[] {
  switch (row.kind) {
    case 'user':
      return userLines(cleanText(row.text || '…'), width)
    case 'assistant':
      return assistantLines(cleanText(row.text || '…'), width)
    case 'thought':
      return thoughtLines(row, ctx, width)
    case 'tool':
      return toolCard(row, width)
    case 'system':
      return ['', ...wrapWidth(cleanText(row.text || '…'), Math.max(8, width - 2)).map((line) => theme.muted(MESSAGE_INDENT + line))]
  }
}

/** Pre-rendered lines are painted verbatim (full width) — no extra guard. */

/** User prompt: `🐋 ` orca role bullet; continuation aligns under it. */
function userLines(text: string, width: number): string[] {
  const bulletW = stringWidth(USER_BULLET)
  const inner = Math.max(8, width - bulletW)
  const wrapped = wrapWidth(text || '…', inner)
  return ['', ...wrapped.map((line, index) =>
    index === 0 ? theme.roleUser(USER_BULLET) + theme.roleUser(line) : ' '.repeat(bulletW) + theme.roleUser(line),
  )]
}

/** Assistant voice: `● ` body bullet + markdown; continuation indents. */
function assistantLines(text: string, width: number): string[] {
  const inner = Math.max(10, width - 2)
  const md = renderMarkdown(text || '…', inner)
  return ['', ...md.map((line, index) => (index === 0 ? theme.text(STATUS_BULLET) + line : MESSAGE_INDENT + line))]
}

function thoughtLines(row: TranscriptRow, ctx: FrameContext, width: number): string[] {
  const expanded = ctx.thoughtExpanded ?? false
  const elapsed = row.seconds ?? (row.startMs !== undefined ? Math.round((ctx.now - row.startMs) / 100) / 10 : 0)
  // Sealed + collapsed: one summary line (full text stays in the session log).
  if (row.seconds !== undefined && !expanded) {
    return ['', theme.live('✻ ') + theme.subtle(`已思考 ${row.seconds}s`)]
  }
  // Expanded (Ctrl+O): the full thinking text, live or sealed.
  if (expanded) {
    const head = row.seconds === undefined
      ? theme.subtle(`${SPIN[tickOf(row, ctx)] ?? SPIN[0]} 思考中 ${elapsed}s · Ctrl+O 折叠`)
      : theme.subtle(`✻ 思考过程 ${row.seconds}s · Ctrl+O 折叠`)
    const wrapped = wrapWidth(cleanText(row.text || '（空）'), Math.max(8, width - 4))
    return ['', head, ...wrapped.map((line) => theme.placeholder(MESSAGE_INDENT + '│ ' + line))]
  }
  // Streaming + collapsed: spinner + timer, last two wrapped lines as preview.
  const head = theme.subtle(`${SPIN[tickOf(row, ctx)] ?? SPIN[0]} 思考中 ${elapsed}s · Ctrl+O 展开`)
  const wrapped = wrapWidth(cleanText(row.text || ''), Math.max(8, width - 4))
  const tail = wrapped.slice(-2).map((line) => theme.placeholder(MESSAGE_INDENT + '⋯ ' + line))
  return ['', head, ...tail]
}

function tickOf(row: TranscriptRow, ctx: FrameContext): number {
  return row.startMs !== undefined ? Math.floor((ctx.now - row.startMs) / 80) % SPIN.length : 0
}

/** Tool run: backgrounded card; status mark + counts in the frame. */
function toolCard(row: TranscriptRow, width: number): string[] {
  const name = cleanLine(row.tool ?? 'tool')
  const style: BoxStyle = { bg: theme.panel, border: theme.panelBorder }
  if (row.diff) {
    const mark = row.status === 'failed' ? theme.fail(FAILURE_MARK) : theme.ok(SUCCESS_MARK)
    const title = mark + theme.strong(`${name} ${cleanLine(row.diff.path)}`)
    const right =
      `${row.diff.added > 0 ? theme.ok(`+${row.diff.added}`) : ''}` +
      `${row.diff.removed > 0 ? ' ' + theme.fail(`−${row.diff.removed}`) : ''}`
    const content: string[] = []
    for (const line of row.diff.lines) {
      const text = truncateCells(cleanLine(line.text), Math.max(8, width - 10))
      if (line.kind === 'add') content.push(theme.ok('+ ' + text))
      else if (line.kind === 'del') content.push(theme.fail('- ' + text))
      else content.push(theme.subtle('· ' + text))
    }
    return ['', ...boxed(content, width, { ...style, title }, { right })]
  }
  const mark =
    row.status === 'running' ? theme.primary('⠋') : row.status === 'failed' ? theme.fail(FAILURE_MARK) : theme.ok(SUCCESS_MARK)
  const suffix = row.status === 'running' ? theme.subtle(' ...') : ''
  const title = mark + theme.strong(name) + suffix
  const wrapped = wrapWidth(cleanText(row.text || ''), Math.max(8, width - 8))
  const content = wrapped.slice(0, 3).map((line) => theme.subtle(line))
  return ['', ...boxed(content, width, { ...style, title })]
}

function wrappedLines(text: string, width: number): string[] {
  return wrapWidth(text, width)
}

/**
 * Terminal cursor column inside the editor box. When the logical cursor sits
 * mid-text, the char under it is painted in reverse video (see `inputBox`)
 * and the terminal cursor parks at the end of the text — diff-painted rows
 * cannot trust mid-line cursor placement, but the visible highlight carries
 * the position.
 */
/**
 * Boxed editor, kimi-style: primary rounded frame, `> ` prompt at column 2.
/**
 * Pending attachment tokens render as inline labels inside the input box;
 * a mid-text logical cursor highlights the char under it (reverse video).
 */
function expandAttachmentTokens(text: string): string {
  let out = ''
  let images = 0
  let files = 0
  for (const ch of Array.from(text)) {
    let label: string | undefined
    if (ch === IMAGE_SENTINEL) label = attachmentToken(ch, ++images)
    else if (ch === FILE_SENTINEL) label = attachmentToken(ch, ++files)
    if (label !== undefined) {
      // Display-only trailing space keeps multiple tokens readable without
      // putting a real space in the raw editor (so Backspace deletes the
      // whole token atomically).
      out += label
    } else {
      out += ch
    }
  }
  return out
}

function inputBox(
  text: string,
  width: number,
  cursor?: number,
  attachments?: readonly string[],
): { lines: string[]; cursorLine: number; cursorCol: number } {
  const w = Math.max(20, width)
  const style: BoxStyle = { bg: (t) => t, border: theme.primary }
  const rows: string[] = [boxTop(w, style)]
  // Legacy separate attachment rows are kept for callers that still pass
  // `attachments`; Orca now embeds image tokens inline via IMAGE_SENTINEL.
  for (const label of attachments ?? []) rows.push(boxLine('🖼 ' + cleanLine(label), w, style))
  const sourceChars = Array.from(text)
  const sourceIndex = Math.max(0, Math.min(sourceChars.length, cursor ?? sourceChars.length))
  const cleaned = cleanLine(expandAttachmentTokens(text))
  // Build the visible line directly from raw chars: only real sentinel tokens
  // are highlighted, so manually typed `[image #1]` text stays plain.
  let body = ''
  let displayIndex = 0
  let imageNumber = 0
  let fileNumber = 0
  for (let i = 0; i < sourceChars.length; i++) {
    const ch = sourceChars[i] ?? ''
    let label: string | undefined
    if (ch === IMAGE_SENTINEL) label = attachmentToken(ch, ++imageNumber)
    else if (ch === FILE_SENTINEL) label = attachmentToken(ch, ++fileNumber)
    if (label !== undefined) {
      const tokenChars = Array.from(label)
      let cursorDisplay = -1
      if (sourceIndex === i) cursorDisplay = displayIndex
      else if (sourceIndex === i + 1) cursorDisplay = displayIndex + tokenChars.length - 1
      let tokenBody = ''
      for (let j = 0; j < tokenChars.length; j++) {
        const tokenChar = tokenChars[j] ?? ''
        tokenBody += displayIndex + j === cursorDisplay ? theme.cursor(tokenChar) : tokenChar
      }
      body += theme.primary(tokenBody)
      displayIndex += tokenChars.length
      continue
    }
    body += sourceIndex === i ? theme.cursor(ch) : ch
    displayIndex++
  }
  if (body === '') body = theme.placeholder('说点什么...')
  const cursorLine = rows.length
  rows.push(boxLine('> ' + body, w, style))
  rows.push(boxBottom(w, style))
  const cursorCol = Math.min(w - 1, 5 + stringWidth(cleaned))
  return { lines: rows, cursorLine, cursorCol }
}

/** Two-line plain status footer (kimi footer.ts): state/route/cwd + hints/context. */
function footerLines(ctx: FrameContext, width: number): string[] {
  const state = ctx.channel.runState
  const route = ctx.route
  const usage = ctx.usage
  const compacting = ctx.channel.compacting
  const badge = compacting
    ? theme.subtle('◌ 压缩中...')
    : state === 'thinking'
      ? theme.subtle('⠋ 思考中...')
      : state === 'working'
        ? theme.subtle('⏺ 执行工具...')
        : ctx.connecting
          ? theme.subtle('○ 连接中...')
          : ''
  const routeText = route
    ? theme.text(`${cleanLine(route.provider)}/${cleanLine(route.model)}${route.reasoningEffort ? `(${cleanLine(route.reasoningEffort)})` : ''}`)
    : ''
  // Live agent preset (M5 status slot): model-adjacent, vanishes when unknown.
  const presetText = ctx.preset ? theme.text(`预设:${cleanLine(ctx.preset)}`) : ''
  // M3/M4 status slots: title · yolo/policy · git branch — all best-effort,
  // all truncated by the gutter guard. Empty slots vanish, never blank gaps.
  const titleText = ctx.title ? theme.text(`「${cleanLine(ctx.title)}」`) : ''
  const modeText = ctx.yolo ? theme.warn('yolo') : ctx.policy === 'never' ? theme.warn('never') : ''
  const planText = ctx.planMode ? theme.warn('plan') : ''
  const askText = ctx.askMode ? theme.warn('ask') : ''
  const branchName = ctx.branch ? cleanLine(ctx.branch) : ''
  const branchIcon = ctx.nerdFont ? ' ' : ''
  const branchText = branchName ? theme.muted(branchIcon + branchName) : ''
  const dir = theme.muted(short(ctx.cwd))
  const line1 = [badge, routeText, presetText, titleText, modeText, planText, askText, dir, branchText]
    .filter((part) => part !== '')
    .join(theme.subtle(' │ '))

  const context =
    usage.messages > 0
      ? `↑${fmtTokens(usage.input)} ↓${fmtTokens(usage.output)}${usage.reasoning > 0 ? ` ✻${fmtTokens(usage.reasoning)}` : ''}`
      : ''
  const hintText = theme.muted(HINT)
  let line2: string
  if (context !== '') {
    const contextText = theme.text(context)
    const ctxW = stringWidth(contextText)
    const avail = Math.max(0, width - 2 - ctxW)
    const shownHint = stringWidth(hintText) > avail ? truncateWidth(hintText, avail) : hintText
    const pad = Math.max(0, width - 2 - stringWidth(shownHint) - ctxW)
    line2 = shownHint + ' '.repeat(pad) + contextText
  } else {
    line2 = hintText
  }
  return [gutterLine(line1, width), gutterLine(line2, width)]
}

/** 1-cell gutter strip (kimi CHROME_GUTTER): ` content ` within `width`.
 *  The row is padded to EXACTLY the terminal width, so ambiguous ellipses
 *  are stripped first (a CJK-wide `…` here wraps the whole footer). */
function gutterLine(content: string, width: number): string {
  return ' ' + truncateWidth(asciiEllipses(content), width - 2) + ' '
}

function fmtTokens(count: number): string {
  return formatTokenCount(count)
}

function short(cwd: string): string {
  cwd = cleanLine(cwd)
  const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? ''
  const display = home && cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd
  return display.replaceAll('\\', '/')
}

function shortSession(id: string): string {
  id = cleanLine(id)
  return id.length > 18 ? '..' + id.slice(-12) : id
}

function truncateCells(line: string, width: number): string {
  return truncateWidth(line, width)
}
