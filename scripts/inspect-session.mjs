/**
 * Diagnostic: decompress one persisted session log (`.jsonl.zstd`, format v3)
 * and report the facts a probe needs to assert — the injected model-switch
 * notice, any `file` content blocks, and the durable route records
 * (`model/selection` / `request/header`) the model-selection fold reads.
 *
 * Usage: node scripts/inspect-session.mjs [<session.v3.jsonl.zstd> | <session-id>]
 */

import {
  DEFAULT_DSH_HOME,
  findSessionLog,
  newestSessionLog,
  readSessionEvents,
} from './session-log.mjs'

const ORCA_SESSIONS = `${DEFAULT_DSH_HOME}/sessions/--C-Users-Mayn-Desktop-dsh-orca--`
const arg = process.argv[2]
const target = arg === undefined ? newestSessionLog(ORCA_SESSIONS)?.path : findSessionLog(arg) ?? arg
if (!target) {
  console.error('no session log found')
  process.exit(1)
}
console.log(`log: ${target}`)

const events = readSessionEvents(target)
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

const picks = events.filter((event) => event.type === 'model/selection')
console.log(`model/selection events: ${picks.length}`)
for (const pick of picks) console.log(`  seq=${pick.seq} data=${JSON.stringify(pick.data)}`)

const headers = events.filter((event) => event.type === 'request/header')
const lastHeader = headers.at(-1)
console.log(`request/header events: ${headers.length}`)
if (lastHeader) {
  console.log(`  last seq=${lastHeader.seq} config=${JSON.stringify(lastHeader.data?.header?.config)}`)
}

const types = new Map()
for (const event of events) types.set(event.type, (types.get(event.type) ?? 0) + 1)
console.log('event vocabulary:', [...types].map(([type, count]) => `${type}×${count}`).join(', '))
