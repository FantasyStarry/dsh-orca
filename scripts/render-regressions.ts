import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'

import { Channel, type TranscriptRow } from '../src/adapter/channel.js'
import { buildFrame, type FrameContext } from '../src/tui/chat.js'
import { cleanText } from '../src/tui/sanitize.js'
import { stringWidth, wrapWidth } from '../src/tui/width.js'

function context(channel: Channel, overrides: Partial<FrameContext> = {}): FrameContext {
  return {
    channel,
    sealedFrom: 0,
    editorText: '',
    width: 80,
    height: 24,
    cwd: 'C:\\work',
    sessionId: 'session-test',
    route: null,
    usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, messages: 0 },
    now: 1_000,
    picker: null,
    fullscreen: true,
    ...overrides,
  }
}

function visible(lines: readonly string[]): string {
  return cleanText(lines.join('\n'))
}

// External data becomes plain text before Orca adds its own SGR. Complete
// sequences preserve following text; unterminated strings consume the tail.
assert.equal(cleanText('a\x1b[31mred\x1b[0mz'), 'aredz')
assert.equal(cleanText('a\x1b]52;c;secret\x07z'), 'az')
assert.equal(cleanText('a\x1bPpayload\x1b\\z'), 'az')
assert.equal(cleanText('a\u009b2Jz'), 'az')
assert.equal(cleanText('a\u009dtitle\u009cz'), 'az')
assert.equal(cleanText('safe\x1b[31'), 'safe')
assert.equal(cleanText('safe\x1b]52;c;payload'), 'safe')
assert.equal(cleanText('a\r\b\tb\nline'), 'a b\nline')

const wrapped = wrapWidth('a abcdefghij', 5)
assert.deepEqual(wrapped, ['a ', 'abcde', 'fghij'])
assert.ok(wrapped.every((line) => stringWidth(line) <= 5))
assert.equal(wrapped.join('').replaceAll(' ', ''), 'aabcdefghij')

const hostile = new Channel()
hostile.rows.push(
  { id: 1, kind: 'user', text: 'user\x1b[2J still', seq: 1 },
  { id: 2, kind: 'assistant', text: 'answer\x1b]0;owned\x07 suffix', seq: 2 },
  { id: 3, kind: 'tool', tool: 'tool\x1bPbad\x1b\\', text: 'result\u009b2J ok', status: 'ok', seq: 3 },
  { id: 4, kind: 'system', text: 'partial\x1b]52;c;payload', seq: 4 },
)
hostile.sealedRowCount = hostile.rows.length
const hostileFrame = buildFrame(context(hostile, {
  editorText: 'edit\x1b[31m red',
  attachments: ['image\x1b]0;bad\x07.png'],
  route: { provider: 'provider\x1b[2J', model: 'model\x1b]0;x\x07' },
  title: 'title\x1bPbad\x1b\\',
}))
const hostileOutput = [...hostileFrame.stream, ...hostileFrame.live].join('\n')
assert.ok(!hostileOutput.includes('\x1b[2J'))
assert.ok(!hostileOutput.includes('\x1b]'))
assert.ok(!hostileOutput.includes('\x1bP'))
assert.ok(!hostileOutput.includes('\u009b'))
assert.match(visible(hostileFrame.live), /answer suffix/)
assert.doesNotMatch(visible(hostileFrame.live), /owned|secret|payload/)

const cursorChannel = new Channel()
const cursorFrame = buildFrame(context(cursorChannel, {
  editorText: 'hello',
  editorCursor: 2,
  attachments: ['first.png', 'second.png'],
}))
assert.equal(cursorFrame.live.length, 24)
assert.equal(cursorFrame.cursor.fromEnd, 3)
assert.equal(cursorFrame.cursor.col, 10)
const cursorRow = cursorFrame.live.length - 1 - cursorFrame.cursor.fromEnd
assert.match(visible([cursorFrame.live[cursorRow] ?? '']), /> he/)

// A long line SOFT-WRAPS inside the editor box instead of being truncated at
// the frame edge, and the caret stays inside the box.
const narrowCursor = buildFrame(context(cursorChannel, { editorText: 'x'.repeat(200), width: 20 }))
assert.equal(narrowCursor.cursor.col, 9) // 200 = 14×14 + 4 → caret after 4 cells
assert.match(visible([narrowCursor.live[narrowCursor.live.length - 1 - narrowCursor.cursor.fromEnd] ?? '']), /│ {3}xxxx/)

// Multi-line editor: a newline splits the box, the box grows by one row per
// line, and the caret parks inside the box (reverse video carries the real
// cursor position — see inputBox).
const multiFrame = buildFrame(context(cursorChannel, {
  editorText: 'alpha\nbravo',
  editorCursor: 8, // inside "bravo"
  fullscreen: false,
}))
const multiVisible = visible(multiFrame.live).split('\n').map((line) => line.replace(/\s+$/, ''))
const firstLine = multiVisible.findIndex((line) => line.includes('> alpha'))
assert.ok(firstLine > 0, '第一条编辑行应在框内')
assert.ok(multiVisible[firstLine + 1]?.includes('bravo'), '第二条编辑行紧随其后')
const caretLine = multiFrame.live.length - 1 - multiFrame.cursor.fromEnd
assert.equal(caretLine, firstLine + 1, '光标行应落在最后一条编辑行')
assert.ok(multiFrame.cursor.col >= 5 && multiFrame.cursor.col <= 19, `caret col=${multiFrame.cursor.col} 应落在框内`)

// The window caps the box height and says how much is hidden.
const tallFrame = buildFrame(context(cursorChannel, {
  editorText: Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n'),
  fullscreen: false,
}))
const tallVisible = visible(tallFrame.live)
assert.match(tallVisible, /↑ \d+ 行/, '折叠时应在底边提示上方还有多少行')
assert.ok(tallVisible.split('\n').length <= 24)

// Multi-line + CJK: the editor soft-wraps by CELLS (a 2-cell glyph never
// straddles the wrap point) and an inline attachment token still renders.
const cjkEditor = buildFrame(context(cursorChannel, {
  editorText: '中文中文中文',
  editorCursor: 6,
  fullscreen: false,
  width: 24,
}))
const cjkRows = visible(cjkEditor.live).split('\n').filter((line) => line.includes('│'))
assert.ok(cjkRows.some((line) => line.includes('中文')), '中文应正常渲染')
for (const line of cjkRows) {
  assert.ok(stringWidth(line) <= 24, `编辑框行不得超宽：${stringWidth(line)}`)
}

// Fullscreen scroll: the window is anchored ABSOLUTELY, so new output below
// must not drag a pinned reading position.
const longChannel = new Channel()
for (let i = 0; i < 40; i++) longChannel.pushUser(`第 ${i} 行`)
longChannel.sealedRowCount = longChannel.rows.length
const tailFrame = buildFrame(context(longChannel, { fullscreen: true, height: 20 }))
assert.ok(tailFrame.windowMaxTop > 0, '40 行内容在 20 行屏上必须溢出')
assert.equal(tailFrame.windowTop, tailFrame.windowMaxTop, '默认跟随实时尾部')
assert.match(visible(tailFrame.live), /上方还有 \d+ 行/)
assert.equal(tailFrame.live.length, 20, 'fullscreen 帧必须恰好填满屏高')

const pinned = tailFrame.windowTop - 4
const scrolledFrame = buildFrame(context(longChannel, { fullscreen: true, height: 20, scrollTop: pinned }))
assert.equal(scrolledFrame.windowTop, pinned)
assert.match(visible(scrolledFrame.live), /下方 \d+ 行/, '上滚后应提示下方还有多少行')
assert.equal(scrolledFrame.live.length, 20)

longChannel.pushUser('新的一行')
longChannel.sealedRowCount = longChannel.rows.length
const afterGrowth = buildFrame(context(longChannel, { fullscreen: true, height: 20, scrollTop: pinned }))
assert.equal(afterGrowth.windowTop, pinned, '新内容不得拖动已钉住的阅读位置')
assert.ok(afterGrowth.windowMaxTop > tailFrame.windowMaxTop, '新增内容应扩大可滚动范围')

// A scrollTop past the end clamps instead of rendering an empty window.
const clamped = buildFrame(context(longChannel, { fullscreen: true, height: 20, scrollTop: 9_999 }))
assert.equal(clamped.windowTop, clamped.windowMaxTop)
assert.equal(clamped.live.length, 20)

// The open row changes in place without touching seq. The next frame must
// invalidate that row while reusing the immutable prefix.
const mutable = new Channel()
mutable.rows.push({ id: 1, kind: 'system', text: 'sealed', seq: 1 })
const open: TranscriptRow = { id: 2, kind: 'assistant', text: 'first', seq: 2 }
mutable.rows.push(open)
mutable.sealedRowCount = 1
buildFrame(context(mutable))
open.text = 'first suffix'
const changed = buildFrame(context(mutable))
assert.match(visible(changed.live), /first suffix/)
mutable.rows.splice(0, mutable.rows.length, { id: 3, kind: 'system', text: 'new session projection', seq: 3 })
mutable.sealedRowCount = 1
const reset = buildFrame(context(mutable))
assert.match(visible(reset.live), /new session projection/)
assert.doesNotMatch(visible(reset.live), /first suffix/)

// Benchmark the path that previously formatted and flattened every historical
// row per tick. The warm frame should only inspect the live boundary and copy
// the visible tail; keep the threshold loose enough for shared CI machines.
const history = new Channel()
for (let i = 0; i < 4_000; i++) {
  history.rows.push({
    id: i + 1,
    kind: 'assistant',
    text: `**row ${i}** with a long markdown body and inline \`code\` for wrapping`,
    seq: i + 1,
  })
}
history.sealedRowCount = history.rows.length
const historyContext = context(history)
const coldStart = performance.now()
const coldFrame = buildFrame(historyContext)
const coldMs = performance.now() - coldStart
const warmStart = performance.now()
const warmFrame = buildFrame(historyContext)
const warmMs = performance.now() - warmStart
assert.deepEqual(warmFrame, coldFrame)
assert.ok(warmMs < coldMs * 0.5, `cached frame ${warmMs.toFixed(2)}ms vs cold ${coldMs.toFixed(2)}ms`)

process.stderr.write(`render regressions passed; fullscreen cache cold=${coldMs.toFixed(2)}ms warm=${warmMs.toFixed(2)}ms\n`)
