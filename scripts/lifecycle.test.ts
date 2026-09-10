import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { bootstrapApp } from '../src/app.js'
import { Channel } from '../src/adapter/channel.js'
import type { AgentHandle, CreateAgentOptions, KernelContext, SessionEvent } from '../src/kernel/types.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000
  while (!check()) {
    assert.ok(Date.now() < deadline, 'condition timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

class Input extends EventEmitter {
  isTTY = true
  raw = false
  setRawMode(value: boolean): void { this.raw = value }
  resume(): void {}
  pause(): void {}
  text(value: string): void { this.emit('data', value) }
}

function harness() {
  const input = new Input()
  const writes: string[] = []
  const listeners = new Map<string, Set<(...args: unknown[]) => unknown>>()
  const services = new Map<string, unknown>()
  const output = { isTTY: true, columns: 100, rows: 24, write(value: string) { writes.push(value); return true } }
  const ctx: KernelContext = {
    on(name, listener) {
      const set = listeners.get(name) ?? new Set()
      set.add(listener)
      listeners.set(name, set)
      return () => { set.delete(listener) }
    },
    get<T>(name: string): T | undefined { return services.get(name) as T | undefined },
    effect() {},
  }
  const state = { disposed: 0, attached: 0, sent: 0 }
  function handle(id: string, events: SessionEvent[] = [], finish = async () => {}): AgentHandle {
    return {
      agent: {
        id, options: { provider: 'p', model: 'm' },
        session: { id, events, append(type, data) { return { type, data } } },
        status: 'idle',
        ctx: { on() { state.attached++; return () => {} } },
        followup() { state.sent++ }, steer() {}, inject() {}, cancel() {}, async whenIdle() {},
      },
      async dispose() { state.disposed++; await finish() },
    }
  }
  services.set('agents', {
    create: async (options: CreateAgentOptions) => handle(options.sessionId),
    resume: async () => { throw new Error('not found') },
    get: () => undefined,
  })
  return {
    input, output, writes, services, state, handle,
    emit(name: string, ...args: unknown[]) { for (const listener of listeners.get(name) ?? []) listener(...args) },
    boot() { return bootstrapApp(ctx, { provider: 'p', model: 'm', fullscreen: false }, {
      stdin: () => input as unknown as NodeJS.ReadStream,
      stdout: () => output as unknown as NodeJS.WriteStream,
    }) },
  }
}

test('parallel tool results retain call ownership and seal after all calls finish', () => {
  const channel = new Channel()
  const emit = (type: string, data: unknown) => channel.ingest({ type, data })
  emit('tool/call', { callId: 'a', name: 'read-a' })
  emit('tool/call', { callId: 'b', name: 'read-b' })
  const result = (id: string, text: string) => emit('tool/result', {
    message: { content: [{ type: 'tool-result', toolCallId: id, content: [{ type: 'text', text }] }] },
  })
  result('b', 'B')
  assert.equal(channel.rows[0]?.status, 'running')
  assert.equal(channel.rows[1]?.text, 'B')
  assert.equal(channel.runState, 'working')
  result('a', 'A')
  assert.deepEqual(channel.rows.map((row) => [row.tool, row.text, row.status]), [['read-a', 'A', 'ok'], ['read-b', 'B', 'ok']])
  assert.equal(channel.sealedRowCount, 2)
  result('missing', 'bad')
  result('b', 'duplicate')
  assert.equal(channel.rows[1]?.text, 'B')
  channel.clearForSwitch()
  result('a', 'old-session')
  assert.equal(channel.rows.length, 0)
})

test('late creation is released before asynchronous dispose finishes', async () => {
  const h = harness()
  const creation = deferred<AgentHandle>()
  let started = false
  h.services.set('agents', { get: () => undefined, resume: async () => { throw new Error('not found') }, create: () => { started = true; return creation.promise } })
  const dispose = h.boot()
  await until(() => started)
  const disposing = dispose()
  assert.equal(h.input.raw, false)
  creation.resolve(h.handle('late'))
  await disposing
  assert.equal(h.state.disposed, 1)
  assert.equal(h.state.attached, 0)
  await dispose()
  assert.equal(h.state.disposed, 1)
})

test('unmount cancels pending loader activation', async () => {
  const h = harness()
  const activation = deferred<void>()
  let waiting = false
  h.services.set('loader', { await: () => { waiting = true; return activation.promise } })
  const dispose = h.boot()
  await until(() => waiting)
  await dispose()
  assert.equal(h.state.attached, 0)
  activation.resolve()
})

test('rapid new-session requests release superseded creation before adopting the next', async () => {
  const h = harness()
  const creation = deferred<AgentHandle>()
  let pendingOptions: CreateAgentOptions | undefined
  let calls = 0
  const disposedIds: string[] = []
  h.services.set('agents', {
    get: () => undefined, resume: async () => { throw new Error('not found') },
    create: (options: CreateAgentOptions) => {
      calls++
      if (calls === 2) {
        pendingOptions = options
        return creation.promise
      }
      return Promise.resolve(h.handle(options.sessionId, [], async () => { disposedIds.push(options.sessionId) }))
    },
  })
  const dispose = h.boot()
  try {
    await until(() => h.state.attached > 0)
    h.input.text('/new\r')
    await until(() => pendingOptions !== undefined)
    h.input.text('/new\r')
    assert.equal(pendingOptions?.signal?.aborted, true)
    const abandoned = pendingOptions!.sessionId
    creation.resolve(h.handle(abandoned, [], async () => { disposedIds.push(abandoned) }))
    await until(() => calls === 3 && h.state.attached === 8) // 2 adopted agents × 4 agent-scoped listeners
    assert.equal(disposedIds.length, 2)
    assert.ok(disposedIds.includes(abandoned))
    h.input.text('hello\r')
    assert.equal(h.state.sent, 1)
  } finally {
    await dispose()
  }
  assert.equal(disposedIds.length, 3)
})

test('resume merges historical and buffered live events once and filters other sessions', async () => {
  const previous = process.env['ORCA_RESUME_SESSION']
  process.env['ORCA_RESUME_SESSION'] = 'restored'
  const h = harness()
  const snapshot = deferred<{ events: SessionEvent[] }>()
  let reading = false
  h.services.set('agents', { resume: async () => h.handle('restored') })
  h.services.set('sessionQuery', { readSession: () => { reading = true; return snapshot.promise } })
  const dispose = h.boot()
  try {
    await until(() => reading)
    const events: SessionEvent[] = [
      { type: 'user/message', seq: 0, data: { text: 'HISTORY-MARKER' } },
      { type: 'assistant/message', seq: 1, data: { usage: { inputTokens: 17, outputTokens: 3 } } },
    ]
    h.emit('session/event', { id: 'restored' }, events[1])
    h.emit('session/event', { id: 'restored' }, { type: 'user/message', seq: 2, data: { text: 'LIVE-MARKER' } })
    snapshot.resolve({ events })
    await until(() => h.writes.join('').includes('LIVE-MARKER'))
    assert.ok(h.writes.join('').includes('HISTORY-MARKER'))
    h.emit('session/event', { id: 'foreign' }, { type: 'user/message', seq: 99, data: { text: 'FOREIGN-MARKER' } })
    h.emit('session/disposed', { id: 'foreign' })
    h.input.text('/usage\r')
    await until(() => h.writes.join('').includes('17 输入'))
    assert.ok(!h.writes.join('').includes('34 输入'))
    assert.ok(!h.writes.join('').includes('FOREIGN-MARKER'))
    h.input.text('hello\r')
    assert.equal(h.state.sent, 1)
  } finally {
    await dispose()
    if (previous === undefined) delete process.env['ORCA_RESUME_SESSION']
    else process.env['ORCA_RESUME_SESSION'] = previous
  }
})

test('host exit waits for handle teardown and logging is restored on unmount', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-lifecycle-'))
  const path = join(dir, 'writes.log')
  const previousLog = process.env['ORCA_LOG']
  process.env['ORCA_LOG'] = path
  const h = harness()
  const finish = deferred<void>()
  const originalWrite = h.output.write
  let exitCode: number | undefined
  let shutdown: Promise<void> | undefined
  h.services.set('agents', {
    get: () => undefined, resume: async () => { throw new Error('not found') },
    create: async (options: CreateAgentOptions) => h.handle(options.sessionId, [], () => finish.promise),
  })
  h.services.set('appExit', (code: number) => { exitCode = code; shutdown = dispose() })
  const dispose = h.boot()
  try {
    await until(() => h.state.attached > 0)
    h.input.text('\x03')
    assert.equal(exitCode, 0)
    assert.equal(h.state.disposed, 1)
    assert.equal(h.output.write, originalWrite)
    let finished = false
    void shutdown?.then(() => { finished = true })
    await Promise.resolve()
    assert.equal(finished, false)
    finish.resolve()
    await shutdown
    h.output.write('AFTER-UNMOUNT')
    assert.ok(!readFileSync(path, 'utf8').includes('AFTER-UNMOUNT'))
  } finally {
    finish.resolve()
    await dispose()
    if (previousLog === undefined) delete process.env['ORCA_LOG']
    else process.env['ORCA_LOG'] = previousLog
    rmSync(dir, { recursive: true, force: true })
  }
})
