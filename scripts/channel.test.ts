/**
 * Channel projection tests — the transcript IS a projection of
 * `session/event`, so every row shape the UI leans on gets asserted here
 * instead of only through the end-to-end smoke:
 *
 *   - parallel tool calls keep their OWN result (callId pairing);
 *   - approval audit rows name the tool they belong to (id pairing);
 *   - compaction opens/closes and moves the seal;
 *   - hook rows collapse to a `pass` no-op;
 *   - turn/start seals everything before it; turn/end settles one summary.
 *
 * Pure in-process: no kernel, no PTY, no API calls.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { Channel } from '../src/adapter/channel.js'
import type { SessionEvent } from '../src/kernel/types.js'

/** Minimal durable-envelope event (seq + type + data is all the channel reads). */
function event(seq: number, type: string, data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): SessionEvent {
  return { seq, type, data, ...extra } as unknown as SessionEvent
}

test('parallel tool calls each keep their own result (callId pairing)', () => {
  const channel = new Channel()
  channel.ingest(event(1, 'tool/call', { name: 'read', callId: 'call-a', arguments: { path: 'a.ts' } }))
  channel.ingest(event(2, 'tool/call', { name: 'grep', callId: 'call-b', arguments: { pattern: 'x' } }))
  assert.deepEqual(channel.rows.map((row) => [row.tool, row.status]), [['read', 'running'], ['grep', 'running']])

  // Results arrive OUT OF ORDER — the second call finishes first.
  const result = (callId: string, text: string): SessionEvent =>
    event(0, 'tool/result', { message: { content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }] } })
  channel.ingest({ ...result('call-b', 'b-result'), seq: 3 } as SessionEvent)
  channel.ingest({ ...result('call-a', 'a-result'), seq: 4 } as SessionEvent)

  const [first, second] = channel.rows
  assert.equal(first?.status, 'ok')
  assert.equal(first?.text, 'a-result')
  assert.equal(second?.status, 'ok')
  assert.equal(second?.text, 'b-result')
})

test('a failed tool result is marked failed, not ok', () => {
  const channel = new Channel()
  channel.ingest(event(1, 'tool/call', { name: 'bash', callId: 'c1' }))
  channel.ingest(event(2, 'tool/result', { error: 'boom', message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'boom' }] }] } }))
  assert.equal(channel.rows[0]?.status, 'failed')
})

test('approval audit rows name their own tool (id pairing)', () => {
  const channel = new Channel()
  channel.ingest(event(1, 'approval/asked', { id: 'ap-1', toolName: 'write' }))
  channel.ingest(event(2, 'approval/asked', { id: 'ap-2', toolName: 'bash' }))
  // Decided in the opposite order — each row must still name its own tool.
  channel.ingest(event(3, 'approval/decided', { id: 'ap-2', outcome: 'rejected' }))
  channel.ingest(event(4, 'approval/decided', { id: 'ap-1', outcome: 'allowed-once' }))
  const text = channel.rows.map((row) => row.text).join('\n')
  assert.match(text, /审批结果（bash）：已拒绝/)
  assert.match(text, /审批结果（write）：已放行（单次）/)
})

test('compaction opens, seals the surface and closes', () => {
  const channel = new Channel()
  channel.pushUser('一段很长的历史')
  // A user row is final the moment it lands, so it is sealed already.
  assert.equal(channel.sealedRowCount, 1)
  channel.ingest(event(1, 'compaction/start'))
  assert.equal(channel.compacting, true)
  assert.match(channel.rows.map((row) => row.text).join('\n'), /正在压缩上下文/)
  channel.ingest(event(2, 'compaction/summary', { shadowedTokenCount: 1234, summary: [{ type: 'text', text: '要点' }] }))
  assert.ok(channel.sealedRowCount > 0, '压缩后旧行应封存')
  assert.match(channel.rows.map((row) => row.text).join('\n'), /压缩完成（释放约 1234 tokens）：要点/)
  channel.ingest(event(3, 'compaction/end', {}))
  assert.equal(channel.compacting, false)
})

test('hook rows: a pass decision renders nothing, others report', () => {
  const channel = new Channel()
  channel.ingest(event(1, 'hook/invoked', { point: 'pre-tool', matcher: 'bash' }))
  assert.match(channel.rows[0]?.text ?? '', /hook 运行中：pre-tool（bash）/)
  const before = channel.rows.length
  channel.ingest(event(2, 'hook/result', { decision: 'pass' }))
  assert.equal(channel.rows.length, before, 'pass 不产生新行')
  channel.ingest(event(3, 'hook/result', { decision: 'block', stderrSummary: '拒绝原因' }))
  assert.match(channel.rows.at(-1)?.text ?? '', /hook 结果：block — 拒绝原因/)
})

test('turn/start seals what came before; turn/end settles one summary row', () => {
  const channel = new Channel()
  channel.pushUser('问题')
  channel.ingest(event(1, 'turn/start', {}, { ms: 1_000 }))
  assert.equal(channel.sealedRowCount, channel.rows.length, 'turn/start 封存此前所有行')
  assert.equal(channel.runState, 'thinking')
  assert.deepEqual(channel.turnSeqs, [1])

  channel.ingest(event(2, 'request/header', { config: { provider: 'p', model: 'm' } }))
  channel.ingest(event(3, 'assistant/message', { message: { content: [{ type: 'text', text: '回答' }] }, usage: { inputTokens: 120, outputTokens: 45, reasoningTokens: 3 } }))
  channel.ingest(event(4, 'turn/end', {}, { ms: 3_000 }))
  assert.equal(channel.runState, 'idle')
  const summary = channel.rows.at(-1)
  assert.match(summary?.text ?? '', /↑120 ↓45/)
  assert.equal(channel.usage.output, 45)
})

test('a token-free turn settles no summary row', () => {
  const channel = new Channel()
  channel.ingest(event(1, 'turn/start', {}, { ms: 0 }))
  const before = channel.rows.length
  channel.ingest(event(2, 'turn/end', {}, { ms: 500 }))
  assert.equal(channel.rows.length, before, '取消的空回合不应留下结算行')
})

test('stream deltas append to one open row; the durable message reconciles it', () => {
  const channel = new Channel()
  channel.ingest(event(1, 'turn/start', {}))
  channel.ingestStreamChunk({ type: 'reasoning-delta', text: '想想' } as never)
  channel.ingestStreamChunk({ type: 'text-delta', text: '你' } as never)
  channel.ingestStreamChunk({ type: 'text-delta', text: '好' } as never)
  const assistant = channel.rows.filter((row) => row.kind === 'assistant')
  assert.equal(assistant.length, 1, '增量必须并入同一行')
  assert.equal(assistant[0]?.text, '你好')
  // A replayed/durable message REPLACES the streamed text (same final string).
  channel.ingest(event(2, 'assistant/message', { message: { content: [{ type: 'text', text: '你好' }] } }))
  const after = channel.rows.filter((row) => row.kind === 'assistant')
  assert.equal(after.length, 1)
  assert.equal(after[0]?.text, '你好')
})

test('unknown event types are ignored, never thrown on', () => {
  const channel = new Channel()
  const before = channel.rows.length
  channel.ingest(event(1, 'future/unknown-thing', { whatever: true }))
  assert.equal(channel.rows.length, before)
})
