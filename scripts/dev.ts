/**
 * Headless smoke harness: `pnpm dev` boots the real bootstrap path against a
 * fake kernel. Phases, all through the same seams the kernel uses:
 *
 *   Phase 0 — the Config Standard Schema contract (cordis resolveConfig).
 *   Phase 1 — degraded boot (#183): `agents` unmounted → one system row.
 *   Phase 2 — mounted fake kernel implementing the REAL dsh contract
 *             (v0.1.1-rc.2): factory race retry → connect → keyboard-driven
 *             `followup(UserMessage)` → session envelope projection
 *             (`request/header`, text/reasoning deltas, tool rows,
 *             `assistant/message` usage, thought collapse) → `/model`
 *             three-stage picker (provider → model → effort) → waterfall
 *             override verified against the captured listener → dispose.
 *
 * Exits non-zero on failure — CI-usable. A real-TTY run is still required
 * for keyboard/rendering feel; this harness only proves plumbing.
 */

import { EventEmitter } from 'node:events'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootstrapApp } from '../src/app.js'
import { probePath } from './paths.mjs'
import { Channel } from '../src/adapter/channel.js'
import { Config } from '../src/index.js'
import type { OrcaConfig } from '../src/index.js'
import { Renderer } from '../src/tui/renderer.js'
import { buildFrame } from '../src/tui/chat.js'
import { boxBottom, boxLine, boxTop } from '../src/tui/box.js'
import type {
  AgentHandle,
  CreateAgentOptions,
  EpochHeader,
  KernelAgentsService,
  KernelContext,
  ResumeAgentOptions,
  Session,
  SessionEvent,
  UserMessage,
} from '../src/kernel/types.js'

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * The durable log a resumed session replays: the real kernel loads the stored
 * events into the reconstructed Session, so `snapshotEvents()` (not a query
 * fallback) is what a remount projects.
 */
function durableHistory(extra: SessionEvent[] = []): SessionEvent[] {
  const now = Date.now()
  return [
    { type: 'turn/start', seq: 0, time: now, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: now, data: { content: [{ type: 'text', text: 'hi 历史' }], source: { kind: 'user' } } },
    { type: 'turn/end', seq: 2, time: now, data: { turn: 1, reason: { kind: 'completed' } } },
    ...extra.map((event, index) => ({ ...event, seq: 3 + index })),
  ] as SessionEvent[]
}

/**
 * Minimal terminal emulator for the renderer contract: replays the write
 * stream (cursor up/down, clear-line, clear-to-end, newline) onto a screen
 * buffer so tests can assert the VISIBLE frame, not just that bytes moved.
 * SGR color pairs are STRIPPED here (assertions target visible text, never
 * raw escape boundaries), and the CSI-2026 sync pair pass through as no-ops.
 */
/**
 * Minimal terminal emulator for the renderer contract: replays the write
 * stream (cursor up/down, clear-line, clear-to-end, newline) onto a screen
 * buffer so tests can assert the VISIBLE frame, not just that bytes moved.
 * SGR color pairs are STRIPPED here (assertions target visible text, never
 * raw escape boundaries), and the CSI-2026 sync pair pass through as no-ops.
 * With `height` set, newlines past the bottom SCROLL (top row drops) — the
 * real-terminal behavior the chrome-drift regressions hinge on.
 */
function paintScreen(writes: string[], height = Number.POSITIVE_INFINITY, includeScrollback = false): string[] {
  const screen: string[] = ['']
  const scrollback: string[] = []
  let row = 0
  const stream = writes.join('')
  const re = /\x1b\[\??[0-9]*([ABlJK])|\x1b\[\??[0-9;]*([HG])|\x1b\[\?2026[hl]|\r\n|\r/g
  let last = 0
  let match: RegExpExecArray | null
  const writeText = (text: string): void => {
    const plain = text.replace(/\x1b\[[0-9;?]*[@-~]/g, '')
    while (screen.length <= row) screen.push('')
    screen[row] += plain
  }
  const lineFeed = (): void => {
    if (row + 1 >= height) {
      scrollback.push(screen.shift() ?? '')
      while (screen.length < height) screen.push('')
      row = height - 1
      return
    }
    row++
    while (screen.length <= row) screen.push('')
  }
  while ((match = re.exec(stream)) !== null) {
    writeText(stream.slice(last, match.index))
    last = re.lastIndex
    const code = match[1]
    if (code === 'A') {
      const param = /\x1b\[\??([0-9]*)A/.exec(match[0])?.[1] ?? '1'
      row = Math.max(0, row - (param === '' ? 1 : Number.parseInt(param, 10)))
    } else if (code === 'B') {
      const param = /\x1b\[\??([0-9]*)B/.exec(match[0])?.[1] ?? '1'
      row += param === '' ? 1 : Number.parseInt(param, 10)
    } else if (code === 'J') {
      // ESC[0J — clear the current line and everything below it.
      screen.length = row + 1
      screen[row] = ''
    } else if (code === 'K') {
      while (screen.length <= row) screen.push('')
      screen[row] = ''
    } else if (match[2] === 'H' || match[2] === 'G') {
      // CUP (row;col) / CHA — the painter addresses rows absolutely.
      // Columns are not modeled (full-line writes). Rows clamp to the
      // viewport when one is given.
      const params = /\x1b\[\??([0-9;]*)[HG]/.exec(match[0])?.[1] ?? ''
      const first = params.split(';')[0] ?? ''
      const target = Number.parseInt(first || '1', 10) - 1
      row = Number.isFinite(height) ? Math.max(0, Math.min(height - 1, target)) : Math.max(0, target)
      while (screen.length <= row) screen.push('')
    } else if (match[0] === '\r\n') {
      lineFeed()
    }
    // lone '\r' and the sync pair: no-ops under the full-line write model
  }
  writeText(stream.slice(last))
  if (!includeScrollback) return screen
  const trim = (rows: string[]): string[] => {
    const copy = [...rows]
    while (copy.length > 0 && copy[0] === '') copy.shift()
    while (copy.length > 0 && copy[copy.length - 1] === '') copy.pop()
    return copy
  }
  return ['── scrollback ──', ...trim(scrollback), '── viewport ──', ...screen]
}

function makeStdout(writes: string[], rows?: number): NodeJS.WriteStream {
  return {
    columns: 100,
    ...(rows === undefined ? {} : { rows }),
    write(chunk: string): boolean {
      writes.push(chunk)
      return true
    },
  } as unknown as NodeJS.WriteStream
}

/** Remove CSI sequences (SGR + cursor moves) so assertions read visible text. */
function stripSgr(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[@-~]/g, '')
}

/**
 * Fake TTY stdin: feeds RAW byte sequences ('data' chunks) so the smoke
 * drives the real Keyboard parser — the same escape decoding the terminal
 * exercises, not a keypress-event bypass.
 */
class FakeStdin extends EventEmitter {
  isTTY = true
  setRawMode(mode: boolean): boolean {
    return mode
  }
  resume(): void {}
  pause(): void {}

  private write(text: string): void {
    this.emit('data', Buffer.from(text, 'utf8'))
  }

  /** A named key (return / escape / up / down / tab / backspace …). */
  key(name: string, opts: { ctrl?: boolean } = {}): void {
    if (opts.ctrl) {
      this.write(String.fromCharCode(name.toLowerCase().charCodeAt(0) - 0x60))
      return
    }
    if (name === 'return') this.write('\r')
    else if (name === 'escape') this.write('\x1b')
    else if (name === 'tab') this.write('\t')
    else if (name === 'backspace') this.write('\x7f')
    else if (name === 'up') this.write('\x1b[A')
    else if (name === 'down') this.write('\x1b[B')
    else if (name === 'left') this.write('\x1b[D')
    else if (name === 'right') this.write('\x1b[C')
    else this.write(name)
  }

  /** Plain text (printable sequence, CJK included) as one burst. */
  text(sequence: string): void {
    this.write(sequence)
  }

  /** A bracketed paste burst (CSI 200~ … 201~), as a real terminal sends. */
  paste(sequence: string): void {
    this.write(`\x1b[200~${sequence}\x1b[201~`)
  }
}

interface KernelRecord {
  createOptions: CreateAgentOptions | null
  createCalls: number
  resumedId: string | null
  followupMessage: UserMessage | null
  cancelCause: { kind: string } | null
  selectionSaved: { provider: string; model: string; reasoningEffort?: string } | null
  /** Messages the plugin queued through `agent.inject` (model-facing context). */
  injected: UserMessage[]
  requestListener: ((...args: unknown[]) => unknown) | null
  /** `system-prompt/assemble` waterfall (prompt variables follow the route). */
  assembleListener: ((...args: unknown[]) => unknown) | null
  approvalListener: ((...args: unknown[]) => unknown) | null
  streamListener: ((...args: unknown[]) => unknown) | null
  policySet: string | null
  titleRenamed: string | null
  compactLine: string | null
  forkCalled: { boundary: number | undefined; childId: string | undefined } | null
  presetMounted: string | null
  disposed: boolean
}

/**
 * Fake kernel context. `mounted` decides whether the kernel services exist;
 * when mounted they implement the REAL contract shapes and the fake agent
 * streams a scripted turn through the real session-event envelope.
 */
class FakeKernel implements KernelContext {
  readonly record: KernelRecord = {
    createOptions: null,
    createCalls: 0,
    resumedId: null,
    followupMessage: null,
    cancelCause: null,
    selectionSaved: null,
    injected: [],
    requestListener: null,
    assembleListener: null,
    approvalListener: null,
    streamListener: null,
    policySet: null,
    titleRenamed: null,
    compactLine: null,
    forkCalled: null,
    presetMounted: null,
    disposed: false,
  }
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  private seq = 0
  private factoryCalls = 0
  private fakePolicy = 'ask'
  private fakeTitle: string | null = null
  private attachmentSeq = 0
  private fileSeq = 0
  /** When true, `sessionQuery` reads as unregistered (late-registration probe). */
  hideSessionQuery = false
  /** When true, `workspaceRegistry` reads as unregistered (degradation probe). */
  hideWorkspaceRegistry = false
  /**
   * The ONE directory the fake workspace owns; `undefined` models a cwd the
   * user never added as a workspace (the attach must then do nothing).
   */
  workspacePath: string | undefined = process.cwd()
  /** The workspace record's durable stamp (the medium-drift guard reads it). */
  workspaceUpdatedAt = '2026-01-01T00:00:00.000Z'
  /** When true, `attachSession` rejects (header cwd validation refusal). */
  workspaceAttachFails = false
  /** When true, the medium drifts exactly while a resolve is in flight. */
  workspaceDriftsOnResolve = false
  /** Session ids the fake workspace has attached, in call order. */
  readonly workspaceAttached: string[] = []

  /**
   * Publish this fake workspace's state to the sandboxed medium file, the way
   * the real domain would after a mutation. The app's drift guard compares the
   * medium against its live registry, so any test that expects an attach must
   * have the medium in sync; {@link driftWorkspaceMedium} simulates the WEB
   * process committing after this process read it.
   */
  writeWorkspaceMedium(updatedAt = this.workspaceUpdatedAt): void {
    const file = process.env['ORCA_WORKSPACE_FILE']
    if (file === undefined || this.workspacePath === undefined) return
    writeFileSync(
      file,
      JSON.stringify({
        unit: { name: 'workspace', version: 2 },
        global: { initialized: true, workspaceIds: ['ws-fake'], archivedSessionIds: [] },
        tables: {
          workspaces: {
            'ws-fake': {
              path: this.workspacePath,
              title: 'fake-workspace',
              createdAt: this.workspaceUpdatedAt,
              updatedAt,
              sessionIds: [...this.workspaceAttached],
            },
          },
        },
      }),
    )
  }

  /** Simulate another process committing a workspace change (drift). */
  driftWorkspaceMedium(): void {
    this.writeWorkspaceMedium('2026-06-06T06:06:06.000Z')
  }
  /**
   * Extra durable events a resumed session's log carries (the model/selection
   * + request/header records the durable-selection fold reads back).
   */
  resumeExtras: SessionEvent[] = []
  /** cwd `/resume` reports in the reconstructed session's header. */
  resumeCwd: string | undefined = process.cwd()
  /** When true, `agentPresets.mount` rejects (preset-failure fallback probe). */
  presetMountFails = false
  /** Kernel-registered commands beyond Orca's own table (menu discovery probe). */
  extraCommands: Array<{ readonly name: string; readonly description: string }> = [
    { name: 'goal', description: '目标模式' },
  ]
  /** Live agents by session id (removed on dispose, like the real store). */
  private readonly liveAgents = new Map<string, AgentHandle['agent']>()
  /** Sessions durable on "disk" (survive dispose, loadable via resume). */
  private readonly persistedSessions = new Set<string>()

  constructor(private readonly mounted: boolean) {}

  on(name: string, listener: (...args: unknown[]) => unknown): () => void {
    const set = this.listeners.get(name) ?? new Set()
    set.add(listener)
    this.listeners.set(name, set)
    return () => {
      this.listeners.get(name)?.delete(listener)
    }
  }

  get<T = unknown>(name: string, _soft?: false): T | undefined {
    if (!this.mounted) return undefined
    if (name === 'agents') return this.agentsService as T
    if (name === 'loader') return { await: async (): Promise<void> => {} } as T
    if (name === 'agentDefaultModel') {
      return {
        // The composition default carries an effort (as a real profile does
        // when the user pinned one): it must survive into agentOptions and
        // the waterfall seed, never silently reset to the model default.
        currentSelection: () => ({ provider: 'default-provider', model: 'default-model', reasoningEffort: 'medium' }),
        saveSelection: async (next: { provider: string; model: string; reasoningEffort?: string }): Promise<void> => {
          this.record.selectionSaved = next
        },
      } as T
    }
    if (name === 'llm') {
      return {
        listProviders: () => [
          { id: 'fake-a', name: 'Fake A' },
          { id: 'fake-b', name: 'Fake B' },
        ],
        listModels: async (provider: string) => [
          { provider, id: `${provider}-m1`, name: `${provider} 模型一` },
          { provider, id: `${provider}-m2`, name: `${provider} 模型二` },
        ],
        resolveModelInfo: async (provider: string, model: string) => ({
          provider,
          id: model,
          name: model,
          reasoning: {
            efforts: [
              { id: 'low', name: '低' },
              { id: 'high', name: '高' },
            ],
            defaultEffort: 'low',
          },
        }),
      } as T
    }
    if (name === 'sessionQuery') {
      if (this.hideSessionQuery) return undefined
      return {
        listSessions: async () => [
          { header: { id: 'session-aaa', cwd: '/tmp/proj', createdAt: Date.now() - 1000 }, live: false, persisted: true },
          { header: { id: 'session-bbb', cwd: '/tmp/proj', createdAt: Date.now() - 2000 }, live: false, persisted: true },
        ],
        readTitle: async (sessionId: string) =>
          sessionId === 'session-aaa' ? { title: '假标题A', updatedAt: Date.now() } : undefined,
        readTitleSnapshots: async (ids: readonly string[]) =>
          ids.map((sessionId) => ({
            sessionId,
            status: 'fulfilled' as const,
            value: sessionId === 'session-aaa' ? { title: { title: '假标题A', updatedAt: Date.now() } } : {},
          })),
        readSession: async (_sessionId: string) => ({ events: durableHistory(this.resumeExtras) }),
      } as T
    }
    if (name === 'sessionTitle') {
      return {
        get: () => (this.fakeTitle ? { title: this.fakeTitle, updatedAt: Date.now() } : undefined),
        rename: (_session: unknown, title: string) => {
          this.record.titleRenamed = title
          this.fakeTitle = title
          return { title, updatedAt: Date.now() }
        },
        refresh: async () => undefined,
      } as T
    }
    if (name === 'commands') {
      return {
        list: () => [
          { name: 'compact', description: '压缩上下文' },
          // Not in Orca's own table: it must surface in the `/` menu.
          ...this.extraCommands,
        ],
        find: (_agent: unknown, cmdName: string) => (cmdName === 'compact' ? { name: 'compact' } : undefined),
        execute: async (_agent: unknown, line: string) => {
          this.record.compactLine = line
          return { commandId: 'cmd-1', result: { kind: 'success' as const, text: '压缩已开始' } }
        },
      } as T
    }
    if (name === 'approval') {
      return {
        setPolicy: (_agent: unknown, policy: string) => {
          this.record.policySet = policy
          this.fakePolicy = policy
        },
        overrideOf: () => this.fakePolicy,
        request: async () => 'unavailable' as const,
      } as T
    }
    if (name === 'workspaceRegistry') {
      if (this.hideWorkspaceRegistry) return undefined
      const kernel = this
      return {
        list: (): unknown[] => (kernel.workspacePath === undefined ? [] : [kernel.workspaceView()]),
        get archivedSessionIds(): readonly string[] {
          return []
        },
        resolveByPath: async (path: string) => {
          if (path !== kernel.workspacePath) return undefined
          if (kernel.workspaceDriftsOnResolve) kernel.driftWorkspaceMedium()
          return kernel.workspaceView()
        },
      } as T
    }
    if (name === 'sessions') {
      return {
        fork: (_source: unknown, boundary?: number, childSessionId?: string) => {
          this.record.forkCalled = { boundary, childId: childSessionId }
          const id = childSessionId ?? 'session-fork'
          this.persistedSessions.add(id)
          return { id }
        },
      } as T
    }
    if (name === 'attachments') {
      return {
        imageLimits: {
          maxImageBytes: 20 * 1048576,
          maxImagesPerMessage: 20,
          maxMessageImageBytes: 200 * 1048576,
          maxImagePixels: 64_000_000,
          maxImageDimension: 8192,
          mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
        },
        saveImage: async (input: { data: Uint8Array; mediaType: string; name?: string }) => {
          this.attachmentSeq++
          return {
            attachmentId: `att-${this.attachmentSeq}`,
            mediaType: input.mediaType,
            bytes: input.data.length,
            width: 8,
            height: 8,
            name: input.name,
          }
        },
        // dsh-attachment 0.1.5 file path (non-image attachments).
        saveFile: async (input: { data: Uint8Array; name?: string }) => {
          this.fileSeq++
          return { attachmentId: `file-${this.fileSeq}`, name: input.name ?? 'file', bytes: input.data.length }
        },
        isAttachmentError: (error: unknown): error is { readonly code: string } =>
          typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string',
      } as T
    }
    if (name === 'agentPresets') {
      const roster = [
        { id: 'standard', trust: 'system' as const, name: '标准模式', description: '功能完整的编码 Agent', order: 1 },
        { id: 'ptc', trust: 'system' as const, name: 'PTC 模式', description: '默认不提供 workflow 工具', order: 2 },
        { id: 'minimal', trust: 'system' as const, name: '极简模式', description: '双工具编码 Agent', order: 3 },
        { id: 'cordis', trust: 'system' as const, name: '创造模式', description: '自定义预设', order: 4 },
        { id: 'broken-demo', trust: 'user' as const, name: '坏预设', broken: '组成文件损坏（演示）', order: 5 },
      ]
      return {
        list: async () => roster,
        defaultId: 'standard',
        resolve: async (id?: string) => {
          const found = roster.find((preset) => preset.id === (id ?? 'standard'))
          if (!found) throw new Error(`unknown preset: ${id}`)
          return found
        },
        composedPreset: () => this.record.presetMounted ?? 'standard',
        mount: async (_agentCtx: unknown, id?: string) => {
          if (this.presetMountFails) {
            throw new Error('agent-presets: preset "standard" failed to mount: (simulated host-service gap)')
          }
          const next = id ?? 'standard'
          this.record.presetMounted = next
          return { id: next, trust: 'system' as const }
        },
      } as T
    }
    if (name === 'fileReferences') {
      return {
        list: async (_agent: unknown, query: string) =>
          (
            [
              { path: 'docs', kind: 'directory' as const },
              { path: 'README.md', kind: 'file' as const },
            ] as const
          ).filter((candidate) => query === '' || candidate.path.toLowerCase().startsWith(query.toLowerCase())),
      } as T
    }
    return undefined
  }

  effect(_register: () => (() => void | Promise<void>) | void): void {
    // Effects are lifecycle-managed by the real kernel; smoke ignores them.
  }

  /** Publish one session event through the real `(session, event)` shape. */
  emit(type: string, data: unknown): void {
    const event: SessionEvent = { type, seq: this.seq++, time: Date.now(), data }
    this.logged.push({ sessionId: this.record.createOptions?.sessionId ?? 'fake-session', event })
    for (const listener of this.listeners.get('session/event') ?? []) {
      listener({ id: this.record.createOptions?.sessionId ?? 'fake-session' }, event)
    }
  }

  /** Every event this kernel published (the durable log a resume replays). */
  private readonly logged: Array<{ readonly sessionId: string; readonly event: SessionEvent }> = []
  /** Sessions whose "persisted" history a resume must load. */
  private readonly durable = new Map<string, readonly SessionEvent[]>()

  /** The durable log of one session — what `session.snapshotEvents()` returns. */
  loggedEvents(sessionId: string): readonly SessionEvent[] {
    return [
      ...(this.durable.get(sessionId) ?? []),
      ...this.logged.filter((entry) => entry.sessionId === sessionId).map((entry) => entry.event),
    ]
  }

  /**
   * Append one event through the same path `Session.append` uses in the real
   * kernel: it enters the log AND is published on `session/event`.
   */
  appendEvent(sessionId: string, type: string, data: unknown): SessionEvent {
    const event: SessionEvent = { type, seq: this.seq++, time: Date.now(), data }
    this.logged.push({ sessionId, event })
    for (const listener of this.listeners.get('session/event') ?? []) listener({ id: sessionId }, event)
    return event
  }

  /**
   * The kernel's `Session.requestHeader()` fold: the header of the LAST
   * `request/header` event in the log, or undefined before the first one.
   */
  private requestHeaderOf(sessionId: string): EpochHeader | undefined {
    let header: EpochHeader | undefined
    for (const event of this.loggedEvents(sessionId)) {
      if (event.type !== 'request/header') continue
      const data = event.data as { readonly header?: EpochHeader } | undefined
      if (data?.header !== undefined) header = data.header
    }
    return header
  }

  /** The one fake workspace the registered `workspaceRegistry` resolves. */
  private workspaceView(): {
    id: string
    path: string | undefined
    title: string
    updatedAt: string
    sessionIds: readonly string[]
    attachSession(sessionId: string): Promise<void>
  } {
    const kernel = this
    return {
      id: 'ws-fake',
      path: this.workspacePath,
      title: 'fake-workspace',
      updatedAt: this.workspaceUpdatedAt,
      // LIVE view: the app must see its own earlier attach reflected here.
      sessionIds: this.workspaceAttached,
      attachSession: async (sessionId: string): Promise<void> => {
        if (this.workspaceAttachFails) {
          throw new Error(`cannot attach session '${sessionId}': its cwd resolves elsewhere`)
        }
        kernel.workspaceAttached.push(sessionId)
      },
    }
  }

  /**
   * Publish one kernel-lifecycle cordis event (NOT a session event) — the
   * shape `ctx.on(name, …)` listeners receive.
   */
  emitKernelEvent(name: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(name) ?? []) listener(...args)
  }

  /**
   * Run the Agent-scoped `system-prompt/assemble` waterfall the way the real
   * kernel does — `(assembly, context, next)`, with `next()` returning the
   * assembled prompt. The base variables are what `dsh-agent-loop` registers:
   * the route the agent was CREATED with, which is exactly what a model
   * switch has to override.
   */
  async assemblePrompt(): Promise<Record<string, unknown>> {
    const created = this.record.createOptions?.agentOptions
    const base: Record<string, unknown> = {
      variables: { provider: created?.provider ?? '', model: created?.model ?? '', cwd: process.cwd() },
    }
    const listener = this.record.assembleListener
    if (!listener) return base
    const result = await listener(base, { agent: null }, async (): Promise<Record<string, unknown>> => base)
    return result === undefined || result === null ? base : (result as Record<string, unknown>)
  }

  /**
   * Publish one live model-stream frame (dsh ≥ 0.1.5): the Agent-scoped
   * `agent/assistant-stream` event, NOT a session event. The transcript is
   * built from these while the turn runs; the durable `assistant/message`
   * then settles it.
   */
  emitStreamFrame(sessionId: string, frame: Record<string, unknown>): void {
    const listener = this.record.streamListener
    if (!listener) return
    listener({ agent: { id: sessionId }, frame })
  }

  private readonly agentsService: KernelAgentsService = {
    create: async (options: CreateAgentOptions): Promise<AgentHandle> => {
      // First call hits the verified boot race: the registry exists before
      // dsh-agent-loop registers the factory. The app must retry, not fail.
      this.factoryCalls++
      if (this.factoryCalls === 1) {
        throw new Error('no agent factory registered (load an agent-loop plugin)')
      }
      this.record.createOptions = options
      this.record.createCalls++
      // The factory runs creation-time `setup` (preset standing-mount in the
      // real kernel); the fake honors it so the mount path is covered.
      const kernel = this
      if (options.setup) {
        await options.setup({
          on(_name: string, _listener: (...args: unknown[]) => unknown): () => void {
            return () => {}
          },
        })
      }
      const session: Session = {
        id: options.sessionId,
        header: {
          id: options.sessionId,
          ...(typeof options.meta?.cwd === 'string' ? { cwd: options.meta.cwd } : {}),
          createdAt: Date.now(),
        },
        events: [],
        snapshotEvents: (): readonly SessionEvent[] => kernel.loggedEvents(options.sessionId),
        requestHeader: (): EpochHeader | undefined => kernel.requestHeaderOf(options.sessionId),
        append(type, data): SessionEvent {
          return kernel.appendEvent(options.sessionId, type, data)
        },
      }
      const agent = {
        id: options.sessionId,
        options: options.agentOptions ?? {},
        session,
        status: 'idle' as const,
        ctx: {
          on(name: string, listener: (...args: unknown[]) => unknown): () => void {
            if (name === 'agent/request') kernel.record.requestListener = listener
            if (name === 'system-prompt/assemble') kernel.record.assembleListener = listener
            if (name === 'approval/request') kernel.record.approvalListener = listener
            if (name === 'agent/assistant-stream') kernel.record.streamListener = listener
            return () => {}
          },
        },
        followup(message: UserMessage): void {
          kernel.record.followupMessage = message
          kernel.streamTurn(message)
        },
        steer(_message: UserMessage): void {},
        inject(message: UserMessage): void {
          kernel.record.injected.push(message)
        },
        cancel(cause: { kind: string }): void {
          kernel.record.cancelCause = cause
        },
        whenIdle: async (): Promise<void> => {},
      }
      kernel.liveAgents.set(options.sessionId, agent)
      kernel.persistedSessions.add(options.sessionId)
      return {
        agent,
        dispose: async (): Promise<void> => {
          kernel.record.disposed = true
          kernel.liveAgents.delete(options.sessionId)
        },
      }
    },
    resume: async (options: ResumeAgentOptions): Promise<AgentHandle> => {
      // Unknown sessions reject like the real persistence backend; each fake
      // kernel owns its persistence, so cross-kernel resumes fail and the app
      // must fall back to a fresh create.
      if (!this.persistedSessions.has(options.resumeSessionId)) {
        throw new Error(`session not found: ${options.resumeSessionId}`)
      }
      this.record.resumedId = options.resumeSessionId
      // The real resume loads the stored log into the reconstructed session;
      // keep the fake's seq counter ahead of the replayed prefix.
      const history = durableHistory(this.resumeExtras)
      this.durable.set(options.resumeSessionId, history)
      this.seq = Math.max(this.seq, history.length)
      // The reconstructed session's header comes from the STORED log, not from
      // the caller — the fake reproduces that, so workspace accounting sees a
      // resumed session exactly as it sees a fresh one.
      return this.agentsService.create({
        sessionId: options.resumeSessionId,
        agentOptions: options.agentOptions,
        ...(this.resumeCwd === undefined ? {} : { meta: { cwd: this.resumeCwd } }),
      })
    },
    get: (id: string) => this.liveAgents.get(id) as AgentHandle['agent'] | undefined,
    list: () => [...this.liveAgents.values()] as Array<AgentHandle['agent']>,
  }

  /**
   * A scripted turn streamed the way the kernel does since dsh 0.1.5: the
   * durable session envelope (`{type, seq, time, data}`) carries
   * `request/header`, the tool lifecycle and the settling `assistant/message`
   * (with its embedded stream), while the LIVE deltas arrive as
   * `agent/assistant-stream` frames — `assistant/chunk` is no longer a
   * session event at all.
   */
  private streamTurn(message: UserMessage): void {
    const turn = 1
    const step = 1
    const sessionId = this.record.createOptions?.sessionId ?? 'fake-session'
    const attemptId = 'attempt-1'
    const at = (delay: number, type: string, data: unknown): void => {
      setTimeout(() => this.emit(type, data), delay)
    }
    const frameAt = (delay: number, frame: Record<string, unknown>): void => {
      setTimeout(() => this.emitStreamFrame(sessionId, frame), delay)
    }
    const text = '**你好**，Orca。\n\n- 列表一\n- 列表二\n\n```ts\nconst n = 1 // 注释\n```\n\n流式增量上屏测试。'
    const reasoning = '思考一下。'
    at(0, 'turn/start', { turn })
    at(5, 'step/start', { turn, step })
    at(10, 'user/message', message)
    at(20, 'request/header', {
      header: { config: { provider: 'default-provider', model: 'default-model' } },
      reason: 'initial',
    })
    frameAt(30, { type: 'start', attemptId, revision: 1, turn, step })
    frameAt(40, { type: 'chunk', attemptId, revision: 1, index: 0, time: Date.now(), chunk: { type: 'text-delta', index: 0, text } })
    frameAt(150, { type: 'chunk', attemptId, revision: 1, index: 1, time: Date.now(), chunk: { type: 'reasoning-delta', index: 1, text: reasoning } })
    at(200, 'tool/call', { turn, step, callId: 'call-1', name: 'edit', arguments: '{"path":"src/app.ts"}' })
    at(260, 'tool/result', {
      turn,
      step,
      message: {
        id: 'msg-result-1',
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'ok' }] }],
        source: { kind: 'tool', callId: 'call-1' },
      },
      meta: { diffs: [{ path: 'src/app.ts', oldText: 'const a = 1\n', newText: 'const a = 2\nconst b = 3\n' }] },
    })
    at(560, 'assistant/message', {
      turn,
      step,
      message: {
        id: 'msg-assistant-1',
        role: 'assistant',
        // The durable message carries BOTH blocks: reasoning first, then the
        // answer. A replay projects this; the live path must not duplicate it.
        content: [
          { type: 'reasoning', text: reasoning },
          { type: 'text', text },
        ],
        source: { kind: 'model', provider: 'default-provider', model: 'default-model' },
      },
      stream: [
        { type: 'reasoning-chunks', time0: Date.now(), index: 0, dt: [0], texts: [reasoning] },
        { type: 'text-chunks', time0: Date.now(), index: 1, dt: [0], texts: [text] },
      ],
      usage: { inputTokens: 120, outputTokens: 45, reasoningTokens: 30, cacheReadTokens: 60, cacheWriteTokens: 15 },
    })
    at(590, 'step/end', { turn, step })
    at(600, 'turn/end', { turn, reason: { kind: 'completed' } })
    frameAt(600, { type: 'end', attemptId, revision: 1, index: 2, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 3 } })
  }
}

async function main(): Promise<void> {
  const problems: string[] = []
  // Sandbox the same-process remount marker: the harness mounts several
  // bootstraps in ONE process, and without isolation every later mount
  // would silently resume the first mount's session.
  process.env['ORCA_LAST_SESSION_FILE'] = join(tmpdir(), `orca-smoke-${process.pid}.json`)
  try {
    rmSync(process.env['ORCA_LAST_SESSION_FILE'])
  } catch {
    // Absent on the first run — nothing to clear.
  }
  // The workspace medium the drift guard reads (see phase 11): sandboxed to a
  // temp file so the smoke never inspects the user's real workspace registry.
  process.env['ORCA_WORKSPACE_FILE'] = join(tmpdir(), `orca-smoke-workspace-${process.pid}.json`)
  try {
    rmSync(process.env['ORCA_WORKSPACE_FILE'])
  } catch {
    // Absent on the first run — nothing to clear.
  }

  // ── Phase 0: the Config Standard Schema contract ──────────────────────────
  const schema = Config['~standard']
  const valueOf = (result: { value?: unknown }): OrcaConfig | undefined =>
    typeof result.value === 'object' && result.value !== null ? (result.value as OrcaConfig) : undefined
  const filled = valueOf(schema.validate({ provider: 'p1', fullscreen: 'yes' as unknown as boolean }))
  if (schema.version !== 1 || filled?.provider !== 'p1' || filled.fullscreen !== false) {
    problems.push('phase0：Config 校验未按 Standard Schema 收敛')
  }
  const empty = valueOf(schema.validate(undefined))
  if (empty?.provider !== '' || empty.model !== '' || empty.fullscreen !== false) {
    problems.push('phase0：Config 缺省校验失败')
  }

  // ── Phase 0.5: renderer contract — the diff painter must reproduce the
  // frame on screen, and sealed lines must SEDIMENT into scrollback in log
  // order (written through the bottom row, one scroll per line) without
  // ever disturbing the live block or double-writing content.
  {
    const rw: string[] = []
    const renderer = new Renderer(makeStdout(rw), () => 4, () => 4)
    renderer.render(['a1', 'a2']) // first frame
    renderer.render(['a1', 'a2', 'a3']) // live append below
    renderer.render(['a3'], ['s1', 's2', 's3', 's4', 's5']) // seal flush: overflow sediments
    renderer.render(['a3', 'a4']) // post-seal live growth
    renderer.render(['a5'], ['s6']) // second seal
    const all = paintScreen(rw, 4, true)
    renderer.dispose()
    const sep = all.indexOf('── viewport ──')
    const sb = all.slice(1, sep)
    const viewport = all.slice(sep + 1)
    // Sealed lines sediment in log order: those already scrolled off live in
    // scrollback, the rest are still visible above the block — together they
    // must be the complete, ordered seal sequence.
    const sealedSeen = [...sb, ...viewport.filter((row) => row.startsWith('s'))]
    if (sealedSeen.join('\n') !== 's1\ns2\ns3\ns4\ns5\ns6') {
      problems.push(`phase0.5：封存行未按序沉淀：${JSON.stringify({ sb, viewport })}`)
    }
    if (viewport[viewport.length - 1] !== 'a5') problems.push(`phase0.5：live 块尾失真：${JSON.stringify(viewport)}`)
    const allowed = new Set(['s1', 's2', 's3', 's4', 's5', 's6', 'a3', 'a4', 'a5', ''])
    if (!viewport.every((row) => allowed.has(row))) problems.push(`phase0.5：视口出现未封存内容：${JSON.stringify(viewport)}`)
  }

  // ── Phase 0.7: picker height contract — model lists must not push the
  // editor/footer below the terminal viewport (the source of ghost chrome
  // after closing /model on a short terminal).
  {
    const picker = {
      title: '选择模型（provider）',
      items: Array.from({ length: 40 }, (_, i) => ({ value: `m${i}`, label: `model-${i}` })),
      index: 20,
    }
    const frame = buildFrame({
      channel: {
        rows: [], sealedRowCount: 0, runState: 'idle', route: null,
        usage: { input: 0, output: 0, reasoning: 0, messages: 0 },
      } as never,
      sealedFrom: 0,
      editorText: '',
      width: 80,
      height: 12,
      cwd: '.',
      sessionId: null,
      route: null,
      usage: { input: 0, output: 0, reasoning: 0, messages: 0 },
      now: Date.now(),
      picker,
    })
    if (frame.live.length > 12) problems.push(`phase0.7：选择器溢出终端高度：${frame.live.length}`)
  }

  // ── Phase 0.75: historical welcome rows do not permanently reserve
  // viewport height once conversation content starts streaming.
  {
    const channel = {
      rows: [{ kind: 'user', text: '你好' }],
      sealedRowCount: 0,
      runState: 'thinking',
      route: null,
      usage: { input: 0, output: 0, reasoning: 0, messages: 1 },
    } as never
    const frame = buildFrame({
      channel,
      sealedFrom: 0,
      editorText: '',
      width: 80,
      height: 24,
      anchorChrome: true,
      cwd: '.',
      sessionId: null,
      route: null,
      usage: { input: 0, output: 0, reasoning: 0, messages: 1 },
      now: Date.now(),
      picker: null,
    })
    if (frame.live.length !== 24) problems.push(`phase0.75：聊天态未填满底部 chrome：${frame.live.length}`)
    if (frame.live.at(-5) === undefined || !frame.live.at(-5)?.includes('╭')) problems.push('phase0.75：输入框未锚定到底部')
  }

  // ── Phase 0.8: closing /model with a route stream must remove the old
  // picker border instead of leaving it above the replacement editor.
  {
    const rw: string[] = []
    const renderer = new Renderer(makeStdout(rw), () => 24, () => 24)
    const cursor = { fromEnd: 3, col: 5 }
    renderer.render(['picker-top', 'picker-row', 'picker-bottom', '╭────╮', '│ >  │', '╰────╯', 'footer-1', 'footer-2'], [], cursor)
    renderer.render(['system: 模型已切换', '╭────╮', '│ >  │', '╰────╯', 'footer-1', 'footer-2'], ['↳ 模型 provider/model'], cursor)
    const all = paintScreen(rw, 24, true)
    const visible = all.join('\n')
    if (visible.includes('picker-top') || visible.includes('picker-row')) {
      problems.push(`phase0.8：关闭 picker 后残留旧边框：${JSON.stringify(all)}`)
    }
    if (!visible.includes('↳ 模型 provider/model')) problems.push('phase0.8：路由封存行未沉淀')
    if (!visible.includes('system: 模型已切换')) problems.push('phase0.8：切换后 live 块缺失')
  }


  // ── Phase 0.6: full-height repaint must NOT scroll — the last frame row
  // carries no trailing newline, so a top-row change on a screen-filling
  // frame keeps every row visible (the chrome-drift regression).
  {
    const rw: string[] = []
    const renderer = new Renderer(makeStdout(rw), () => 4, () => 4)
    const cursor = { fromEnd: 0, col: 3 }
    renderer.render(['a1', 'a2', 'a3', 'a4'], [], cursor) // fills a 4-row screen
    renderer.render(['b1', 'a2', 'a3', 'a4'], [], cursor) // top-row change → tail repaint
    renderer.render(['b1', 'a2', 'a3', 'c4'], [], cursor) // tail change
    renderer.render(['b1', 'a2', 'a3', 'c4'], ['s1', 's2'], cursor) // seal flush sediments
    const all = paintScreen(rw, 4, true)
    renderer.dispose()
    const sep = all.indexOf('── viewport ──')
    const sb = all.slice(1, sep)
    const viewport = all.slice(sep + 1)
    // The seal rows sediment into scrollback; the frame itself must come
    // through intact — no lost row, no drift, no stale tail.
    if (viewport.join('\n') !== 'b1\na2\na3\nc4') problems.push(`phase0.6：整屏重绘丢行/漂移：${JSON.stringify(viewport)}`)
    if (!sb.join('\n').includes('s1\ns2')) problems.push(`phase0.6：封存行未沉淀：${JSON.stringify(sb)}`)
  }

  // ── Phase 0.65: expanding from the post-stream live height to a full
  // viewport must repaint as a frame, keeping the input at the bottom.
  {
    const rw: string[] = []
    const renderer = new Renderer(makeStdout(rw), () => 10, () => 10)
    const cursor = { fromEnd: 3, col: 5 }
    renderer.render(['old-1', 'old-2', 'old-3', 'old-input', 'old-f1', 'old-f2'], ['welcome-1', 'welcome-2'], cursor)
    renderer.render(['', '', '', '', 'new-1', 'new-2', 'new-3', 'new-input', 'new-f1', 'new-f2'], [], cursor)
    const all = paintScreen(rw, 10, true)
    const sep = all.indexOf('── viewport ──')
    const viewport = all.slice(sep + 1)
    const tail = viewport.slice(-5).join('\n')
    if (!tail.includes('new-input') || !tail.includes('new-f2')) problems.push(`phase0.65：live 扩展后 chrome 未锚底：${JSON.stringify(viewport)}`)
  }

  // ── Phase 0.85: turn settlement lands one summary row on exact durable
  // timestamps (45 output tokens over 0.6s ⇒ 75.0 tok/s); token-free turns
  // settle nothing. The row must stay TERSE: no provider prefix, and the model
  // only when it differs from the previous turn's ─────────────────────────────
  {
    const ch = new Channel()
    const t0 = Date.now()
    ch.ingest({ type: 'request/header', seq: 0, time: t0, data: { header: { config: { provider: 'p', model: 'm' } } } } as never)
    ch.ingest({ type: 'turn/start', seq: 1, time: t0, data: { turn: 1 } } as never)
    ch.ingest({ type: 'assistant/message', seq: 2, time: t0 + 600, data: { usage: { inputTokens: 120, outputTokens: 45, reasoningTokens: 30, cacheReadTokens: 60, cacheWriteTokens: 15 } } } as never)
    ch.ingest({ type: 'turn/end', seq: 3, time: t0 + 600, data: { turn: 1, reason: { kind: 'completed' } } } as never)
    const transcript = ch.rows.map((row) => row.text).join('\n')
    for (const expect of ['✓ 本轮', ' · m · ', '0.6s', '75.0 tok/s', '↑120 ↓45', '✻30', '⇄75 缓存']) {
      if (!transcript.includes(expect)) problems.push(`phase0.85：回合结算行缺「${expect}」：${transcript}`)
    }
    if (transcript.includes('p/m')) problems.push(`phase0.85：结算行不应重复 provider 前缀：${transcript}`)
    if (transcript.includes('用时')) problems.push(`phase0.85：结算行不应带「用时」标签：${transcript}`)
    if (ch.usage.cacheRead !== 60 || ch.usage.cacheWrite !== 15) {
      problems.push(`phase0.85：缓存 token 未累加：${JSON.stringify(ch.usage)}`)
    }
    // Second turn on the SAME route: the model name is not repeated.
    ch.ingest({ type: 'assistant/message', seq: 4, time: t0 + 700, data: { usage: { inputTokens: 10, outputTokens: 5 } } } as never)
    ch.ingest({ type: 'assistant/message', seq: 5, time: t0 + 800, data: { usage: { inputTokens: 10, outputTokens: 5 } } } as never)
    ch.ingest({ type: 'turn/start', seq: 6, time: t0 + 700, data: { turn: 2 } } as never)
    ch.ingest({ type: 'assistant/message', seq: 7, time: t0 + 1000, data: { usage: { inputTokens: 10, outputTokens: 5 } } } as never)
    ch.ingest({ type: 'turn/end', seq: 8, time: t0 + 1300, data: { turn: 2, reason: { kind: 'completed' } } } as never)
    const summaries = ch.rows.filter((row) => row.text.startsWith('✓ 本轮'))
    if (summaries.length !== 2) problems.push(`phase0.85：回合结算行数量异常：${String(summaries.length)}`)
    if (summaries[1]?.text.includes(' · m · ')) {
      problems.push(`phase0.85：同路由的第二轮不应重复模型名：${summaries[1]?.text ?? ''}`)
    }
    // A real switch IS announced again.
    ch.ingest({ type: 'request/header', seq: 9, time: t0 + 1400, data: { header: { config: { provider: 'q', model: 'm2' } } } } as never)
    ch.ingest({ type: 'turn/start', seq: 10, time: t0 + 1400, data: { turn: 3 } } as never)
    ch.ingest({ type: 'assistant/message', seq: 11, time: t0 + 1700, data: { usage: { inputTokens: 10, outputTokens: 5 } } } as never)
    ch.ingest({ type: 'turn/end', seq: 12, time: t0 + 2000, data: { turn: 3, reason: { kind: 'completed' } } } as never)
    const third = ch.rows.filter((row) => row.text.startsWith('✓ 本轮'))[2]
    if (third === undefined || !third.text.includes(' · m2 · ')) {
      problems.push(`phase0.85：切模型后的结算行应重新带上模型名：${third?.text ?? '(缺)'}`)
    }
    const before = ch.rows.length
    ch.ingest({ type: 'turn/start', seq: 13, time: t0 + 2100, data: { turn: 4 } } as never)
    ch.ingest({ type: 'turn/end', seq: 14, time: t0 + 2200, data: { turn: 4, reason: { kind: 'cancelled' } } } as never)
    if (ch.rows.length !== before) problems.push('phase0.85：空回合不应落结算行')
  }

  // ── Phase 0.86: box frames paint EVERY frame glyph with the border color ──
  // A box whose straight runs fall back to the terminal's default foreground
  // reads as a white line with four colored dots (the cmd.exe report).
  {
    const border = (text: string): string => `\x1b[34m${text}\x1b[39m`
    const style = { bg: (text: string): string => text, border }
    const top = boxTop(20, style)
    const bottom = boxBottom(20, style)
    const line = boxLine('hi', 20, style)
    const blueRuns = (text: string): number => (text.match(/\x1b\[34m─+\x1b\[39m/g) ?? []).length
    if (blueRuns(top) === 0) problems.push('phase0.86：boxTop 的横线未着边框色')
    if (blueRuns(bottom) === 0) problems.push('phase0.86：boxBottom 的横线未着边框色')
    if (!line.includes('\x1b[34m│\x1b[39m')) problems.push('phase0.86：boxLine 的竖线未着边框色')
  }

  // ── Phase 0.86: the thought row collapses the moment visible text starts
  // (and on reasoning `block-end`) — the spinner must not run under the
  // streaming answer ───────────────────────────────────────────────────────
  {
    // The live path (dsh ≥ 0.1.5): deltas arrive as `agent/assistant-stream`
    // chunk frames, never as session events.
    const ch = new Channel()
    ch.ingest({ type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 1 } } as never)
    ch.beginAttempt()
    ch.ingestStreamChunk({ type: 'reasoning-delta', index: 0, text: '想一下' })
    const open = ch.rows.find((row) => row.kind === 'thought')
    if (!open || open.seconds !== undefined) problems.push('phase0.86：思考行应该先保持展开流式')
    ch.ingestStreamChunk({ type: 'text-delta', index: 0, text: '正文开始' })
    const sealed = ch.rows.find((row) => row.kind === 'thought')
    if (!sealed || sealed.seconds === undefined) problems.push('phase0.86：正文开始后思考行未折叠为已思考')
    // Block-framed protocol: reasoning block-end seals even before any text.
    const ch2 = new Channel()
    ch2.ingest({ type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 1 } } as never)
    ch2.beginAttempt()
    ch2.ingestStreamChunk({ type: 'reasoning-delta', index: 0, text: '想一下' })
    ch2.ingestStreamChunk({ type: 'block-end', index: 0, block: { type: 'reasoning', text: '想一下' } })
    const sealed2 = ch2.rows.find((row) => row.kind === 'thought')
    if (!sealed2 || sealed2.seconds === undefined) problems.push('phase0.86：reasoning block-end 未折叠思考行')
    // The legacy in-log chunk shape stays supported (older persisted logs).
    const ch3 = new Channel()
    ch3.ingest({ type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 1 } } as never)
    ch3.ingest({ type: 'assistant/chunk', seq: 1, time: Date.now(), data: { chunk: { type: 'text-delta', index: 0, text: '旧日志' } } } as never)
    if (!ch3.rows.some((row) => row.kind === 'assistant' && row.text === '旧日志')) {
      problems.push('phase0.86：旧版 assistant/chunk 日志未投影')
    }
  }

  // ── Phase 0.87: replay (dsh ≥ 0.1.5) — the log has NO chunks, so the
  // durable `assistant/message` content is the only text source; a live turn
  // that already streamed must not double-project it ────────────────────────
  {
    const message = {
      id: 'msg-1',
      role: 'assistant',
      content: [
        { type: 'reasoning', text: '先想' },
        { type: 'text', text: '答复正文' },
      ],
      source: { kind: 'model' },
    }
    const log = [
      { type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: Date.now(), data: { content: [{ type: 'text', text: '问' }], source: { kind: 'user' } } },
      { type: 'step/start', seq: 2, time: Date.now(), data: { turn: 1, step: 1 } },
      { type: 'assistant/message', seq: 3, time: Date.now(), data: { turn: 1, step: 1, message, stream: [] } },
      { type: 'step/end', seq: 4, time: Date.now(), data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 5, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const ch = new Channel()
    ch.replay(log as never)
    const answer = ch.rows.filter((row) => row.kind === 'assistant')
    const thought = ch.rows.filter((row) => row.kind === 'thought')
    if (answer.length !== 1 || answer[0]?.text !== '答复正文') {
      problems.push(`phase0.87：replay 未从 assistant/message 投影正文：${JSON.stringify(ch.rows.map((r) => [r.kind, r.text]))}`)
    }
    if (thought.length !== 1 || thought[0]?.seconds === undefined) {
      problems.push('phase0.87：replay 未投影（并折叠）思考行')
    }
    // Same log, but live: deltas first, then the settling event.
    const live = new Channel()
    for (const event of log.slice(0, 3)) live.ingest(event as never)
    live.beginAttempt()
    live.ingestStreamChunk({ type: 'reasoning-delta', index: 0, text: '先想' })
    live.ingestStreamChunk({ type: 'text-delta', index: 1, text: '答复正文' })
    live.ingest(log[3] as never)
    const liveAnswer = live.rows.filter((row) => row.kind === 'assistant')
    const liveThought = live.rows.filter((row) => row.kind === 'thought')
    if (liveAnswer.length !== 1 || liveAnswer[0]?.text !== '答复正文') {
      problems.push(`phase0.87：live 流式正文被重复/篡改：${JSON.stringify(live.rows.map((r) => [r.kind, r.text]))}`)
    }
    if (liveThought.length !== 1) {
      problems.push(`phase0.87：live 思考行重复：${String(liveThought.length)}`)
    }
    // File blocks (new in 0.1.5) must label the row instead of degrading to a
    // bare `…` — and co-exist with image labels.
    const chFiles = new Channel()
    chFiles.ingest({
      type: 'user/message',
      seq: 0,
      time: Date.now(),
      data: {
        content: [
          { type: 'image', attachment: { attachmentId: 'i1', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
          { type: 'file', attachment: { attachmentId: 'f1', name: 'a.pdf', bytes: 3 } },
        ],
        source: { kind: 'user' },
      },
    } as never)
    const userRow = chFiles.rows.find((row) => row.kind === 'user')
    if (userRow?.text !== '[image #1] [file #1]') {
      problems.push(`phase0.87：附件标签渲染异常：「${userRow?.text ?? '(无行)'}」`)
    }
  }

  // ── Phase 1: degraded boot (#183) — no `agents` service, never a throw ───
  const writes1: string[] = []
  const kernel1 = new FakeKernel(false)
  const dispose1 = bootstrapApp(
    kernel1,
    { provider: '', model: '', fullscreen: false },
    { stdout: () => makeStdout(writes1), stdin: () => new FakeStdin() },
  )
  await sleep(150)
  dispose1()
  const painted1 = writes1.join('')
  const visible1 = stripSgr(painted1)
  if (writes1.length === 0) problems.push('phase1：没有帧写入')
  if (!visible1.includes('agents` 未挂载')) problems.push('phase1：降级启动提示缺失')

  // ── Phase 2: mounted fake kernel, real contract, real keyboard drive ────
  const writes2: string[] = []
  const stdin2 = new FakeStdin()
  const kernel2 = new FakeKernel(true)
  const dispose2 = bootstrapApp(
    kernel2,
    // Empty provider/model: the composition default (agentDefaultModel) must
    // be picked up — the exact path the real profile exercises.
    { provider: '', model: '', fullscreen: false },
    { stdout: () => makeStdout(writes2), stdin: () => stdin2 },
  )
  await sleep(250) // create() retries once (factory pending), then connects
  stdin2.key('escape') // Esc with an empty editor → agent.cancel({kind:'user'})
  for (const ch of '帮我看看') stdin2.text(ch)
  stdin2.key('return')
  await sleep(850) // the scripted turn streams through (incl. usage @560ms)
  if (!stripSgr(writes2.join('')).includes('思考中')) problems.push('phase2：思考中状态未上屏')

  // Type + backspace WITHOUT submitting: the chrome must stay a single copy.
  // Regression guard for cursor-accounted repaints — when the painter forgot
  // where placeCursor left the cursor, every keystroke smeared a new
  // hint+footer block down the screen.
  stdin2.text('试')
  await sleep(100)
  stdin2.key('backspace')
  await sleep(100)
  {
    const snap = paintScreen(writes2, 24)
    const countOf = (needle: string): number => snap.filter((row) => row.includes(needle)).length
    if (countOf('> 说点什么...') !== 1) problems.push('phase2：编辑后输入行重复/缺失')
    if (countOf('Enter 发送') !== 1) problems.push('phase2：编辑后提示行重复/缺失')
    if (snap.some((row) => row.includes('思考中...'))) problems.push('phase2：idle 页脚不应显示思考中徽标')
    if (!snap.some((row) => row.includes('↑120'))) problems.push('phase2：turn/end 后用量未上屏')
    if (snap.some((row) => row.includes('试说'))) problems.push('phase2：退格后占位符残留输入字符')
  }

  // /model picker: open → provider → model → effort(down to 低) → applied
  for (const ch of '/model') stdin2.text(ch)
  stdin2.key('return')
  await sleep(150) // provider list loads
  stdin2.key('return') // pick Fake A
  await sleep(150) // model list loads
  stdin2.key('return') // pick fake-a-m1
  await sleep(150) // efforts load
  stdin2.key('down') // move to 低
  stdin2.key('return') // pick 低
  await sleep(250) // selection applies + saveSelection settles

  // Arrow keys in the editor must no-op, never smear CSI garbage into the
  // prompt — regression guard for the navigate classification. Submitted
  // text must be exactly 'q1'.
  for (const ch of 'q1') stdin2.text(ch)
  stdin2.key('up')
  stdin2.key('return')
  await sleep(120)
  // Snapshot BEFORE dispose: dispose intentionally wipes the live region
  // (including the footer) — the final chrome check targets the live UI.
  const rows2 = paintScreen(writes2, 24)
  dispose2()
  await sleep(20) // handle.dispose() settles

  const painted2 = writes2.join('')
  const visible2 = stripSgr(painted2)
  const record = kernel2.record
  if (writes2.length === 0) problems.push('phase2：没有帧写入')
  if (visible2.includes('agent 启动失败')) problems.push('phase2：工厂未就绪竞态未被重试吸收')
  if (!visible2.includes('session 已连接')) problems.push('phase2：session 连接提示缺失')
  if (!visible2.includes('帮我看看')) problems.push('phase2：user/message 未投影（session 非真源）')
  if (!visible2.includes('你好，Orca。')) problems.push('phase2：assistant 流式转录缺失')
  if (!visible2.includes('流式增量上屏测试。')) problems.push('phase2：增量 chunk 未并入同一行')
  if (!visible2.includes('• 列表一') || !visible2.includes('• 列表二')) problems.push('phase2：markdown 列表未渲染')
  if (!visible2.includes('╭─ ts ')) problems.push('phase2：围栏代码块未渲染')
  if (!visible2.includes('const n = 1')) problems.push('phase2：代码行未渲染')
  if (!visible2.includes('思考一下。')) problems.push('phase2：reasoning-delta 未进思考行')
  if (!/已思考 \d+(\.\d+)?s/.test(visible2)) problems.push('phase2：思考块未折叠为时长摘要')
  if (!visible2.includes('✓ edit src/app.ts')) problems.push('phase2：工具 diff 卡头未渲染')
  if (!visible2.includes('+ const a = 2') || !visible2.includes('- const a = 1')) problems.push('phase2：diff 增删行未着色渲染')
  if (!visible2.includes('+ const b = 3')) problems.push('phase2：diff 新增行缺失')
  if (!visible2.includes('✦ orca')) problems.push('phase2：欢迎区缺失')
  if (!visible2.includes('Directory:')) problems.push('phase2：欢迎区信息行缺失')
  if (!visible2.includes('↳ 模型 default-provider/default-model')) problems.push('phase2：路由线未打印')
  if (!visible2.includes('default-provider/default-model')) problems.push('phase2：页脚未显示 request/header 路由')
  if (!visible2.includes('↑120') || !visible2.includes('↓45')) problems.push('phase2：token 用量未上屏')
  for (const expect of ['选择 Provider', '选择模型（fake-a）', '选择思考强度（fake-a-m1）', '模型已切换：fake-a/fake-a-m1(low)']) {
    if (!visible2.includes(expect)) problems.push(`phase2：/model 流程缺少「${expect}」`)
  }
  if (record.selectionSaved?.provider !== 'fake-a' || record.selectionSaved.model !== 'fake-a-m1' || record.selectionSaved.reasoningEffort !== 'low') {
    problems.push('phase2：saveSelection 未持久化选择')
  }
  // The model must LEARN about the switch (durable injected notice, the
  // behavior the kernel's installModelSelection provides) — and only once,
  // sourced `plugin` so the transcript never shows it as a human prompt.
  {
    const injected = record.injected
    if (injected.length !== 1) problems.push(`phase2：模型切换未注入一次告知：${injected.length}`)
    const notice = injected[0]
    const text = notice?.content[0]
    if (notice?.source['kind'] !== 'plugin') problems.push('phase2：切换告知的 source 应为 plugin')
    if (text?.type !== 'text' || !text.text.includes('fake-a/fake-a-m1') || !text.text.includes('low')) {
      problems.push(`phase2：切换告知内容异常：${JSON.stringify(text ?? null)}`)
    }
    if (visible2.includes('[orca] The active model')) problems.push('phase2：切换告知不应进入转录')
  }
  const listener = record.requestListener
  if (!listener) {
    problems.push('phase2：agent/request waterfall 监听未注册')
  } else {
    const rewritten = (await listener({}, async () => ({ provider: 'x', model: 'y', reasoningEffort: 'old' }))) as Record<string, unknown>
    if (rewritten['provider'] !== 'fake-a' || rewritten['model'] !== 'fake-a-m1' || rewritten['reasoningEffort'] !== 'low') {
      problems.push('phase2：waterfall 未按选择改写请求路由')
    }
  }
  if (record.createOptions === null || !/^session-/.test(record.createOptions.sessionId)) {
    problems.push('phase2：create 未收到规范的 sessionId')
  }
  if (record.createOptions?.meta?.cwd !== process.cwd()) problems.push('phase2：create 未携带 cwd')
  if (record.createOptions?.agentOptions?.provider !== 'default-provider') problems.push('phase2：agentOptions.provider 未取组合默认路由')
  if (record.createOptions?.agentOptions?.model !== 'default-model') problems.push('phase2：agentOptions.model 未取组合默认模型')
  if (record.createOptions?.agentOptions?.reasoningEffort !== 'medium') problems.push('phase2：agentOptions.reasoningEffort 丢失组合默认思考强度')
  if (!visible2.includes('default-provider/default-model(medium)')) {
    problems.push('phase2：思考强度未在路由线/页脚显示（attach 时被丢弃）')
  }
  // The LAST followup is the arrow-guard submit; its text proves the editor
  // stayed clean ('帮我看看' projection is asserted via the painted frames).
  const lastFollowup = record.followupMessage
  const lastBlock = lastFollowup?.content[0]
  if (lastBlock?.type !== 'text' || lastBlock.text !== 'q1') {
    problems.push(`phase2：编辑器方向键混入转义垃圾：${JSON.stringify(lastFollowup ?? null)}`)
  }
  if (lastFollowup?.source['kind'] !== 'user') problems.push('phase2：followup 消息缺 user 来源')
  if (record.cancelCause?.kind !== 'user') problems.push('phase2：cancel 未携带 user 原因')
  if (!record.disposed) problems.push('phase2：dispose 未触达 handle.dispose')

  // Final VISIBLE screen tail must be the intact bottom chrome: editor box
  // (top → prompt → bottom) + footer L1 → L2, each exactly once.
  while (rows2.length > 0 && rows2[rows2.length - 1] === '') rows2.pop()
  const tail = rows2.slice(-5)
  const hint = 'Enter 发送 · Alt+Enter 换行 · /model · @文件 · Ctrl+V 图片 · Esc 取消 · Ctrl+C 退出'
  if (tail.length !== 5) problems.push(`phase2：最终画面尾部不足 5 行：${JSON.stringify(rows2.slice(-7))}`)
  const promptRow = rows2.find((row) => row.includes('> 说点什么...'))
  if (promptRow === undefined) {
    problems.push(`phase2：输入行不完整：${JSON.stringify(rows2.slice(-8))}`)
  }
  if (!rows2.some((row) => row.includes(hint))) problems.push(`phase2：提示行缺失或不唯一：${JSON.stringify(tail)}`)
  // The q1 submit opened the second turn — the footer badge is mid-turn here.
  const footerRow = rows2.find((row) => row.includes('思考中...'))
  if (footerRow === undefined) problems.push(`phase2：页脚缺失或状态不符：${JSON.stringify(tail)}`)
  // The /model switch happened before q1 — the footer must show the LIVE selection.
  if (footerRow === undefined || !footerRow.includes('fake-a/fake-a-m1(low)')) problems.push(`phase2：页脚未反映切换后路由：${JSON.stringify(footerRow)}`)

  // ── Phase 3: M3 会话命令 + M4 审批/压缩/hook/回退 ──────────────────────────
  const writes3: string[] = []
  const stdin3 = new FakeStdin()
  const kernel3 = new FakeKernel(true)
  const dispose3 = bootstrapApp(
    kernel3,
    { provider: '', model: '', fullscreen: false },
    { stdout: () => makeStdout(writes3), stdin: () => stdin3 },
  )
  await sleep(250)
  const visible3 = (): string => stripSgr(writes3.join(''))
  const typeLine = async (line: string): Promise<void> => {
    for (const ch of line) stdin3.text(ch)
    stdin3.key('return')
    await sleep(120)
  }

  await typeLine('/help')
  if (!visible3().includes('【任务】/todo') || !visible3().includes('/resume')) problems.push('phase3：/help 未列出会话命令')
  await typeLine('/usage')
  if (!visible3().includes('用量')) problems.push('phase3：/usage 未上屏')
  // Turn summary: one scripted turn settles a `✓ 本轮 · 用时 · tok/s` row.
  await typeLine('压测速度')
  await sleep(900)
  if (!visible3().includes('✓ 本轮') || !visible3().includes('tok/s')) {
    problems.push('phase3：回合结束缺结算行（✓ 本轮 · 用时 · tok/s）')
  }
  if (!visible3().includes('⇄75 缓存')) problems.push('phase3：结算行缺缓存命中段')
  await typeLine('/title 新标题')
  if (kernel3.record.titleRenamed !== '新标题') problems.push('phase3：/title 未调用 rename')
  if (!visible3().includes('标题已更新')) problems.push('phase3：/title 确认缺失')
  await typeLine('/title')
  if (!visible3().includes('会话标题')) problems.push('phase3：/title 查看缺失')
  await typeLine('/yolo on')
  if (!visible3().includes('yolo 已开启')) problems.push('phase3：/yolo on 未上屏')
  // Yolo auto-allow: the waterfall resolves without any panel.
  {
    const listener = kernel3.record.approvalListener
    if (!listener) problems.push('phase3：approval waterfall 未注册')
    else {
      const outcome = (await listener({ toolName: 'read', reason: '单测' }, async () => 'rejected')) as string
      if (outcome !== 'allowed-once') problems.push(`phase3：yolo 未自动放行：${outcome}`)
    }
  }
  await typeLine('/yolo off')
  if (!visible3().includes('yolo 已关闭')) problems.push('phase3：/yolo off 未上屏')
  await typeLine('/nerdfont on')
  if (!visible3().includes('Nerd Font 分支图标已开启')) problems.push('phase3：/nerdfont on 未上屏')
  await typeLine('/nerdfont off')
  if (!visible3().includes('Nerd Font 分支图标已关闭')) problems.push('phase3：/nerdfont off 未上屏')
  // Panel path: the ask pends, the picker shows, `1` allows. The ask carries
  // the exact `callId`, so the panel quotes the pending tool call's arguments
  // instead of asking the user to approve a bare tool name.
  {
    const listener = kernel3.record.approvalListener
    if (listener) {
      kernel3.emit('tool/call', { turn: 1, step: 1, callId: 'call-approve', name: 'edit', arguments: '{"path":"src/app.ts"}' })
      await sleep(60)
      const pending = listener(
        { toolName: 'edit', callId: 'call-approve', reason: '改文件' },
        async () => 'rejected',
      ) as Promise<string>
      await sleep(150)
      if (!visible3().includes('审批：edit')) problems.push('phase3：审批面板未上屏')
      if (!visible3().includes('src/app.ts')) problems.push('phase3：审批面板未按 callId 引用工具调用参数')
      stdin3.text('1')
      await sleep(100)
      const outcome = await pending
      if (outcome !== 'allowed-once') problems.push(`phase3：面板按 1 未放行：${outcome}`)
      // The decided tool row keeps its own id; the panel must not have eaten it.
      kernel3.emit('tool/result', {
        turn: 1,
        step: 1,
        message: { id: 'm1', role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-approve', content: [{ type: 'text', text: 'done' }] }] },
      })
      await sleep(60)
      // Close the turn: the following `/compact` is idle-gated, and a running
      // tool row would (correctly) make it refuse.
      kernel3.emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await sleep(60)
    }
  }
  // Esc on the panel rejects.
  {
    const listener = kernel3.record.approvalListener
    if (listener) {
      const pending = listener({ toolName: 'bash', reason: '跑命令' }, async () => 'allowed-once') as Promise<string>
      await sleep(150)
      stdin3.key('escape')
      await sleep(100)
      const outcome = await pending
      if (outcome !== 'rejected') problems.push(`phase3：面板 Esc 未拒绝：${outcome}`)
    }
  }
  await typeLine('/permission')
  if (!visible3().includes('审批策略')) problems.push('phase3：/permission 未上屏')
  await typeLine('/compact 留重点')
  await sleep(120)
  if (kernel3.record.compactLine !== '/compact 留重点') problems.push(`phase3：/compact 未经 commands.execute：${kernel3.record.compactLine}`)
  kernel3.emit('compaction/start', { compactionId: 'c1', turn: null })
  await sleep(80)
  kernel3.emit('compaction/summary', {
    compactionId: 'c1',
    summary: [{ type: 'text', text: '摘要正文' }],
    shadowedRange: { start: 0, end: 1 },
    shadowedSeqs: [0, 1],
    shadowedTokenCount: 123,
    provider: 'p',
    model: 'm',
  })
  await sleep(80)
  kernel3.emit('compaction/end', { compactionId: 'c1', turn: null })
  await sleep(80)
  if (!visible3().includes('压缩完成')) problems.push('phase3：compaction 投影缺失')
  kernel3.emit('session/title', { title: '会话A', messageSeqs: [], source: { kind: 'user' } })
  await sleep(80)
  if (!visible3().includes('会话A')) problems.push('phase3：session/title 未上屏（页脚/标题）')
  kernel3.emit('hook/invoked', { turn: 1, point: 'PreToolUse', dialect: 'claude-code', handlerId: 'h1' })
  await sleep(60)
  kernel3.emit('hook/result', { turn: 1, point: 'PreToolUse', handlerId: 'h1', decision: 'allow', durationMs: 5 })
  await sleep(60)
  if (!visible3().includes('hook')) problems.push('phase3：hook 投影缺失')
  kernel3.emit('approval/asked', { id: 'a1', toolName: 'write', reason: '写文件' })
  await sleep(60)
  kernel3.emit('approval/decided', { id: 'a1', outcome: 'allowed-once' })
  await sleep(60)
  if (!visible3().includes('请求审批') || !visible3().includes('审批结果')) problems.push('phase3：approval 审计投影缺失')
  // The audit pair is correlated by `id`: the result row names its own tool
  // even when several asks are interleaved.
  if (!visible3().includes('审批结果（write）')) problems.push('phase3：审批审计未按 id 配对')
  // /resume browser lists fake sessions with titles.
  for (const ch of '/resume') stdin3.text(ch)
  stdin3.key('return')
  await sleep(250)
  if (!visible3().includes('历史会话') || !visible3().includes('假标题A')) problems.push('phase3：/resume 浏览器未列出标题')
  stdin3.key('escape') // close the browser
  await sleep(100)
  // Rewind: two closed turns → double-Esc forks to the previous boundary.
  kernel3.emit('turn/start', { turn: 1 })
  await sleep(40)
  kernel3.emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await sleep(40)
  kernel3.emit('turn/start', { turn: 2 })
  await sleep(40)
  kernel3.emit('turn/end', { turn: 2, reason: { kind: 'completed' } })
  await sleep(80)
  stdin3.key('escape')
  await sleep(40)
  stdin3.key('escape')
  await sleep(250)
  if (!kernel3.record.forkCalled) problems.push('phase3：双击 Esc 未触发回退 fork')
  if (!visible3().includes('已回退')) problems.push('phase3：回退确认缺失')
  // Welcome must wait for the connection: Session/Model rows carry real
  // values, never the `—`/`未设置` placeholders of a pre-connect render.
  if (!visible3().includes('✦ orca')) problems.push('phase3：欢迎卡缺失')
  if (visible3().includes('未设置')) problems.push('phase3：欢迎卡抢跑（连接前渲染）')
  dispose3()
  await sleep(20)

  // ── Phase 4: 欢迎卡延迟 + 服务懒探测 + / 命令菜单 ──────────────────────────
  const writes4: string[] = []
  const stdin4 = new FakeStdin()
  const kernel4 = new FakeKernel(true)
  kernel4.hideSessionQuery = true // registered "later" — eager capture would miss it forever
  const dispose4 = bootstrapApp(
    kernel4,
    { provider: '', model: '', fullscreen: false },
    { stdout: () => makeStdout(writes4), stdin: () => stdin4 },
  )
  await sleep(300)
  const visible4 = (): string => stripSgr(writes4.join(''))
  // Service registered after boot must still resolve (lazy probe, not
  // bootstrap-time capture).
  for (const ch of '/resume') stdin4.text(ch)
  stdin4.key('return')
  await sleep(120)
  if (!visible4().includes('sessionQuery 服务未挂载')) problems.push('phase4：缺失服务应明确提示')
  stdin4.key('escape') // clear the editor
  await sleep(80)
  kernel4.hideSessionQuery = false
  for (const ch of '/resume') stdin4.text(ch)
  stdin4.key('return')
  await sleep(250)
  if (!visible4().includes('历史会话')) problems.push('phase4：后注册的 sessionQuery 未被懒探测到')
  stdin4.key('escape')
  await sleep(100)
  // Inline menu: `/` lists commands without submitting.
  stdin4.text('/')
  await sleep(120)
  {
    const snap = paintScreen(writes4, 24)
    if (!snap.some((row) => row.includes('/resume'))) problems.push('phase4：/ 菜单未列出 /resume')
    if (!snap.some((row) => row.includes('/help'))) problems.push('phase4：/ 菜单未列出 /help')
  }
  // ↓ + Tab completes the highlighted entry into the editor.
  stdin4.key('down')
  await sleep(80)
  stdin4.key('tab')
  await sleep(80)
  {
    const snap = paintScreen(writes4, 24)
    if (!snap.some((row) => row.includes('> /model'))) problems.push('phase4：Tab 未补全高亮命令')
  }
  stdin4.key('escape') // clear editor
  await sleep(80)
  // Partial input + Enter completes first, dispatches on the second Enter.
  for (const ch of '/usa') stdin4.text(ch)
  await sleep(80)
  stdin4.key('return')
  await sleep(100)
  {
    const snap = paintScreen(writes4, 24)
    if (!snap.some((row) => row.includes('> /usage'))) problems.push('phase4：Enter 未补全部分命令')
    if (visible4().includes('用量：')) problems.push('phase4：补全回车不应直接分发')
  }
  stdin4.key('return')
  await sleep(120)
  if (!visible4().includes('用量：')) problems.push('phase4：补全后回车未分发 /usage')
  stdin4.key('escape')
  await sleep(80)
  // Kernel-registered commands join the same inline menu (dsh-commands).
  for (const ch of '/g') stdin4.text(ch)
  await sleep(120)
  {
    const snap = paintScreen(writes4, 24)
    if (!snap.some((row) => row.includes('/goal'))) problems.push('phase4：/ 菜单未列入内核命令')
    if (snap.some((row) => row.includes('/compact 压缩上下文'))) {
      problems.push('phase4：本地同名命令应遮蔽内核命令')
    }
  }
  stdin4.key('escape')
  await sleep(80)
  // `commands/change` must refresh the discovered list live.
  kernel4.extraCommands = [
    { name: 'goal', description: '目标模式' },
    { name: 'schedule', description: '定时任务' },
  ]
  kernel4.emitKernelEvent('commands/change')
  await sleep(80)
  for (const ch of '/sch') stdin4.text(ch)
  await sleep(120)
  if (!paintScreen(writes4, 24).some((row) => row.includes('/schedule'))) {
    problems.push('phase4：commands/change 未刷新菜单')
  }
  stdin4.key('escape')
  await sleep(80)
  dispose4()
  await sleep(20)

  // ── Phase 5: 同进程静默重挂载（热重载不再叠欢迎卡/建新会话）────────────────
  const writes5a: string[] = []
  const kernel5 = new FakeKernel(true)
  const dispose5a = bootstrapApp(
    kernel5,
    { provider: '', model: '', fullscreen: false },
    { stdout: () => makeStdout(writes5a), stdin: () => new FakeStdin() },
  )
  await sleep(300)
  const session5 = kernel5.record.createOptions?.sessionId
  if (!session5) problems.push('phase5：首次挂载未建会话')
  if (!stripSgr(writes5a.join('')).includes('✦ orca')) problems.push('phase5：首次挂载缺欢迎卡')
  dispose5a()
  await sleep(50)
  // Same process, same pid-file, previous agent disposed: the remount must
  // RESUME the session (no fresh create) with no welcome card, replaying the
  // durable log into the fresh channel.
  const createsBefore = kernel5.record.createCalls
  const writes5b: string[] = []
  const stdin5b = new FakeStdin()
  const dispose5b = bootstrapApp(
    kernel5,
    { provider: '', model: '', fullscreen: false },
    { stdout: () => makeStdout(writes5b), stdin: () => stdin5b },
  )
  await sleep(300)
  const visible5b = stripSgr(writes5b.join(''))
  if (kernel5.record.resumedId !== session5) problems.push(`phase5：重挂载未恢复同一会话：${kernel5.record.resumedId}`)
  if (kernel5.record.createCalls > createsBefore + 1) problems.push('phase5：重挂载建了多余会话')
  if (visible5b.includes('✦ orca')) problems.push('phase5：重挂载不应再刷欢迎卡')
  if (!visible5b.includes('hi 历史')) problems.push('phase5：持久化日志未重放进转录')
  dispose5b()
  await sleep(20)

  // ── Phase 6: pinned chrome + gradual aging — the /model picker flow
  // must neither move the editor row nor eat the welcome card: the editor
  // sits on the same viewport row before/after, and `✦ orca` stays in view.
  {
    const rw: string[] = []
    const stdin6 = new FakeStdin()
    const kernel6 = new FakeKernel(true)
    const dispose6 = bootstrapApp(
      kernel6,
      { provider: '', model: '', fullscreen: false },
      { stdout: () => makeStdout(rw), stdin: () => stdin6 },
    )
    await sleep(250)
    const editorBefore = paintScreen(rw, 24).findIndex((row) => row.includes('> 说点什么...'))
    for (const ch of '/model') stdin6.text(ch)
    stdin6.key('return')
    await sleep(150)
    stdin6.key('return') // provider
    await sleep(150)
    stdin6.key('return') // model
    await sleep(150)
    stdin6.key('return') // effort 默认
    await sleep(250) // selection applies + route line flushes
    const snap6 = paintScreen(rw, 24)
    const editorRow6 = snap6.findIndex((row) => row.includes('> 说点什么...'))
    if (editorRow6 < 0) {
      problems.push('phase6：picker 关闭后编辑框缺失')
    } else {
      if (editorRow6 !== editorBefore) {
        problems.push(`phase6：picker 流程移动了输入框行（${editorBefore}→${editorRow6}）`)
      }
      if (!snap6.some((row) => row.includes('✦ orca'))) {
        problems.push('phase6：picker 流程后欢迎卡不在屏上')
      }
      if (!snap6.some((row) => row.includes('模型已切换：fake-a/fake-a-m1'))) {
        problems.push('phase6：模型切换提示缺失')
      }
    }
    dispose6()
    await sleep(20)
  }

  // ── Phase 7: fullscreen (alternate screen) — the frame fills EXACTLY the
  // terminal height, the footer is pinned to the last row, the transcript is
  // a sliding window (head note when it overflows), and nothing ever seals.
  {
    const rw: string[] = []
    const stdin7 = new FakeStdin()
    const kernel7 = new FakeKernel(true)
    const dispose7 = bootstrapApp(
      kernel7,
      { provider: '', model: '', fullscreen: true },
      { stdout: () => makeStdout(rw, 24), stdin: () => stdin7 },
    )
    await sleep(250)
    for (const ch of '测') stdin7.text(ch)
    stdin7.key('return')
    await sleep(850) // first scripted turn
    for (const ch of '再') stdin7.text(ch)
    stdin7.key('return')
    await sleep(850) // second turn overflows the window
    const snap7 = paintScreen(rw, 24)
    if (snap7.length !== 24) problems.push(`phase7：fullscreen 屏高应为 24 行，实际 ${snap7.length}`)
    if (!snap7[23].includes('Ctrl+C 退出')) problems.push('phase7：fullscreen 页脚未钉在末行')
    if (!snap7.some((row) => row.includes('> 说点什么...'))) problems.push('phase7：fullscreen 编辑框缺失')
    if (!snap7.some((row) => row.includes('上方还有'))) problems.push('phase7：窗口溢出后缺头注')
    if (!snap7.some((row) => row.includes('✓ 本轮'))) problems.push('phase7：转录窗口缺回合结算行')

    // Mouse wheel scrolls the alt-screen window (there is no native
    // scrollback in the alternate screen).
    stdin7.text('\x1b[<64;20;10M') // wheel up
    await sleep(160)
    const scrolled7 = paintScreen(rw, 24)
    if (!scrolled7.some((row) => row.includes('下方'))) {
      problems.push(`phase7：滚轮上滚未移动全屏窗口：${JSON.stringify(scrolled7.slice(0, 3))}`)
    }
    stdin7.text('\x1b[<65;20;10M') // wheel down → back to the live tail
    await sleep(160)
    if (!paintScreen(rw, 24).some((row) => row.includes('上方还有'))) {
      problems.push('phase7：滚轮下滚未回到实时尾部')
    }

    // Drag selection + OSC 52 copy (alt screen only): press on a text row,
    // drag right, release — the app must emit the clipboard sequence.
    {
      const rows7 = paintScreen(rw, 24)
      const target = rows7.findIndex((row) => /[\u4e00-\u9fa5A-Za-z]/.test(row))
      if (target === -1) {
        problems.push('phase7：找不到可选择的文本行')
      } else {
        const row = target + 1
        stdin7.text(`\x1b[<0;3;${row}M`)
        await sleep(60)
        stdin7.text(`\x1b[<32;12;${row}M`)
        await sleep(60)
        const during = rw.join('')
        stdin7.text(`\x1b[<0;12;${row}m`)
        await sleep(200)
        if (!during.includes('\x1b[?1002h\x1b[?1006h')) problems.push('phase7：fullscreen 启动未开启 SGR 鼠标模式')
        if (!during.includes('\x1b[7m')) problems.push('phase7：拖拽未把选区画成反显')
        if (!rw.join('').includes('\x1b]52;c;')) problems.push('phase7：释放后未写出 OSC 52 剪贴板序列')
        if (!paintScreen(rw, 24).some((line) => line.includes('已复制'))) problems.push('phase7：复制后缺少提示行')
      }
    }
    dispose7()
    await sleep(20)
  }

  // ── Phase 8: 编辑器光标编辑 + @ 补全 + 图片附加 + 历史召回 ─────────────────
  {
    const rw: string[] = []
    const stdin8 = new FakeStdin()
    const kernel8 = new FakeKernel(true)
    const dispose8 = bootstrapApp(
      kernel8,
      { provider: '', model: '', fullscreen: false },
      { stdout: () => makeStdout(rw), stdin: () => stdin8 },
    )
    await sleep(250)
    // Cursor editing: 'abcd' → left,left → insert 'X' → 'abXcd'.
    for (const ch of 'abcd') stdin8.text(ch)
    stdin8.key('left')
    stdin8.key('left')
    stdin8.text('X')
    await sleep(80)
    stdin8.key('return')
    await sleep(120)
    {
      const block = kernel8.record.followupMessage?.content[0]
      if (block?.type !== 'text' || block.text !== 'abXcd') {
        problems.push(`phase8：光标插入位置错误：${JSON.stringify(kernel8.record.followupMessage ?? null)}`)
      }
    }
    // Multi-line editor: Alt+Enter (ESC CR — what Windows Terminal sends)
    // inserts a break instead of submitting, ↑ moves INSIDE the text instead
    // of recalling history, and Enter submits the whole thing as ONE message
    // whose text block really contains the newline.
    for (const ch of '第一行') stdin8.text(ch)
    stdin8.text('\x1b\r')
    for (const ch of '第二行') stdin8.text(ch)
    await sleep(120)
    {
      const rows = paintScreen(rw, 24)
      const head = rows.findIndex((row) => row.includes('第一行'))
      if (head === -1 || !rows[head + 1]?.includes('第二行')) {
        problems.push(`phase8：Alt+Enter 未把编辑框撑成两行：${JSON.stringify(rows.slice(-8))}`)
      }
      if (rows.some((row) => row.includes('说点什么'))) problems.push('phase8：多行编辑时仍显示占位符')
    }
    stdin8.key('up')
    await sleep(60)
    stdin8.text('!')
    stdin8.key('return')
    await sleep(120)
    {
      const block = kernel8.record.followupMessage?.content[0]
      if (block?.type !== 'text' || block.text !== '第一行!\n第二行') {
        problems.push(`phase8：多行编辑/换行提交错误：${JSON.stringify(kernel8.record.followupMessage ?? null)}`)
      }
    }
    // @ completion: '@read' → menu → Tab → '@README.md' → Enter submits it.
    for (const ch of '@read') stdin8.text(ch)
    await sleep(300) // debounce + fetch
    if (!paintScreen(rw, 24).some((row) => row.includes('文件'))) problems.push('phase8：@ 文件菜单未上屏')
    stdin8.key('tab')
    await sleep(120)
    stdin8.key('return')
    await sleep(120)
    {
      const block = kernel8.record.followupMessage?.content[0]
      if (block?.type !== 'text' || block.text !== '@README.md') {
        problems.push(`phase8：@ 补全未按候选完成：${JSON.stringify(kernel8.record.followupMessage ?? null)}`)
      }
    }
    // A non-image file rides the same path but becomes a `file` block
    // (dsh-attachment 0.1.5) with its own inline token and its own counter.
    // Attached FIRST: dispatching a slash command resets the editor, so a
    // command line can never be typed while other attachments are pending.
    const txtPath = join(tmpdir(), `orca-smoke-${process.pid}.txt`)
    writeFileSync(txtPath, 'hello file')
    for (const ch of `/img ${txtPath}`) stdin8.text(ch)
    stdin8.key('return')
    await sleep(300)
    {
      const screen = paintScreen(rw, 24).join('\n')
      if (!screen.includes('[file #1]')) {
        problems.push(`phase8：文件附件徽标未渲染：${screen.split('\n').find((row) => row.includes('│ >')) ?? ''}`)
      }
    }
    // A pending attachment token must not hide the inline `/` menu: the menu
    // is derived from the editor TEXT, tokens excluded.
    stdin8.text('/he')
    await sleep(150)
    {
      const screen = paintScreen(rw, 24).join('\n')
      if (!screen.includes('/help')) problems.push('phase8：挂起附件时 / 菜单被遮住')
    }
    stdin8.key('backspace')
    stdin8.key('backspace')
    stdin8.key('backspace')
    await sleep(150)
    {
      const screen = paintScreen(rw, 24).join('\n')
      if (screen.includes('/help')) problems.push('phase8：退格后 / 菜单未关闭')
      if (!screen.includes('[file #1]')) problems.push('phase8：退格删除了附件 token')
    }
    // /img attaches a durable image; bracketed paste of an image path does too.
    const pngPath = join(tmpdir(), `orca-smoke-${process.pid}.png`)
    writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47])) // header-only; the fake store skips decode
    for (const ch of `/img ${pngPath}`) stdin8.text(ch)
    stdin8.key('return')
    await sleep(250)
    stdin8.paste(pngPath)
    await sleep(400)
    {
      // Attachments are inline Claude Code style tokens inside the editor,
      // each kind numbering itself.
      const screen = paintScreen(rw, 24).join('\n')
      if (!screen.includes('[file #1] [image #1] [image #2]')) {
        problems.push('phase8：内联附件徽标未在输入框内渲染')
      }
    }
    // Backspace removes the last inline image token (atomic delete).
    stdin8.key('backspace')
    await sleep(150)
    {
      const screen = paintScreen(rw, 24).join('\n')
      if (!screen.includes('[image #1]')) problems.push('phase8：删除后 [image #1] 丢失')
      if (screen.includes('[image #2]')) problems.push('phase8：Backspace 未能删除第二个内联图片')
    }
    // Re-add the second image so the final send still carries two.
    stdin8.paste(pngPath)
    await sleep(400)
    {
      const screen = paintScreen(rw, 24).join('\n')
      if (!screen.includes('[file #1] [image #1] [image #2]')) problems.push('phase8：重新附加后内联图片未恢复为两张')
    }
    for (const ch of '看看图') stdin8.text(ch)
    stdin8.key('return')
    await sleep(700)
    {
      const message = kernel8.record.followupMessage
      const blocks = message?.content ?? []
      const first = blocks[0]
      const image = blocks[1]
      if (first?.type !== 'text' || first.text !== '看看图') problems.push('phase8：带附件提交的文本块缺失')
      if (image?.type !== 'image' || image.attachment.attachmentId !== 'att-1') {
        problems.push(`phase8：图片块未随消息发送：${JSON.stringify(image ?? null)}`)
      }
      if (blocks[2]?.type !== 'image') problems.push('phase8：第二张图片块缺失')
      const file = blocks[3]
      if (file?.type !== 'file' || file.attachment.name.endsWith('.txt') !== true) {
        problems.push(`phase8：文件块未随消息发送：${JSON.stringify(file ?? null)}`)
      }
      if (!stripSgr(rw.join('')).includes('[image #1] [image #2] [file #1]')) problems.push('phase8：user/message 附件投影缺失')
    }
    // ↑ on an empty editor recalls the last prompt; submitting again is image-free.
    stdin8.key('up')
    await sleep(80)
    stdin8.key('return')
    await sleep(200)
    {
      const message = kernel8.record.followupMessage
      const first = message?.content[0]
      if (message?.content.length !== 1 || first?.type !== 'text' || first.text !== '看看图') {
        problems.push(`phase8：↑ 历史召回失败：${JSON.stringify(message ?? null)}`)
      }
    }
    if (problems.length > 0 || process.env['ORCA_DUMP'] === '1') {
      try {
        writeFileSync(
          probePath('dev-phase8-screen.txt'),
          paintScreen(rw, 24, true).map((r, i) => `${String(i).padStart(3)}| ${r}`).join('\n'),
        )
      } catch {}
    }
    dispose8()
    await sleep(20)
    try {
      rmSync(pngPath)
    } catch {
      // Best-effort cleanup.
    }
  }

  // ── Phase 9: 思考强度保持——插件级 provider/model 覆盖不吞掉 effort ──────────
  // A profile pins orca.provider/model AND the composition default carries an
  // effort: agentOptions must merge BOTH (the override route + the effort),
  // not reset the effort to the model default.
  {
    const rw: string[] = []
    const kernel9 = new FakeKernel(true)
    const dispose9 = bootstrapApp(
      kernel9,
      { provider: 'cfg-p', model: 'cfg-m', fullscreen: false },
      { stdout: () => makeStdout(rw), stdin: () => new FakeStdin() },
    )
    await sleep(250)
    if (
      kernel9.record.createOptions?.agentOptions?.provider !== 'cfg-p' ||
      kernel9.record.createOptions?.agentOptions?.model !== 'cfg-m' ||
      kernel9.record.createOptions?.agentOptions?.reasoningEffort !== 'medium'
    ) {
      problems.push(
        `phase9：配置覆盖丢失思考强度：${JSON.stringify(kernel9.record.createOptions?.agentOptions ?? null)}`,
      )
    }
    dispose9()
    await sleep(20)
  }

  // ── Phase 10: /preset 预设选择 → 下个新会话挂载组成 ─────────────────────
  // Roster lists (built-in + broken-disabled), the pick records a selection,
  // and the next FRESH session carries `meta.agentPreset` + runs `setup`
  // mount; the footer shows the live composed preset.
  {
    const writes10: string[] = []
    const stdin10 = new FakeStdin()
    const kernel10 = new FakeKernel(true)
    const dispose10 = bootstrapApp(
      kernel10,
      { provider: '', model: '', fullscreen: false },
      { stdout: () => makeStdout(writes10), stdin: () => stdin10 },
    )
    await sleep(300) // boot create (factory-race retry) + default mount
    if (kernel10.record.presetMounted !== 'standard') {
      problems.push(`phase10：首建未挂默认预设：${kernel10.record.presetMounted ?? '(none)'}`)
    }
    for (const ch of '/preset') stdin10.text(ch)
    stdin10.key('return')
    await sleep(150)
    const flow10 = (): string => stripSgr(writes10.join(''))
    if (!flow10().includes('选择 Agent 预设') || !flow10().includes('标准模式')) {
      problems.push('phase10：/preset 选择器未列出 roster')
    }
    stdin10.key('down')
    await sleep(60)
    stdin10.key('down')
    await sleep(60)
    stdin10.key('return') // minimal (broken-demo stays disabled at the tail)
    await sleep(150)
    if (!flow10().includes('预设已切换：minimal')) problems.push('phase10：预设选择未应用')
    for (const ch of '/new') stdin10.text(ch)
    stdin10.key('return')
    await sleep(400) // dispose + fresh create (factory already registered)
    if (kernel10.record.createOptions?.meta?.agentPreset !== 'minimal') {
      problems.push(`phase10：新会话未携带预设 lineage：${JSON.stringify(kernel10.record.createOptions?.meta ?? null)}`)
    }
    if (kernel10.record.presetMounted !== 'minimal') problems.push('phase10：创建时未 mount 预设组成')
    if (!flow10().includes('预设:minimal')) problems.push('phase10：页脚未显示 live 预设')
    dispose10()
    await sleep(20)
  }

  // ── Phase 10b: 预设挂载失败回退——mount 被拒不 brick 启动 ─────────────────
  // A rejected preset composition rolls the whole create back; the app must
  // retry ONCE rosterless (pre-preset behavior) instead of dying with
  // "agent 启动失败". Boot: race-retry → create(mount throws) → fallback.
  {
    const writes11: string[] = []
    const kernel11 = new FakeKernel(true)
    kernel11.presetMountFails = true
    const dispose11 = bootstrapApp(
      kernel11,
      { provider: '', model: '', fullscreen: false },
      { stdout: () => makeStdout(writes11), stdin: () => new FakeStdin() },
    )
    await sleep(900) // 100ms factory race + mount rejection + rosterless retry
    if (kernel11.record.createCalls < 2) {
      problems.push(`phase10b：挂载失败后未回退重试（create 次数 ${kernel11.record.createCalls}）`)
    }
    if (kernel11.record.createOptions?.meta?.agentPreset !== undefined) {
      problems.push(`phase10b：回退创建仍携带预设 lineage：${JSON.stringify(kernel11.record.createOptions?.meta ?? null)}`)
    }
    if (kernel11.record.presetMounted !== null) {
      problems.push(`phase10b：被拒的 mount 不应生效：${kernel11.record.presetMounted}`)
    }
    const flow11 = (): string => stripSgr(writes11.join(''))
    if (!flow11().includes('回退无预设组成')) problems.push('phase10b：未提示回退')
    if (flow11().includes('agent 启动失败')) problems.push('phase10b：回退成功却报了启动失败')
    dispose11()
    await sleep(20)
  }

  // ── Phase 11: 工作区归属——TUI 会话登记进它 cwd 的工作区 ───────────────────
  // The web sidebar groups sessions by workspace MEMBERSHIP
  // (`workspace.json`'s `sessionIds`), and membership is host-side only: the
  // browser cannot file an ungrouped row either. A TUI session that is never
  // attached can therefore only ever sit in the ungrouped pile.
  {
    const writes12: string[] = []
    const stdin12 = new FakeStdin()
    const kernel12 = new FakeKernel(true)
    // The medium must already match the registry the app will read, or the
    // drift guard refuses to write (that IS the guard's contract).
    kernel12.writeWorkspaceMedium()
    const dispose12 = bootstrapApp(
      kernel12,
      { provider: '', model: '', fullscreen: false },
      { stdout: () => makeStdout(writes12), stdin: () => stdin12 },
    )
    await sleep(300)
    const first12 = kernel12.record.createOptions?.sessionId
    if (first12 === undefined || kernel12.workspaceAttached[0] !== first12) {
      problems.push(`phase11：首个会话未登记工作区：${JSON.stringify(kernel12.workspaceAttached)}`)
    }
    for (const ch of '/new') stdin12.text(ch)
    stdin12.key('return')
    await sleep(400)
    const second12 = kernel12.record.createOptions?.sessionId
    if (kernel12.workspaceAttached.length !== 2 || kernel12.workspaceAttached[1] !== second12) {
      problems.push(`phase11：/new 的会话未登记工作区：${JSON.stringify(kernel12.workspaceAttached)}`)
    }
    // A session already accounted must NOT be written again (the registry
    // mutation is a durable file write shared with the web process).
    const accounted12 = kernel12.workspaceAttached.length
    dispose12()
    await sleep(50)
    const writes12b: string[] = []
    const dispose12b = bootstrapApp(
      kernel12,
      { provider: '', model: '', fullscreen: false },
      { stdout: () => makeStdout(writes12b), stdin: () => new FakeStdin() },
    )
    await sleep(300)
    if (kernel12.workspaceAttached.length !== accounted12) {
      problems.push(`phase11：已登记的会话被重复登记：${JSON.stringify(kernel12.workspaceAttached)}`)
    }
    dispose12b()
    await sleep(20)

    // Degradation (#183): every missing/failing seam is silent, and the
    // session still connects. Each boot gets its own remount marker so it
    // creates a session rather than resuming the previous case's.
    const isolatedBoot = async (kernel: FakeKernel, tag: string): Promise<string> => {
      const file = join(tmpdir(), `orca-smoke-${process.pid}-ws-${tag}.json`)
      process.env['ORCA_LAST_SESSION_FILE'] = file
      try {
        rmSync(file)
      } catch {
        // Absent is the normal case.
      }
      kernel.writeWorkspaceMedium()
      const writes: string[] = []
      const dispose = bootstrapApp(
        kernel,
        { provider: '', model: '', fullscreen: false },
        { stdout: () => makeStdout(writes), stdin: () => new FakeStdin() },
      )
      await sleep(300)
      const visible = stripSgr(writes.join(''))
      dispose()
      await sleep(20)
      return visible
    }
    const noRegistry12 = new FakeKernel(true)
    noRegistry12.hideWorkspaceRegistry = true
    const visibleNoRegistry = await isolatedBoot(noRegistry12, 'none')
    if (!visibleNoRegistry.includes('session 已连接') || visibleNoRegistry.includes('agent 启动失败')) {
      problems.push('phase11：缺 workspaceRegistry 时未降级启动')
    }
    const unowned12 = new FakeKernel(true)
    unowned12.workspacePath = undefined
    await isolatedBoot(unowned12, 'unowned')
    if (unowned12.workspaceAttached.length !== 0) {
      problems.push(`phase11：没有对应工作区时仍尝试登记：${JSON.stringify(unowned12.workspaceAttached)}`)
    }
    const refused12 = new FakeKernel(true)
    refused12.workspaceAttachFails = true
    const visibleRefused = await isolatedBoot(refused12, 'refused')
    if (refused12.workspaceAttached.length !== 0) {
      problems.push(`phase11：被拒的登记不应算成功：${JSON.stringify(refused12.workspaceAttached)}`)
    }
    if (!visibleRefused.includes('session 已连接') || visibleRefused.includes('agent 启动失败')) {
      problems.push('phase11：登记被拒时未降级启动')
    }
    // Another writer (the web app) committed after this process read the
    // registry: the TUI must NOT publish its stale document over that.
    const drifted12 = new FakeKernel(true)
    drifted12.workspaceDriftsOnResolve = true
    await isolatedBoot(drifted12, 'drift')
    if (drifted12.workspaceAttached.length !== 0) {
      problems.push(`phase11：账本已被其它进程改写却仍写了归属：${JSON.stringify(drifted12.workspaceAttached)}`)
    }
  }

  // ── Phase 12: 会话记录的模型——TUI 与 web 读同一份 durable 记录 ─────────────
  // The kernel's own reading order is: the last still-unconsumed
  // `model/selection` event, else the last `request/header` config, else the
  // composition default. The web host appends that event on a pick; the TUI
  // must append AND read it, or a pick is invisible to the web and a session
  // opened here forgets the model it ran on.
  {
    // (a) A TUI pick becomes a durable `model/selection` in the session log.
    const writes13: string[] = []
    const stdin13 = new FakeStdin()
    const kernel13 = new FakeKernel(true)
    const dispose13 = bootstrapApp(
      kernel13,
      { provider: '', model: '', fullscreen: false },
      { stdout: () => makeStdout(writes13), stdin: () => stdin13 },
    )
    await sleep(300)
    for (const ch of '/model') stdin13.text(ch)
    stdin13.key('return')
    await sleep(150)
    stdin13.key('return') // provider fake-a
    await sleep(150)
    stdin13.key('return') // model fake-a-m1
    await sleep(150)
    stdin13.key('return') // effort 模型默认
    await sleep(250)
    const picked13 = kernel13
      .loggedEvents(kernel13.record.createOptions?.sessionId ?? '')
      .filter((event) => event.type === 'model/selection')
    const last13 = picked13.at(-1)?.data as { provider?: string; model?: string; reasoningEffort?: string } | undefined
    if (last13?.provider !== 'fake-a' || last13?.model !== 'fake-a-m1') {
      problems.push(`phase12：/model 未落 durable model/selection：${JSON.stringify(last13 ?? null)}`)
    }
    if (last13 !== undefined && last13.reasoningEffort !== undefined) {
      problems.push(`phase12：模型默认的选型不应带 effort：${JSON.stringify(last13)}`)
    }
    if (kernel13.record.selectionSaved?.provider !== 'fake-a') {
      problems.push('phase12：/model 未写全局默认（settings）')
    }
    // The PROMPT must follow the pick too: dsh-agent-loop registers
    // `{{provider}}`/`{{model}}` from the CREATION route, so without the
    // `system-prompt/assemble` hook a switched session keeps telling the model
    // (and the model keeps telling the user) that it runs on the old model.
    {
      const assembled = await kernel13.assemblePrompt()
      const variables = (assembled['variables'] ?? {}) as Record<string, unknown>
      if (variables['model'] !== 'fake-a-m1' || variables['provider'] !== 'fake-a') {
        problems.push(`phase12：切换后系统提示词变量未跟随选型：${JSON.stringify(variables)}`)
      }
      if (assembled['variables'] === undefined) problems.push('phase12：assemble 未保留其余变量')
      const cwdKept = (assembled['variables'] as Record<string, unknown> | undefined)?.['cwd']
      if (cwdKept !== process.cwd()) problems.push(`phase12：assemble 覆盖了无关变量：${JSON.stringify(assembled['variables'])}`)
    }
    dispose13()
    await sleep(20)

    // (b) A resumed session runs on the route ITS LOG records, not on this
    // process's default: mount → dispose → remount with a scripted durable log.
    const extraSeq = { n: 0 }
    const resumeVisible = async (
      extras: SessionEvent[],
      tag: string,
    ): Promise<{ visible: string; kernel: FakeKernel }> => {
      extraSeq.n += 1
      const file = join(tmpdir(), `orca-smoke-${process.pid}-resume-${tag}-${extraSeq.n}.json`)
      process.env['ORCA_LAST_SESSION_FILE'] = file
      try {
        rmSync(file)
      } catch {
        // Absent is the normal case.
      }
      const kernel = new FakeKernel(true)
      const disposeA = bootstrapApp(
        kernel,
        { provider: '', model: '', fullscreen: false },
        { stdout: () => makeStdout([]), stdin: () => new FakeStdin() },
      )
      await sleep(250)
      disposeA()
      await sleep(40)
      kernel.resumeExtras = extras
      const writes: string[] = []
      const disposeB = bootstrapApp(
        kernel,
        { provider: '', model: '', fullscreen: false },
        { stdout: () => makeStdout(writes), stdin: () => new FakeStdin() },
      )
      await sleep(300)
      const visible = stripSgr(writes.join(''))
      disposeB()
      await sleep(20)
      return { visible, kernel }
    }
    const header = (config: Record<string, unknown>, adapterDefaults?: Record<string, unknown>): SessionEvent =>
      ({
        type: 'request/header',
        seq: 0,
        time: Date.now(),
        data: { header: { config, ...(adapterDefaults === undefined ? {} : { adapterDefaults }) }, reason: 'initial' },
      }) as SessionEvent
    const pick = (provider: string, model: string, reasoningEffort?: string): SessionEvent =>
      ({
        type: 'model/selection',
        seq: 0,
        time: Date.now(),
        data: { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) },
      }) as SessionEvent

    const recorded = await resumeVisible([header({ provider: 'rec-p', model: 'rec-m', reasoningEffort: 'high' })], 'header')
    if (!recorded.visible.includes('↳ 模型 rec-p/rec-m(high)')) {
      problems.push(`phase12：恢复会话未沿用日志里的路由：${recorded.visible.slice(-400)}`)
    }
    const pending = await resumeVisible(
      [header({ provider: 'rec-p', model: 'rec-m' }), pick('sel-p', 'sel-m', 'low')],
      'pending',
    )
    if (!pending.visible.includes('↳ 模型 sel-p/sel-m(low)')) {
      problems.push(`phase12：未生效的 model/selection 未优先：${pending.visible.slice(-400)}`)
    }
    // An effort the ADAPTER materialized is not a route choice: it must not be
    // re-pinned as one, so this session announces the route WITHOUT an effort.
    const adapterDefault = await resumeVisible(
      [header({ provider: 'ad-p', model: 'ad-m', reasoningEffort: 'medium' }, { reasoningEffort: true })],
      'adapter',
    )
    if (!adapterDefault.visible.includes('↳ 模型 ad-p/ad-m') || adapterDefault.visible.includes('ad-m(medium)')) {
      problems.push(`phase12：适配器默认 effort 被当成选型：${adapterDefault.visible.slice(-400)}`)
    }
  }

  if (problems.length > 0) {
    console.error(`smoke 失败：${problems.join('；')}`)
    try {
      writeFileSync(probePath('dev-phase2-screen.txt'), rows2.map((r, i) => `${String(i).padStart(3)}| ${r}`).join('\n'))
      writeFileSync(probePath('dev-phase3-stream.txt'), stripSgr(writes3.join('')))
      console.error(`失败屏面已写入 ${probePath('dev-phase2-screen.txt')} / dev-phase3-stream.txt`)
    } catch {}
    process.exit(1)
  }
  console.log(
    `smoke 通过 ✔（降级 + 真实契约闭环 + /model 热切换：${writes2.length} 次帧写入，${Buffer.byteLength(painted2)} 字节 ANSI）`,
  )
  process.exit(0)
}

await main()
