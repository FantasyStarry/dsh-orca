/**
 * PTY probe: boots the real orca profile in a ConPTY and drives the exact
 * user-reported repro (model switch + `/` menu) while interpreting the ANSI
 * stream with a minimal terminal emulator (grid + cursor + scroll). After
 * every step it snapshots the visible screen and asserts the input box is
 * intact and the cursor sits inside it.
 *
 * Zero API cost: no prompt is ever submitted to the model.
 *
 * Usage: node scripts/probe-pty.mjs [--dump]   (exit 0 = pass, 1 = fail)
 *        node scripts/probe-pty.mjs --features  (adds ONE minimal real prompt)
 *        node scripts/probe-pty.mjs --state     (two boots: workspace accounting
 *                                    + the session's remembered model; zero API cost)
 */

import { writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { DEFAULT_DSH_HOME, findSessionLog, readSessionEvents } from './session-log.mjs'
import { dshBinPath, dshVersion, probeCwd, probePath, requireFromDsh } from './paths.mjs'

const DSH_BIN = dshBinPath()
const CWD = probeCwd()
const COLS = Number(process.env['ORCA_PROBE_COLS']) || 110
const ROWS = Number(process.env['ORCA_PROBE_ROWS']) || 45
const STEP_TIMEOUT_MS = 30_000
const GLOBAL_TIMEOUT_MS = 150_000
const DUMP = process.argv.includes('--dump')

const pty = requireFromDsh('node-pty')

// ── mini terminal emulator ───────────────────────────────────────────────────

/** Mirror of src/tui/width.ts policy: CJK + …/⋯ are double-cell. */
function isWide(code) {
  if (code === 0x2026 || code === 0x22ef) return true
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
}

class Screen {
  constructor(cols, rows) {
    this.cols = cols
    this.rows = rows
    this.grid = []
    this.scrollback = []
    for (let r = 0; r < rows; r++) this.grid.push(new Array(cols).fill(' '))
    this.cx = 0
    this.cy = 0
    // Escape sequences may split across ConPTY chunks — buffer until each
    // one is complete before interpreting (same design as the app's parser).
    this.buf = ''
    this.pendingWrap = false
  }

  text(row) {
    return (this.grid[row] ?? []).join('').replaceAll('\x00', '').replace(/\s+$/, '')
  }

  plain() {
    return this.grid.map((_, r) => this.text(r)).join('\n')
  }

  /** Scrollback + viewport — sealed rows live above the fold (M8). */
  plainAll() {
    return [
      ...this.scrollback.map((g) => (g ?? []).join('').replaceAll('\x00', '').replace(/\s+$/, '')),
      ...this.grid.map((_, r) => this.text(r)),
    ].join('\n')
  }

  feed(data) {
    this.buf += data
    this.consume()
  }

  consume() {
    for (;;) {
      if (this.buf === '') return
      const ch = this.buf[0]
      if (ch === '\x1b') {
        const csi = /^\x1b\[([0-9;:?<>=]*)([A-Za-z~])/.exec(this.buf)
        if (csi) {
          this.buf = this.buf.slice(csi[0].length)
          this.csi(csi[1], csi[2])
          continue
        }
        const osc = /^\x1b\][^\x07\x1b]*(\x07|\x1b\\)/.exec(this.buf)
        if (osc) {
          this.buf = this.buf.slice(osc[0].length)
          continue
        }
        // Incomplete escape (lone ESC, partial CSI/OSC) — wait for more data.
        if (/^\x1b(\[[0-9;:?<>=]*|\][^\x07\x1b]*)?$/.test(this.buf)) return
        this.buf = this.buf.slice(2) // unknown 2-char escape — drop
        continue
      }
      const next = this.buf.indexOf('\x1b', 1)
      const run = next === -1 ? this.buf : this.buf.slice(0, next)
      this.buf = next === -1 ? '' : this.buf.slice(next)
      for (const c of run) this.handleChar(c)
    }
  }

  handleChar(c) {
    if (c === '\r') {
      this.cx = 0
      this.pendingWrap = false
    } else if (c === '\n') {
      this.lineFeed()
    } else if (c === '\b') {
      if (this.cx > 0) this.cx--
      this.pendingWrap = false
    } else if (c === '\t') {
      this.cx = Math.min(this.cols - 1, (Math.floor(this.cx / 8) + 1) * 8)
      this.pendingWrap = false
    } else if (c < ' ') {
      // other control — ignore
    } else {
      this.put(c)
    }
  }

  put(ch) {
    // DECAWM deferred wrap (real-terminal semantics): writing INTO the last
    // column arms the wrap; it fires only when the NEXT glyph is put, and
    // any explicit cursor move (CR/CHA/CUP…) cancels it. Immediate wrap
    // would drop a row for every exactly-terminal-wide line.
    if (this.pendingWrap) {
      this.pendingWrap = false
      this.cx = 0
      this.lineFeed()
    }
    const wide = isWide(ch.codePointAt(0))
    if (wide && this.cx === this.cols - 1) {
      // A wide glyph cannot split across the edge — wrap whole.
      this.cx = 0
      this.lineFeed()
    }
    const row = this.grid[this.cy]
    if (row) row[this.cx] = ch
    this.cx++
    if (wide) {
      if (row && this.cy === this.grid.indexOf(row)) row[this.cx] = '\x00'
      this.cx++
    }
    if (this.cx >= this.cols) {
      this.cx = this.cols
      this.pendingWrap = true
    }
  }

  lineFeed() {
    if (this.cy >= this.rows - 1) {
      this.scrollback.push(this.grid.shift())
      this.grid.push(new Array(this.cols).fill(' '))
    } else {
      this.cy++
    }
  }

  csi(params, final) {
    const nums = params
      .split(';')
      .map((p) => (p === '' || p === '?' ? 0 : parseInt(p, 10) || 0))
    const n = nums[0] ?? 0
    switch (final) {
      case 'A':
        this.pendingWrap = false
        this.cy = Math.max(0, this.cy - Math.max(1, n))
        break
      case 'B':
        this.pendingWrap = false
        this.cy = Math.min(this.rows - 1, this.cy + Math.max(1, n))
        break
      case 'C':
        this.pendingWrap = false
        this.cx = Math.min(this.cols - 1, this.cx + Math.max(1, n))
        break
      case 'D':
        this.pendingWrap = false
        this.cx = Math.max(0, this.cx - Math.max(1, n))
        break
      case 'G':
        this.pendingWrap = false
        this.cx = Math.max(0, Math.min(this.cols - 1, n - 1))
        break
      case 'H':
      case 'f': {
        const row = (nums[0] || 1) - 1
        const col = (nums[1] || 1) - 1
        this.pendingWrap = false
        this.cy = Math.max(0, Math.min(this.rows - 1, row))
        this.cx = Math.max(0, Math.min(this.cols - 1, col))
        break
      }
      case 'J':
        if (n === 0) {
          const row = this.grid[this.cy]
          if (row) row.fill(' ', this.cx)
          for (let r = this.cy + 1; r < this.rows; r++) this.grid[r].fill(' ')
        } else if (n === 2) {
          for (const row of this.grid) row.fill(' ')
        }
        break
      case 'K': {
        const row = this.grid[this.cy]
        if (!row) break
        if (n === 0) row.fill(' ', this.cx)
        else row.fill(' ')
        break
      }
      default:
        break // ?2026 sync, SGR 'm', etc. — ignored
    }
  }
}

// ── driver ───────────────────────────────────────────────────────────────────

// Replay mode: feed recorded app-level writes (an ORCA_LOG file) through the
// emulator offline and print the resulting screen + cursor. Diagnostic for
// frame-geometry regressions without booting the kernel.
const replayFile = process.env['PROBE_REPLAY']
if (replayFile) {
  const log = readFileSync(replayFile, 'utf8')
  const bodies = [...log.matchAll(/^--- boot#\d+ write#\d+ [^\n]*---\n([\s\S]*?)\n(?=--- boot#|\n?$)/gm)].map((m) => m[1])
  const screen = new Screen(COLS, ROWS)
  for (const body of bodies) {
    const before = `${screen.cy},${screen.cx}`
    screen.feed(body)
    console.error(`write rows=${bodies.indexOf(body)} cursor ${before} -> ${screen.cy},${screen.cx}`)
  }
  console.log(screen.plain())
  process.exit(0)
}

// Assertions run against the APP-level byte stream (ORCA_LOG), not ConPTY's
// re-rendering: ConPTY rewrites cursor motion and reflows rows with its own
// width policy, which is un-emulatable noise. The app stream is the contract
// Orca owns — if the app-level grid is correct, any conforming terminal
// (including ConPTY with matching width tables) renders it correctly.
const APP_LOG = probePath('probe-orca-app.log')
try {
  writeFileSync(APP_LOG, '')
} catch {}

const screen = new Screen(COLS, ROWS)
// ConPTY-layer mirror: fed with the raw pseudoconsole stream (what Windows
// Terminal actually renders). Divergence between the two screens localizes
// width/scroll bugs to the ConPTY re-render vs the app's own frame.
const conpty = new Screen(COLS, ROWS)
let raw = ''
let logOffset = 0
let logTail = ''
const SEG_RE = /--- boot#\d+ write#\d+ [^\n]*---\n/

let lastGrow = 0

/** Poll the app log and feed newly completed writes into the app screen. */
function pollAppLog() {
  let text
  try {
    text = readFileSync(APP_LOG, 'utf8')
  } catch {
    return
  }
  if (text.length <= logOffset) {
    // Quiet file: the LAST write never gets a successor header, so flush a
    // pending body once the log has been still for a moment.
    if (logTail && Date.now() - lastGrow > 100 && SEG_RE.test(logTail)) {
      const head = SEG_RE.exec(logTail)
      const body = logTail.slice(head.index + head[0].length)
      logTail = ''
      // Strip the log wrapper's trailing newline — it is metadata, not bytes
      // the app wrote to the terminal.
      screen.feed(body.endsWith('\n') ? body.slice(0, -1) : body)
    }
    return
  }
  lastGrow = Date.now()
  const fresh = text.slice(logOffset)
  logOffset = text.length
  logTail += fresh
  for (;;) {
    const head = SEG_RE.exec(logTail)
    if (!head) break
    const bodyStart = head.index + head[0].length
    const next = SEG_RE.exec(logTail.slice(bodyStart))
    if (!next) break // body not complete yet
    const body = logTail.slice(bodyStart, bodyStart + next.index)
    logTail = logTail.slice(bodyStart + next.index)
    screen.feed(body.endsWith('\n') ? body.slice(0, -1) : body)
  }
}

// The kernel version and cwd are printed UP FRONT: a probe that silently
// drives a stale hoisted dsh (or the wrong workspace) is worse than a failure.
console.log(`probe: dsh ${dshVersion()} @ ${DSH_BIN}`)
console.log(`probe: cwd ${CWD} · ${COLS}x${ROWS}${DUMP ? ' · --dump' : ''}`)

const proc = pty.spawn(process.execPath, [DSH_BIN, '--profile', 'orca'], {
  name: 'xterm-256color',
  cols: COLS,
  rows: ROWS,
  cwd: CWD,
  env: {
    ...process.env,
    ORCA_LOG: APP_LOG,
    ...(process.argv.includes('--fullscreen') ? { ORCA_FULLSCREEN: '1' } : {}),
  },
})
proc.onData((data) => {
  conpty.feed(data)
  raw += data
})
proc.onExit(({ exitCode }) => {
  raw += `\n\n<<< PROCESS EXITED code=${exitCode} >>>`
})

const fail = (message) => {
  console.error(`probe 失败：${message}`)
  try {
    pollAppLog()
    writeFileSync(probePath('probe-last-screen.txt'), screen.plain())
    writeFileSync(probePath('probe-last-raw.log'), raw)
    console.error('最终屏幕已写入 probe-last-screen.txt；原始字节已写入 probe-last-raw.log')
  } catch {}
  try {
    proc.kill()
  } catch {}
  process.exit(1)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function markSettledSafe(timer) {
  timer.settled = true
  clearTimeout(timer)
}

function waitMarker(name, regex, timeoutMs = STEP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      pollAppLog()
      // Sealed rows sediment into scrollback within a tick — match against
      // the scrollback + viewport union, not the viewport alone.
      if (regex.test(screen.plainAll())) {
        clearInterval(timer)
        resolve()
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error(`等待「${name}」超时`))
      }
    }, 100)
  })
}

/**
 * Wait out the app's render tick, then poll twice: the first poll feeds
 * complete segments, the second (after a quiet window) flushes the LAST
 * write's body — it never gets a successor header in the log.
 */
async function settle(ms = 220) {
  await sleep(ms)
  pollAppLog()
  await sleep(160)
  pollAppLog()
}

/** Bottom-anchored input box check: exactly one editor line, cursor inside. */
function assertInputBox(step, expectedEditor = null) {
  pollAppLog()
  const lines = []
  for (let r = 0; r < ROWS; r++) lines.push(screen.text(r))
  const editorRows = []
  for (let r = 0; r < ROWS; r++) {
    if (/^│ > /.test(lines[r]) || (lines[r].startsWith('│ >') && expectedEditor === '')) editorRows.push(r)
  }
  // Placeholder variant: `│ > 说点什么…` also matches `│ > `.
  if (editorRows.length !== 1) {
    fail(`[${step}] 输入框内容行数量异常：${editorRows.length}（行号 ${editorRows.join(',')}）\n${screen.plain()}`)
  }
  const editorRow = editorRows[0]
  // Cursor must sit on the editor row, right of the text.
  if (screen.cy !== editorRow) {
    fail(`[${step}] 光标不在输入框行：cursor=(${screen.cy},${screen.cx}) editor 行=${editorRow}\n${screen.plain()}`)
  }
  // Empty editor: the caret belongs right after `> ` (0-based col 4). A far
  // right caret means the CHA park was lost in some terminal layer.
  if (expectedEditor === '' || expectedEditor === null) {
    if (screen.cx !== 4) {
      fail(`[${step}] 空输入框光标列异常：期望 col=4，实际 ${screen.cx}\n${screen.plain()}`)
    }
  }
  // The box bottom border must directly follow the editor content row — on
  // BOTH layers: the app's own frame and the ConPTY render the user sees.
  const below = lines[editorRow + 1] ?? ''
  if (!below.startsWith('╰')) {
    fail(`[${step}] 输入框底边框缺失：editor 行=${editorRow} 下一行=「${below.slice(0, 40)}」\n${screen.plain()}`)
  }
  const clines = []
  for (let r = 0; r < ROWS; r++) clines.push(conpty.text(r))
  const cEditorRows = []
  for (let r = 0; r < ROWS; r++) {
    if (/^│ > /.test(clines[r])) cEditorRows.push(r)
  }
  if (cEditorRows.length === 1) {
    const cBelow = clines[cEditorRows[0] + 1] ?? ''
    if (!cBelow.startsWith('╰')) {
      fail(
        `[${step}] ConPTY 层底边框缺失：editor 行=${cEditorRows[0]} 下一行=「${cBelow.slice(0, 40)}」\n` +
          `=== ConPTY 层 ===\n${conpty.plain()}`,
      )
    }
  } else {
    fail(`[${step}] ConPTY 层编辑行数量异常：${cEditorRows.length}\n=== ConPTY 层 ===\n${conpty.plain()}`)
  }
  if (expectedEditor !== null) {
    const raw = lines[editorRow] ?? ''
    const m = /^│ > (.*?) *│ *$/.exec(raw)
    const shown = m ? m[1] : raw.replace(/^│ > /, '').replace(/ *│ *$/, '').replace(/ +$/, '')
    if (expectedEditor !== '' && !shown.startsWith(expectedEditor)) {
      fail(`[${step}] 输入框内容不符：期望以「${expectedEditor}」开头，实际「${shown}」`)
    }
    if (expectedEditor === '' && shown !== '' && shown !== '说点什么...') {
      fail(`[${step}] 输入框应为空/占位符，实际「${shown}」`)
    }
  }
  if (DUMP) console.log(`--- ${step} (cursor=${screen.cy},${screen.cx}) ---\n${screen.plain()}\n`)
}

/** Fullscreen contract: the footer hint stays pinned to the LAST row on both
 *  layers — the regression guard for the "切完模型 UI 又往上走" complaint. */
function assertFooterPinned(step) {
  pollAppLog()
  const appLast = screen.text(ROWS - 1)
  if (!appLast.includes('Ctrl+C 退出')) {
    fail(`[${step}] fullscreen 页脚未钉在末行（app 层末行=「${appLast.slice(0, 40)}」）\n${screen.plain()}`)
  }
  const conptyLast = conpty.text(ROWS - 1)
  if (!conptyLast.includes('Ctrl+C 退出')) {
    fail(`[${step}] fullscreen 页脚未钉在末行（ConPTY 层末行=「${conptyLast.slice(0, 40)}」）\n=== ConPTY 层 ===\n${conpty.plain()}`)
  }
}

// ── fullscreen verification (--fullscreen): boots with ORCA_FULLSCREEN=1 ────
// The whole viewport is ours: the footer must stay pinned to the last row
// across the /model switch (the user-reported "UI 又往上走" regression) and
// the input box must keep its bottom border on both layers.
if (process.argv.includes('--fullscreen')) {
  const globalTimer = setTimeout(() => fail(`全局超时 ${GLOBAL_TIMEOUT_MS}ms`), GLOBAL_TIMEOUT_MS)
  try {
    await waitMarker('fullscreen 连接', /DeepSeek Harness 终端前端/)
    await waitMarker('fullscreen session', /session 已连接：session-[0-9a-f-]+/)
    await settle()
    assertInputBox('fullscreen 启动', '')
    assertFooterPinned('fullscreen 启动')
    proc.write('/model')
    await waitMarker('菜单出现', /切换模型/)
    proc.write('\r')
    await waitMarker('选择 Provider', /选择 Provider/)
    await settle()
    proc.write('\r')
    await waitMarker('选择模型', /选择模型（/)
    await settle(400)
    proc.write('\r')
    await waitMarker('选择思考强度', /选择思考强度（/)
    await waitMarker('思考档位加载完成', /默认（模型默认行为）/)
    await settle(120)
    proc.write('\r')
    await settle(200)
    await waitMarker('模型已切换', /模型已切换：/)
    await settle()
    assertFooterPinned('fullscreen 切模型后')
    assertInputBox('fullscreen 切模型后', '')
    markSettledSafe(globalTimer)
    try {
      writeFileSync(probePath('probe-last-raw.log'), raw)
    } catch {}
    proc.write('\x03')
    await sleep(500)
    try {
      proc.kill()
    } catch {}
    console.log('fullscreen probe 通过 ✔（页脚钉底 + 输入框完好贯穿模型切换）')
    process.exit(0)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

// ── feature verification (--features): one tiny real prompt that exercises ──
// the 0.1.5 attachment path (file block + /img) and the model-switch notice
// together. Costs one minimal API call — only run deliberately.
if (process.argv.includes('--features')) {
  const globalTimer = setTimeout(() => fail(`全局超时 ${GLOBAL_TIMEOUT_MS}ms`), GLOBAL_TIMEOUT_MS)
  try {
    await waitMarker('TUI 启动', /DeepSeek Harness 终端前端/)
    await waitMarker('session 已连接', /session 已连接：session-[0-9a-f-]+/)
    await settle()

    // 1) A non-image file goes through the NEW file path (saveFile → FileBlock)
    //    and shows its own inline token.
    const sample = probePath('probe-attach-sample.txt')
    writeFileSync(sample, 'orca probe attachment\n')
    proc.write(`/img ${sample}`)
    await settle()
    proc.write('\r')
    await waitMarker('文件附件徽标出现', /\[file #1\]/, 15_000)
    await settle()

    // 2) Switch to a DIFFERENT model: a real change must be announced to the
    //    model (the installModelSelection semantics Orca now implements).
    proc.write('/model')
    await waitMarker('菜单补全提示', /切换模型/)
    proc.write('\r')
    await waitMarker('选择 Provider', /选择 Provider/)
    await settle(300)
    proc.write('\r')
    await waitMarker('选择模型', /选择模型（/)
    await settle(500)
    proc.write('\x1b[B') // ↓ — pick a different model than the active one
    await settle(200)
    proc.write('\r')
    await waitMarker('选择思考强度', /选择思考强度（/)
    await waitMarker('思考档位加载完成', /默认（模型默认行为）/)
    await settle(150)
    proc.write('\r')
    await settle(250)
    await waitMarker('模型已切换', /模型已切换：/)
    await settle()

    // 3) The pending attachment MUST have survived the slash commands, and the
    //    turn must actually run with it (a rejected file block would surface as
    //    a turn failure row).
    if (!screen.plain().includes('[file #1]')) fail(`[切完模型] 附件 token 丢失\n${screen.plain()}`)
    assertInputBox('切完模型后（附件应仍在）', '[file #1]')
    proc.write('一句话说明这个附件')
    await settle()
    proc.write('\r')
    await waitMarker('回合运行中', /(思考中|执行工具)/, 60_000)
    await waitMarker('回合结束', /(✓ 本轮|已思考 \d)/, 120_000)
    await settle(600)
    assertInputBox('带附件回合结束后', '')
    const shown = screen.plainAll()
    if (!shown.includes('[file #1]')) fail(`[附件] user 行未投影 [file #1]\n${screen.plain()}`)

    markSettledSafe(globalTimer)
    try {
      writeFileSync(probePath('probe-last-raw.log'), raw)
    } catch {}
    proc.write('\x03')
    await sleep(500)
    try {
      proc.kill()
    } catch {}
    console.log('features probe 通过 ✔（文件附件通路 + 模型切换告知 + 附件跨命令存活）')
    process.exit(0)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

// ── state verification (--state): 工作区归属 + 会话记录的模型 ────────────────
// Two real boots against the orca profile, zero API calls:
//   A. a fresh session must be filed under the Workspace that owns this cwd
//      (`workspace.json`) — host-side membership is the only way the web
//      sidebar can group a TUI conversation instead of leaving it ungrouped —
//      and a `/model` pick must land in the session LOG as the durable
//      `model/selection` event the web host's `session.selectModel` appends;
//   B. a second process resuming that session under a DECOY composition
//      override (ORCA_PROVIDER/ORCA_MODEL) must still render the route the LOG
//      records — proof the session's own record outranks the composition
//      default instead of being re-asked every boot.
// Phase A's pick rewrites `agent-default-model` in settings.yaml (standing
// Orca behavior for a real pick, not a probe artifact): the file is
// snapshotted up front and restored byte-exactly once both boots are gone.
if (process.argv.includes('--state')) {
  const SETTINGS = `${DEFAULT_DSH_HOME}/settings.yaml`
  const WORKSPACES = `${DEFAULT_DSH_HOME}/storages/workspace.json`
  const APP_LOG2 = probePath('probe-orca-app2.log')
  const settingsSnapshot = readFileSync(SETTINGS)
  const stripAnsi = (text) => text.replace(/\x1b\[[0-9;?]*[@-~]/g, '').replace(/\x1b[\[\]][^\x07\x1b]*(\x07|\x1b\\)/g, '')
  const routeOf = (selection) =>
    `${selection.provider}/${selection.model}${selection.reasoningEffort ? `(${selection.reasoningEffort})` : ''}`
  /** The `agent-default-model` block of settings.yaml (the pre-probe default). */
  const defaultModelOf = (text) => {
    const block = /^agent-default-model:\n((?:[ \t]+.*\n?)*)/m.exec(text)?.[1]
    const provider = block && /provider:[ \t]*(\S+)/.exec(block)?.[1]
    const model = block && /model:[ \t]*(\S+)/.exec(block)?.[1]
    return provider && model ? { provider, model } : null
  }
  /** The workspace record owning the probe cwd, when the registry has one. */
  const workspaceRecord = () => {
    const data = JSON.parse(readFileSync(WORKSPACES, 'utf8'))
    const wanted = CWD.replaceAll('/', '\\').toLowerCase()
    return Object.values(data.tables.workspaces).find((record) => record.path.toLowerCase() === wanted)
  }
  const decoy = defaultModelOf(settingsSnapshot.toString('utf8'))
  const globalTimer = setTimeout(() => fail(`全局超时 ${GLOBAL_TIMEOUT_MS}ms`), GLOBAL_TIMEOUT_MS)
  let procB = null
  try {
    if (decoy === null) fail('settings.yaml 缺少 agent-default-model，构造不出诱饵路由')
    await waitMarker('TUI 启动', /DeepSeek Harness 终端前端/)
    await waitMarker('session 已连接', /session 已连接：session-[0-9a-f-]+/)
    await settle()
    const sessionId = /session 已连接：(session-[0-9a-f-]+)/.exec(screen.plainAll())?.[1]
    if (!sessionId) fail(`未从屏幕读到会话 id\n${screen.plain()}`)

    // 1) Workspace accounting — the attach is fire-and-forget after connect.
    const deadline = Date.now() + 8000
    let record = workspaceRecord()
    while (!(record?.sessionIds ?? []).includes(sessionId) && Date.now() < deadline) {
      await sleep(250)
      record = workspaceRecord()
    }
    if (!record) {
      fail(`当前 cwd 不是已登记工作区：${CWD}；注册表里有 ${JSON.stringify(Object.values(JSON.parse(readFileSync(WORKSPACES, 'utf8')).tables.workspaces).map((r) => r.path))}`)
    }
    if (!(record.sessionIds ?? []).includes(sessionId)) {
      fail(
        `会话未登记到工作区 ${record.path}（${sessionId}）：${JSON.stringify(record.sessionIds.slice(0, 6))}\n` +
          `账本当前更新戳：${JSON.stringify(Object.values(JSON.parse(readFileSync(WORKSPACES, 'utf8')).tables.workspaces).map((r) => [r.path, r.updatedAt]))}` +
          `\n若 web 进程在本 TUI 启动后写过工作区账本，TUI 会按漂移守卫拒绝写入（避免用旧快照覆盖）：重启 web 服务或本次 TUI 会话即可重试`,
      )
    }
    console.log(`工作区归属 ✔  ${record.path} ⊃ ${sessionId}`)

    // 2) A /model pick must become a DURABLE record: the same event the web
    //    host appends, in the session's own log. The pick must also DIFFER from
    //    the composition default, or the resume check below could not tell the
    //    two apart — so the picker flow is retried with a different cursor
    //    movement until it lands somewhere else (`↓` in a single-model provider
    //    or a single-effort model list cannot move at all).
    const pickRoute = async (providerDown, modelDown, effortDown) => {
      proc.write('/model')
      await waitMarker('菜单补全提示', /切换模型/)
      proc.write('\r')
      await waitMarker('选择 Provider', /选择 Provider/)
      await settle(300)
      if (providerDown > 0) {
        proc.write('\x1b[B'.repeat(providerDown))
        await settle(250)
      }
      proc.write('\r')
      await waitMarker('选择模型', /选择模型（/)
      await settle(500)
      if (modelDown > 0) {
        proc.write('\x1b[B'.repeat(modelDown))
        await settle(300)
      }
      proc.write('\r')
      await waitMarker('选择思考强度', /选择思考强度（/)
      await waitMarker('思考档位加载完成', /默认（模型默认行为）/)
      await settle(250)
      if (effortDown > 0) {
        proc.write('\x1b[B'.repeat(effortDown))
        await settle(250)
      }
      proc.write('\r')
      await settle(300)
      await waitMarker('模型已切换', /模型已切换：/)
      await settle()
      const path = findSessionLog(sessionId)
      if (!path) return null
      const last = readSessionEvents(path).filter((event) => event.type === 'model/selection').at(-1)
      return last ? routeOf(last.data) : null
    }
    const moves = [
      [0, 1, 0],
      [0, 2, 0],
      [1, 0, 0],
      [1, 1, 0],
      [2, 0, 0],
    ]
    const tried = []
    let picked = null
    for (const [providerDown, modelDown, effortDown] of moves) {
      picked = await pickRoute(providerDown, modelDown, effortDown)
      tried.push(picked)
      if (picked !== null && picked !== routeOf(decoy)) break
      console.log(`  选型重试（${providerDown}/${modelDown}/${effortDown} → ${picked ?? 'null'}）`)
    }
    if (picked === null) fail(`日志里没有 durable model/selection：/model 只改了内存与 settings`)
    if (picked === routeOf(decoy)) {
      fail(`候选选型都与 composition 默认相同（${JSON.stringify(tried)}），本次探针无法区分来源`)
    }
    console.log(`模型记录 ✔  日志落盘 model/selection=${picked}（composition 默认 ${routeOf(decoy)}）`)

    // Boot A must be GONE before boot B resumes the session: a live owner
    // holds the persistence lease.
    proc.write('\x03')
    const exitedBy = Date.now() + 10_000
    while (!raw.includes('<<< PROCESS EXITED') && Date.now() < exitedBy) await sleep(200)
    if (!raw.includes('<<< PROCESS EXITED')) fail('首启进程未在 10s 内退出')
    await sleep(500)

    // 3) Resume under a decoy override: the LOG's route must win.
    try {
      writeFileSync(APP_LOG2, '')
    } catch {}
    procB = pty.spawn(process.execPath, [DSH_BIN, '--profile', 'orca'], {
      name: 'xterm-256color',
      cols: COLS,
      rows: ROWS,
      cwd: CWD,
      env: {
        ...process.env,
        ORCA_LOG: APP_LOG2,
        ORCA_RESUME_SESSION: sessionId,
        ORCA_PROVIDER: decoy.provider,
        ORCA_MODEL: decoy.model,
      },
    })
    let exitedB = false
    procB.onExit(() => {
      exitedB = true
    })
    const resumedDeadline = Date.now() + 30_000
    let appText = ''
    for (;;) {
      try {
        appText = stripAnsi(readFileSync(APP_LOG2, 'utf8'))
      } catch {
        appText = ''
      }
      if (appText.includes(`↳ 模型 ${picked}`)) break
      if (Date.now() > resumedDeadline) {
        fail(`恢复会话未沿用日志里的路由 ${picked}\n${appText.slice(-800)}`)
      }
      await sleep(200)
    }
    if (appText.includes(`↳ 模型 ${routeOf(decoy)}`)) {
      fail(`恢复会话用了 composition 覆盖（${routeOf(decoy)}）而不是日志记录`)
    }
    console.log(`模型记忆 ✔  恢复会话渲染 ${picked}，未采用诱饵 ${routeOf(decoy)}`)

    // Every boot ends the way a user ends it (Ctrl+C → disposer → exit), so no
    // half-killed ConPTY child outlives the probe and keeps this pipeline open.
    procB.write('\x03')
    const byB = Date.now() + 10_000
    while (!exitedB && Date.now() < byB) await sleep(200)
    if (!exitedB) fail('恢复进程未在 10s 内退出')
    await sleep(400)
    markSettledSafe(globalTimer)
    try {
      writeFileSync(probePath('probe-last-raw.log'), raw)
    } catch {}
    writeFileSync(SETTINGS, settingsSnapshot)
    console.log('state probe 通过 ✔（工作区归属 + durable 模型记录 + 恢复沿用）')
    process.exit(0)
  } catch (error) {
    try {
      procB?.kill()
    } catch {}
    try {
      proc.kill()
    } catch {}
    writeFileSync(SETTINGS, settingsSnapshot)
    fail(error instanceof Error ? error.message : String(error))
  }
}

// ── live-turn verification (--live): one tiny real prompt, streaming + ──────
// thinking collapse/expand checked against the app-truth screen. Costs one
// minimal API call — only run deliberately.
if (process.argv.includes('--live')) {
  const globalTimer = setTimeout(() => fail(`全局超时 ${GLOBAL_TIMEOUT_MS}ms`), GLOBAL_TIMEOUT_MS)
  try {
    await waitMarker('TUI 启动', /DeepSeek Harness 终端前端/)
    await waitMarker('session 已连接', /session 已连接：session-[0-9a-f-]+/)
    await settle()

    proc.write('用一句话说明你是谁')
    await settle()
    proc.write('\r') // submit the turn
    // Streaming phase: the footer badge must show live state, and either a
    // thinking spinner or an assistant row must appear while the turn runs.
    await waitMarker('回合运行中（思考徽标或助手行）', /(思考中|执行工具)/, 60_000)
    // Wait for the turn to end: the sealed thought line or the assistant
    // bullet row shows up in the transcript, then the editor is back.
    await waitMarker('回合结束（已思考或助手内容）', /(已思考 \d|●)/, 120_000)
    await settle(600)
    assertInputBox('回合结束后', '')

    // Thinking expand (Ctrl+O = \x0f): if a sealed thought line is present,
    // toggling must reveal the ✻ expanded header, toggling again collapses.
    const hadThought = screen.plain().includes('已思考 ')
    if (hadThought) {
      proc.write('\x0f')
      await settle()
      if (!screen.plain().includes('思考过程')) fail('[Ctrl+O 展开] 展开后未出现「思考过程」头部')
      proc.write('\x0f')
      await settle()
      if (!screen.plain().includes('已思考 ')) fail('[Ctrl+O 折叠] 再次切换后未恢复「已思考」行')
      console.log('思考折叠/展开 ✔（Ctrl+O 两个方向）')
    } else {
      console.log('（本回合无思考行，跳过折叠断言）')
    }
    assertInputBox('切换后输入框完好', '')

    markSettledSafe(globalTimer)
    proc.write('\x03')
    await sleep(500)
    try {
      proc.kill()
    } catch {}
    console.log('live probe 通过 ✔（流式渲染 + 回合收尾 + 输入框完好）')
    process.exit(0)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

try {
  const globalTimer = setTimeout(() => {
    if (!globalTimer.settled) fail(`全局超时 ${GLOBAL_TIMEOUT_MS}ms`)
  }, GLOBAL_TIMEOUT_MS)
  const markSettled = () => {
    globalTimer.settled = true
    clearTimeout(globalTimer)
  }

  await waitMarker('TUI 启动', /DeepSeek Harness 终端前端/)
  await waitMarker('session 已连接', /session 已连接：session-[0-9a-f-]+/)
  await settle()
  assertInputBox('启动')
  // 欢迎卡回归门：字节流 marker 只能证明画过（33ms 闪存也会过），屏状态才证明看得见。
  if (!screen.plain().includes('✦ orca')) fail(`[启动] 欢迎卡不在屏上\n${screen.plain()}`)

  // ── step 1: `/` menu shows and dismisses without breaking the editor ──
  proc.write('/')
  await waitMarker('/ 菜单出现', /命令/)
  await settle()
  assertInputBox('输入 /', '/')
  proc.write('\x1b[B') // ↓ cycle menu
  await sleep(150)
  proc.write('\x1b') // Esc dismiss menu (also clears editor)
  await settle()
  assertInputBox('Esc 关菜单后', '')

  // ── step 2: /model picker full flow ──
  proc.write('/model')
  await waitMarker('菜单补全提示', /切换模型/)
  proc.write('\r')
  await waitMarker('选择 Provider', /选择 Provider/)
  await settle()
  // Pick the provider of the live route (first listed usually) — just take item 1.
  proc.write('\r')
  await waitMarker('选择模型', /选择模型（/)
  await settle(400)
  proc.write('\r') // first model
  await waitMarker('选择思考强度', /选择思考强度（/)
  await waitMarker('思考档位加载完成', /默认（模型默认行为）/)
  await settle(120)
  proc.write('\r') // 默认
  await settle(200)
  await waitMarker('模型已切换', /模型已切换：/)
  await settle()
  assertInputBox('模型切换完成后', '')
  // 欢迎卡回归门（本轮报告）：switch 后卡必须还在屏上（常驻置顶 + 自然溢出）。
  if (!screen.plain().includes('✦ orca')) fail(`[模型切换完成后] 欢迎卡不在屏上\n${screen.plain()}`)

  // ── step 3: reopen the / menu mid-conversation, then Esc ──
  proc.write('/')
  await waitMarker('/ 菜单再次出现', /命令/)
  await settle()
  assertInputBox('对话后输入 /', '/')
  proc.write('\x1b')
  await settle()
  assertInputBox('二次 Esc 后', '')

  // ── step 3b: the menu must ALSO list kernel-registered commands ──
  // `/goal` comes from @deepseek-ai/dsh-command-goal (dsh-base bundle) and is
  // not in Orca's own table — seeing it proves the discovery seam works
  // against the live kernel.
  proc.write('/go')
  await waitMarker('内核命令出现在菜单', /\/goal/)
  await settle()
  assertInputBox('输入 /go', '/go')
  proc.write('\x1b')
  await settle()
  assertInputBox('内核命令菜单关闭后', '')

  // ── step 4: CJK typing keeps the cursor math honest ──
  proc.write('你好orca')
  await settle()
  assertInputBox('中文输入', '你好orca')
  proc.write('\x1b') // clear editor
  await settle()
  assertInputBox('清空后', '')

  // ── step 5: reopen /model, abort mid-flow with Esc, editor must recover ──
  proc.write('/model\r')
  await waitMarker('选择 Provider 2', /选择 Provider/)
  await settle(300)
  proc.write('\x1b')
  await settle()
  assertInputBox('picker 中途 Esc', '')

  markSettled()
  try {
    writeFileSync(probePath('probe-last-raw.log'), raw)
  } catch {}
  proc.write('\x03')
  await sleep(500)
  try {
    proc.kill()
  } catch {}
  console.log('probe 通过 ✔（输入框在菜单/模型切换全流程后保持正确）')
  process.exit(0)
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
