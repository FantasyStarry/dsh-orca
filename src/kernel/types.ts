/**
 * Structural mirrors of the DeepSeek Harness kernel seams that Orca consumes.
 *
 * Orca is an in-process Cordis plugin: at runtime inside a dsh profile these
 * shapes are satisfied by the real `@deepseek-ai/*` kernel services. The
 * mirrors exist so the package typechecks and runs standalone (fake kernel in
 * `scripts/dev.ts`) without vendoring the kernel. Every mirror states the
 * source seam it mirrors; when a mirror drifts from the real surface, fix the
 * mirror and note the kernel version it was checked against.
 *
 * **Checked against `@deepseek-ai/dsh` v0.1.5-rc.1 (2026-09).** Shapes were
 * read from the declaration files the installed kernel ships with itself
 * (`dsh/node_modules/@deepseek-ai/…/lib/types/*.d.ts`):
 *
 * - `dsh-agent`  → `AgentRegistry` (`ctx.agents`), `AgentHandle`, `Agent`,
 *   `AgentOptions` (carries `reasoningEffort`), `CreateAgentOptions`
 *   (`meta.agentPreset` lineage + creation-time `setup` composition hook),
 *   `ResumeAgentOptions`, `AgentCancelCause`, `AssistantStreamFrame`, and the
 *   `agent/*` cordis events — **`agent/assistant-stream` is the live model
 *   stream as of 0.1.5; the `assistant/chunk` session event no longer exists.**
 * - `dsh-agent-presets` → `AgentPresets` (`ctx.agentPresets`): roster
 *   (`list`/`resolve`), the user default (`defaultId`), per-agent live lookup
 *   (`composedPreset`) and standing-mount composition (`mount`, called from the
 *   agent factory `setup` hook — the only supported call site).
 * - `dsh-session` → `Session` (`snapshotEvents`, `requestHeader`, `append`,
 *   `header`), `SessionEvent`, `SessionEventMap`, and the `session/*` cordis
 *   events. The appendable surface is `assistant/message` (embedding the
 *   attempt `stream`), `assistant/attempt`, `system/message`, and the log-only
 *   boundary/audit events — there is no chunk event.
 * - `dsh-workspace` → `WorkspaceRegistry` (`ctx.workspaceRegistry`,
 *   `list` / `resolveByPath`) and `Workspace` (`path`, `sessionIds`,
 *   `attachSession`): the durable Workspace + Session-membership account the
 *   web sidebar groups by. NOT part of `dsh-base` — the Orca bundle mounts the
 *   row, and every use is soft-probed.
 * - `dsh-llm` → `StreamChunk`, `ContentBlock` (incl. `ImageBlock` / the
 *   0.1.5 `FileBlock`), message roles, and the `LlmRuntime` selector surface —
 *   exact-route resolution is `resolveModelInfo(provider, model)` (the name
 *   `resolveModel` never existed on the runtime).
 * - `dsh-attachment` → `AttachmentStore` (`ctx.attachments`): durable image
 *   admission (`saveImage`) + limits, and the 0.1.5 file path. Optional seam,
 *   soft-probed.
 * - `dsh-file-reference` → `FileReferenceService` (`ctx.fileReferences`):
 *   cancellable `@path` completion candidates. Optional seam, soft-probed.
 *
 * Deliberate simplifications (kept honest by runtime-defensive parsing):
 * - `SessionId` / `CallId` / `MessageId` are branded strings in the kernel;
 *   brands are compile-time only, so the mirrors use plain `string` and the
 *   runtime accepts plain JSON of the same shape.
 * - `SessionEventMap` mirrors only the types Orca consumes; plugin-merged
 *   extensions (compaction, hooks, `session/title`, `command/*`, the `agent/*`
 *   log events, …) are intentionally absent — unknown event types are ignored
 *   at the channel boundary.
 * - `CreateAgentOptions` / `ResumeAgentOptions` omit `seed`/`parentAgent`
 *   until Orca uses them.
 */

// ── dsh-llm: content blocks and messages ────────────────────────────────────

/** Plain text visible to the end user (dsh-llm `TextBlock`). */
export interface TextBlock {
  readonly type: 'text'
  readonly text: string
}

/** Reasoning / thinking content, distinct from visible text (dsh-llm `ReasoningBlock`). */
export interface ReasoningBlock {
  readonly type: 'reasoning'
  readonly text: string
}

/** A tool invocation requested by the model (dsh-llm `ToolCallBlock`). */
export interface ToolCallBlock {
  readonly type: 'tool-call'
  readonly id: string
  readonly name: string
  /** Raw JSON string as produced by the model. */
  readonly arguments: string
}

/** The result of a tool invocation, sent back to the model (dsh-llm `ToolResultBlock`). */
export interface ToolResultBlock {
  readonly type: 'tool-result'
  readonly toolCallId: string
  readonly content: readonly ContentBlock[]
  readonly isError?: boolean
}

/**
 * Where a message came from (dsh-llm `MessageSource`, merge-extensible).
 * Orca only branches on `kind === 'user'`; everything else is opaque.
 */
export interface MessageSource {
  readonly kind: string
  readonly [key: string]: unknown
}

/** One immutable message representation (dsh-llm `Message`). */
export interface Message {
  readonly id: string
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: readonly ContentBlock[]
  readonly source: MessageSource
}

export interface UserMessage extends Message {
  readonly role: 'user'
}

export interface AssistantMessage extends Message {
  readonly role: 'assistant'
}

export interface ToolResultMessage extends Message {
  readonly role: 'user'
  readonly content: readonly [ToolResultBlock]
}

/** Raster image formats accepted by the attachment admission path (dsh-attachment). */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/**
 * A durable raster image reference (dsh-attachment `ImageAttachmentRef`,
 * checked against dsh 0.1.5-rc.1). Opaque storage id + verified facts; never
 * a filesystem path or URL.
 */
export interface ImageAttachmentRef {
  readonly attachmentId: string
  readonly mediaType: ImageMediaType
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
  readonly originalDimensions?: { readonly width: number; readonly height: number }
}

/**
 * A durable raster image reference, valid in user content (dsh-llm
 * `ImageBlock`). The block is role-neutral; only user messages carry images
 * today.
 */
export interface ImageBlock {
  readonly type: 'image'
  readonly attachment: ImageAttachmentRef
}

/**
 * Provider-neutral content block (dsh-llm `ContentBlock`; `ContentBlockMap`
 * keys, incl. `file` since 0.1.5). Unknown plugin-merged blocks never match a
 * `type` check and are ignored.
 */
export type ContentBlock = TextBlock | ReasoningBlock | ImageBlock | FileBlock | ToolCallBlock | ToolResultBlock

/** A durable NON-image attachment reference (dsh-attachment `FileAttachmentRef`). */
export interface FileAttachmentRef {
  readonly attachmentId: string
  readonly name: string
  readonly bytes: number
}

/**
 * A durable file reference in user content (dsh-llm `FileBlock`, new in
 * 0.1.5). Role-neutral like `ImageBlock`.
 */
export interface FileBlock {
  readonly type: 'file'
  readonly attachment: FileAttachmentRef
}

/**
 * Raw streaming protocol carried by live `agent/assistant-stream` chunk
 * frames and embedded in durable assistant settlements (dsh-llm
 * `StreamChunk`). Visible text arrives as `text-delta` / `reasoning-delta`;
 * the other variants carry no transcript text for Orca's purposes — but a
 * `block-end` assembling a reasoning block is the end-of-thinking signal
 * that collapses the thought row (delta-only protocols without block framing
 * fall back to sealing on the first `text-delta`).
 */
export type StreamChunk =
  | { readonly type: 'block-start'; readonly index: number; readonly blockType: string }
  | { readonly type: 'text-delta'; readonly index: number; readonly text: string }
  | { readonly type: 'reasoning-delta'; readonly index: number; readonly text: string }
  | { readonly type: 'tool-call-delta'; readonly index: number; readonly id: string; readonly name?: string; readonly argumentsDelta: string }
  | { readonly type: 'block-end'; readonly index: number; readonly block: ContentBlock }
  | { readonly type: 'usage'; readonly usage: TokenUsage }
  | { readonly type: 'finish'; readonly reason: { readonly kind: string } }

/**
 * One live assistant-stream publication (`agent/assistant-stream`, dsh-agent
 * `AssistantStreamFrame`, new in 0.1.5). This is the ONLY live delta channel:
 * chunks are transient and never enter the session log. `start` opens an
 * attempt, `chunk` carries one ordered `StreamChunk`, `end` reports the
 * settlement (the durable `assistant/message`/`assistant/attempt` event).
 */
export type AssistantStreamFrame =
  | { readonly type: 'start'; readonly attemptId: string; readonly revision: number; readonly turn: number; readonly step: number }
  | {
      readonly type: 'chunk'
      readonly attemptId: string
      readonly revision: number
      /** Dense zero-based position within the attempt. */
      readonly index: number
      readonly time: number
      readonly chunk: StreamChunk
    }
  | {
      readonly type: 'end'
      readonly attemptId: string
      readonly revision: number
      readonly index: number
      readonly outcome: { readonly kind: 'committed'; readonly eventType: string; readonly seq: number } | { readonly kind: 'abandoned' }
    }

// ── dsh-session: the event log (source of truth) ────────────────────────────

/** One entry in an agent's todo list (dsh-session `TodoItem`). */
export interface TodoItem {
  readonly content: string
  readonly status: 'pending' | 'in_progress' | 'completed'
}

/** Why a turn ended (dsh-session `TurnEndReason`, merge-extensible — parsed loosely). */
export interface TurnEndReason {
  readonly kind?: string
  readonly error?: { readonly message?: string; readonly code?: string }
}

/**
 * The core of dsh-session's `SessionEventMap` — the data payload of each
 * appendable event type. This mirror lists only the types Orca projects;
 * real consumers must tolerate unknown types (they may carry `ignorable`).
 */
export interface SessionEventMap {
  'turn/start': { readonly turn: number }
  'turn/end': { readonly turn: number; readonly reason: TurnEndReason }
  'step/start': { readonly turn: number; readonly step: number }
  'step/end': { readonly turn: number; readonly step: number }
  'user/message': UserMessage
  /** The rendered system prompt — surface node 0 (new as a logged event in 0.1.5). */
  'system/message': { readonly turn: number; readonly step: number; readonly message: Message }
  /**
   * Assembled assistant message for one step (dsh 0.1.5): carries the
   * `stream` records that REPLACED the old `assistant/chunk` events, so a
   * replayed log has no chunks — only this and the message content.
   */
  'assistant/message': {
    readonly turn: number
    readonly step: number
    readonly message: AssistantMessage
    readonly stream?: readonly unknown[]
    readonly usage?: TokenUsage
    readonly interrupted?: true
  }
  /** One model attempt that committed no surface message (failure/retry/cancel). */
  'assistant/attempt': { readonly turn: number; readonly step: number; readonly stream?: readonly unknown[] }
  'tool/call': { readonly turn: number; readonly step: number; readonly callId: string; readonly name: string; readonly arguments: string }
  'tool/result': { readonly turn: number; readonly step: number; readonly message: ToolResultMessage; readonly error?: { readonly name: string; readonly code: string } }
  'todo/write': { readonly todos: readonly TodoItem[] }
  /** Full request header snapshot; the latest one reconstructs the route (dsh-session `EpochHeader`). */
  'request/header': { readonly header: EpochHeader; readonly reason: string }
  /**
   * Durable model-selection intent (0.1.5; appended by the web host's
   * `session.selectModel` and by Orca's `/model`). It is the SESSION's own
   * record of "run the next request on this route": a reader applies it while
   * it differs from the last `request/header` config, then considers it
   * consumed. It never reaches the model surface (log-only).
   */
  'model/selection': { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
  /** Durable approval override (`dsh-user-approval`); the LAST one wins. */
  'approval/policy': { readonly policy: KernelApprovalPolicy; readonly source?: 'delegation' }
  /** Approval audit pair (`dsh-user-approval`, log-only, paired by `id`). */
  'approval/asked': { readonly id: string; readonly toolName: string; readonly callId?: string; readonly reason?: string }
  'approval/decided': { readonly id: string; readonly outcome: string }
  'session/end-seed': { readonly inherited?: true }
}

export type SessionEventType = keyof SessionEventMap

/** Provider-neutral call configuration (dsh-llm `LlmCallConfig`). */
export interface LlmCallConfig {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
  readonly temperature?: number
  readonly maxTokens?: number
  readonly stop?: readonly string[]
}

/**
 * Fields the resolved adapter materialized itself rather than receiving from
 * the caller (dsh-llm `LlmCallConfigAdapterDefaults`). A `reasoningEffort`
 * flagged here is the adapter's own default, so it must NOT be read back as an
 * explicit route choice — the kernel's model-selection fold drops it.
 */
export interface LlmCallConfigAdapterDefaults {
  readonly reasoningEffort?: boolean
}

/**
 * The request header in force after one `request/header` event
 * (dsh-session `EpochHeader`). `adapterDefaults` is absent unless the adapter
 * materialized some field itself.
 */
export interface EpochHeader {
  readonly config: LlmCallConfig
  readonly adapterDefaults?: LlmCallConfigAdapterDefaults
}

/** Token accounting reported by the adapter (dsh-llm `TokenUsage`). */
export interface TokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
}

/** Display metadata for one registered provider route (dsh-llm `LlmProviderInfo`). */
export interface LlmProviderInfo {
  /** Provider route key used by `GenerateOptions.provider`. */
  readonly id: string
  /** Human-readable provider name for selectors. */
  readonly name: string
}

/** One model entry of a provider route (dsh-llm `LlmModelInfo`). */
export interface LlmModelInfo {
  readonly provider: string
  /** Model id passed to `GenerateOptions.model`. */
  readonly id: string
  /** Human-readable model name for selectors. */
  readonly name: string
  readonly description?: string
  /** Modalities the route accepts ('text' | 'image'). */
  readonly inputModalities?: readonly string[]
}

/** Adapter-owned reasoning effort metadata (dsh-llm `LlmReasoningEffortInfo`). */
export interface LlmReasoningEffortInfo {
  readonly id: string
  readonly name: string
  readonly description?: string
}

/** Exact-route model metadata resolved by its adapter (dsh-llm `LlmResolvedModelInfo`). */
export interface LlmResolvedModelInfo extends LlmModelInfo {
  /** Advertised capacity of the route. */
  readonly context?: { readonly contextWindow: number }
  readonly defaultMaxTokens?: number
  readonly reasoning?: {
    readonly efforts: readonly LlmReasoningEffortInfo[]
    readonly defaultEffort?: string
  }
  /** `'in-history'` when the route reads the latest `system` message in history. */
  readonly systemPromptUpdate?: string
}

/**
 * The LLM runtime (`ctx.llm`, dsh-llm `LlmRuntime` — the selector subset):
 * route/model enumeration plus exact-route resolution for reasoning efforts.
 * The exact-route resolver is `resolveModelInfo` (`resolveModel` only ever
 * named a method on the abstract adapter base, never the runtime).
 */
export interface KernelLlmService {
  listProviders(): readonly LlmProviderInfo[] | Promise<readonly LlmProviderInfo[]>
  listModels(provider: string): Promise<readonly LlmModelInfo[]>
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>
}

/**
 * One persisted session event (dsh-session `SessionEvent`). The payload is
 * nested under `data`; `surfaceOp` / `sourceEventSeqs` exist only on surface
 * events (`user/message`, `assistant/message`, `tool/result`) and are not
 * consumed by Orca. Parsed defensively at the channel boundary: when `data`
 * is absent the channel falls back to flat legacy fields.
 */
export interface SessionEvent {
  readonly type: string
  readonly seq?: number
  readonly time?: number
  /** The typed payload (`SessionEventMap[type]` in the real kernel). */
  readonly data?: unknown
  /** Readers may safely skip unrecognized types carrying this marker. */
  readonly ignorable?: true
  /** Tolerate legacy flat payloads; never rely on extra fields. */
  readonly [key: string]: unknown
}

/**
 * An event-sourced session (dsh-session `Session`). Only the consumption
 * surface is mirrored; Orca appends log-only events (no surface metadata)
 * when it needs custom UI state in the replayable log.
 */
export interface Session {
  readonly id: string
  /**
   * Immutable storage metadata (dsh-session `SessionHeader`): the creation-time
   * `cwd` a workspace membership check validates against, and `createdAt`.
   */
  readonly header: { readonly id: string; readonly cwd?: string; readonly createdAt: number }
  /**
   * Materialize an immutable snapshot of the log (dsh 0.1.5 `snapshotEvents`).
   * This is the ONLY snapshot API — the preview-era `session.events` field no
   * longer exists in the kernel and is not mirrored.
   */
  snapshotEvents(fromSeq?: number, toSeqExclusive?: number): readonly SessionEvent[]
  /**
   * The {@link EpochHeader} in force after the log's last header event — what
   * the NEXT request is compared against — or `undefined` before the first
   * one (dsh 0.1.5 `Session.requestHeader`, an incrementally maintained fold).
   * Optional here only because the mirror must survive a kernel without it.
   */
  requestHeader?(): EpochHeader | undefined
  /**
   * Append one event. The real signature is strongly typed per event type and
   * requires surface metadata for surface types (`system/message`,
   * `user/message`, `assistant/message`, `tool/result`); Orca appends ONLY the
   * log-only `model/selection` route intent, so the mirror stays on that shape.
   */
  append(type: string, data: Record<string, unknown>): SessionEvent
}

// ── dsh-workspace: the durable Workspace account the web sidebar groups by ──

/**
 * One durable Workspace registration (dsh-workspace `Workspace`, display +
 * membership subset — checked against 0.1.5-rc.1). `path` is the canonical
 * `fs.realpath` stamp; `sessionIds` is the ordered ownership account.
 */
export interface KernelWorkspace {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly sessionIds: readonly string[]
  /**
   * Record one session as owned by this workspace. Rejects (never no-ops) when
   * the session's stored header carries no `cwd`, its `cwd` does not resolve,
   * or it resolves to a different directory — so a caller must never swallow
   * the difference between "attached" and "refused". Idempotent for a session
   * already accounted here.
   */
  attachSession(sessionId: string): Promise<void>
}

/**
 * Durable workspace registry (`ctx.workspaceRegistry`, dsh-workspace
 * `WorkspaceRegistry` — the lookup subset Orca needs). NOT mounted by
 * `dsh-base`: the Orca bundle inserts the `workspace` row, and a composition
 * without it degrades to "no workspace accounting" silently.
 * Checked against dsh 0.1.5-rc.1.
 */
export interface KernelWorkspaceRegistry {
  /** Ordered registry projection; performs no persistence reads. */
  list(): readonly KernelWorkspace[]
  /**
   * Resolve the workspace owning one directory, without creating or mutating
   * anything: an existing unowned directory resolves to `undefined`, a path
   * that does not resolve rejects.
   */
  resolveByPath(path: string): Promise<KernelWorkspace | undefined>
}

// ── dsh-agent: registry, handle, agent ──────────────────────────────────────

/** Why an active agent driver was cancelled (dsh-session `AgentCancelCause`). */
export type AgentCancelCause =
  | { readonly kind: 'user' }
  | { readonly kind: 'parent' }
  | { readonly kind: 'hook'; readonly reason: string }
  | { readonly kind: 'disposed' }

/** Per-agent options (dsh-agent `AgentOptions`, checked against dsh 0.1.5-rc.1). */
export interface AgentOptions {
  /** Provider route (must have a registered adapter at call time). */
  readonly provider?: string
  /** Model id interpreted by the selected provider adapter. */
  readonly model?: string
  /** Adapter-owned reasoning effort for the selected provider/model route. */
  readonly reasoningEffort?: string
  /** Maximum output tokens for each conversation-model request. */
  readonly maxTokens?: number
}

/**
 * The subset of the agent-scoped Cordis `Context` Orca drives from the agent
 * (dsh-agent `Agent.ctx`). Waterfall listeners (`agent/request`, …) receive
 * `(payload, next)` and return their value through the listener's return —
 * cordis `ctx.on` always returns the listener's disposer.
 */
export interface AgentScopedContext {
  on(name: string, listener: (...args: unknown[]) => unknown): () => void
}

/**
 * A live agent (dsh-agent `Agent`). Prompts go through `followup` / `steer`
 * carrying full `UserMessage` values; in-flight work through `cancel(cause)`.
 */
export interface Agent {
  /** The single identity shared with `session`. */
  readonly id: string
  readonly options: AgentOptions
  /** The live session this agent drives; its log is the durable source of truth. */
  readonly session: Session
  /** `idle` | `running`, mirrored on every `agent/status` transition. */
  readonly status: 'idle' | 'running'
  /** Agent-scoped context; its contributions unwind on disposal. */
  readonly ctx: AgentScopedContext
  /** Queue an ordinary follow-up turn and wake the driver. */
  followup(message: UserMessage): void
  /** Submit steering for the nearest step. */
  steer(message: UserMessage): void
  /** Queue model-facing context for the next pre-step without waking. */
  inject(message: UserMessage): void
  /** Cancel in-flight work; `kind: 'user'` is the front-door cause. */
  cancel(cause: AgentCancelCause, options?: { readonly keepInbox?: boolean }): void
  /** Resolve when no driver or maintenance task remains. */
  whenIdle(): Promise<void>
}

/**
 * An owned agent plus its disposer (dsh-agent `AgentHandle`). The disposer is
 * a capability: only the holder can tear the agent down. Note the handle
 * itself carries no prompt methods — driving happens through `handle.agent`.
 */
export interface AgentHandle {
  readonly agent: Agent
  dispose(): Promise<void>
}

/** Options for `ctx.agents.create` (dsh-agent `CreateAgentOptions`, used subset). */
export interface CreateAgentOptions {
  /** Creation cancellation (dsh-agent, checked 0.1.5-rc.1). */
  readonly signal?: AbortSignal
  /** The live agent/session identity — the caller mints it, e.g. `session-<uuid>`. */
  readonly sessionId: string
  /** Session creation metadata (validated absolute `cwd`, preset lineage, …). */
  readonly meta?: {
    readonly cwd?: string
    readonly agentPreset?: string
  }
  /** Per-agent options (model, …). */
  readonly agentOptions?: AgentOptions
  /**
   * Creation-time composition of the agent's scoped world (dsh-agent `setup`).
   * Runs inside the factory after minting `agentCtx` but before publication —
   * the one supported call site for `agentPresets.mount` (a rejection rolls
   * the whole creation back). Real hook receives the full scoped Context;
   * the subset below is all Orca passes through.
   */
  readonly setup?: (agentCtx: AgentScopedContext) => void | Promise<void>
}

/** Options for `ctx.agents.resume` (dsh-agent `ResumeAgentOptions`, used subset). */
export interface ResumeAgentOptions {
  /** Resume cancellation (dsh-agent, checked 0.1.5-rc.1). */
  readonly signal?: AbortSignal
  /** The persisted session id to load and use as the live identity. */
  readonly resumeSessionId: string
  readonly agentOptions?: AgentOptions
}

/**
 * The kernel plugin loader (`ctx.loader`, cordis-plugin-loader). Loader
 * entries activate concurrently, so a plugin that drives kernel services at
 * startup awaits this first — the pattern dsh-headless uses before creating
 * its agent (`await ctx.get('loader')?.await()`).
 */
export interface KernelLoader {
  await(): Promise<void>
}

/**
 * The default model selection (`ctx.agentDefaultModel`, dsh-agent-default-model).
 * Owning service of the composition's `provider`/`model` defaults; callers
 * read `currentSelection()` and pass the pair through `agentOptions` — the
 * kernel applies NO default on its own (an agent without a provider/model
 * fails every turn with "has no provider/model"). `saveSelection` persists a
 * new default when a settings provider is mounted.
 */
export interface KernelAgentDefaultModel {
  currentSelection(): {
    provider: string
    model: string
    reasoningEffort?: string
  }
  saveSelection(next: { provider: string; model: string; reasoningEffort?: string }): Promise<void>
}

/**
 * One preset directory carrying a mountable agent composition
 * (dsh-agent-presets `AgentPreset`, display subset — checked 0.1.5-rc.1).
 */
export interface AgentPreset {
  /** Stable identifier; the preset directory's name. */
  readonly id: string
  /** `system` ships with the deployment, `user` was authored locally. */
  readonly trust: 'system' | 'user'
  /** Display name from the preset's metadata; absent falls back to `id`. */
  readonly name?: string
  /** One sentence on what this preset is for, when published. */
  readonly description?: string
  /** Declared position within its group; absent sorts after those declaring one. */
  readonly order?: number
  /** Why this preset cannot compose a session — absent when it can. */
  readonly broken?: string
}

/**
 * Registry over the deployment's agent presets (`ctx.agentPresets`,
 * dsh-agent-presets `AgentPresets` — the Orca-used subset).
 */
export interface KernelAgentPresetsService {
  /** Every preset the configured roots currently supply. */
  list(): Promise<AgentPreset[]>
  /** The preset id mounted when a caller names none (reads live settings). */
  readonly defaultId: string
  /**
   * Resolve one preset by id (`undefined` → default). Broken presets still
   * resolve — mounting paths refuse them; throws when unknown.
   */
  resolve(id?: string): Promise<AgentPreset>
  /** The preset one live agent runs on (`undefined` when it joined none). */
  composedPreset(agentCtx: AgentScopedContext): string | undefined
  /**
   * Compose one agent from a preset (standing mount + scope join). Call from
   * the agent factory `setup` hook only; throws on unknown/unusable presets.
   */
  mount(agentCtx: AgentScopedContext, id?: string): Promise<AgentPreset>
}

/**
 * The kernel agent factory (`ctx.agents`, dsh-agent `AgentRegistry` — the
 * creation subset plus live lookup). Creation/resume are async and return
 * owned handles; `get`/`list` read the live registry without owning.
 * Checked against dsh 0.1.5-rc.1.
 */
export interface KernelAgentsService {
  create(options: CreateAgentOptions): Promise<AgentHandle>
  resume(options: ResumeAgentOptions): Promise<AgentHandle>
  get(id: string): Agent | undefined
  list(): Agent[]
}

/**
 * Live session store (`ctx.sessions`, dsh-session `SessionStore` — the fork
 * subset Orca needs for rewind). Checked against dsh 0.1.5-rc.1.
 */
export interface KernelSessionsService {
  fork(source: string | Session, boundary?: number, childSessionId?: string): Session
}

/**
 * Unified session history reads (`ctx.sessionQuery`, dsh-session-query
 * `SessionQueryEngine` — the browser subset). All reads are live-preferred
 * and defensive: any rejection degrades to “no history”.
 * Checked against dsh 0.1.5-rc.1.
 */
export interface KernelSessionRecord {
  readonly header: { readonly id: string; readonly cwd?: string; readonly createdAt: number }
  readonly live: boolean
  readonly persisted: boolean
}

export interface KernelTitleSnapshot {
  readonly title: string
  readonly updatedAt: number
}

export interface KernelSessionQueryService {
  listSessions(signal?: AbortSignal): Promise<KernelSessionRecord[]>
  readTitle(sessionId: string, signal?: AbortSignal): Promise<KernelTitleSnapshot | undefined>
  readTitleSnapshots(sessionIds: readonly string[], signal?: AbortSignal): Promise<
    ReadonlyArray<
      | { readonly sessionId: string; readonly status: 'fulfilled'; readonly value: { readonly title?: KernelTitleSnapshot } }
      | { readonly sessionId: string; readonly status: 'rejected'; readonly reason: unknown }
    >
  >
  /**
   * Read and replay-validate one complete logical session log without making
   * it live (dsh-session-query `readSession`). Orca replays the events into
   * a fresh channel after a same-process silent remount so the transcript
   * survives hot reload.
   */
  readSession(sessionId: string): Promise<{ readonly events: readonly SessionEvent[] }>
}

/**
 * Log-backed title service (`ctx.sessionTitle`, dsh-session-title).
 * `rename` pins the title (user source); `get` folds the latest event.
 * Checked against dsh 0.1.5-rc.1.
 */
export interface KernelSessionTitleSnapshot {
  readonly title: string
  readonly updatedAt: number
}

export interface KernelSessionTitleService {
  get(session: Session): KernelSessionTitleSnapshot | undefined
  rename(session: Session, title: string): KernelSessionTitleSnapshot
  refresh(session: Session, signal?: AbortSignal): Promise<KernelSessionTitleSnapshot | undefined>
}

/**
 * Human-command registry (`ctx.commands`, dsh-commands `CommandRuntime`).
 * Orca dispatches `/compact` etc. through `execute` so the kernel-owned
 * handler (and its `command/run`/`command/done` audit pair) runs verbatim;
 * unknown lines resolve to `undefined` and fall back to a normal prompt.
 * Checked against dsh 0.1.5-rc.1.
 */
export interface KernelCommandDescriptor {
  readonly name: string
  readonly description: string
}

export interface KernelCommandExecution {
  readonly commandId: string
  readonly result: { readonly kind: 'success'; readonly text?: string } | { readonly kind: 'error'; readonly text: string }
}

/**
 * One attachment handed to a kernel command (dsh-commands
 * `CommandSubmitAttachment`): an inline encoded image, or the receipt id of a
 * file the caller already admitted through the attachment store.
 */
export type KernelCommandSubmitAttachment =
  | { readonly type: 'image'; readonly mediaType: ImageMediaType; readonly data: string; readonly name?: string }
  | { readonly type: 'file'; readonly receiptId: string }

export interface KernelCommandsService {
  list(agent: Agent): readonly KernelCommandDescriptor[]
  find(agent: Agent, name: string): { readonly name: string } | undefined
  execute(
    agent: Agent,
    line: string,
    submittedAttachments: readonly KernelCommandSubmitAttachment[],
    signal: AbortSignal,
  ): Promise<KernelCommandExecution | undefined>
}

/**
 * User-questions seam (`ctx.userQuestions`, dsh-user-questions). The model
 * asks via `dsh-tool-ask-user`; Orca registers the single UI provider that
 * renders the question and returns the human's structured answer.
 * Checked against @deepseek-ai/dsh-user-questions 0.1.5-rc.1.
 */
export interface KernelAskUserQuestionOption {
  readonly label: string
  readonly description?: string
}

export interface KernelAskUserQuestionItem {
  readonly id: string
  readonly question: string
  readonly detail?: string
  readonly header?: string
  readonly options?: readonly KernelAskUserQuestionOption[]
  readonly multiSelect?: boolean
  readonly intent?: { readonly kind: 'plan-review'; readonly approve: string }
}

export interface KernelAskUserQuestionAnswerItem {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

export interface KernelAskUserQuestionAnswer {
  readonly answers: readonly KernelAskUserQuestionAnswerItem[]
}

export interface KernelAskUserQuestionRequest {
  readonly questions: readonly KernelAskUserQuestionItem[]
  readonly agent?: unknown
  readonly signal?: AbortSignal
}

export interface KernelUserQuestionProvider {
  ask(request: KernelAskUserQuestionRequest): Promise<KernelAskUserQuestionAnswer>
}

export interface KernelUserQuestionService {
  registerProvider(provider: KernelUserQuestionProvider): () => void
}


/**
 * Approval seam (`ctx.approval`, dsh-user-approval). Orca only switches the
 * session policy (`ask` ⇄ `never` for `/yolo`) and answers the
 * `approval/request` waterfall as the interactive answerer; the audit pair
 * (`approval/asked` + `approval/decided`) is projected from the log.
 * Checked against dsh 0.1.5-rc.1.
 */
export type KernelApprovalPolicy = 'ask' | 'never'

export interface KernelApprovalRequest {
  readonly agent: Agent
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
  readonly signal?: AbortSignal
}

export type KernelApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

export interface KernelApprovalService {
  /**
   * The deployment's configured default policy (`never` under a headless/
   * full-access composition). Reported when the session log carries no
   * override — without it the footer would claim `ask` on a `never` profile.
   */
  readonly config?: { readonly policy?: KernelApprovalPolicy }
  setPolicy(agent: Agent, policy: KernelApprovalPolicy): void
  overrideOf(session: Session): KernelApprovalPolicy | undefined
  request(req: KernelApprovalRequest): Promise<KernelApprovalOutcome>
}

/**
 * Durable image attachment store (`ctx.attachments`, dsh-attachment
 * `AttachmentStore` — the admission subset Orca needs). A submitted image is
 * validated/normalized and committed durably BEFORE the owning user message
 * is appended; the returned reference rides the message's `image` block.
 * checked against dsh 0.1.5-rc.1. Optional seam — soft-probed.
 */
export interface KernelAttachmentLimits {
  readonly maxImageBytes: number
  readonly maxImagesPerMessage: number
  readonly maxMessageImageBytes: number
  readonly maxImagePixels: number
  readonly maxImageDimension: number
  readonly mediaTypes: readonly ImageMediaType[]
}

export interface SaveImageAttachment {
  readonly data: Uint8Array
  /** Caller-declared media type, checked against the decoded bytes. */
  readonly mediaType: ImageMediaType
  /** Optional display name; never interpreted as a path. */
  readonly name?: string
}

/** One non-image file handed to `saveFile` (dsh-attachment 0.1.5). */
export interface SaveFileAttachment {
  readonly data: Uint8Array
  readonly name?: string
}

/** Structured attachment failure (dsh-attachment `AttachmentError`). */
export interface KernelAttachmentError {
  /** Stable code, e.g. `UNSUPPORTED_IMAGE_TYPE` / `IMAGE_TOO_LARGE`. */
  readonly code: string
}

export interface KernelAttachmentStore {
  readonly imageLimits: KernelAttachmentLimits
  saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef>
  /**
   * Admit a non-image file and return its durable reference (dsh 0.1.5). The
   * reference rides the user message as a `file` block. Optional: it degrades
   * to "unsupported" on a kernel without the file path.
   */
  saveFile?(input: SaveFileAttachment): Promise<FileAttachmentRef>
  /** Narrow an unknown rejection to a coded attachment error. Optional. */
  isAttachmentError?(error: unknown): error is KernelAttachmentError
}

/**
 * `@path` completion candidates for one agent's working directory
 * (`ctx.fileReferences`, dsh-file-reference `FileReferenceService`).
 * Paths are workspace-relative; directories keep completion open (trailing
 * `/`), files finish the mention. Checked against dsh 0.1.5-rc.1. Optional
 * seam — soft-probed; Orca falls back to a shallow local scan when absent.
 */
export interface FileReferenceCandidate {
  readonly path: string
  readonly kind: 'file' | 'directory'
}

export interface KernelFileReferenceService {
  list(agent: Agent, query: string, signal: AbortSignal): Promise<FileReferenceCandidate[]>
}

/**
 * The subset of the Cordis `Context` Orca relies on.
 *
 * Discipline (dsh-ecosystem-spec #183): code-level inject stays empty; every
 * optional seam is soft-probed via `get(name, false)` and must degrade
 * silently when absent — an optional seam may never break the boot.
 */
export interface KernelContext {
  /**
   * Subscribe to a kernel event. `ctx.on` returns the listener's disposer
   * (cordis 4.0.2); emit listeners return nothing, waterfall listeners
   * receive `(payload, next)` and return the chained value.
   */
  on(name: string, listener: (...args: unknown[]) => unknown): () => void
  /** Soft-probe a service; pass `false` to return undefined instead of throwing. */
  get<T = unknown>(name: string): T | undefined
  get<T = unknown>(name: string, soft: false): T | undefined
  /**
   * Register a reversible effect: the disposer runs when the plugin unloads
   * (hot reload, profile teardown). Orca's whole app tree hangs off one
   * effect so unmount always restores the terminal. Cordis 4.0.2 awaits
   * asynchronous disposers before completing scope teardown.
   */
  effect(register: () => (() => void | Promise<void>) | void): void
}

/** Launcher-owned bounded exit request (`dsh-cmdline`, checked 0.1.5-rc.1). */
export type KernelAppExit = (code: number) => void

/**
 * Event names emitted by the kernel that Orca subscribes to. Real dispatch
 * shapes (dsh-agent / dsh-session cordis `Events`):
 * - `session/event` → `(session, event)` emit
 * - `session/disposed` → `(session)` emit
 * - `agent/status` → `({ agent, status })` emit
 * - `agent/error` → `({ agent, turn, step, error })` emit
 * - `agent/assistant-stream` → `({ agent, frame })` emit (dsh ≥ 0.1.5, the
 *   live model-stream publication; agent-scoped)
 * - `approval/request` → `(req, next)` waterfall (scoped to the agent)
 * - `commands/change` → `()` emit (command list changed)
 * Payloads are parsed defensively either way.
 */
export const KERNEL_EVENTS = {
  sessionEvent: 'session/event',
  agentStatus: 'agent/status',
  assistantStream: 'agent/assistant-stream',
  sessionDisposed: 'session/disposed',
  agentError: 'agent/error',
  approvalRequest: 'approval/request',
  commandsChange: 'commands/change',
} as const
