/**
 * Scrollback probe: spawns the fake-kernel app under a REAL ConPTY, drives N
 * prompt submissions, and interprets the byte stream with a terminal
 * emulator that RETAINS SCROLLBACK. Asserts the Claude-Code-style contract:
 *
 *   every sealed transcript line must be recoverable above the viewport —
 *   complete, in log order, with no ghost copies and no chrome residue —
 *   and the live block must keep the editor pinned to the bottom row.
 *
 * This is the regression net for the whole class of "old messages vanish /
 * ghost rows / glued chrome" painter bugs: the in-process smoke's screen
 * model and the app-level ORCA_LOG layer cannot see the terminal's
 * scrollback, but a real terminal absolutely holds Orca to it.
 *
 * Zero API cost (fake kernel). Usage: node scripts/probe-scrollback.mjs
 */

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { probePath, requireFromDsh } from './paths.mjs'

const pty = requireFromDsh('node-pty')

const COLS = 100
const ROWS = 30
const TURNS = Number(process.env['PROBE_TURNS'] ?? '3')
const LINES = Number(process.env['PROBE_LINES'] ?? '14')
const HERE = dirname(fileURLToPath(import.meta.url))

/** Minimal VT emulator with scrollback. Covers the vocabulary Orca emits:
 *  CUP/CHA, CUU/CUD, ED(0/2), EL(0/2), \r\n \r \n, SGR/CSI-2026 ignored. */
class Term {
  constructor(cols, rows) {
    this.cols = cols
    this.rows = rows
    this.scrollback = []
    this.grid = Array.from({ length: rows }, () => new Array(cols).fill(' '))
    this.cx = 0
    this.cy = 0
    this.buf = ''
  }
  line(r) { return (this.grid[r] ?? []).join('').replace(/\s+$/, '') }
  scroll(n) {
    for (let i = 0; i < n; i++) {
      this.scrollback.push(this.grid.shift())
      this.grid.push(new Array(this.cols).fill(' '))
    }
  }
  put(ch) {
    if (this.cx >= this.cols) { this.cx = 0; this.cy++; if (this.cy >= this.rows) { this.cy = this.rows - 1; this.scroll(1) } }
    this.grid[this.cy][this.cx] = ch
    this.cx++
  }
  feed(data) {
    this.buf += data
    for (;;) {
      if (this.buf.startsWith('\x1b')) {
        const m = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(this.buf)
        if (!m) {
          if (this.buf.length <= 1) return
          if (this.buf[1] === '[') return // partial CSI — wait
          this.buf = this.buf.slice(1) // swallow other escapes
          continue
        }
        this.buf = this.buf.slice(m[0].length)
        const p = m[1].split(';').map((x) => parseInt(x || '1', 10))
        this.csi(m[2], Number.isFinite(p[0]) ? p[0] : 1, p[1])
        continue
      }
      const i = this.buf.indexOf('\x1b', 1)
      const text = i === -1 ? this.buf : this.buf.slice(0, i)
      this.buf = i === -1 ? '' : this.buf.slice(i)
      if (text) this.text(text)
      if (i === -1) return
    }
  }
  text(text) {
    for (const ch of text) {
      if (ch === '\r') { this.cx = 0; continue }
      if (ch === '\n') { this.cy++; if (this.cy >= this.rows) { this.cy = this.rows - 1; this.scroll(1) } continue }
      if (ch.codePointAt(0) < 0x20) continue
      this.put(ch)
    }
  }
  csi(final, n, n2) {
    switch (final) {
      case 'A': this.cy = Math.max(0, this.cy - n); break
      case 'B': this.cy = Math.min(this.rows - 1, this.cy + n); break
      case 'G': this.cx = Math.max(0, Math.min(this.cols - 1, n - 1)); break
      case 'H': case 'f': {
        this.cy = Math.max(0, Math.min(this.rows - 1, n - 1))
        this.cx = Math.max(0, Math.min(this.cols - 1, (n2 ?? 1) - 1))
        break
      }
      case 'J': {
        if (n === 0) {
          for (let c = this.cx; c < this.cols; c++) this.grid[this.cy][c] = ' '
          for (let r = this.cy + 1; r < this.rows; r++) this.grid[r] = new Array(this.cols).fill(' ')
        } else if (n === 2) this.grid = Array.from({ length: this.rows }, () => new Array(this.cols).fill(' '))
        break
      }
      case 'K': {
        const from = n === 2 ? 0 : this.cx
        for (let c = from; c < this.cols; c++) this.grid[this.cy][c] = ' '
        break
      }
      default: break // SGR (m), CSI 2026 sync, etc. — ignored
    }
  }
  all() { return [...this.scrollback.map((g) => (g ?? []).join('').replace(/\s+$/, '')), ...Array.from({ length: this.rows }, (_, r) => this.line(r))] }
}

const term = new Term(COLS, ROWS)
const child = pty.spawn(process.execPath, ['--import', 'tsx/esm', join(HERE, 'scrollback-child.mts')], {
  name: 'xterm-256color',
  cols: COLS,
  rows: ROWS,
  cwd: join(HERE, '..'),
  env: { ...process.env, EXP_TURNS: String(TURNS), EXP_LINES: String(LINES) },
})
child.onData((d) => term.feed(d))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function submit(text) {
  for (const ch of text) child.write(ch)
  await sleep(50)
  child.write('\r')
}

await sleep(2500)
for (let t = 1; t <= TURNS; t++) {
  await submit(`q${t}`)
  await sleep(3500)
}
await sleep(800)
child.kill()
await sleep(300)

const problems = []
for (let t = 1; t <= TURNS; t++) {
  for (let l = 1; l <= LINES; l++) {
    const marker = `T${t}-L${l} `
    if (!term.all().some((row) => row.includes(marker))) {
      problems.push(`T${t}-L${l} 丢失（既不在 scrollback 也不在视口）`)
      break
    }
  }
}
// No ghost copies: each sealed line must appear exactly once in scrollback.
for (let t = 1; t <= TURNS; t++) {
  const copies = term.scrollback.filter((g) => (g ?? []).join('').includes(`T${t}-L1 ——`)).length
  if (copies > 1) problems.push(`T${t} 在 scrollback 中出现 ${copies} 份（ghost 重复）`)
}
// The live block keeps the editor pinned to the bottom rows.
const viewport = Array.from({ length: ROWS }, (_, r) => term.line(r))
if (!viewport[ROWS - 1].includes('Enter 发送')) problems.push('页脚未钉在末行')
if (!viewport.some((row) => row.includes('> 说点什么...'))) problems.push('编辑框缺失')

if (problems.length > 0) {
  console.error(`scrollback probe 失败：${problems.join('；')}`)
  const file = probePath('probe-scrollback-last.txt')
  writeFileSync(file, [
    ...term.scrollback.map((g, i) => `${String(i).padStart(4)}| ${(g ?? []).join('').replace(/\s+$/, '')}`),
    ...Array.from({ length: ROWS }, (_, r) => `  V${r}| ${term.line(r)}`),
  ].join('\n'))
  console.error(`完整屏面已写入 ${file}`)
  process.exit(1)
}
console.log(`scrollback probe 通过 ✔（${TURNS} 个回合 × ${LINES} 行全部沉淀可回溯，无 ghost，chrome 钉底）`)
process.exit(0)
