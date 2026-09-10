/**
 * Raw-mode keyboard input with an in-house escape-sequence parser.
 *
 * node:readline's keypress emitter holds a lone ESC for ~500ms
 * (escapeCodeTimeout) waiting to see whether a CSI sequence follows: every
 * Esc press lags half a second, and Esc+key pairs merge into alt+keys — the
 * "菜单/picker 关不掉、输入框残留脏字符" class of bugs (verified under
 * ConPTY: a lone ESC emitted its keypress ~520ms late). This module parses
 * the raw byte stream itself with a 40ms escape window.
 *
 * Parser guarantees:
 * - recognized CSI/SS3 map to named keys; UNKNOWN sequences (mouse reports,
 *   focus events, paste markers, Kitty extras) are swallowed — raw escape
 *   bytes can never smear into the prompt;
 * - a lone ESC flushes instantly when the next burst is clearly not a
 *   sequence continuation, else after 40ms (double-Esc rewind stays usable);
 * - multibyte UTF-8 survives chunk splits (StringDecoder);
 * - Kitty CSI-u / xterm modifyOtherKeys printable sequences decode to text
 *   (`\x1b[97;1u` → `a`; release `:3` events swallowed, see `./keys.js`);
 * - bracketed paste (CSI 200~ … 201~, enabled by the app) arrives as ONE
 *   burst through the optional `onPaste` callback instead of a keystroke
 *   replay that would submit on the first embedded newline;
 * - legacy Alt+V (`ESC v` / `ESC V`) and CSI-u Alt+V map to `alt+v` so the
 *   app can bind an image-paste hotkey that survives Windows Terminal's
 *   Ctrl+V interception;
 * - names mirror the old readline surface the app already keys off
 *   ('return' for \r, 'backspace' for \x7f/\x08, ctrl+letter for C0).
 */

import { StringDecoder } from 'node:string_decoder'
import { decodePrintableKey, isKeyRelease } from './keys.js'

export interface KeyPress {
  /** Printable character for text keys, else the named key. */
  readonly name: string
  readonly ctrl: boolean
  readonly alt: boolean
  readonly shift: boolean
  readonly sequence: string
}

export type KeyHandler = (key: KeyPress) => void

/**
 * One decoded mouse report (SGR extended mode: `CSI < b ; x ; y M|m`).
 * Coordinates are 1-based terminal cells, exactly as the terminal reports
 * them. Orca only enables mouse tracking in the alternate screen, so the
 * inline mode keeps the terminal's own selection/copy.
 */
export interface MouseReport {
  readonly kind: 'press' | 'release' | 'move' | 'wheel'
  /** 0 left, 1 middle, 2 right; for `wheel`, 0 = up and 1 = down. */
  readonly button: number
  readonly x: number
  readonly y: number
  readonly shift: boolean
  readonly alt: boolean
  readonly ctrl: boolean
}

export type MouseHandler = (event: MouseReport) => void

/** SGR mouse: `\x1b[<0;12;5M` (press/move/wheel) / `…m` (release). */
const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/

const ESC = '\x1b'
/** How long a lone ESC waits for a CSI prefix before flushing as Esc. */
const ESC_FLUSH_MS = 40
const CSI_RE = /^\x1b\[([0-9;:<=>?]*)([A-Za-z~])/
const SS3_RE = /^\x1bO([A-Za-z])/

const CSI_KEYS: Readonly<Record<string, string>> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
}

/** CSI-u form of Alt+V (`\x1b[118;3u`) / Alt+Shift+V (`\x1b[86;4u`). */
const ALT_V_CSI_RE = /^\x1b\[(\d+);(\d+)(?::(\d+))?u$/
/** CSI-u form of CR/LF with modifiers: `\x1b[13;3u` = Alt+Enter. */
const CSI_NEWLINE_RE = /^\x1b\[(13|10);(\d+)(?::\d+)?u$/

const SS3_KEYS: Readonly<Record<string, string>> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  P: 'f1',
  Q: 'f2',
  R: 'f3',
  S: 'f4',
}

/** `CSI n ~` tilde keys (insert/delete/pages/Home/End, F1-F10). */
function csiTildeKey(params: string): string | null {
  const head = params.split(';')[0] ?? ''
  const n = parseInt(head, 10)
  if (!Number.isFinite(n)) return null
  if (n === 2) return 'insert'
  if (n === 3) return 'delete'
  if (n === 5) return 'pageup'
  if (n === 6) return 'pagedown'
  if (n === 7) return 'home'
  if (n === 8) return 'end'
  if (n >= 11 && n <= 15) return `f${n - 10}`
  if (n >= 17 && n <= 21) return `f${n - 11}`
  return null // 200/201 paste markers and everything else — swallowed
}

export class Keyboard {
  private readonly handler: KeyHandler
  private readonly onPaste: ((text: string) => void) | null
  private readonly onMouse: MouseHandler | null
  private active = false
  /** Decoded but not yet parsed input (partial sequences wait here). */
  private pending = ''
  private readonly decoder = new StringDecoder('utf8')
  private escTimer: NodeJS.Timeout | null = null
  /** Inside a bracketed paste (CSI 200~ … 201~): chars buffer as one burst. */
  private pasting = false
  private pasteBuf = ''

  constructor(
    private readonly stdin: NodeJS.ReadStream,
    handler: KeyHandler,
    onPaste?: (text: string) => void,
    onMouse?: MouseHandler,
  ) {
    this.handler = handler
    this.onPaste = onPaste ?? null
    this.onMouse = onMouse ?? null
  }

  start(): void {
    if (this.active || !this.stdin.isTTY) return
    this.stdin.setRawMode(true)
    this.stdin.resume()
    this.stdin.on('data', this.onData)
    this.active = true
  }

  stop(): void {
    if (!this.active) return
    this.stdin.removeListener('data', this.onData)
    this.stdin.setRawMode(false)
    this.stdin.pause()
    this.clearEscTimer()
    this.pending = ''
    this.pasting = false
    this.pasteBuf = ''
    this.active = false
  }

  private clearEscTimer(): void {
    if (this.escTimer !== null) {
      clearTimeout(this.escTimer)
      this.escTimer = null
    }
  }

  private readonly onData = (chunk: string | Buffer): void => {
    // Chunk boundaries may split multibyte chars or escape sequences — the
    // decoder holds partial bytes back, parse() holds partial sequences.
    this.pending += this.decoder.write(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk)
    this.clearEscTimer()
    this.parse()
    this.armEscTimer()
  }

  /** End a bracketed paste: deliver the whole burst at once. */
  private endPaste(): void {
    this.pasting = false
    const text = this.pasteBuf
    this.pasteBuf = ''
    if (text === '') return
    if (this.onPaste) this.onPaste(text)
    else for (const ch of text) this.handler(decodeChar(ch))
  }

  /**
   * Arm the lone-ESC flush: pending is either a bare ESC (flush as the Esc
   * key) or an unterminated sequence prefix (swallow — anti-smear wins over
   * recovering junk bytes the terminal should never send half of).
   */
  private armEscTimer(): void {
    if (this.pending === '') return
    if (!this.pending.startsWith(ESC)) return
    this.escTimer = setTimeout(() => {
      this.escTimer = null
      if (this.pending === ESC) {
        this.pending = ''
        this.handler({ name: 'escape', ctrl: false, alt: false, shift: false, sequence: ESC })
      } else if (this.pending.startsWith(ESC)) {
        this.pending = '' // unterminated junk — dropped, never smeared
      }
    }, ESC_FLUSH_MS)
  }

  private parse(): void {
    for (;;) {
      if (this.pending === '') return
      if (this.pending.startsWith(ESC + '[200~')) {
        // Bracketed paste start — everything until 201~ is one burst.
        this.pending = this.pending.slice(6)
        this.pasting = true
        this.pasteBuf = ''
        continue
      }
      if (this.pending.startsWith(ESC + '[201~')) {
        this.pending = this.pending.slice(6)
        if (this.pasting) this.endPaste()
        continue
      }
      if (!this.pending.startsWith(ESC)) {
        // Plain run: everything up to the next ESC (or the end). Inside a
        // bracketed paste the run joins the burst instead of the editor.
        const next = this.pending.indexOf(ESC, 1)
        const run = next === -1 ? this.pending : this.pending.slice(0, next)
        this.pending = next === -1 ? '' : this.pending.slice(next)
        if (this.pasting) {
          this.pasteBuf += run
          continue
        }
        for (const ch of run) this.handler(decodeChar(ch))
        continue
      }
      if (this.pending === ESC) return // lone ESC — timer decides
      const csi = CSI_RE.exec(this.pending)
      if (csi) {
        const match = csi[0]
        this.pending = this.pending.slice(match.length)
        this.emitCsi(csi[1] ?? '', csi[2] ?? '', match)
        continue
      }
      const ss3 = SS3_RE.exec(this.pending)
      if (ss3) {
        const match = ss3[0]
        this.pending = this.pending.slice(match.length)
        const name = SS3_KEYS[ss3[1] ?? '']
        if (name) this.handler({ name, ctrl: false, alt: false, shift: false, sequence: match })
        continue
      }
      if (this.pending.startsWith(ESC + ESC)) {
        // Two fast Esc presses: emit one now, keep the second pending.
        this.pending = this.pending.slice(1)
        this.handler({ name: 'escape', ctrl: false, alt: false, shift: false, sequence: ESC })
        continue
      }
      const follower = this.pending[1] ?? ''
      if (follower === '[' || follower === 'O') return // partial sequence — wait for more
      // Alt+Enter (ESC CR / ESC LF) is the multi-line editor's newline chord.
      // It MUST be recognized here: the generic path below flushes the Esc
      // first, so Alt+Enter would degrade into "cancel, then submit".
      if ((follower === '\r' || follower === '\n') && this.pending.length >= 2) {
        const seq = this.pending.slice(0, 2)
        this.pending = this.pending.slice(2)
        this.handler({ name: 'alt+enter', ctrl: false, alt: true, shift: false, sequence: seq })
        continue
      }
      // Only Alt+V is recognized as an alt-chord: Windows Terminal consumes
      // Ctrl+V for its own paste, so image paste needs this escape hatch.
      // All other ESC+char stays the old behavior (Esc first, then the char).
      if ((follower === 'v' || follower === 'V') && this.pending.length >= 2) {
        const seq = this.pending.slice(0, 2)
        this.pending = this.pending.slice(2)
        this.handler({ name: follower, ctrl: false, alt: true, shift: follower === 'V', sequence: seq })
        continue
      }
      // ESC + ordinary char: flush the Esc FIRST (instant cancel), then
      // parse the char as fresh input.
      this.pending = this.pending.slice(1)
      this.handler({ name: 'escape', ctrl: false, alt: false, shift: false, sequence: ESC })
    }
  }

  /** CSI → named key; unknown finals (focus/paste markers) vanish. */
  private emitCsi(params: string, final: string, sequence: string): void {
    // SGR mouse reports never become keys: they carry button, motion and
    // modifier bits in one code, and the app decides what to do with them.
    if (this.onMouse && (final === 'M' || final === 'm')) {
      const mouse = SGR_MOUSE_RE.exec(sequence)
      if (mouse) {
        const code = Number(mouse[1])
        const x = Number(mouse[2])
        const y = Number(mouse[3])
        if (Number.isFinite(code) && Number.isFinite(x) && Number.isFinite(y)) {
          const wheel = (code & 64) !== 0
          const drag = (code & 32) !== 0
          this.onMouse({
            kind: wheel ? 'wheel' : final === 'm' ? 'release' : drag ? 'move' : 'press',
            button: wheel ? ((code & 1) !== 0 ? 1 : 0) : code & 3,
            x,
            y,
            shift: (code & 4) !== 0,
            alt: (code & 8) !== 0,
            ctrl: (code & 16) !== 0,
          })
        }
        return
      }
    }
    // Kitty `disambiguate` 模式把裸可打印键发成 CSI-u（`\x1b[97;1u` = `a`）；
    // 先还原成文本，否则 Kitty/Ghostty/WezTerm 下输入直接丢字。release 事件
    //（flag 2 的 `:3` 后缀）永远吞掉——按键松开不应再进一次编辑器。
    if (isKeyRelease(sequence)) return
    // CSI-u newline chords (Kitty protocol): `\x1b[13;3u` Alt+Enter,
    // `\x1b[13;2u` Shift+Enter, `\x1b[13;5u` Ctrl+Enter. CR/LF are not
    // printable, so the printable decoder below drops them — they must be
    // mapped here or the chord is silently swallowed.
    const newlineCsi = CSI_NEWLINE_RE.exec(sequence)
    if (newlineCsi) {
      const modValue = Number(newlineCsi[2])
      const bits = Number.isFinite(modValue) && modValue >= 2 ? modValue - 1 : 0
      const shift = (bits & 1) !== 0
      const alt = (bits & 2) !== 0
      const ctrl = (bits & 4) !== 0
      if (shift || alt || ctrl) {
        this.handler({ name: alt ? 'alt+enter' : 'return', ctrl, alt, shift, sequence })
        return
      }
    }
    // CSI-u Alt+V: Windows Terminal 不会把 Ctrl+V 交给 TUI，Alt+V 是图片粘贴
    // 的逃生口；这里把 `\x1b[118;3u` / `\x1b[86;4u` 还原成 `alt+v`。
    const altV = ALT_V_CSI_RE.exec(sequence)
    if (altV) {
      const modValue = Number(altV[2])
      const bits = Number.isFinite(modValue) && modValue >= 2 ? modValue - 1 : 0
      if ((bits & 2) !== 0 && (bits & 4) === 0) {
        const cp = Number(altV[1])
        if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return
        const ch = String.fromCodePoint(cp)
        if (ch === 'v' || ch === 'V') {
          this.handler({ name: ch, ctrl: false, alt: true, shift: ch === 'V', sequence })
          return
        }
      }
    }
    const printable = decodePrintableKey(sequence)
    if (printable !== undefined) {
      for (const ch of printable) this.handler(decodeChar(ch))
      return
    }
    let name: string | null
    if (final === '~') name = csiTildeKey(params)
    else if (final === 'Z') name = 'tab' // `\x1b[Z` is always shift-tab
    else name = CSI_KEYS[final] ?? null
    if (!name) return
    // `1;5A` style modifiers: second param = bitmask+1 (1 shift, 2 alt, 4 ctrl).
    const parts = params.split(';')
    const modifier = parts.length >= 2 ? parseInt(parts[1] ?? '', 10) : Number.NaN
    const bits = Number.isFinite(modifier) && modifier >= 2 ? modifier - 1 : 0
    this.handler({
      name,
      ctrl: (bits & 4) !== 0,
      alt: (bits & 2) !== 0,
      shift: final === 'Z' ? true : (bits & 1) !== 0,
      sequence,
    })
  }
}

/** Map one decoded character to a KeyPress with readline-compatible names. */
function decodeChar(ch: string): KeyPress {
  const code = ch.codePointAt(0) ?? 0
  if (ch === '\r' || ch === '\n') return { name: 'return', ctrl: false, alt: false, shift: false, sequence: ch }
  if (ch === '\t') return { name: 'tab', ctrl: false, alt: false, shift: false, sequence: ch }
  if (ch === '\x7f' || ch === '\x08') return { name: 'backspace', ctrl: false, alt: false, shift: false, sequence: ch }
  if (code < 0x20) return { name: String.fromCharCode(code + 0x60), ctrl: true, alt: false, shift: false, sequence: ch }
  return { name: ch, ctrl: false, alt: false, shift: false, sequence: ch }
}

/** Submit / cancel / text-entry classification used by the editor. */
export function classify(key: KeyPress): 'submit' | 'newline' | 'cancel' | 'exit' | 'backspace' | 'navigate' | 'text' | 'ignore' {
  if (key.ctrl && key.name === 'c') return 'exit'
  if (key.ctrl && key.name === 'd') return 'exit'
  if (key.name === 'escape') return 'cancel'
  // Newline chords (the editor is multi-line). Alt+Enter is the one that works
  // on every terminal: Windows Terminal and ConPTY send it as ESC CR, which
  // `input.ts` decodes as the named `alt+enter`. Shift+Enter only arrives
  // distinct under the Kitty protocol, and Ctrl+J is the legacy LF byte.
  if (key.name === 'alt+enter') return 'newline'
  if (key.name === 'return' && key.shift) return 'newline'
  if (key.ctrl && key.name === 'j') return 'newline'
  if (key.name === 'return' && !key.ctrl && !key.alt) return 'submit'
  if (key.name === 'backspace') return 'backspace'
  // Navigation keys carry escape sequences as their `sequence`; inserting
  // them into the editor would smear raw CSI garbage into the prompt line.
  // They are routed to the app's editor handlers instead (cursor motion,
  // history recall, picker/menu navigation); `insert`/`pageup`/`pagedown`
  // are accepted here and deliberately ignored downstream.
  if (['up', 'down', 'left', 'right', 'home', 'end', 'delete', 'pageup', 'pagedown', 'insert'].includes(key.name)) {
    return 'navigate'
  }
  if (!key.ctrl && !key.alt && key.sequence.length > 0 && key.sequence.codePointAt(0)! >= 0x20) {
    return 'text'
  }
  return 'ignore'
}
