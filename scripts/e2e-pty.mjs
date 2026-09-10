/**
 * PTY end-to-end test: boots the REAL orca profile in a real ConPTY terminal
 * and drives the M2a surface with real keystrokes — TUI boot, route header,
 * the full /model picker flow over real kernel services, clean Ctrl+C exit.
 *
 * Composition-agnostic: the provider/model pair is parsed from the live
 * header instead of hardcoded, and the picker selects items by matching the
 * route's own provider/model ids.
 *
 * Zero API cost by design: no prompt is submitted; streaming over a live
 * model turn remains the human acceptance step (already verified in M1).
 *
 * node-pty is resolved from the installed dsh package (it ships with the
 * kernel); this script never modifies the kernel.
 *
 * Usage: node scripts/e2e-pty.mjs   (exit 0 = pass, 1 = fail)
 */

import { writeFileSync } from 'node:fs'
import { dshBinPath, dshVersion, probeCwd, probePath, requireFromDsh } from './paths.mjs'

const DSH_BIN = dshBinPath()
const CWD = probeCwd()
const STEP_TIMEOUT_MS = 30_000
const GLOBAL_TIMEOUT_MS = 120_000

const pty = requireFromDsh('node-pty')

const stripAnsi = (text) => text.replaceAll(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replaceAll(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')

const markersSeen = []
let buffer = ''
let settled = false

console.log(`e2e: dsh ${dshVersion()} · cwd ${CWD}`)

const proc = pty.spawn(process.execPath, [DSH_BIN, '--profile', 'orca'], {
  name: 'xterm-256color',
  cols: 110,
  rows: 45,
  cwd: CWD,
  env: process.env,
})

proc.onData((data) => {
  buffer += data
})

const fail = (message) => {
  console.error(`e2e 失败：${message}（buffer=${buffer.length} chars）`)
  try {
    const file = probePath('e2e-last-buffer.log')
    writeFileSync(file, buffer)
    console.error(`完整缓冲已写入 ${file}`)
  } catch (error) {
    console.error(`缓冲落盘失败：${error.message}`)
  }
  try {
    proc.kill()
  } catch {}
  process.exit(1)
}

/** Resolve once the marker appears in the captured stream; reject on timeout. */
function waitMarker(name, regex, timeoutMs = STEP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (regex.test(buffer)) {
      markersSeen.push(name)
      resolve()
      return
    }
    const started = Date.now()
    const timer = setInterval(() => {
      if (regex.test(buffer)) {
        clearInterval(timer)
        markersSeen.push(`${name}@${buffer.length}`)
        resolve()
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error(`等待「${name}」超时（${timeoutMs}ms，buffer=${buffer.length}）`))
      }
    }, 100)
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Select the picker item whose visible line contains `needle`: locate the
 * picker screen by its `title` row (the M2c picker uses flat `─` borders),
 * count the item rows before the target and press ↓ that many times, then
 * Enter. Matching is normalized (ids like `gpt-5.6-sol` match display names
 * like "GPT-5.6 Sol").
 */
function pickItemContaining(title, needle) {
  const normalize = (text) => text.toLowerCase().replaceAll(' ', '-')
  const target = normalize(needle)
  const plain = stripAnsi(buffer)
  const region = plain.slice(plain.lastIndexOf(title))
  const lines = region.split('\r\n').map((line) => line.trim())
  const titleIndex = lines.findIndex((line) => line.includes(title))
  if (titleIndex < 0) throw new Error(`picker 未在屏上：找不到标题行「${title}」`)
  // Item region: after the title/hint/blank header, until the flat bottom border.
  let itemStart = titleIndex + 1
  while (itemStart < lines.length && (lines[itemStart] === '' || lines[itemStart].includes('↑/↓') || lines[itemStart].includes('▲'))) itemStart++
  let itemEnd = itemStart
  while (itemEnd < lines.length && !lines[itemEnd].startsWith('─') && !lines[itemEnd].includes('▼')) itemEnd++
  const itemLines = lines.slice(itemStart, itemEnd)
  const itemIndex = itemLines.findIndex((line) => normalize(line).includes(target))
  if (itemIndex < 0) throw new Error(`picker 中找不到包含「${needle}」的项（可见项：${itemLines.join(' | ')}）`)
  for (let i = 0; i < itemIndex; i++) proc.write('\x1b[B')
  proc.write('\r')
}

const globalTimer = setTimeout(() => {
  if (!settled) fail(`全局超时 ${GLOBAL_TIMEOUT_MS}ms`)
}, GLOBAL_TIMEOUT_MS)

try {
  await waitMarker('TUI 启动（欢迎区）', /DeepSeek Harness 终端前端/)
  await waitMarker('session 已连接', /session 已连接：session-[0-9a-f-]+/)

  // Parse the live route from the slim route line — never hardcode the
  // composition default.
  await sleep(300)
  const routeMatch = /↳ 模型 ([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)/.exec(stripAnsi(buffer))
  if (!routeMatch) fail(`未解析出路由行：${stripAnsi(buffer).slice(-300)}`)
  const provider = routeMatch[1]
  const model = routeMatch[2]
  markersSeen.push(`路由 ${provider}/${model}`)

  // /model picker over real kernel services: provider → model → 默认 effort.
  proc.write('/model\r')
  await waitMarker('选择 Provider', /选择 Provider/)
  await sleep(500)
  pickItemContaining('选择 Provider', provider)
  await waitMarker('选择模型', new RegExp(`选择模型（${provider}）`))
  await sleep(800)
  pickItemContaining(`选择模型（${provider}）`, model)
  await waitMarker('选择思考强度', /选择思考强度（/)
  await waitMarker('思考档位加载完成', /默认（模型默认行为）/)
  proc.write('\r') // 默认（模型默认行为）— first item, cursor already there
  await sleep(300)
  await waitMarker('模型已切换', new RegExp(`模型已切换：${provider}/${model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))

  proc.write('\x03') // Ctrl+C — clean teardown
  await sleep(500)
  console.log(`e2e 通过 ✔（${markersSeen.join(' → ')}；零 API 消耗）`)
  settled = true
  clearTimeout(globalTimer)
  try {
    proc.kill()
  } catch {}
  process.exit(0)
} catch (error) {
  clearTimeout(globalTimer)
  settled = true
  fail(error instanceof Error ? error.message : String(error))
}
