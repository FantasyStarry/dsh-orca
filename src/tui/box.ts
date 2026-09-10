/**
 * Box primitives — the layout atoms for the card/bubble visual language.
 * A box is a full-width frame (rounded corners) whose body is background-
 * filled, so cards read as solid panels against the terminal background.
 *
 * Nesting rule: the frame characters are painted INSIDE the background
 * wrapper (`bg(border('╭') + … + border('╮'))`), so corners keep the border
 * color while the whole line carries the card fill. This only works because
 * every theme paint closes with a PRECISE reset (see theme.ts) — a blanket
 * `\x1b[0m` inside would punch the fill out.
 *
 * Width math is always terminal cells; content is truncated at the card edge
 * (never hard-wrapped here — callers pre-wrap with wrapSpans/wrapWidth).
 */

import { asciiEllipses, stringWidth, truncateWidth } from './width.js'
import type { Paint } from './theme.js'

export interface BoxStyle {
  /** Background fill painted across the whole box (body + borders). */
  readonly bg: Paint
  /** Foreground for the frame characters. */
  readonly border: Paint
  /** Optional title embedded in the top border (plain or pre-painted). */
  readonly title?: string
  /** Applied to `title` when it is plain; pass pre-painted titles and omit. */
  readonly titlePaint?: Paint
}

const TL = '╭'
const TR = '╮'
const BL = '╰'
const BR = '╯'
const H = '─'
const V = '│'

function inner(width: number): number {
  return Math.max(2, width - 2)
}

/**
 * Top border: `╭─ title ──── [right]─╮`. `right` (pre-painted) hugs the corner.
 *
 * Every glyph of the frame — corners, the horizontal run AND the title's own
 * `─ ` furniture — is painted with the border color. Painting only the corners
 * leaves the straight runs in the terminal's DEFAULT foreground, which reads
 * as a white line with four blue dots (visible in cmd.exe).
 */
export function boxTop(width: number, style: BoxStyle, right?: string): string {
  const innerW = inner(width)
  let label = ''
  if (style.title) {
    const t = style.titlePaint ? style.titlePaint(style.title) : asciiEllipses(style.title)
    label = style.border('─ ') + t + ' '
  }
  const rightPart = right === undefined ? '' : ` ${asciiEllipses(right)}`
  const labelW = stringWidth(label)
  const rightW = stringWidth(rightPart)
  const fill = H.repeat(Math.max(1, innerW - labelW - rightW))
  return style.bg(style.border(TL) + label + style.border(fill) + rightPart + style.border(TR))
}

/** Bottom border: `╰──[hint]───╯`. `hint` is pre-painted; dropped when it cannot fit. */
export function boxBottom(width: number, style: BoxStyle, hint?: string): string {
  const innerW = inner(width)
  const plain = hint === undefined ? '' : `─ ${asciiEllipses(hint)} `
  // A hint that does not fit is DROPPED rather than truncated: truncating
  // pre-painted text would either cut an escape sequence or mis-size the
  // frame, and a border that wraps desyncs the whole diff painter.
  const showHint = hint !== undefined && stringWidth(plain) <= innerW
  const fill = H.repeat(Math.max(1, innerW - (showHint ? stringWidth(plain) : 0)))
  const body = showHint
    ? style.border('─ ') + asciiEllipses(hint) + style.border(' ') + style.border(fill)
    : style.border(fill)
  return style.bg(style.border(BL) + body + style.border(BR))
}

/**
 * Body line: `│ content …pad… │` with the whole line background-filled.
 * Content is sanitized of ambiguous ellipses first — the padding math must
 * agree with every terminal's width table or the border wraps (see
 * asciiEllipses).
 */
export function boxLine(content: string, width: number, style: BoxStyle): string {
  const innerW = inner(width)
  let c = asciiEllipses(content)
  if (stringWidth(c) > innerW - 2) c = truncateWidth(c, innerW - 2)
  const pad = Math.max(0, innerW - 2 - stringWidth(c))
  return style.bg(style.border(V) + ' ' + c + ' '.repeat(pad) + ' ' + style.border(V))
}

/** A complete box: top border → body lines → bottom border (optional hint). */
export function boxed(
  content: readonly string[],
  width: number,
  style: BoxStyle,
  opts?: { readonly hint?: string; readonly right?: string },
): string[] {
  return [boxTop(width, style, opts?.right), ...content.map((line) => boxLine(line, width, style)), boxBottom(width, style, opts?.hint)]
}
