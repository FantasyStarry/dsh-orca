/**
 * Selection geometry tests — the alt-screen copy path is pure but fiddly:
 * mouse coordinates are terminal CELLS, frame lines carry SGR, and a wrong
 * mapping silently copies the wrong characters. Everything here runs without
 * a terminal.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { paintSelection, selectionText, normalizeSelection, type Selection } from '../src/tui/selection.js'
import { fileUrlToPath } from '../src/app.js'
import { readClipboard } from '../src/clipboard.js'

const sel = (ar: number, ac: number, fr: number, fc: number): Selection => ({
  anchor: { row: ar, col: ac },
  focus: { row: fr, col: fc },
})

test('normalizeSelection orders any drag direction', () => {
  assert.deepEqual(normalizeSelection(sel(1, 5, 1, 2)).start, { row: 1, col: 2 })
  assert.deepEqual(normalizeSelection(sel(3, 2, 1, 9)).end, { row: 3, col: 2 })
  assert.deepEqual(normalizeSelection(sel(2, 4, 2, 4)).start, { row: 2, col: 4 })
})

test('selectionText maps 1-based cell columns onto plain text', () => {
  const lines = ['hello world', 'second line']
  assert.equal(selectionText(lines, sel(1, 1, 1, 5)), 'hello')
  assert.equal(selectionText(lines, sel(1, 7, 1, 11)), 'world')
  // Multi-row: first row runs to its end (col 9 = 'r'), the last stops at the
  // focus cell (col 6 = 'd' of "second").
  assert.equal(selectionText(lines, sel(1, 9, 2, 6)), 'rld\nsecond')
  // A right-to-left drag copies in reading order.
  assert.equal(selectionText(lines, sel(1, 5, 1, 1)), 'hello')
  assert.equal(selectionText(lines, null), '')
})

test('SGR sequences never count as characters', () => {
  const painted = ['\x1b[38;2;1;2;3mabc\x1b[39m\x1b[7mD\x1b[27mef']
  assert.equal(selectionText(painted, sel(1, 1, 1, 3)), 'abc')
  // The painted cell is the 4th: the escape bytes must not shift it.
  assert.equal(selectionText(painted, sel(1, 4, 1, 4)), 'D')
  assert.equal(selectionText(painted, sel(1, 1, 1, 6)), 'abcDef', '带 SGR 的行走字不受转义字节影响')
})

test('wide clusters occupy two cells and copy as one character', () => {
  const lines = ['中文abc']
  assert.equal(selectionText(lines, sel(1, 1, 1, 2)), '中')
  assert.equal(selectionText(lines, sel(1, 3, 1, 4)), '文')
  // Selecting the tail of a wide cluster still yields the whole cluster.
  assert.equal(selectionText(lines, sel(1, 2, 1, 2)), '中')
  assert.equal(selectionText(lines, sel(1, 1, 1, 5)), '中文a')
})

test('trailing blanks are trimmed per row, interior text is not', () => {
  const lines = ['ab        ', '          ']
  assert.equal(selectionText(lines, sel(1, 1, 2, 10)), 'ab', '末尾空白行不应粘进正文')
  assert.equal(selectionText(['a   b'], sel(1, 1, 1, 5)), 'a   b')
})

test('paintSelection wraps only the selected cells and keeps the width', () => {
  const lines = ['abcdef', 'ghijkl']
  const painted = paintSelection(lines, sel(1, 2, 1, 4), (t) => `[${t}]`)
  assert.equal(painted[0], 'a[b][c][d]ef')
  assert.equal(painted[1], 'ghijkl', '选区外的行原样返回')
  // The paint inserts escapes only — the visible width is unchanged.
  assert.equal(selectionText(painted, null).length > 0, false)
  assert.equal(paintSelection(lines, null, (t) => `[${t}]`)[0], 'abcdef')
})

test('paintSelection respects existing SGR inside the line', () => {
  const lines = ['\x1b[31mab\x1b[39mcd']
  const painted = paintSelection(lines, sel(1, 2, 1, 3), (t) => `{${t}}`)
  // The red run keeps its own escape; the wrap lands exactly on b and c.
  assert.equal(painted[0], '\x1b[31ma{b}\x1b[39m{c}d')
})

test('file URLs become filesystem paths (clipboard `text/uri-list`)', () => {
  assert.equal(fileUrlToPath('file:///C:/pics/a.png'), 'C:/pics/a.png')
  assert.equal(fileUrlToPath('file:///home/u/my%20pic.png'), '/home/u/my pic.png')
  assert.equal(fileUrlToPath('file:///home/u/图.png'), '/home/u/图.png')
  assert.equal(fileUrlToPath('C:/pics/a.png'), null)
  assert.equal(fileUrlToPath('file://server/share/a.png'), 'server/share/a.png')
})

test('clipboard reads degrade to a notice instead of throwing', async () => {
  // A platform with no helper binary must answer `unavailable` (never throw,
  // never hang past the timeout) — the TUI prints the message as a system row.
  const linux = await readClipboard({ platform: 'linux', timeoutMs: 5_000 })
  assert.ok(['unavailable', 'none', 'text', 'image'].includes(linux.kind))
  if (linux.kind === 'unavailable') assert.match(linux.message, /wl-clipboard|xclip/)
  const darwin = await readClipboard({ platform: 'darwin', timeoutMs: 5_000 })
  assert.ok(['unavailable', 'none', 'text', 'image'].includes(darwin.kind))
  const other = await readClipboard({ platform: 'aix', timeoutMs: 1_000 })
  assert.equal(other.kind, 'unavailable')
})
