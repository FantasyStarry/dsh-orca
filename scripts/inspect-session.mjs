/**
 * Diagnostic: decompress one persisted session log (`.jsonl.zstd`, format v3)
 * and report the facts a probe needs to assert — the injected model-switch
 * notice and any `file` content blocks.
 *
 * Usage: node scripts/inspect-session.mjs <path-to-session.v3.jsonl.zstd>
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** zstd frame magic (`0xFD2FB528` little-endian). */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Decompress a whole `.jsonl.zstd` log. The kernel appends CONCATENATED zstd
 * frames (header, then data), and Node's zstd decoder stops at the first
 * frame — so locate each frame by its magic and decode the slices
 * independently, merging a slice with the next when the magic was a false
 * positive inside a payload.
 */
function decompressFrames(buffer) {
  const starts = []
  for (let i = 0; i + 4 <= buffer.length; i++) {
    if (buffer.compare(MAGIC, 0, 4, i, i + 4) === 0) starts.push(i)
  }
  if (starts[0] !== 0) starts.unshift(0)
  const parts = []
  for (let index = 0; index < starts.length; index++) {
    let ok = null
    for (let end = index + 1; end <= starts.length; end++) {
      const slice = buffer.subarray(starts[index], end < starts.length ? starts[end] : buffer.length)
      try {
        ok = zstdDecompressSync(slice)
        index = end - 1
        break
      } catch {
        // A false-positive magic inside a payload: extend the slice.
      }
    }
    if (ok !== null) parts.push(ok)
  }
  return Buffer.concat(parts).toString('utf8')
}

const SESSIONS = 'C:/Users/Mayn/.dsh/sessions/--C-Users-Mayn-Desktop-dsh-orca--'

/** Newest persisted log under the orca session root (recursive). */
function newestLog(dir) {
  let best = null
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = newestLog(full)
      if (nested && (!best || nested.mtime > best.mtime)) best = nested
      continue
    }
    if (!entry.name.endsWith('.zstd')) continue
    const mtime = statSync(full).mtimeMs
    if (!best || mtime > best.mtime) best = { path: full, mtime }
  }
  return best
}

const target = process.argv[2] ?? newestLog(SESSIONS)?.path
if (!target) {
  console.error('no session log found')
  process.exit(1)
}
console.log(`log: ${target}`)

const events = decompressFrames(readFileSync(target))
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line))
console.log(`events: ${events.length}`)

const notices = events.filter(
  (event) =>
    event.type === 'user/message' &&
    Array.isArray(event.data?.content) &&
    event.data.content.some((block) => block.type === 'text' && block.text.includes('[orca] The active model')),
)
console.log(`model-switch notices: ${notices.length}`)
for (const notice of notices) {
  console.log(`  source=${JSON.stringify(notice.data.source)} text=${JSON.stringify(notice.data.content[0].text)}`)
}

const fileMessages = events.filter(
  (event) => event.type === 'user/message' && event.data?.content?.some((block) => block.type === 'file'),
)
console.log(`user messages carrying a file block: ${fileMessages.length}`)
for (const message of fileMessages) {
  const file = message.data.content.find((block) => block.type === 'file')
  console.log(`  source=${JSON.stringify(message.data.source)} file=${JSON.stringify(file.attachment)}`)
}

const types = new Map()
for (const event of events) types.set(event.type, (types.get(event.type) ?? 0) + 1)
console.log('event vocabulary:', [...types].map(([type, count]) => `${type}×${count}`).join(', '))
