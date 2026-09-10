/**
 * Persisted session-log reader shared by the diagnostics scripts.
 *
 * A session log is `<DSH_HOME>/sessions/<cwd-key>/<session-id>/session.v3.jsonl.zstd`
 * written as a v3 JSONL document, and the kernel appends CONCATENATED zstd
 * frames to it (a header frame, then one frame per flush). Node's zstd decoder
 * stops at the first frame, so the file is split by frame magic and each slice
 * decoded on its own.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { DSH_HOME } from './paths.mjs'

/** zstd frame magic (`0xFD2FB528` little-endian). */
export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** The default DSH home the probes read (`DSH_HOME` wins; never a user name). */
export const DEFAULT_DSH_HOME = DSH_HOME

/**
 * Decompress a whole `.jsonl.zstd` log. A slice whose first bytes are a
 * false-positive magic inside a payload is merged with the next one.
 * @param {Buffer} buffer - the complete file contents.
 * @returns {string} the decoded JSONL text.
 */
export function decompressFrames(buffer) {
  const starts = []
  for (let i = 0; i + 4 <= buffer.length; i++) {
    if (buffer.compare(ZSTD_MAGIC, 0, 4, i, i + 4) === 0) starts.push(i)
  }
  if (starts[0] !== 0) starts.unshift(0)
  const parts = []
  for (let index = 0; index < starts.length; index++) {
    for (let end = index + 1; end <= starts.length; end++) {
      const slice = buffer.subarray(starts[index], end < starts.length ? starts[end] : buffer.length)
      try {
        parts.push(zstdDecompressSync(slice))
        index = end - 1
        break
      } catch {
        // A false-positive magic inside a payload: extend the slice.
      }
    }
  }
  return Buffer.concat(parts).toString('utf8')
}

/**
 * Read one session log's events in log order.
 * @param {string} path - the `session.v3.jsonl.zstd` path.
 * @returns {Array<Record<string, unknown>>} parsed events.
 */
export function readSessionEvents(path) {
  return decompressFrames(readFileSync(path))
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
}

/**
 * Locate one session's log under `DSH_HOME/sessions`, without assuming the
 * cwd-key bucket: the bucket is derived from the session's creation cwd, which
 * the caller may not know (a resumed session keeps its original one).
 * @param {string} sessionId - the session id.
 * @param {string} [home] - DSH home; defaults to {@link DEFAULT_DSH_HOME}.
 * @returns {string | null} the log path, or null when no bucket holds it.
 */
export function findSessionLog(sessionId, home = DEFAULT_DSH_HOME) {
  const root = join(home, 'sessions')
  let buckets
  try {
    buckets = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  } catch {
    return null
  }
  for (const bucket of buckets) {
    const candidate = join(root, bucket.name, sessionId, 'session.v3.jsonl.zstd')
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // Not in this bucket.
    }
  }
  return null
}

/**
 * The newest persisted log under one directory (recursive).
 * @param {string} dir - session root to walk.
 * @returns {{ path: string, mtime: number } | null} newest log, or null.
 */
export function newestSessionLog(dir) {
  let best = null
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = newestSessionLog(full)
      if (nested && (!best || nested.mtime > best.mtime)) best = nested
      continue
    }
    if (!entry.name.endsWith('.zstd')) continue
    const mtime = statSync(full).mtimeMs
    if (!best || mtime > best.mtime) best = { path: full, mtime }
  }
  return best
}
