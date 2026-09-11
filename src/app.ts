/**
 * App bootstrap: wire kernel seams ↔ channel ↔ renderer ↔ keyboard.
 *
 * Lifecycle contract: bootstrapApp returns a disposer; the plugin registers
 * it via ctx.effect so unmount restores the terminal, stops input, and
 * disposes the agent. Exit paths (Ctrl+C) run the same disposer.
 *
 * Agent driving follows the real `ctx.agents` contract (dsh-agent
 * v0.1.5-rc.1): `create/resume` return an owned `AgentHandle` whose `agent`
 * carries the prompt surface (`followup`/`steer` take full `UserMessage`
 * values), and the handle's `dispose` is the only teardown path.
 *
 * Model selection mirrors the kernel's `installModelSelection` approach
 * without importing kernel packages: an `agent/request` waterfall listener
 * on the agent's own scope rewrites the resolved call config with the live
 * selection; `agentDefaultModel.saveSelection` persists it best-effort.
 *
 * Which route a session runs on is NOT Orca's invention: it is folded from the
 * SESSION's own durable record exactly as the web host does it — the last
 * still-unused `model/selection` event, else the last `request/header`
 * config, else the composition default (`agentDefaultModel`). A pick appends
 * the same log-only `model/selection` event the web's `session.selectModel`
 * appends, so both front doors read back the same answer.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, unlinkSync, appendFileSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { readClipboard } from './clipboard.js'
import { expandCustomCommand, readCustomCommands } from './custom-commands.js'
import type { CustomCommand } from './custom-commands.js'
import { Channel, isStreamChunk } from './adapter/channel.js'
import type { SessionRoute } from './adapter/channel.js'
import type { OrcaConfig } from './index.js'
import {
  builtinRules,
  evaluateCall,
  parseRulePattern,
  readRulesFile,
  ruleText,
  rulesPaths,
  suggestPattern,
  writeRulesFile,
} from './permission-rules.js'
import type { PermissionRule, RuleDecision, RuleScope } from './permission-rules.js'
import type {
  Agent,
  AgentHandle,
  AgentScopedContext,
  ContentBlock,
  EpochHeader,
  FileAttachmentRef,
  FileReferenceCandidate,
  ImageAttachmentRef,
  ImageMediaType,
  KernelAgentDefaultModel,
  KernelAgentPresetsService,
  KernelAgentsService,
  KernelAppExit,
  KernelApprovalPolicy,
  KernelApprovalService,
  KernelAskUserQuestionAnswer,
  KernelAskUserQuestionAnswerItem,
  KernelAskUserQuestionRequest,
  KernelAttachmentStore,
  KernelCommandDescriptor,
  KernelCommandsService,
  KernelContext,
  KernelFileReferenceService,
  KernelLlmService,
  KernelLoader,
  KernelSessionQueryService,
  KernelSessionTitleService,
  KernelSessionsService,
  KernelSkillsService,
  KernelWorkspace,
  KernelWorkspaceRegistry,
  Session,
  SessionEvent,
  StreamChunk,
  UserMessage,
} from './kernel/types.js'
import { KERNEL_EVENTS } from './kernel/types.js'
import { buildFrame, routeKey, routeLine, welcomeCard, IMAGE_SENTINEL, FILE_SENTINEL } from './tui/chat.js'
import { classify, Keyboard } from './tui/input.js'
import type { KeyPress, MouseReport } from './tui/input.js'
import { openPicker, movePicker, pickedItem, togglePicker, type PickerItem, type PickerState } from './tui/picker.js'
import { Renderer } from './tui/renderer.js'
import { paintSelection, selectionText, type Selection } from './tui/selection.js'
import { theme } from './tui/theme.js'
import { currentOrcaVersion, fetchLatestOrcaVersion, installLatestOrca, compareVersions } from './update.js'

export interface AppIoDeps {
  stdout(): NodeJS.WriteStream
  stdin(): NodeJS.ReadStream
}

/** How long start() keeps waiting for dsh-agent-loop to register its factory. */
const FACTORY_RETRY_ATTEMPTS = 50
const FACTORY_RETRY_DELAY_MS = 100

/** Paste cap: beyond this the editor would stall the frame builder, so truncate. */
const PASTE_MAX_CHARS = 20_000

/**
 * SGR mouse mode: 1002 reports press/release AND drag motion, 1006 switches
 * the coordinates to `CSI < b ; x ; y M` (1-based cells, no 223-column cap).
 * Only turned on for the alternate screen — see the startup comment.
 */
const MOUSE_ON = '\x1b[?1002h\x1b[?1006h'
const MOUSE_OFF = '\x1b[?1002l\x1b[?1006l'
/** Wheel notch → transcript lines (one notch is three lines everywhere else). */
const WHEEL_LINES = 3

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

/** Loader activation may itself be waiting for the scope being disposed. */
async function waitUntilAborted(work: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  let stop = (): void => {}
  const aborted = new Promise<void>((resolve) => { stop = resolve })
  signal.addEventListener('abort', stop, { once: true })
  try {
    await Promise.race([work, aborted])
  } finally {
    signal.removeEventListener('abort', stop)
  }
}

/** In-process mount counter — attributes ORCA_LOG lines to one bootstrap. */
let bootSeq = 0

type PickerStage =
  | { readonly kind: 'providers' }
  | { readonly kind: 'models'; readonly provider: string }
  | { readonly kind: 'effort'; readonly provider: string; readonly model: string }
  | { readonly kind: 'sessions' }
  | { readonly kind: 'presets' }
  | { readonly kind: 'approval' }
  | { readonly kind: 'question' }

/** Slash command metadata — kimi-style grouping, aliases, idle gating. */
interface SlashCommand {
  readonly name: string
  readonly aliases: readonly string[]
  readonly group: string
  readonly description: string
  /** When true the command refuses while a turn is running (needs idle). */
  readonly idleOnly?: boolean
}

const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: 'help', aliases: ['h', '?'], group: '信息', description: '显示命令帮助' },
  { name: 'model', aliases: [], group: '账号/配置', description: '切换模型（provider → 模型 → 思考强度）' },
  { name: 'preset', aliases: [], group: '会话', description: '查看/切换 Agent 预设（下个新会话生效）' },
  { name: 'img', aliases: ['image', 'attach', 'file'], group: '输入', description: '附加本地文件（/img <路径>；图片走 image 块，其他走 file 块）' },
  { name: 'new', aliases: ['clear'], group: '会话', description: '丢弃当前上下文，开新会话' },
  { name: 'resume', aliases: ['sessions'], group: '会话', description: '浏览并恢复历史会话' },
  { name: 'title', aliases: ['rename'], group: '会话', description: '查看或设置会话标题' },
  { name: 'compact', aliases: [], group: '会话', description: '压缩上下文（可附 hint）', idleOnly: true },
  { name: 'usage', aliases: [], group: '信息', description: '显示 token 用量明细' },
  { name: 'yolo', aliases: [], group: '模式', description: '审批全放行开关（on/off）' },
  { name: 'permission', aliases: [], group: '模式', description: '查看/切换权限档位（内核预设）' },
  { name: 'perms', aliases: ['rules'], group: '模式', description: '本地审批规则（allow/deny/ask、只读免问、会话放行）' },
  { name: 'nerdfont', aliases: ['branch-icon'], group: '界面', description: '切换页脚 git 分支 Nerd Font 图标（on/off，无参切换）' },
  { name: 'skills', aliases: [], group: '扩展', description: '列出可用 skill（输入 /名字 直接调用）' },
  { name: 'update', aliases: ['upgrade'], group: '信息', description: '检查并更新 dsh-orca 到最新版' },
  { name: 'todo', aliases: ['todos'], group: '任务', description: '查看待办（编辑作为指令交给模型）' },
  { name: 'ask', aliases: [], group: '模式', description: '向 agent 提问（仅回答，不执行工具）' },
  { name: 'plan', aliases: [], group: '模式', description: '切换内核 plan 模式（计划需你批准）' },
]

function findSlash(name: string): SlashCommand | undefined {
  const lower = name.toLowerCase()
  return SLASH_COMMANDS.find((cmd) => cmd.name === lower || cmd.aliases.includes(lower))
}

function parseSlash(text: string): { readonly name: string; readonly args: string } | undefined {
  if (!text.startsWith('/')) return undefined
  const space = text.indexOf(' ')
  if (space === -1) return { name: text.slice(1), args: '' }
  return { name: text.slice(1, space), args: text.slice(space + 1).trim() }
}

/** True when `query` occurs in `text` as an ordered subsequence. */
function isSubsequence(query: string, text: string): boolean {
  if (query === '') return true
  let index = 0
  for (const char of text) {
    if (char === query[index]) index++
    if (index >= query.length) return true
  }
  return false
}

/**
 * Inline-menu rank for one candidate: 0 for an exact/prefix hit on the name or
 * an alias, 1 for a subsequence hit (`/modl` finds `/model`), undefined for a
 * miss. Lower sorts first; ties fall back to alphabetical order.
 */
function menuScore(name: string, aliases: readonly string[], query: string): number | undefined {
  const candidates = [name, ...aliases]
  if (query === '') return 0
  if (candidates.some((candidate) => candidate.startsWith(query))) return 0
  if (candidates.some((candidate) => isSubsequence(query, candidate))) return 1
  return undefined
}

export function bootstrapApp(
  ctx: KernelContext,
  config: OrcaConfig,
  deps: AppIoDeps = defaultDeps(),
  previousTeardown: Promise<void> = Promise.resolve(),
): () => Promise<void> {
  const stdout = deps.stdout()
  const stdin = deps.stdin()
  const bootId = ++bootSeq

  // Byte-level forensics (opt-in): ORCA_LOG=<path> records every stdout
  // write with its terminal geometry. Used to diagnose viewport artifacts
  // (truncation/misalignment) against the exact byte stream. Never affects
  // rendering; failures are swallowed so logging can never break the TUI.
  const logPath = process.env['ORCA_LOG']
  let restoreLog = (): void => {}
  if (logPath) {
    try {
      appendFileSync(
        logPath,
        `\n### boot#${bootId} pid=${process.pid} cols=${String(stdout.columns)} rows=${String(stdout.rows)} at=${new Date().toISOString()}\n`,
      )
      const originalWrite = stdout.write
      const origWrite = originalWrite.bind(stdout) as (...args: unknown[]) => boolean
      let writeNo = 0
      const loggedWrite = ((...args: unknown[]): boolean => {
        try {
          const head = args[0]
          const body = typeof head === 'string' ? head : '<non-string chunk>'
          appendFileSync(
            logPath,
            `--- boot#${bootId} write#${writeNo++} cols=${String(stdout.columns)} rows=${String(stdout.rows)} bytes=${Buffer.byteLength(body)} ---\n${body}\n`,
          )
        } catch {
          // Logging must never break the TUI.
        }
        return origWrite(...args)
      }) as typeof stdout.write
      stdout.write = loggedWrite
      restoreLog = () => {
        if (stdout.write === loggedWrite) stdout.write = originalWrite
      }
    } catch {
      // Logging must never break the TUI.
    }
  }

  const channel = new Channel()
  const renderer = new Renderer(
    stdout,
    () => stdout.columns ?? 80,
    () => stdout.rows ?? 24,
  )
  // Optional seams are soft-probed LAZILY at each use site (#183): loader
  // entries activate concurrently, so a service captured once at bootstrap
  // may stay `undefined` forever even though the kernel registers it moments
  // later (verified: `sessionQuery` read "unmounted" in-profile). Probing
  // through these getters after `loader.await()` (or on user action) always
  // sees the live registry.
  const getAgents = (): KernelAgentsService | undefined => ctx.get<KernelAgentsService>('agents', false)
  const getLlm = (): KernelLlmService | undefined => ctx.get<KernelLlmService>('llm', false)
  const getDefaultModel = (): KernelAgentDefaultModel | undefined => ctx.get<KernelAgentDefaultModel>('agentDefaultModel', false)
  const getAgentPresets = (): KernelAgentPresetsService | undefined => ctx.get<KernelAgentPresetsService>('agentPresets', false)
  const getSessionQuery = (): KernelSessionQueryService | undefined => ctx.get<KernelSessionQueryService>('sessionQuery', false)
  const getSessionTitle = (): KernelSessionTitleService | undefined => ctx.get<KernelSessionTitleService>('sessionTitle', false)
  const getCommands = (): KernelCommandsService | undefined => ctx.get<KernelCommandsService>('commands', false)
  const getApproval = (): KernelApprovalService | undefined => ctx.get<KernelApprovalService>('approval', false)
  const getSessions = (): KernelSessionsService | undefined => ctx.get<KernelSessionsService>('sessions', false)
  const getAttachments = (): KernelAttachmentStore | undefined => ctx.get<KernelAttachmentStore>('attachments', false)
  const getFileReferences = (): KernelFileReferenceService | undefined =>
    ctx.get<KernelFileReferenceService>('fileReferences', false)
  const getWorkspaceRegistry = (): KernelWorkspaceRegistry | undefined =>
    ctx.get<KernelWorkspaceRegistry>('workspaceRegistry', false)
  /**
   * Skill registry (`ctx.skills`, dsh-skill). The menu shows the USER-facing
   * catalog (`invocation.userInvocable`); invoking one is still the kernel's
   * `/name` gesture on a plain user message, so Orca only has to offer the
   * name — it never loads or injects the body itself.
   */
  const getSkills = (): KernelSkillsService | undefined => ctx.get<KernelSkillsService>('skills', false)

  let handle: AgentHandle | null = null
  let agent: Agent | null = null
  let disposed = false
  let disposeTask: Promise<void> | null = null
  let sessionTask: Promise<void> = previousTeardown.catch(() => {})
  let sessionAbort = new AbortController()
  let targetSessionId: string | null = null
  let replaying = false
  let bufferedEvents: SessionEvent[] = []
  let projectedSeq = -1
  const agentListenerDisposers: Array<() => void> = []

  const project = (event: SessionEvent): void => {
    const seq = event.seq
    if (typeof seq === 'number' && Number.isFinite(seq)) {
      if (seq <= projectedSeq) return
      projectedSeq = seq
    }
    channel.ingest(event)
  }

  const runSessionTask = (work: (signal: AbortSignal) => Promise<void>): Promise<void> => {
    if (disposed) return Promise.resolve()
    sessionAbort.abort()
    const controller = new AbortController()
    sessionAbort = controller
    sessionTask = sessionTask.then(async () => {
      if (!disposed && !controller.signal.aborted) await work(controller.signal)
    }).catch((error: unknown) => {
      if (!disposed && !controller.signal.aborted) {
        channel.pushSystem(`会话操作失败：${error instanceof Error ? error.message : String(error)}`)
      }
    })
    return sessionTask
  }
  /**
   * Effective approval policy folded from the log (`ask` default,
   * `never` = headless auto-reject). Yolo (auto-allow) is NOT a policy —
   * the kernel has no allow-all policy; Orca implements it as an
   * auto-answering `approval/request` waterfall (see below).
   */
  let approvalPolicy: KernelApprovalPolicy = 'ask'
  /** Yolo mode: auto-answer every approval ask with `allowed-once`. */
  let yoloMode = false
  /**
   * Plan mode is KERNEL state (`dsh-plan-mode`): the log-only `plan/mode`
   * event is the truth and `channel.planActive` folds it, so resume/fork
   * recover it. Orca used to keep a local boolean that rejected every tool
   * approval — that shadowed the kernel's reviewed exit (`exit_plan_mode`)
   * and lost the state on resume. Enforcement is now where the kernel puts
   * it: approval prompts and the sandbox, not a client-side veto.
   */
  const planActive = (): boolean => channel.planActive
  /** One-shot ask mode: the current `/ask` turn should answer without tools. */
  let askMode = false
  /**
   * Active agent-initiated question (ctx.userQuestions provider). When set,
   * the next submit is captured as the human's answer instead of being sent
   * to the agent.
   */
  let pendingQuestion: {
    readonly request: KernelAskUserQuestionRequest
    index: number
    readonly answers: KernelAskUserQuestionAnswerItem[]
    resolve: (answer: KernelAskUserQuestionAnswer) => void
    reject: (error: Error) => void
  } | null = null
  /** When true, the current question is waiting for a free-text custom answer. */
  let questionCustomMode = false
  /** Draft selected labels for the current multi-select question. */
  let questionDraftSelected: string[] = []

  /** Live model selection — overrides the request route via the waterfall. */
  let selection: SessionRoute | null = null
  /**
   * Route last announced to the model through an injected notice. Reset with
   * every agent, so a resumed session re-announces its (possibly different)
   * route once.
   */
  let announcedSelection: SessionRoute | null = null
  /**
   * Live preset selection (preset id) — composed via `meta.agentPreset` +
   * factory `setup` mount on the NEXT fresh session (`/new`). Resume/fork
   * inherit the recorded lineage; the running session never changes.
   */
  let presetSelection: string | null = null
  /** Preset id the live agent actually runs on (`composedPreset`, footer truth). */
  let livePreset: string | null = null
  /** The user explicitly chose 模型默认行为 in the effort picker — a real
   * "no effort" choice that persisted defaults must not silently undo. */
  let effortCleared = false
  let picker: PickerState | null = null
  let pickerStage: PickerStage | null = null
  const listenerDisposers: Array<() => void> = []

  // ── approval panel (M4) ───────────────────────────────────────────────────
  // One-shot FIFO: the kernel may ask concurrently (parallel tools); Orca
  // shows the head and queues the rest. Each entry resolves its waterfall
  // exactly once — dispose/cancel resolves `cancelled`, yolo `allowed-once`.

  interface PendingApproval {
    readonly toolName: string
    /** Exact tool call being decided, when the asker had one. */
    readonly callId?: string
    readonly reason: string
    /** Rule that already decided this ask (`ask` rules only reach the panel). */
    readonly rule?: PermissionRule
    resolve: (outcome: 'allowed-once' | 'rejected' | 'cancelled') => void
    settled: boolean
  }

  const approvalQueue: PendingApproval[] = []

  // ── approval rule layer (/perms) ──────────────────────────────────────────
  // The kernel has no rules (only `ask` | `never`), so "don't ask me again"
  // lives here. Rules answer the ask; they never run a tool the kernel
  // refused, and nothing local ever decides a call the kernel never asked
  // about. `answerApproval` below is the single gate.

  /** Session-scoped rules: created by the panel, gone with the session. */
  let sessionRules: PermissionRule[] = []
  /** File-backed rules, re-read on demand (`/perms reload`, session switch). */
  let userRules: PermissionRule[] = []
  let projectRules: PermissionRule[] = []
  /** Rule-file diagnostics (a broken JSON file must be reported, not ignored). */
  let rulesErrors: string[] = []
  /** Read-only tools are auto-allowed unless the config/deployment says no. */
  let autoAllowReadOnly = config.autoAllowReadOnly
  /** Rule keys already reported on screen (one notice per rule per session). */
  const announcedRules = new Set<string>()
  /** Ctrl-E on the approval panel expands the pending call's arguments. */
  let approvalExpanded = false

  const ruleStack = (): PermissionRule[] => [
    ...builtinRules(autoAllowReadOnly),
    ...userRules,
    ...projectRules,
    ...sessionRules,
  ]

  const loadRules = (announce: boolean): void => {
    const paths = rulesPaths(process.cwd())
    const user = readRulesFile(paths.user, 'user')
    const project = readRulesFile(paths.project, 'project')
    userRules = [...user.rules]
    projectRules = [...project.rules]
    rulesErrors = [user, project]
      .filter((file) => file.error !== undefined)
      .map((file) => `${file.path}：${file.error ?? ''}`)
    if (announce) {
      channel.pushSystem(
        `审批规则已重新读取：user ${userRules.length} 条 · project ${projectRules.length} 条 · session ${sessionRules.length} 条`,
      )
      for (const problem of rulesErrors) channel.pushSystem(`规则文件无法解析，已忽略：${problem}`)
    }
  }

  /** Rule keys are stable across reloads — that is what the notice dedupes on. */
  const ruleKey = (rule: PermissionRule): string => `${rule.scope}:${rule.decision}:${rule.pattern}`

  const noteRuleHit = (rule: PermissionRule, toolName: string): void => {
    const key = ruleKey(rule)
    if (announcedRules.has(key)) return
    announcedRules.add(key)
    channel.pushSystem(`⛨ 规则命中：${ruleText(rule)}（${scopeLabel(rule.scope)}${rule.reason !== undefined ? ` · ${rule.reason}` : ''}）→ ${toolName}`)
  }

  const scopeLabel = (scope: RuleScope): string =>
    scope === 'session' ? '本会话' : scope === 'project' ? '项目' : scope === 'user' ? '用户' : '内置'

  /** Approve/deny state to report once a rule auto-answered an ask. */

  const showApprovalPanel = (): void => {
    const head = approvalQueue[0]
    if (!head) return
    // Approval is modal: it supersedes any picker (the model picker can be
    // reopened with /model after the decision).
    pickerStage = { kind: 'approval' }
    // Show WHAT is being approved: the kernel hands us the exact `callId`, so
    // the panel can quote the pending tool call's arguments instead of asking
    // the user to approve a bare tool name.
    const call = head.callId === undefined ? undefined : channel.toolPreviewFor(head.callId)
    const detail = call !== undefined ? ` · ${call}` : head.reason !== '' ? ` — ${head.reason}` : ''
    // Rule capture is only offered when the rule would still be narrower than
    // the tool itself: an unparsable/oversized call gets no "总是放行" row that
    // silently means "this tool, always".
    const narrow = suggestPattern(head.toolName, argsOf(head))
    const items: PickerItem[] = []
    // Rule origin goes INSIDE the panel, not into the transcript: it must be
    // readable at the moment of the decision, and it explains why an `ask`
    // rule beat an `allow` rule.
    if (head.rule !== undefined) {
      items.push({ value: '__rule__', label: `命中规则：${ruleText(head.rule)}（${scopeLabel(head.rule.scope)}）`, disabled: true })
    }
    items.push(
      { value: 'allowed-once', label: '放行单次', hint: '1' },
      { value: 'allow-session', label: `本会话放行 ${head.toolName}`, hint: '2' },
      narrow !== head.toolName
        ? { value: 'allow-project', label: `总是放行 ${narrow}`, hint: '3 · 写入项目规则' }
        : { value: 'allow-project', label: `总是放行 ${head.toolName}（整工具）`, hint: '3 · 写入项目规则' },
      { value: 'rejected', label: '拒绝', hint: '4/Esc' },
    )
    picker = openPicker(`审批：${head.toolName}${detail}`, items)
  }

  /** Raw arguments of the ask under decision, when the channel still has them. */
  const argsOf = (entry: PendingApproval): string | undefined =>
    entry.callId === undefined ? undefined : channel.toolArgumentsFor(entry.callId)

  /**
   * Ctrl-E on the approval panel: dump the pending call's FULL arguments into
   * the transcript. The panel title keeps a one-line preview (so the layout
   * contract holds), and the expansion lands where the terminal's own
   * selection and scrollback can reach it — a transcript row is copyable, a
   * panel row is not.
   */
  const expandApproval = (): void => {
    const head = approvalQueue[0]
    if (!head) return
    const raw = argsOf(head)
    if (raw === undefined) {
      channel.pushSystem(
        `无法展开参数：${head.callId === undefined ? '内核未给 callId' : '参数超过 64 KiB 保留上限'}（按 ${head.toolName} 整工具判断）`,
      )
      return
    }
    if (approvalExpanded) {
      channel.pushSystem('参数已展开过（再按 Ctrl-E 不会重复打印）')
      return
    }
    approvalExpanded = true
    let pretty = raw
    try {
      pretty = JSON.stringify(JSON.parse(raw), null, 2)
    } catch {
      // Non-JSON payload: print it as-is.
    }
    const lines = pretty.split('\n')
    const MAX_LINES = 40
    const body = lines.slice(0, MAX_LINES).join('\n')
    channel.pushSystem(`审批参数（${head.toolName}）:\n${body}${lines.length > MAX_LINES ? `\n…还有 ${lines.length - MAX_LINES} 行` : ''}`)
  }

  /** Add a rule and persist it when it has a file scope. */
  const addRule = (rule: PermissionRule): { readonly ok: boolean; readonly detail: string } => {
    if (rule.scope === 'session') {
      sessionRules = [...sessionRules, { ...rule, scope: 'session' }]
      return { ok: true, detail: '本会话' }
    }
    const paths = rulesPaths(process.cwd())
    const path = rule.scope === 'user' ? paths.user : paths.project
    const existing = rule.scope === 'user' ? userRules : projectRules
    const already = existing.findIndex((candidate) => candidate.pattern === rule.pattern && candidate.decision === rule.decision)
    const next = already === -1 ? [...existing, rule] : existing
    const written = writeRulesFile(path, next)
    if (!written.ok) return { ok: false, detail: `${path}：${written.error}` }
    if (rule.scope === 'user') userRules = next
    else projectRules = next
    return { ok: true, detail: path }
  }

  const settleApprovalHead = (outcome: 'allowed-once' | 'rejected' | 'cancelled'): void => {
    const head = approvalQueue.shift()
    if (!head || head.settled) {
      if (pickerStage?.kind === 'approval') closePicker()
      return
    }
    head.settled = true
    if (pickerStage?.kind === 'approval') closePicker()
    approvalExpanded = false
    head.resolve(outcome)
    // Show the next queued ask, if any.
    if (approvalQueue.length > 0) showApprovalPanel()
  }

  /**
   * One panel decision. Rule-capture rows ("本会话放行" / "总是放行") write the
   * rule FIRST and then answer the ask exactly as a plain approval would, so
   * the kernel-side outcome vocabulary never grows.
   */
  const decideApproval = (value: string): void => {
    const head = approvalQueue[0]
    if (!head) return
    if (value === 'allow-session' || value === 'allow-project') {
      const scope: RuleScope = value === 'allow-session' ? 'session' : 'project'
      const pattern = scope === 'session' ? head.toolName : suggestPattern(head.toolName, argsOf(head))
      const created = addRule({ decision: 'allow', scope, pattern })
      if (!created.ok) {
        channel.pushSystem(`规则写入失败：${created.detail}`)
      } else {
        channel.pushSystem(`已加规则：allow ${pattern}（${scopeLabel(scope)} · ${created.detail}）`)
        // The user's action IS the record — do not re-announce this rule.
        announcedRules.add(`${scope}:allow:${pattern}`)
      }
      settleApprovalHead('allowed-once')
      return
    }
    settleApprovalHead(value === 'allowed-once' ? 'allowed-once' : 'rejected')
  }

  const answerApproval = (
    toolName: string,
    callId: string | undefined,
    reason: string,
    signal: AbortSignal | undefined,
  ): Promise<'allowed-once' | 'rejected' | 'cancelled'> => {
    // Ask mode blocks tool execution by rejecting approvals before yolo;
    // plan mode deliberately does NOT (kernel plan mode keeps every tool
    // callable and lets approvals/sandbox own enforcement).
    if (askMode) return Promise.resolve('rejected')
    // Yolo: auto-allow without ever showing the panel. It is a deliberate
    // "stop asking" switch, so it short-circuits BEFORE rules — and the rules
    // themselves can only answer an ask that reaches us.
    if (yoloMode) return Promise.resolve('allowed-once')
    if (disposed) return Promise.resolve('cancelled')
    const name = toolName === '' ? 'tool' : toolName
    const args = callId === undefined || callId === '' ? undefined : channel.toolArgumentsFor(callId)
    // The rule layer decides the ANSWER; the kernel still owns the ask, the
    // audit pair and the sandbox. `allow`/`deny` therefore resolve exactly the
    // same vocabulary the panel would have produced, so the log stays honest.
    const match = evaluateCall(ruleStack(), name, args)
    if (match && match.decision !== 'ask') {
      noteRuleHit(match.rule, name)
      return Promise.resolve(match.decision === 'allow' ? 'allowed-once' : 'rejected')
    }
    return new Promise<'allowed-once' | 'rejected' | 'cancelled'>((resolve) => {
      const entry: PendingApproval = {
        toolName: name,
        ...(callId === undefined || callId === '' ? {} : { callId }),
        reason,
        ...(match === undefined ? {} : { rule: match.rule }),
        resolve,
        settled: false,
      }
      approvalQueue.push(entry)
      if (approvalQueue.length === 1) showApprovalPanel()
      signal?.addEventListener(
        'abort',
        () => {
          const index = approvalQueue.indexOf(entry)
          if (index !== -1) approvalQueue.splice(index, 1)
          if (!entry.settled) {
            entry.settled = true
            if (pickerStage?.kind === 'approval' && approvalQueue.length === 0) closePicker()
            else if (pickerStage?.kind === 'approval') showApprovalPanel()
            resolve('cancelled')
          }
        },
        { once: true },
      )
    })
  }

  // Kernel → channel: session events are the single source of truth. The
  // listener shape is (session, event); both arrive unknown-typed and are
  // parsed defensively by the channel.
  listenerDisposers.push(
    ctx.on(KERNEL_EVENTS.sessionEvent, (...args: unknown[]) => {
      const event = args[1] as Partial<SessionEvent> | undefined
      const session = recordOf(args[0])
      if (disposed || session?.['id'] !== targetSessionId) return
      if (event && typeof event.type === 'string') {
        if (replaying) bufferedEvents.push(event as SessionEvent)
        else project(event as SessionEvent)
        // One-shot /ask mode lasts exactly one turn.
        if (event.type === 'turn/end') askMode = false
        // Fold the durable approval override for the footer — the log is
        // truth; the local /yolo switch below only updates the same fold.
        if (event.type === 'approval/policy' && agent) {
          try {
            const next = getApproval()?.overrideOf(agent.session)
            if (next) approvalPolicy = next
          } catch {
            // Best-effort fold; the footer keeps its last known value.
          }
        }
      }
    }),
  )
  listenerDisposers.push(
    ctx.on(KERNEL_EVENTS.sessionDisposed, (...args: unknown[]) => {
      if (recordOf(args[0])?.['id'] !== targetSessionId) return
      channel.pushSystem('session 已释放')
      handle = null
      agent = null
      targetSessionId = null
    }),
  )
  // Model-turn failures surface outside the session log (`agent/error` is a
  // live dispatch, not a persisted event) — show them as local notices.
  listenerDisposers.push(
    ctx.on(KERNEL_EVENTS.agentError, (...args: unknown[]) => {
      const payload = recordOf(args[0])
      const subject = recordOf(payload?.['agent'])
      if (subject?.['id'] !== targetSessionId) return
      const failure = payload ? recordOf(payload['error']) : undefined
      const message = failure && typeof failure['message'] === 'string' ? failure['message'] : '未知错误'
      channel.pushSystem(`agent 出错：${message}`)
    }),
  )

  const submit = (
    text: string,
    images: readonly ImageAttachmentRef[] = [],
    files: readonly FileAttachmentRef[] = [],
  ): void => {
    // A user-authored command REWRITES the outgoing text (its body is the
    // prompt); everything below then treats it as an ordinary message, so
    // attachments ride along and the transcript shows the expanded prompt.
    let outgoing = text
    const slash = parseSlash(text.trim())
    if (slash) {
      const cmd = findSlash(slash.name)
      if (cmd) {
        // Idle-gated commands refuse while a turn runs (kimi "Always
        // available" column) — the user breaks with Esc first.
        if (cmd.idleOnly && channel.runState !== 'idle') {
          channel.pushSystem(`/${cmd.name} 需在空闲时执行，先按 Esc 打断当前回合`)
          return
        }
        dispatchSlash(cmd.name, slash.args)
        return
      }
      const custom = findCustomCommand(slash.name)
      if (custom) {
        outgoing = expandCustomCommand(custom, slash.args)
        channel.pushSystem(`已展开自定义命令 /${custom.name}${custom.path ? `（${shortPath(custom.path)}）` : ''}`)
      } else {
        // Unknown slash: try the kernel-owned registry (e.g. commands
        // registered by plugins, including /compact's owner). Admission misses
        // resolve to undefined and fall through to a normal prompt — the kimi
        // behavior. Attachments are NOT forwarded: `CommandSubmitAttachment`
        // wants either base64 image bytes (we hold durable refs) or a STAGED
        // file receipt minted by the session upload owner, which an out-of-tree
        // TUI has no way to obtain. A miss therefore re-sends them as a prompt
        // (and a name that is a user-invocable skill reaches the kernel's
        // `/name` gesture the same way).
        const registry = agent ? getCommands() : undefined
        if (agent && registry) {
          const line = text.trim()
          void (async (): Promise<void> => {
            try {
              const execution = await registry.execute(agent, line, [], new AbortController().signal)
              if (execution === undefined) {
                agent.followup(buildUserMessage(text, images, files))
              } else if (files.length > 0 || images.length > 0) {
                channel.pushSystem('提示：内核命令不接收 Orca 的附件，本条命令未附带附件')
              }
            } catch (error) {
              channel.pushSystem(`命令执行失败：${error instanceof Error ? error.message : String(error)}`)
            }
          })()
          return
        }
      }
      // No registry to ask — treat as a normal prompt (kimi fallback).
    }
    if (!agent) {
      channel.pushSystem('agent 未就绪，输入被丢弃')
      return
    }
    // A lone image path (drag-drop fallback for terminals without bracketed
    // paste) attaches instead of sending the path as a prompt. Strip quotes
    // for the existence check but keep the original for attachment (it knows
    // how to handle quoted paths with spaces). Deliberately IMAGE-only:
    // auto-attaching any existing path would hijack ordinary prompts such as
    // "README.md" — non-image files need the explicit `/img` (`/attach`).
    const rawPath = outgoing.trim()
    const unquotedPath = rawPath.replace(/^"|"$/g, '').trim()
    if (
      images.length === 0 &&
      files.length === 0 &&
      looksLikeImagePath(rawPath) &&
      existsSync(resolvePath(unquotedPath))
    ) {
      void attachLocalPath(rawPath)
      return
    }
    // No optimistic echo: the user row is projected from the kernel's
    // `user/message` event, so the transcript stays a pure log projection.
    agent.followup(buildUserMessage(outgoing, images, files))
  }

  const dispatchSlash = (name: string, args: string): void => {
    switch (name) {
      case 'help':
        showHelp()
        break
      case 'model':
        openModelPicker()
        break
      case 'preset':
        doPreset(args)
        break
      case 'img':
        void doImage(args)
        break
      case 'usage':
        showUsage()
        break
      case 'title':
        doTitle(args)
        break
      case 'new':
        void switchToNew()
        break
      case 'resume':
        openResumePicker()
        break
      case 'compact':
        void doCompact(args)
        break
      case 'yolo':
        doYolo(args)
        break
      case 'permission':
        void doPermission(args)
        break
      case 'perms':
        doPerms(args)
        break
      case 'nerdfont':
        doNerdFont(args)
        break
      case 'skills':
        void doSkills()
        break
      case 'update':
        void doUpdate(args)
        break
      case 'todo':
        doTodo(args)
        break
      case 'ask':
        doAsk(args)
        break
      case 'plan':
        void doPlan(args)
        break
      default:
        channel.pushSystem(`未知命令：/${name}（/help 查看）`)
        break
    }
  }

  const showHelp = (): void => {
    const groups = new Map<string, string[]>()
    for (const cmd of SLASH_COMMANDS) {
      const aliases = cmd.aliases.length > 0 ? `（别名 /${cmd.aliases.join('、/')}）` : ''
      const line = `/${cmd.name}${aliases} — ${cmd.description}`
      const list = groups.get(cmd.group) ?? []
      list.push(line)
      groups.set(cmd.group, list)
    }
    // Kernel-registered commands (e.g. /compact's owner) append after ours.
    const registry = agent ? getCommands() : undefined
    if (agent && registry) {
      try {
        const extra = registry
          .list(agent)
          .filter((descriptor) => findSlash(descriptor.name) === undefined)
          .map((descriptor) => `/${descriptor.name} — ${descriptor.description}`)
        if (extra.length > 0) groups.set('内核', extra)
      } catch {
        // Discovery is best-effort; local help stays usable.
      }
    }
    // User-authored commands and skills are DYNAMIC, so they are listed here
    // rather than in the static table (a long list is summarised; `/skills`
    // prints the full catalogue).
    refreshCustomCommands()
    if (customCommands.length > 0) {
      groups.set(
        '自定义',
        customCommands.map(
          (command) =>
            `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ''} — ${command.description || '自定义命令'}`,
        ),
      )
    }
    refreshSkills()
    if (skillItems.length > 0) {
      const names = skillItems.map((skill) => `/${skill.name}`)
      const shown = names.slice(0, 8).join(' ')
      groups.set('Skills', [`${shown}${names.length > 8 ? ` …共 ${names.length} 个` : ''}（输入名字直接调用，/skills 看全部）`])
    } else if (getSkills()) {
      groups.set('Skills', ['未发现用户可调用的 skill（项目 .agents/skills 或 ~/.agents/skills）'])
    }
    channel.pushSystem('可用命令：')
    for (const [group, lines] of groups) {
      channel.pushSystem(`【${group}】${lines.join(' · ')}`)
    }
    channel.pushSystem('快捷键：@ 文件补全（Tab/Enter 确认）· Alt+Enter/Shift+Enter/Ctrl+J 换行 · ↑↓ 在多行里移动光标（到首/末行才召回历史）· Ctrl+V/Alt+V 附加剪贴板图片 · Shift+Tab 切换 yolo · Ctrl+O 展开思考 · Ctrl+C 打断/双击退出 · 双击 Esc 回退上一轮 · 未知 /命令将作为普通消息发给模型')
  }

  const showUsage = (): void => {
    const usage = channel.usage
    const cache = usage.cacheRead + usage.cacheWrite
    channel.pushSystem(
      `用量：↑${usage.input} 输入 · ↓${usage.output} 输出${usage.reasoning > 0 ? ` · ✻${usage.reasoning} 推理` : ''}${cache > 0 ? ` · ⇄${cache} 缓存` : ''} · ${usage.messages} 条 assistant 消息`,
    )
  }

  /**
   * Execute one kernel-registered slash command through `ctx.commands`.
   *
   * `ran`         — the registry admitted the line; the command's own
   *                 `command/run` + `command/done` events render the result.
   * `missing`     — no `commands` service in this composition.
   * `unregistered`— the kernel has no command by that name (or no agent yet).
   *
   * Delegation is the point: where the kernel owns state (`/permission`
   * presets, `/plan` mode, `/goal`, `/compact`), Orca must not re-implement
   * it locally — that is how the old shadow implementations drifted.
   */
  const runKernelCommand = async (line: string): Promise<'ran' | 'missing' | 'unregistered'> => {
    if (!agent) return 'unregistered'
    const registry = getCommands()
    if (!registry) return 'missing'
    try {
      const execution = await registry.execute(agent, line, [], new AbortController().signal)
      return execution === undefined ? 'unregistered' : 'ran'
    } catch (error) {
      channel.pushSystem(`命令执行失败：${error instanceof Error ? error.message : String(error)}`)
      return 'ran'
    }
  }

  const showPermission = (): void => {
    const approval = getApproval()
    if (agent && approval) {
      try {
        // Session override first, then the DEPLOYMENT default (a headless /
        // full-access composition configures `never`) — only then the local
        // estimate, which is what an unconfigured `ask` kernel would use.
        const override = approval.overrideOf(agent.session) ?? approval.config?.policy
        const effective = override ?? approvalPolicy
        channel.pushSystem(`审批策略：${effective}${yoloMode ? ' · yolo 开（自动放行单次）' : ''}（ask = 逐次确认，never = 全拒绝）`)
        return
      } catch {
        // Fall through to the cached value.
      }
    }
    channel.pushSystem(`审批策略：${approvalPolicy}${yoloMode ? ' · yolo 开' : ''}（approval 服务未挂载时为本地估计值）`)
  }

  /**
   * Permission presets (sandbox mode + approval policy bound together) are
   * KERNEL state owned by `dsh-permission-presets`, whose `/permission`
   * command is the only thing that can switch them — so arguments are
   * delegated and a bare `/permission` reports BOTH: Orca's folded approval
   * policy (local explanation) and the kernel's current preset.
   */
  const doPermission = async (args: string): Promise<void> => {
    const arg = args.trim()
    if (arg !== '') {
      const outcome = await runKernelCommand(`/permission ${arg}`)
      if (outcome === 'missing') {
        channel.pushSystem('commands 服务未挂载：无法切换权限档位（需 dsh-permission-presets + dsh-commands）')
      } else if (outcome === 'unregistered') {
        channel.pushSystem('内核未注册 /permission 命令（需挂载 dsh-permission-presets）')
      }
      return
    }
    showPermission()
    await runKernelCommand('/permission')
  }

  /**
   * Local permission rules (`/perms`). The kernel has NO rule engine — its
   * `ctx.approval` is policy-level (`ask` | `never`) — so "don't ask me again"
   * is Orca's own layer. It is deliberately inspectable: every rule prints with
   * its scope and file, `/perms` shows the ORIGIN of anything already in
   * force, and nothing here can run a tool the kernel refused.
   *
   *   /perms                             list effective rules + files
   *   /perms allow|deny|ask <pattern>    add (project file by default)
   *   /perms ... --user | --session      choose scope (`--reason <文字>` 可选)
   *   /perms rm <n>                      remove the rule numbered by /perms
   *   /perms reads on|off                builtin 只读工具免问（本次运行）
   *   /perms reload                      re-read both rule files
   */
  const doPerms = (args: string): void => {
    const parts = args.trim().split(/\s+/).filter((part) => part !== '')
    const verb = (parts[0] ?? 'list').toLowerCase()
    const paths = rulesPaths(process.cwd())

    const describe = (rule: PermissionRule, index?: number): string => {
      const number = index === undefined ? '' : `${String(index).padStart(2, ' ')}. `
      const reason = rule.reason === undefined ? '' : ` — ${rule.reason}`
      const mark = rule.decision === 'deny' ? '⛔' : rule.decision === 'ask' ? '❓' : '✓'
      return `${number}${mark} ${ruleText(rule)} [${scopeLabel(rule.scope)}]${reason}`
    }

    const list = (): void => {
      const builtin = builtinRules(autoAllowReadOnly)
      const all = ruleStack()
      channel.pushSystem(
        `审批规则（共 ${all.length} 条）：内置 ${builtin.length} · 用户 ${userRules.length} · 项目 ${projectRules.length} · 本会话 ${sessionRules.length}`,
      )
      channel.pushSystem(`判定优先级：deny > ask > allow；同判定下更靠后的作用域胜出（本会话 > 项目 > 用户 > 内置）`)
      all.forEach((rule, index) => {
        channel.pushSystem(describe(rule, index + 1))
      })
      if (all.length === 0) {
        channel.pushSystem('（没有规则：每次审批都会问；只读工具免问可用 /perms reads on 打开）')
      }
      channel.pushSystem(`用户规则：${paths.user}`)
      channel.pushSystem(`项目规则：${paths.project}（“总是放行”写这里）`)
      if (yoloMode) channel.pushSystem('注意：yolo 当前开着，规则不会被执行（yolo 先放行一切）')
      for (const problem of rulesErrors) channel.pushSystem(`规则文件无法解析，已忽略：${problem}`)
    }

    if (verb === 'list') {
      list()
      return
    }

    if (verb === 'reload') {
      loadRules(true)
      return
    }

    if (verb === 'reads') {
      const choice = (parts[1] ?? '').toLowerCase()
      if (choice !== 'on' && choice !== 'off') {
        channel.pushSystem(`只读工具免问：${autoAllowReadOnly ? '开' : '关'}（/perms reads on|off；持久开关是 profile 里 orca 行的 autoAllowReadOnly）`)
        return
      }
      autoAllowReadOnly = choice === 'on'
      channel.pushSystem(
        autoAllowReadOnly
          ? `只读工具免问已开启（本次运行）：${builtinRules(true).length} 条内置 allow（deny/ask 规则仍优先）`
          : '只读工具免问已关闭（本次运行）：只读工具也会逐次确认',
      )
      return
    }

    if (verb === 'rm' || verb === 'remove') {
      const index = Number.parseInt(parts[1] ?? '', 10)
      const all = ruleStack()
      if (!Number.isInteger(index) || index < 1 || index > all.length) {
        channel.pushSystem(`用法：/perms rm <编号>（编号见 /perms 列表，1..${all.length}）`)
        return
      }
      const target = all[index - 1]
      if (!target) return
      if (target.scope === 'builtin') {
        channel.pushSystem('内置规则不可单条删除：用 /perms reads off 关闭只读免问')
        return
      }
      if (target.scope === 'session') {
        sessionRules = sessionRules.filter((rule) => rule !== target)
        channel.pushSystem(`已删除本会话规则：${ruleText(target)}`)
        return
      }
      const path = target.scope === 'user' ? paths.user : paths.project
      const from = target.scope === 'user' ? userRules : projectRules
      const next = from.filter((rule) => rule !== target)
      const written = writeRulesFile(path, next)
      if (!written.ok) {
        channel.pushSystem(`规则文件写入失败：${written.error}`)
        return
      }
      if (target.scope === 'user') userRules = next
      else projectRules = next
      channel.pushSystem(`已删除${scopeLabel(target.scope)}规则：${ruleText(target)}（${path}）`)
      return
    }

    if (verb === 'allow' || verb === 'deny' || verb === 'ask') {
      const decision = verb as RuleDecision
      const flags = parts.slice(1)
      let scope: RuleScope = 'project'
      let reason: string | undefined
      const patternParts: string[] = []
      for (let index = 0; index < flags.length; index++) {
        const token = flags[index] ?? ''
        if (token === '--user' || token === '-u') scope = 'user'
        else if (token === '--session' || token === '-s') scope = 'session'
        else if (token === '--project' || token === '-p') scope = 'project'
        else if (token === '--reason' || token === '-r') {
          reason = flags[index + 1]
          index++
        } else patternParts.push(token)
      }
      let pattern = patternParts.join(' ')
      if (pattern !== '' && parseRulePattern(pattern) === undefined && patternParts.length > 1) {
        // A pattern containing spaces must be quoted; a bare multi-word entry
        // is far more likely to be a forgotten quote than a valid pattern.
        channel.pushSystem(`模式无法解析：${pattern}（含空格时请加引号，例如 bash("npm test":*)）`)
        return
      }
      if (pattern === '') {
        channel.pushSystem(`用法：/perms ${decision} <对象> [--user|--session] [--reason 文字]`)
        channel.pushSystem('对象写法：* / tool / tool(参数) / tool(前缀:*) / tool(glob*)。例：/perms allow bash(npm test:*)')
        return
      }
      if (decision === 'allow' && pattern === '*') {
        channel.pushSystem('拒绝创建 allow *：整机放行请用 /yolo on（它明确、可一键关，也不会写进规则文件）')
        return
      }
      const parsed = parseRulePattern(pattern)
      if (parsed === undefined) {
        channel.pushSystem(`模式无法解析：${pattern}（合法写法：* / tool / tool(参数) / tool(前缀:*)）`)
        return
      }
      pattern = parsed.spec === undefined ? parsed.tool : `${parsed.tool}(${parsed.spec})`
      const created = addRule({
        decision,
        scope,
        pattern,
        ...(reason === undefined ? {} : { reason }),
      })
      if (!created.ok) {
        channel.pushSystem(`规则写入失败：${created.detail}`)
        return
      }
      channel.pushSystem(`已加规则：${decision} ${pattern}（${scopeLabel(scope)} · ${created.detail}）`)
      if (decision === 'deny') channel.pushSystem('deny 会直接拒绝该工具的调用（模型会收到拒绝结果），且优先于任何 allow')
      return
    }

    channel.pushSystem('用法：/perms [list|allow|deny|ask|rm|reads|reload]（无参 = 列表）')
  }

  const doYolo = (args: string): void => {
    const normalized = args.trim().toLowerCase()
    let next: boolean | null = null
    if (normalized === 'on' || normalized === 'true' || normalized === '1') next = true
    else if (normalized === 'off' || normalized === 'false' || normalized === '0') next = false
    else if (normalized === '') next = !yoloMode
    if (next === null) {
      channel.pushSystem('用法：/yolo [on|off]')
      return
    }
    yoloMode = next
    // Yolo needs asks to reach our answerer: force the session policy back
    // to `ask` when enabling (a `never` policy would auto-reject before we
    // ever see the request). Best-effort; local flag still drives the panel.
    const approval = getApproval()
    if (next && agent && approval) {
      try {
        approval.setPolicy(agent, 'ask')
        approvalPolicy = 'ask'
      } catch {
        // Local flag stands on its own.
      }
    }
    channel.pushSystem(next ? 'yolo 已开启：工具审批自动放行（单次授权）' : 'yolo 已关闭：恢复逐次确认')
  }

  const doImage = async (args: string): Promise<void> => {
    const path = args.trim()
    if (path === '') {
      channel.pushSystem('用法：/img <路径>（图片走 image 块，其他文件走 file 块；可多次附加，随下一条消息发送）')
      return
    }
    await attachLocalPath(path)
  }

  const doNerdFont = (args: string): void => {
    const arg = args.trim().toLowerCase()
    let next: boolean
    if (arg === '' || arg === 'toggle') {
      next = !nerdFont
    } else if (arg === 'on' || arg === '1' || arg === 'true' || arg === 'yes') {
      next = true
    } else if (arg === 'off' || arg === '0' || arg === 'false' || arg === 'no') {
      next = false
    } else {
      channel.pushSystem('用法：/nerdfont [on|off]（无参切换）')
      return
    }
    nerdFont = next
    writeOrcaSettings({ nerdFont })
    channel.pushSystem(next ? 'Nerd Font 分支图标已开启（页脚显示 ）' : 'Nerd Font 分支图标已关闭（仅显示分支名）')
  }

  /**
   * `/skills` — the human-facing skill catalog. Reads the registry LIVE
   * (rather than the menu cache) so the answer is never stale, and lists only
   * `userInvocable` entries: those are exactly the ones the kernel's `/name`
   * gesture will honour in a user message.
   */
  const doSkills = async (): Promise<void> => {
    const skills = getSkills()
    if (!skills) {
      channel.pushSystem('skills 服务未挂载：无法列出 skill（profile 需挂载 dsh-skill + dsh-skill-filesystem）')
      return
    }
    try {
      const catalogue = await skills.list({ cwd: process.cwd() })
      const invocable = catalogue
        .filter((skill) => skill.invocation.userInvocable)
        .sort((a, b) => a.name.localeCompare(b.name))
      const modelOnly = catalogue.length - invocable.length
      if (invocable.length === 0) {
        const suffix = modelOnly > 0 ? `（另有 ${modelOnly} 个仅供模型调用）` : ''
        channel.pushSystem(`暂无可用 skill${suffix}：把 <name>/SKILL.md 放进项目 \`.agents/skills/\` 或 \`~/.agents/skills/\``)
        return
      }
      channel.pushSystem(`可用 skill（${invocable.length}）${modelOnly > 0 ? ` · 另 ${modelOnly} 个仅供模型调用` : ''}：输入 /名字 直接调用`)
      for (const skill of invocable) {
        channel.pushSystem(`/${skill.name} — ${skill.description}${skill.source ? `（${skill.source}）` : ''}`)
      }
    } catch (error) {
      channel.pushSystem(`skill 目录读取失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const doUpdate = async (_args: string): Promise<void> => {
    const current = currentOrcaVersion()
    channel.pushSystem(`当前版本：v${current}，正在检查最新版本...`)
    const latest = await fetchLatestOrcaVersion()
    if (!latest) {
      channel.pushSystem('检查最新版本失败：请确认网络或 npm 可用')
      return
    }
    if (compareVersions(latest, current) <= 0) {
      channel.pushSystem(`已是最新版本：v${current}`)
      return
    }
    channel.pushSystem(`发现新版本：v${latest}，开始更新...`)
    const result = await installLatestOrca()
    if (result.ok) {
      channel.pushSystem(`更新成功：v${latest}，请重启 Orca 生效`)
    } else {
      channel.pushSystem(`更新失败：${result.message}`)
    }
  }

  const doTodo = (args: string): void => {
    const parts = args.trim().split(/\s+/).filter((part) => part !== '')
    const command = (parts[0] ?? 'list').toLowerCase()
    const rest = parts.slice(1).join(' ').trim()
    const todos = channel.todos
    const usage = '用法：/todo [list|add <内容>|set <内容>|done <编号>|undo <编号>|del <编号>|clear]（set 多项用 | 分隔）'
    const showList = (): void => {
      if (todos.length === 0) {
        channel.pushSystem('暂无待办（待办由模型用 todo_write 维护）')
        return
      }
      const lines = todos.map((todo, index) => {
        const mark = todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '◐' : '○'
        return `${index + 1}. ${mark} ${todo.content}`
      })
      channel.pushSystem(`待办（${todos.length}）：`)
      for (const line of lines) channel.pushSystem(line)
    }
    /**
     * Hand the edit to the MODEL instead of mutating the projection: the list
     * is whole-list-replace state owned by `todo_write`, and the kernel's
     * invariant rejects a durable `todo/write` outside an open turn — so a
     * client-side "edit" could never be a real write. The old local mutation
     * silently lost every change on the next model write (and never reached
     * the model at all).
     */
    const askModel = (instruction: string): void => {
      channel.pushSystem('待办由模型持有（todo_write）：本条指令已作为消息交给模型改写。')
      submit(`待办列表需要更新（请用 todo_write 重写整份列表）：${instruction}`)
    }
    const todoContentAt = (index: number): string | undefined => todos[index - 1]?.content
    const checkIndex = (): number | null => {
      const n = Number(parts[1])
      if (!Number.isInteger(n) || n < 1 || n > todos.length) {
        channel.pushSystem(`用法：/todo ${command} <编号>（1-${todos.length}）`)
        return null
      }
      return n
    }
    switch (command) {
      case 'list':
      case 'ls':
        showList()
        break
      case 'add': {
        if (!rest) {
          channel.pushSystem('用法：/todo add <内容>')
          return
        }
        askModel(`在原列表基础上追加一项「${rest}」，其余项保持不变。`)
        break
      }
      case 'set': {
        if (!rest) {
          channel.pushSystem('用法：/todo set <内容>（多项用 | 或 Alt+Enter 换行分隔）')
          return
        }
        // Split on newlines and `|` only: `/` and `;` are ordinary content in
        // paths and code, so splitting on them would silently shred an item.
        const items = rest.split(/[\n|]+/).map((item) => item.trim()).filter((item) => item !== '')
        askModel(`把整份列表替换为：${items.map((item, index) => `${index + 1}. ${item}`).join('；')}。`)
        break
      }
      case 'done': {
        const n = checkIndex()
        if (n === null) return
        askModel(`把第 ${n} 项「${todoContentAt(n) ?? ''}」标记为 completed。`)
        break
      }
      case 'undo': {
        const n = checkIndex()
        if (n === null) return
        askModel(`把第 ${n} 项「${todoContentAt(n) ?? ''}」改回 pending。`)
        break
      }
      case 'del':
      case 'delete': {
        const n = checkIndex()
        if (n === null) return
        askModel(`删除第 ${n} 项「${todoContentAt(n) ?? ''}」，其余项保持不变。`)
        break
      }
      case 'clear':
        askModel('清空待办（写入空列表）。')
        break
      default:
        channel.pushSystem(usage)
        break
    }
  }

  const doAsk = (args: string): void => {
    const question = args.trim()
    if (!question) {
      channel.pushSystem('用法：/ask <问题>')
      return
    }
    askMode = true
    channel.pushSystem('Ask 模式：本轮只回答，不执行工具')
    submit(question, [])
  }

  /**
   * `/plan` delegates to the KERNEL plan mode (`dsh-plan-mode`). Its `/plan`
   * command owns the state (a log-only `plan/mode` event the `plan`
   * projection folds, so resume/fork recover it), injects the `plan:policy`
   * prompt section, and pairs with the `exit_plan_mode` tool whose review
   * arrives on the user-questions channel (see `showCurrentQuestion`). The
   * old local boolean shadowed that command, so the reviewed exit could
   * never run.
   */
  const doPlan = async (args: string): Promise<void> => {
    const arg = args.trim()
    const lower = arg.toLowerCase()
    let line: string
    if (lower === '' || lower === 'on') line = '/plan'
    else if (lower === 'off') line = '/plan off'
    else if (lower === 'toggle') line = planActive() ? '/plan off' : '/plan'
    // Any other text is an INSTRUCTION: the kernel enters plan mode and
    // steers the text as the next step's user message.
    else line = `/plan ${arg}`
    const outcome = await runKernelCommand(line)
    if (outcome === 'missing') {
      channel.pushSystem('commands 服务未挂载：无法切换 plan 模式（需 dsh-plan-mode + dsh-commands）')
    } else if (outcome === 'unregistered') {
      channel.pushSystem('内核未注册 /plan 命令（需挂载 dsh-plan-mode）')
    }
  }

  // ── agent-initiated questions (ctx.userQuestions provider) ────────────────

  const showCurrentQuestion = (): void => {
    if (!pendingQuestion) return
    const item = pendingQuestion.request.questions[pendingQuestion.index]
    if (!item) return
    questionCustomMode = false
    questionDraftSelected = []
    // `exit_plan_mode` reviews travel the SAME user-questions channel: the
    // question carries `intent.kind = 'plan-review'`, the plan markdown is
    // `detail`, and `intent.approve` names the approving option label. The
    // plan is pushed as ordinary system rows (they wrap and reflow on
    // resize) instead of a pre-rendered card, so nothing is truncated.
    const review = item.intent?.kind === 'plan-review'
    if (review) {
      channel.pushSystem(item.question)
      if (item.detail) channel.pushSystem(item.detail)
    } else {
      channel.pushSystem(`问题：${item.question}`)
      if (item.detail) channel.pushSystem(`详情：${item.detail}`)
    }
    if (item.options && item.options.length > 0) {
      pickerStage = { kind: 'question' }
      picker = openPicker(
        review ? '计划评审' : `问题：${item.question}`,
        [
          ...item.options.map((option, index) => ({
            value: option.label,
            label: `${index + 1}. ${option.label}`,
            ...(option.description ? { hint: option.description } : {}),
          })),
          { value: '__custom__', label: review ? '给反馈让模型继续改...' : '自定义回答...' },
        ],
        undefined,
      )
      if (item.multiSelect) picker.multi = true
    } else {
      channel.pushSystem('请直接输入回答后回车；Esc 取消')
    }
  }

  const answerCurrentQuestion = (raw: string, forceCustom = false, baseSelected: readonly string[] = []): void => {
    if (!pendingQuestion) return
    const item = pendingQuestion.request.questions[pendingQuestion.index]
    if (!item) {
      pendingQuestion.reject(new Error('question list is empty'))
      pendingQuestion = null
      return
    }
    const text = raw.trim()
    let selected: string[] = []
    let custom: string | undefined
    if (forceCustom) {
      selected = [...baseSelected]
      custom = text || undefined
    } else if (item.options && item.options.length > 0) {
      const parts = item.multiSelect ? text.split(/[,，、\s]+/).filter(Boolean) : [text]
      for (const part of parts) {
        const num = Number(part)
        const option =
          Number.isInteger(num) && num >= 1 && num <= item.options.length
            ? item.options[num - 1]
            : item.options.find((candidate) => candidate.label === part)
        if (option) selected.push(option.label)
        else custom = custom ? `${custom} ${part}` : part
      }
      if (!item.multiSelect && selected.length > 0) custom = undefined
      if (!item.multiSelect && selected.length === 0 && custom === undefined) custom = text
    } else {
      custom = text || undefined
    }
    pendingQuestion.answers.push({
      id: item.id,
      selected,
      ...(custom !== undefined ? { custom } : {}),
    })
    pendingQuestion.index++
    const next = pendingQuestion.request.questions[pendingQuestion.index]
    if (next) {
      showCurrentQuestion()
    } else {
      const answers = [...pendingQuestion.answers]
      const resolve = pendingQuestion.resolve
      pendingQuestion = null
      resolve({ answers })
    }
  }

  const cancelPendingQuestion = (): void => {
    if (!pendingQuestion) return
    const item = pendingQuestion.request.questions[pendingQuestion.index]
    const reject = pendingQuestion.reject
    pendingQuestion = null
    questionCustomMode = false
    questionDraftSelected = []
    // Esc during a plan review is the kernel's "dismissed to speak instead"
    // path: the model must stay in plan mode and wait for the user's message.
    // (The kernel wraps its own ASK_CANCELLED error here; an out-of-tree TUI
    // cannot construct that type, so the message carries the same meaning.)
    if (item?.intent?.kind === 'plan-review') {
      reject(
        new Error(
          'The user dismissed the plan review to speak instead; stay in plan mode, stop here, and wait for their message.',
        ),
      )
      return
    }
    reject(new Error('ask_user_question was aborted before the user answered'))
  }

  const answerCurrentQuestionOption = (label: string): void => {
    closePicker()
    answerCurrentQuestion(label)
  }

  const answerCurrentQuestionSelected = (selected: readonly string[]): void => {
    if (!pendingQuestion) return
    const item = pendingQuestion.request.questions[pendingQuestion.index]
    if (!item) {
      pendingQuestion.reject(new Error('question list is empty'))
      pendingQuestion = null
      return
    }
    pendingQuestion.answers.push({ id: item.id, selected: [...selected] })
    pendingQuestion.index++
    const next = pendingQuestion.request.questions[pendingQuestion.index]
    if (next) {
      showCurrentQuestion()
    } else {
      const answers = [...pendingQuestion.answers]
      const resolve = pendingQuestion.resolve
      pendingQuestion = null
      resolve({ answers })
    }
  }

  const startCustomAnswer = (baseSelected: readonly string[] = []): void => {
    questionCustomMode = true
    questionDraftSelected = [...baseSelected]
    closePicker()
    channel.pushSystem('请输入自定义回答后回车；Esc 取消')
  }

  const askUserQuestions = (request: KernelAskUserQuestionRequest): Promise<KernelAskUserQuestionAnswer> =>
    new Promise((resolve, reject) => {
      if (pendingQuestion) {
        reject(new Error('已有待回答问题，请先完成当前问题'))
        return
      }
      pendingQuestion = { request, index: 0, answers: [], resolve, reject }
      showCurrentQuestion()
    })

  const doTitle = (args: string): void => {
    if (!agent) {
      channel.pushSystem('agent 未就绪，标题不可用')
      return
    }
    if (args === '') {
      // Show: prefer the folded log title, fall back to the service.
      const current = channel.title ?? safeTitleGet()
      channel.pushSystem(current ? `会话标题：${current}` : '会话暂无标题（首条用户消息后自动生成）')
      return
    }
    const sessionTitle = getSessionTitle()
    if (!sessionTitle) {
      channel.pushSystem('sessionTitle 服务未挂载：无法设置标题')
      return
    }
    try {
      const snapshot = sessionTitle.rename(agent.session, args)
      channel.pushSystem(`标题已更新：${snapshot.title}`)
    } catch (error) {
      channel.pushSystem(`设置标题失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const safeTitleGet = (): string | null => {
    const sessionTitle = getSessionTitle()
    if (!agent || !sessionTitle) return null
    try {
      return sessionTitle.get(agent.session)?.title ?? null
    } catch {
      return null
    }
  }

  const doCompact = async (hint: string): Promise<void> => {
    const line = hint === '' ? '/compact' : `/compact ${hint}`
    const outcome = await runKernelCommand(line)
    if (outcome === 'missing') {
      channel.pushSystem('commands 服务未挂载：无法执行 /compact（内核需挂载 dsh-command-compact）')
    } else if (outcome === 'unregistered') {
      channel.pushSystem('内核未注册 /compact 命令')
    }
    // Success/failure rows arrive via command/done + compaction/* events.
  }

  const releaseAgent = async (): Promise<void> => {
    targetSessionId = null
    replaying = false
    bufferedEvents = []
    const previous = handle
    handle = null
    agent = null
    // The discovered command list belongs to the agent scope that is leaving.
    kernelCommands = []
    announcedSelection = null
    while (approvalQueue.length > 0) settleApprovalHead('cancelled')
    for (const stop of agentListenerDisposers.splice(0)) stop()
    try {
      await previous?.dispose()
    } catch {
      // A failed teardown must not prevent terminal restoration or switching.
    }
  }

  const clearProjection = (): void => {
    channel.clearForSwitch()
    projectedSeq = -1
    flushedSealed = 0
    flushedLine = 0
    titleCache = null
    livePreset = null
    // Session-scoped approval rules and their "already announced" memo die with
    // the session — file rules (user/project) are re-read on the next attach.
    sessionRules = []
    announcedRules.clear()
    approvalExpanded = false
    loadRules(false)
  }

  const switchToNew = (): Promise<void> => runSessionTask(async (signal) => {
    if (!getAgents()) {
      channel.pushSystem('agents 服务未挂载：无法新建会话')
      return
    }
    await releaseAgent()
    if (signal.aborted || disposed) return
    clearProjection()
    welcomed = true
    await createAgent(signal)
  })

  const createAgent = async (signal: AbortSignal, resumeId?: string, silent = false): Promise<boolean> => {
    if (disposed || signal.aborted) return false
    const agentFactory = getAgents()
    if (!agentFactory) {
      channel.pushSystem('kernel service `agents` 未挂载：Orca 以只读模式启动')
      return false
    }
    const cwd = process.cwd()
    const agentOptions = currentAgentOptions()
    // Fresh sessions compose the selected preset (explicit pick wins, else the
    // kernel default): the id is recorded in `meta.agentPreset` lineage AND
    // mounted via the factory `setup` hook (the only supported call site — a
    // mount rejection rolls the creation back). Resume/fork inherit the
    // recorded lineage untouched. Without the roster service this collapses
    // to today's rosterless create.
    const presetService = resumeId ? undefined : getAgentPresets()
    let presetId: string | undefined
    if (presetService) {
      try {
        presetId = (await presetService.resolve(presetSelection ?? undefined)).id
      } catch {
        if (presetSelection) channel.pushSystem(`预设 ${presetSelection} 不可用，已回退默认组成`)
      }
    }
    const resolvedPresetId = presetId
    const presetComposed = resolvedPresetId !== undefined && presetService !== undefined
    const buildCreateOptions = (withPreset: boolean) => ({
      sessionId: mintSessionId(),
      signal,
      meta: { cwd, ...(withPreset && resolvedPresetId !== undefined ? { agentPreset: resolvedPresetId } : {}) },
      ...(agentOptions ? { agentOptions } : {}),
      ...(withPreset && resolvedPresetId !== undefined && presetService !== undefined
        ? {
            setup: async (agentCtx: AgentScopedContext): Promise<void> => {
              await presetService.mount(agentCtx, resolvedPresetId)
            },
          }
        : {}),
    })
    let withPreset = presetComposed
    let created: AgentHandle
    for (let attempt = 0; ; attempt++) {
      if (disposed || signal.aborted) return false
      const options = buildCreateOptions(withPreset)
      targetSessionId = resumeId ?? options.sessionId
      bufferedEvents = []
      replaying = true
      projectedSeq = -1
      try {
        created = resumeId
          ? await agentFactory.resume({ resumeSessionId: resumeId, signal, ...(agentOptions ? { agentOptions } : {}) })
          : await agentFactory.create(options)
        break
      } catch (error) {
        if (disposed || signal.aborted) return false
        const message = error instanceof Error ? error.message : String(error)
        if (attempt < FACTORY_RETRY_ATTEMPTS && /no agent factory registered/i.test(message)) {
          await sleep(FACTORY_RETRY_DELAY_MS)
          continue
        }
        // A rejected preset composition rolls the whole creation back —
        // retry ONCE rosterless (the pre-preset behavior) so a broken
        // preset or a missing host service degrades instead of bricking
        // the boot. The pick stays recorded for the NEXT session.
        if (!resumeId && withPreset) {
          withPreset = false
          dbg(`createAgent 预设回退：${message}`)
          channel.pushSystem(`预设 ${resolvedPresetId} 挂载失败，本次启动回退无预设组成：${message}`)
          continue
        }
        dbg(`createAgent 失败：${message}`)
        if (!silent) channel.pushSystem(`agent 启动失败：${message}`)
        targetSessionId = null
        replaying = false
        bufferedEvents = []
        return false
      }
    }
    try {
      if (disposed || signal.aborted) {
        await created.dispose()
        return false
      }
      // Snapshot construction does not re-emit historical events. Buffer live
      // events during adoption, then merge them with the durable prefix by seq.
      let events: readonly SessionEvent[] = []
      try {
        if (created.agent.session.snapshotEvents) events = created.agent.session.snapshotEvents()
        else if (resumeId) events = (await getSessionQuery()?.readSession(resumeId))?.events ?? []
      } catch {
        events = []
      }
      if (disposed || signal.aborted) {
        await created.dispose()
        return false
      }
      const combined = [...events, ...bufferedEvents]
      combined.sort((a, b) => (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER))
      for (const event of combined) project(event)
      bufferedEvents = []
      replaying = false
      handle = created
      // Which route this session runs on is the SESSION's own record, not this
      // process's last pick: a resumed session carries the model it was last
      // used on (web or TUI), so it must outrank a leftover live selection.
      // A fresh session has neither, and keeps the picker/default answer.
      const recorded = durableSelection(created.agent.session)
      if (recorded !== undefined) {
        dbg(`会话记录的模型：${recorded.provider}/${recorded.model}${recorded.reasoningEffort ?? ''}`)
        selection = recorded
        effortCleared = recorded.reasoningEffort === undefined
      } else if (resumeId !== undefined) {
        // A RESUMED session that records no route at all (created but never
        // used, or a log without a request header): the kernel — and therefore
        // the web — runs it on the composition default. Carrying this
        // process's last pick in would make the TUI disagree with the
        // session's own record, so fall back to the same default the kernel
        // would use. Missing service = degrade to whatever was already there.
        const fallback = defaultRoute()
        if (fallback !== undefined) {
          dbg(`会话无路由记录，回落到组合默认：${fallback.provider}/${fallback.model}`)
          selection = fallback
          effortCleared = fallback.reasoningEffort === undefined
        }
      }
      attachAgent(created.agent)
    } catch (error) {
      await created.dispose().catch(() => {})
      if (handle === created) handle = null
      agent = null
      throw error
    }
    if (silent) welcomed = true
    else channel.pushSystem(`session 已连接：${created.agent.session.id}`)
    // Remember the live session for a same-process silent remount (hot
    // reload): the next bootstrap resumes THIS session instead of minting a
    // new one, so rebuilds stop stacking welcomes on the screen.
    writeLastSession(created.agent.session.id)
    // Fire-and-forget: a storage write must never gate the first frame, and
    // the helper contains every failure.
    void attachSessionToWorkspace(created.agent.session)
    return true
  }

  /**
   * Same-process silent remount (hot reload path). When the previous mount
   * in THIS process owned `lastSessionId` and its agent is gone (its effect
   * disposer ran `handle.dispose()`), resume it from persistence and replay
   * the durable log into the fresh channel: no new session, no welcome card,
   * no route line — the rebuild is invisible. Any failure falls through to
   * the normal fresh-create path. An explicit ORCA_RESUME_SESSION always
   * wins and bypasses this.
   */
  const trySilentRemount = async (signal: AbortSignal): Promise<boolean> => {
    const agentFactory = getAgents()
    if (!agentFactory) return false
    const last = readLastSession()
    if (!last || last.pid !== process.pid) return false
    // Still live = still owned by its mount (its effect never unwound).
    // Adopting foreign ownership would race its disposal — stay out.
    try {
      if (agentFactory.get(last.sessionId)) return false
    } catch {
      return false
    }
    return createAgent(signal, last.sessionId, true)
  }

  /**
   * The composition default this deployment would create a new agent on
   * (`agentDefaultModel`, `~/.dsh/settings.yaml`). Also the route the kernel
   * falls back to for a session whose own log records nothing.
   */
  const defaultRoute = (): SessionRoute | undefined => {
    const current = getDefaultModel()?.currentSelection()
    if (current === undefined || current.provider === '' || current.model === '') return undefined
    return {
      provider: current.provider,
      model: current.model,
      ...(typeof current.reasoningEffort === 'string' && current.reasoningEffort !== ''
        ? { reasoningEffort: current.reasoningEffort }
        : {}),
    }
  }

  const currentAgentOptions = (): { provider: string; model: string; reasoningEffort?: string } | undefined => {
    // Effort precedence: the live picker selection wins, then the persisted
    // composition default — in BOTH branches. The provider/model override
    // (config or default service) must never silently reset the effort, and
    // an explicit 模型默认 pick (effortCleared) must never be undone.
    const defaultModel = getDefaultModel()
    const selection0 = defaultModel?.currentSelection()
    const fallbackEffort =
      !effortCleared && selection0 !== undefined && selection0.reasoningEffort !== undefined && selection0.reasoningEffort !== ''
        ? selection0.reasoningEffort
        : undefined
    if (config.provider !== '' && config.model !== '') {
      const effort = selection?.reasoningEffort ?? fallbackEffort
      return { provider: config.provider, model: config.model, ...(effort !== undefined ? { reasoningEffort: effort } : {}) }
    }
    // The live picker selection outranks the persisted default (survives a
    // failed settings write and applies to the NEXT session on /new).
    if (selection) {
      return {
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort !== undefined && selection.reasoningEffort !== ''
          ? { reasoningEffort: selection.reasoningEffort }
          : {}),
      }
    }
    return selection0 && selection0.provider !== '' && selection0.model !== ''
      ? {
          provider: selection0.provider,
          model: selection0.model,
          ...(fallbackEffort !== undefined ? { reasoningEffort: fallbackEffort } : {}),
        }
      : undefined
  }

  /** Two routes are the same selection when provider, model and effort match. */
  const sameRoute = (left: SessionRoute, right: SessionRoute): boolean =>
    left.provider === right.provider &&
    left.model === right.model &&
    left.reasoningEffort === right.reasoningEffort

  /**
   * The route ONE session is recorded on, read out of its own log exactly the
   * way the kernel reads it (`dsh-api-session-controller`'s
   * `selectionFor` + the `model/selection` projection):
   *
   * 1. the last `model/selection` event, while it still differs from the route
   *    of the last request — a pick the next request has not consumed yet;
   * 2. else the last `request/header` config — the route actually used last;
   * 3. else nothing, and the caller falls back to the composition default.
   *
   * An effort the ADAPTER materialized itself (`adapterDefaults.reasoningEffort`)
   * is not a choice anyone made, so it is dropped rather than re-pinned.
   * History is read live-preferred: a resumed session's snapshot IS its durable
   * log, so this needs no persistence read of its own.
   */
  const durableSelection = (session: Session): SessionRoute | undefined => {
    let picked: SessionRoute | undefined
    try {
      for (const event of session.snapshotEvents()) {
        if (event.type !== 'model/selection') continue
        const data = recordOf(event.data)
        const provider = data === undefined || typeof data['provider'] !== 'string' ? '' : data['provider']
        const model = data === undefined || typeof data['model'] !== 'string' ? '' : data['model']
        if (provider === '' || model === '') continue
        const effort = data !== undefined && typeof data['reasoningEffort'] === 'string' ? data['reasoningEffort'] : ''
        picked = { provider, model, ...(effort !== '' ? { reasoningEffort: effort } : {}) }
      }
    } catch {
      return undefined
    }
    const used = routeOfHeader(session)
    if (picked !== undefined && (used === undefined || !sameRoute(picked, used))) return picked
    return used
  }

  /** The route of the session's last `request/header`, without adapter-materialized fields. */
  const routeOfHeader = (session: Session): SessionRoute | undefined => {
    let header: EpochHeader | undefined
    try {
      header = session.requestHeader?.()
    } catch {
      return undefined
    }
    const config = header?.config
    if (config === undefined) return undefined
    const provider = typeof config.provider === 'string' ? config.provider : ''
    const model = typeof config.model === 'string' ? config.model : ''
    if (provider === '' || model === '') return undefined
    const effort = header?.adapterDefaults?.reasoningEffort === true ? undefined : config.reasoningEffort
    return { provider, model, ...(typeof effort === 'string' && effort !== '' ? { reasoningEffort: effort } : {}) }
  }

  const attachAgent = (next: Agent): void => {
    agent = next
    // Footer truth: what this live agent actually runs on (recorded lineage
    // may predate the pick; the scope chain is authoritative).
    try {
      livePreset = getAgentPresets()?.composedPreset(next.ctx) ?? null
    } catch {
      livePreset = null
    }
    if (!selection) {
      const createdProvider = next.options.provider
      const createdModel = next.options.model
      const createdEffort = next.options.reasoningEffort
      if (createdProvider !== undefined && createdProvider !== '' && createdModel !== undefined && createdModel !== '') {
        // The effort MUST ride along: the request waterfall below strips any
        // inherited `reasoningEffort` before applying `selection` — dropping
        // it here would silently reset every request to the model default
        // even though the agent was created with an explicit effort.
        selection = {
          provider: createdProvider,
          model: createdModel,
          ...(createdEffort !== undefined && createdEffort !== '' ? { reasoningEffort: createdEffort } : {}),
        }
      }
    }
    try {
      const approval = getApproval()
      const override = approval?.overrideOf(next.session) ?? approval?.config?.policy
      if (override) approvalPolicy = override
    } catch {
      // Keep last known policy.
    }
    // Model selection, mirroring the kernel's `installModelSelection`
    // (@deepseek-ai/dsh-agent/model-selection) seam by seam. The kernel's
    // helper is a runtime export of a kernel package and is deliberately NOT
    // imported: an out-of-tree plugin resolves `@deepseek-ai/*` through the
    // profile's module fallback, which on this machine still holds a stale
    // 0.1.2-alpha.3 copy — importing it would install a foreign generation's
    // waterfall over a 0.1.5 kernel.
    //
    // 1. `system-prompt/assemble` — the prompt's `{{provider}}` / `{{model}}`
    //    variables must follow the LIVE selection. `dsh-agent-loop` registers
    //    them from `agent.options.*`, i.e. the route the agent was CREATED
    //    with, and the shipped presets' persona reads "You are a coding agent
    //    powered by the {{model}} model." (verified in a real session log:
    //    the persona still named the creation route after a switch). Without
    //    this hook the session's own memory of which model it runs on is
    //    stale — the model keeps telling the user the old name.
    // 2. `agent/request` — apply the selection SNAPSHOT taken at assembly time
    //    rather than whatever is live now, so a switch cannot split one step
    //    (prompt assembled for A, request sent to B); a mid-step pick takes
    //    effect from the next step. An absent effort clears the inherited one.
    //    The `?? selection` fallback only matters for a harness that never
    //    assembles (the fake kernel); the real kernel always assembles first.
    // 3. the durable switch notice (below), so a model inheriting the
    //    conversation knows the turns above it came from another model.
    let assembledSelection: SessionRoute | undefined
    const disposeAssemble = next.ctx.on('system-prompt/assemble', (...args: unknown[]) => {
      const waterfallNext = args[args.length - 1] as () => Promise<Record<string, unknown>>
      return (async (): Promise<Record<string, unknown>> => {
        const assembled = await waterfallNext()
        const live = selection
        assembledSelection = live ?? undefined
        if (!live) return assembled
        const variables = recordOf(assembled['variables']) ?? {}
        return { ...assembled, variables: { ...variables, provider: live.provider, model: live.model } }
      })()
    })
    agentListenerDisposers.push(disposeAssemble)
    const disposeWaterfall = next.ctx.on('agent/request', (...args: unknown[]) => {
      const waterfallNext = args[1] as () => Promise<Record<string, unknown>>
      return (async (): Promise<Record<string, unknown>> => {
        const resolved = await waterfallNext()
        const live = assembledSelection ?? selection
        if (!live) return resolved
        const { reasoningEffort: _inherited, ...rest } = resolved
        return {
          ...rest,
          provider: live.provider,
          model: live.model,
          ...(live.reasoningEffort !== undefined ? { reasoningEffort: live.reasoningEffort } : {}),
        }
      })()
    })
    agentListenerDisposers.push(disposeWaterfall)
    // Interactive answerer for `approval/request` (dsh-user-approval
    // waterfall, scoped to this agent — dies with the agent). Yolo
    // short-circuits inside answerApproval; the audit pair still lands via
    // session/event. A throwing answerer must never break the turn — the
    // service normalizes it to `unavailable`, but we fail closed to
    // `rejected` ourselves so the panel can never grant by accident.
    const disposeApproval = next.ctx.on(KERNEL_EVENTS.approvalRequest, (...args: unknown[]) => {
      const req = recordOf(args[0])
      const waterfallNext = typeof args[1] === 'function' ? (args[1] as () => Promise<string>) : undefined
      return (async (): Promise<string> => {
        let toolName = ''
        let callId: string | undefined
        let reason = ''
        let signal: AbortSignal | undefined
        if (req) {
          if (typeof req['toolName'] === 'string') toolName = req['toolName']
          if (typeof req['callId'] === 'string') callId = req['callId']
          if (typeof req['reason'] === 'string') reason = req['reason']
          if (req['signal'] instanceof AbortSignal) signal = req['signal']
        }
        try {
          return await answerApproval(toolName, callId, reason, signal)
        } catch {
          return 'rejected'
        } finally {
          // Keep the chain honest: if we did not claim the ask (e.g. yolo
          // short-circuit still counts as a claim — we returned), nothing to
          // delegate. We always claim, so `next` is never called.
          void waterfallNext
        }
      })()
    })
    agentListenerDisposers.push(disposeApproval)

    // Interactive answerer for `user-questions/request` (dsh-user-questions
    // waterfall, scoped to this agent). The model calls `ask_user_question`
    // through `@deepseek-ai/dsh-tool-ask-user`; we render the question and
    // return the structured answer, or delegate when another answerer claims it.
    const disposeUserQuestions = next.ctx.on('user-questions/request', (...args: unknown[]) => {
      const req = recordOf(args[0])
      const waterfallNext = typeof args[1] === 'function' ? (args[1] as () => Promise<KernelAskUserQuestionAnswer>) : undefined
      if (!req) return waterfallNext ? waterfallNext() : { answers: [] }
      const questions = Array.isArray(req['questions']) ? (req['questions'] as KernelAskUserQuestionRequest['questions']) : []
      const signal = req['signal'] instanceof AbortSignal ? req['signal'] : undefined
      return askUserQuestions({ questions, agent: req['agent'], ...(signal ? { signal } : {}) })
    })
    agentListenerDisposers.push(disposeUserQuestions)

    // Live model streaming (dsh ≥ 0.1.5). The session log no longer records
    // chunks — a live turn publishes `agent/assistant-stream` frames on the
    // AGENT scope instead, and the durable `assistant/message` settles them.
    // Without this listener the transcript would only fill in at step end.
    const disposeStream = next.ctx.on(KERNEL_EVENTS.assistantStream, (...args: unknown[]) => {
      if (disposed) return
      const payload = recordOf(args[0])
      const subject = recordOf(payload?.['agent'])
      // Defence in depth: the listener is already agent-scoped, but a frame
      // for another agent must never touch this transcript.
      if (subject && subject['id'] !== targetSessionId) return
      const frame = recordOf(payload?.['frame'])
      if (!frame) return
      const kind = frame['type']
      if (kind === 'start') {
        channel.beginAttempt()
        return
      }
      if (kind !== 'chunk') {
        // `end` reports settlement bookkeeping (attemptId/revision/outcome);
        // the durable event owns the transcript, so nothing to project.
        return
      }
      const chunk = frame['chunk']
      if (isStreamChunk(chunk)) channel.ingestStreamChunk(chunk as StreamChunk)
    })
    agentListenerDisposers.push(disposeStream)
    // The registry is agent-scoped, so the command list is (re)discovered for
    // every attached agent; `commands/change` keeps it fresh afterwards. The
    // user-authored command tree and the skill catalogue are process-wide, so
    // they are read once per attach (and throttled re-reads afterwards).
    refreshKernelCommands()
    refreshCustomCommands(true)
    refreshSkills()
    loadRules(false)
  }

  // ── /model picker ─────────────────────────────────────────────────────────

  const dbg = (message: string): void => {
    if (process.env['ORCA_DEBUG'] === '1') process.stderr.write(`[orca:dbg] ${message}\n`)
  }

  const closePicker = (): void => {
    picker = null
    pickerStage = null
  }

  // ── inline slash-command menu (kimi `/` completion) ───────────────────────
  // Non-modal: derived from the editor text every frame, navigated with ↑↓
  // (wrap-around), completed with Tab (or Enter on a partial match),
  // dismissed by Esc (which clears the editor as before).

  let menuIndex = 0

  /**
   * Commands registered by kernel plugins (dsh-commands `ctx.commands`), e.g.
   * `/compact`'s owner. Orca's own table shadows them by name, so the menu
   * lists only what it cannot dispatch itself. Refreshed when the registry
   * announces a change and whenever an agent is attached.
   */
  let kernelCommands: readonly KernelCommandDescriptor[] = []

  const refreshKernelCommands = (): void => {
    const registry = agent ? getCommands() : undefined
    if (!registry || !agent) {
      kernelCommands = []
      return
    }
    try {
      kernelCommands = registry.list(agent).filter((descriptor) => findSlash(descriptor.name) === undefined)
    } catch {
      // Discovery is best-effort; the local table stays usable.
      kernelCommands = []
    }
  }

  listenerDisposers.push(
    ctx.on(KERNEL_EVENTS.commandsChange, () => {
      refreshKernelCommands()
    }),
  )
  // The skill registry invalidates its catalog on any provider/revision
  // change and expects consumers to refetch for their own lookup options.
  listenerDisposers.push(
    ctx.on(KERNEL_EVENTS.skillsChange, () => {
      skillsFetchedAt = 0
      refreshSkills()
    }),
  )

  /**
   * User-authored commands (`.orca/commands/**` + `$DSH_HOME/orca/commands`).
   * Re-scanned with a 1s cache so editing a file reaches the menu without a
   * restart, while a keystroke-per-frame menu cannot hammer the filesystem.
   * `ORCA_COMMANDS_DIR` overrides the project root (tests point it at a temp
   * tree; a deployment can relocate it).
   */
  let customCommands: CustomCommand[] = []
  let customCommandsReadAt = 0

  const customCommandRoots = (): string[] => {
    const override = process.env['ORCA_COMMANDS_DIR']
    const project =
      override !== undefined && override !== '' ? override : join(process.cwd(), '.orca', 'commands')
    const home = process.env['DSH_HOME']
    const userRoot =
      home !== undefined && home !== ''
        ? join(home, 'orca', 'commands')
        : join(process.env['USERPROFILE'] ?? process.env['HOME'] ?? '', '.dsh', 'orca', 'commands')
    return [project, userRoot]
  }

  const refreshCustomCommands = (force = false): void => {
    const now = Date.now()
    if (!force && now - customCommandsReadAt < 1000) return
    customCommandsReadAt = now
    customCommands = readCustomCommands(customCommandRoots())
  }

  const findCustomCommand = (name: string): CustomCommand | undefined => {
    refreshCustomCommands()
    const lower = name.toLowerCase()
    return customCommands.find((command) => command.name.toLowerCase() === lower)
  }

  /**
   * User-invocable skills from the kernel skill registry (dsh-skill). The
   * fetch is asynchronous (providers may touch the filesystem), so the menu
   * renders this cache and a landed fetch bumps the channel version to
   * repaint. A failing provider keeps the last good catalogue — discovery is
   * best-effort by contract, exactly like the kernel's own consumer.
   */
  let skillItems: readonly { readonly name: string; readonly description: string; readonly source: string }[] = []
  let skillsFetchedAt = 0
  let skillsFetching = false

  const refreshSkills = (): void => {
    const skills = getSkills()
    if (!skills || skillsFetching) return
    if (Date.now() - skillsFetchedAt < 5000) return
    skillsFetching = true
    void (async (): Promise<void> => {
      try {
        const catalogue = await skills.list({ cwd: process.cwd() })
        skillItems = catalogue
          .filter((skill) => skill.invocation.userInvocable)
          .map((skill) => ({ name: skill.name, description: skill.description, source: String(skill.source ?? '') }))
          .sort((a, b) => a.name.localeCompare(b.name))
        skillsFetchedAt = Date.now()
        channel.version++
      } catch {
        // Keep the last good catalogue; the menu simply stays as it was.
      } finally {
        skillsFetching = false
      }
    })()
  }

  const menuMatches = (editorText: string): PickerItem[] => {
    // Attachment tokens share the editor with the command text; the menu is
    // derived from the TEXT only, so a pending `[file #1]` never hides it.
    const plain = stripAttachmentTokens(editorText)
    if (!plain.startsWith('/') || plain.includes(' ')) return []
    const prefix = plain.slice(1).toLowerCase()
    // A file edit should reach the menu without a restart, and the catalog is
    // fetched once per menu generation at most (both are throttled).
    refreshCustomCommands()
    refreshSkills()
    const idle = channel.runState === 'idle'
    const ranked: { readonly score: number; readonly item: PickerItem }[] = []
    for (const cmd of SLASH_COMMANDS) {
      const score = menuScore(cmd.name, cmd.aliases, prefix)
      if (score === undefined) continue
      ranked.push({
        score,
        item: {
          value: cmd.name,
          label: `/${cmd.name}`,
          ...(cmd.description === '' ? {} : { hint: cmd.description }),
          section: '本地',
          // Idle-gated commands stay VISIBLE mid-turn but unselectable, so the
          // menu explains the refusal up front (Enter prints the reason).
          ...(cmd.idleOnly === true && !idle ? { disabled: true } : {}),
        },
      })
    }
    // User-authored Markdown commands: they expand into a prompt, so they are
    // offered under their own heading and may intentionally shadow a kernel
    // command of the same name.
    for (const command of customCommands) {
      const score = menuScore(command.name, [], prefix)
      if (score === undefined) continue
      ranked.push({
        score,
        item: {
          value: command.name,
          label: `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ''}`,
          hint: command.description === '' ? '自定义命令' : command.description,
          section: '自定义',
        },
      })
    }
    // Kernel commands append after ours and never duplicate a name already
    // offered (Orca's own handlers delegate to the kernel command of the same
    // name — `/compact`, `/permission`, `/plan` — and a custom command is an
    // explicit user override).
    const customNames = new Set(customCommands.map((command) => command.name.toLowerCase()))
    for (const descriptor of kernelCommands) {
      const name = descriptor.name.toLowerCase()
      if (findSlash(descriptor.name) !== undefined || customNames.has(name)) continue
      const score = menuScore(name, [], prefix)
      if (score === undefined) continue
      ranked.push({
        score,
        item: {
          value: descriptor.name,
          label: `/${descriptor.name}${descriptor.input?.hint ? ` ${descriptor.input.hint}` : ''}`,
          hint: descriptor.description,
          section: '内核',
        },
      })
    }
    // Skills are invoked by NAME on a normal user message (the kernel's
    // `dsh-tool-skill` gesture injects the body), so the menu only has to
    // offer the token; a name already taken above would never reach it.
    for (const skill of skillItems) {
      const name = skill.name.toLowerCase()
      if (findSlash(name) !== undefined || customNames.has(name)) continue
      if (kernelCommands.some((descriptor) => descriptor.name.toLowerCase() === name)) continue
      const score = menuScore(name, [], prefix)
      if (score === undefined) continue
      ranked.push({
        score,
        item: { value: skill.name, label: `/${skill.name}`, hint: skill.description, section: 'Skills' },
      })
    }
    // Rank by match quality, then regroup into FIXED sections: a global sort
    // would interleave the headings (every section change emits a header, so
    // the window would fill with headers instead of commands). Within one
    // section the relative order is the declaration order, except that prefix
    // hits (score 0) precede subsequence hits (score 1).
    ranked.sort((a, b) => a.score - b.score)
    const bySection = new Map<string, PickerItem[]>()
    for (const entry of ranked) {
      const section = entry.item.section ?? ''
      const list = bySection.get(section) ?? []
      list.push(entry.item)
      bySection.set(section, list)
    }
    const sections = ['本地', '自定义', '内核', 'Skills']
    const ordered: PickerItem[] = []
    for (const section of sections) ordered.push(...(bySection.get(section) ?? []))
    for (const [section, items] of bySection) {
      if (!sections.includes(section)) ordered.push(...items)
    }
    return ordered
  }

  const currentMenu = (): { readonly items: readonly PickerItem[]; readonly index: number } | null => {
    if (picker) return null
    const items = menuMatches(editor)
    if (items.length === 0) return null
    return { items, index: Math.max(0, Math.min(items.length - 1, menuIndex)) }
  }

  const completeMenu = (): boolean => {
    const menu = currentMenu()
    if (!menu || menu.items.length === 0) return false
    const item = menu.items[menu.index]
    if (!item) return false
    if (item.disabled === true) {
      channel.pushSystem(`/${item.value} 需在空闲时执行，先按 Esc 打断当前回合`)
      return true
    }
    // Completing a command replaces the editor TEXT only: pending attachment
    // tokens stay put, AHEAD of it (they belong to the next message, not to
    // the command) — `menuMatches` strips them back out.
    const kept = Array.from(editor).filter(isAttachmentSentinel)
    const completed = `${kept.join('')}/${item.value}`
    // Already complete → let Enter DISPATCH. Without this, a fully typed
    // kernel command, custom command or skill name re-completed itself
    // forever and could never be run from the menu (kimi/Claude Code both
    // dispatch on the second Enter, which only works because this returns
    // false the second time).
    if (completed === editor) return false
    editor = completed
    cursorPos = codeLen(editor)
    menuIndex = 0
    return true
  }

  /**
   * Announce a provider/model change to the MODEL, durably — the kernel's
   * `installModelSelection` adds exactly such a notice
   * ("assistant turns above this point were generated by X; the session
   * continues with Y"), and without it a silent 换模型 leaves the model
   * reasoning about a route it is no longer on — and, just as bad, unaware
   * that the turns above it were written by a different model. Effort-only
   * changes add nothing (the kernel's rule), and a repeat of the same route is
   * never announced twice.
   *
   * The "previous" anchor is what the MODEL believes: the last notice this
   * process sent, else the route of the session's last request header (which
   * survives a resume, a process restart, or a pick made in the web host).
   */
  const announceSelection = (next: SessionRoute): void => {
    if (!agent) return
    const headerRoute = routeOfHeader(agent.session)
    const previous = announcedSelection ?? headerRoute ?? null
    if (previous !== null && previous.provider === next.provider && previous.model === next.model) {
      announcedSelection = { ...next }
      return
    }
    const label = (route: SessionRoute, other: SessionRoute): string =>
      route.provider === other.provider ? route.model : `${route.provider}/${route.model}`
    const from = previous === null ? 'an earlier model' : label(previous, next)
    const to = previous === null ? `${next.provider}/${next.model}` : label(next, previous)
    const effort = next.reasoningEffort !== undefined && next.reasoningEffort !== '' ? ` (reasoning effort: ${next.reasoningEffort})` : ''
    try {
      agent.inject({
        id: `msg-${randomUUID()}`,
        role: 'user',
        content: [
          {
            type: 'text',
            text: `[model changed: assistant turns above this point were generated by ${from}; the session continues with ${to}${effort}.]`,
          },
        ],
        // `plugin` (never `user`): the notice is model-facing context, not a
        // human prompt — the transcript projection drops it.
        source: { kind: 'plugin', plugin: 'orca', form: 'notice', summary: `${from} → ${to}` },
      })
      announcedSelection = { ...next }
    } catch {
      // Best-effort: a failed notice must never break the switch.
    }
  }

  const applySelection = (next: SessionRoute): void => {
    dbg(`applySelection ${next.provider}/${next.model}`)
    selection = next
    effortCleared = next.reasoningEffort === undefined
    const effort = next.reasoningEffort ? `(${next.reasoningEffort})` : ''
    const defaultModel = getDefaultModel()
    // Say what the pick AFFECTS: the live session immediately, and (when the
    // service is mounted) the deployment default every new session starts on.
    // Scope matters — the web's per-session pick does not touch the default,
    // so a user who does not want it changed has to know this one does.
    channel.pushSystem(
      `模型已切换：${next.provider}/${next.model}${effort} · 下一次请求生效${
        defaultModel ? ' · 已同步为新会话默认' : ''
      }`,
    )
    announceSelection(next)
    // Durable, log-only route intent: the SAME event the web host's
    // `session.selectModel` appends, so the choice lives in the session's own
    // log and either front door reads it back (`durableSelection`). Without it
    // a TUI pick is invisible to the web and dies with this process. Never
    // fatal: a rejected append (a concurrent append is the documented case)
    // leaves the in-memory switch intact for this run.
    try {
      agent?.session.append('model/selection', {
        provider: next.provider,
        model: next.model,
        ...(next.reasoningEffort !== undefined && next.reasoningEffort !== ''
          ? { reasoningEffort: next.reasoningEffort }
          : {}),
      })
    } catch (error) {
      dbg(`model/selection 追加失败：${error instanceof Error ? error.message : String(error)}`)
    }
    if (defaultModel) {
      // Persist as the composition default, best-effort — the settings write
      // may reject OR throw synchronously (verified in-profile: a sync throw
      // rode the keypress handler and killed the process); neither may
      // break the switch. A failure is reported: the line above promised the
      // default moved, and a silent no-op would be a lie.
      void Promise.resolve()
        .then(() => defaultModel.saveSelection({ ...next }))
        .then(() => dbg('saveSelection ok'))
        .catch((error) => {
          dbg(`saveSelection failed: ${error instanceof Error ? error.message : String(error)}`)
          channel.pushSystem('新会话默认写入失败：本次选型只对当前会话生效')
        })
    }
  }

  const pickFailed = (error: unknown): void => {
    closePicker()
    channel.pushSystem(`枚举模型失败：${error instanceof Error ? error.message : String(error)}`)
  }

  /**
   * Record this session under the Workspace that owns its `cwd`, so the web
   * sidebar groups the TUI conversation with the same directory instead of
   * leaving it in the ungrouped pile. Workspace membership is durable host
   * state (`~/.dsh/storages/workspace.json`) shared with the web process; the
   * TUI only ever ADDs its own live session to a workspace that already
   * exists — it never creates, renames, reorders or archives anything — and
   * only while the medium still matches the registry this process read (see
   * the guard below). Two long-lived processes both holding a whole-document
   * snapshot cannot both be writers; the TUI yields instead of winning.
   *
   * Soft everywhere (#183): no `workspaceRegistry` (a profile without the
   * Orca bundle's `workspace` row), no workspace for this cwd (the directory
   * was never added as one), a medium that moved on, or a refused attach all
   * degrade to silence — a session that cannot be filed is still a working
   * session.
   */
  const attachSessionToWorkspace = async (session: Session): Promise<void> => {
    const registry = getWorkspaceRegistry()
    if (!registry) return
    const cwd = session.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') return
    try {
      const workspace = await registry.resolveByPath(cwd)
      if (workspace === undefined) {
        dbg(`工作区未登记，跳过归属：${cwd}`)
        return
      }
      if (workspace.sessionIds.includes(session.id)) {
        dbg(`会话本就在工作区 ${workspace.path} 内`)
        return
      }
      // NEVER write from a snapshot the medium has moved past: the registry
      // medium is a single JSON document republished WHOLE by whichever
      // process writes it (`dsh-storage-json`: "in-memory state is
      // authoritative"), and the web app is normally the process holding it.
      // An out-of-date TUI write would therefore revert every workspace edit
      // the web committed since this TUI started — so we only add our own
      // session while the medium still matches the registry we read.
      if (workspaceMediumFingerprint() !== workspaceRegistryFingerprint(registry)) {
        dbg(`工作区账本已被其它进程改写，跳过归属以免覆盖：${workspace.path}`)
        return
      }
      await workspace.attachSession(session.id)
      dbg(`会话已归入工作区 ${workspace.path}`)
    } catch (error) {
      // `attachSession` validates the header cwd against the workspace path and
      // REJECTS instead of no-oping: a refused attach is a real answer about
      // where this session belongs, so it is reported, never retried blindly.
      dbg(`工作区归属失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const confirmPicker = (): void => {
    if (!picker || !pickerStage) {
      dbg(`confirmPicker skip: picker=${picker !== null} stage=${pickerStage?.kind ?? 'null'}`)
      return
    }
    if (pickerStage.kind === 'question') {
      const item = pickedItem(picker)
      if (!item || item.disabled) return
      if (item.value === '__custom__') {
        startCustomAnswer(picker.multi ? Array.from(picker.checked ?? []) : [])
      } else if (picker.multi) {
        closePicker()
        answerCurrentQuestionSelected(Array.from(picker.checked ?? []))
      } else {
        answerCurrentQuestionOption(item.value)
      }
      return
    }
    if (pickerStage.kind === 'sessions') {
      confirmResumePicker()
      return
    }
    if (pickerStage.kind === 'approval') {
      const item = pickedItem(picker)
      if (!item || item.disabled) return
      decideApproval(item.value)
      return
    }
    if (pickerStage.kind === 'presets') {
      const item = pickedItem(picker)
      if (!item || item.disabled) return
      applyPreset(item.value)
      closePicker()
      return
    }
    const llm = getLlm()
    if (!llm) {
      dbg(`confirmPicker skip: picker=${picker !== null} stage=${pickerStage?.kind ?? 'null'} llm=${llm !== undefined}`)
      return
    }
    const item = pickedItem(picker)
    dbg(`confirmPicker stage=${pickerStage.kind} item=${item?.value ?? '(none)'}${item?.disabled ? ' (disabled)' : ''}`)
    // Disabled rows (the loading placeholder) are not confirmable; an empty
    // value on the effort stage is a VALID choice — “默认（模型默认行为）”.
    if (!item || item.disabled) return

    if (pickerStage.kind === 'providers') {
      const provider = item.value
      const stage: PickerStage = { kind: 'models', provider }
      pickerStage = stage
      picker = openPicker(`选择模型（${provider}）`, loadingItems(), selection?.model)
      void (async (): Promise<void> => {
        try {
          const models = await llm.listModels(provider)
          if (stage !== pickerStage) return // superseded by Esc/new open
          if (!models || models.length === 0) {
            channel.pushSystem(`${provider} 下没有可用模型`)
            closePicker()
            return
          }
          picker = openPicker(
            `选择模型（${provider}）`,
            models.map((m) => itemOf(m.name || m.id, m.id, m.description)),
            selection?.model,
          )
        } catch (error) {
          pickFailed(error)
        }
      })()
      return
    }

    if (pickerStage.kind === 'models') {
      const provider = pickerStage.provider
      const model = item.value
      const stage: PickerStage = { kind: 'effort', provider, model }
      pickerStage = stage
      picker = openPicker(`选择思考强度（${model}）`, loadingItems(), selection?.reasoningEffort)
      void (async (): Promise<void> => {
        const items: PickerItem[] = [itemOf('默认（模型默认行为）', '')]
        try {
          // Exact-route resolution (dsh `LlmRuntime.resolveModelInfo`). The
          // preview-era `resolveModel` name never existed on the runtime — it
          // only ever named the adapter base class method — so there is no
          // legacy fallback to keep.
          const resolved = await llm.resolveModelInfo(provider, model)
          for (const effort of resolved?.reasoning?.efforts ?? []) {
            items.push(itemOf(effort.name || effort.id, effort.id, effort.description))
          }
        } catch {
          // Exact-route resolution is optional; default-only stays usable.
        }
        if (stage !== pickerStage) return
        picker = openPicker(`选择思考强度（${model}）`, items, selection?.reasoningEffort)
      })()
      return
    }

    // Effort stage → final selection.
    if (pickerStage.kind !== 'effort') return
    const { provider, model } = pickerStage
    const reasoningEffort = item.value !== '' ? item.value : undefined
    applySelection(reasoningEffort ? { provider, model, reasoningEffort } : { provider, model })
    closePicker()
  }

  const handlePickerKey = (key: KeyPress): void => {
    if (!picker) return
    // Approval shortcuts: numbered direct-select (kimi 1/2/3) answers without
    // moving the cursor, so the common case is one keystroke. The numbers map
    // to the ROWS THE USER SEES (1 = first selectable row), and Ctrl-E dumps
    // the pending call's full arguments into the transcript — a one-line
    // preview is not enough to approve a file write.
    if (pickerStage?.kind === 'approval') {
      if (key.ctrl && key.name === 'e') {
        expandApproval()
        return
      }
      if (classify(key) === 'text') {
        const index = Number.parseInt(key.sequence, 10)
        if (Number.isInteger(index) && index >= 1 && index <= 9) {
          const selectable = picker.items.filter((item) => item.disabled !== true)
          const item = selectable[index - 1]
          // An out-of-range digit must NOT silently fall through to the panel's
          // own navigation (it would move the cursor on a stray keypress).
          if (item) decideApproval(item.value)
          return
        }
      }
    }
    const action = classify(key)
    if (action === 'cancel') {
      // Esc on the approval panel is an explicit reject (kimi behavior);
      // on the question panel it aborts the whole ask.
      if (pickerStage?.kind === 'approval') {
        settleApprovalHead('rejected')
        return
      }
      if (pickerStage?.kind === 'question') {
        cancelPendingQuestion()
        closePicker()
        return
      }
      closePicker()
      return
    }
    if (action === 'submit') {
      confirmPicker()
      return
    }
    if (action === 'navigate') {
      if (key.name === 'up') movePicker(picker, -1)
      else if (key.name === 'down') movePicker(picker, 1)
      return
    }
    if (action === 'text') {
      if (key.name === ' ' && picker.multi) {
        const item = pickedItem(picker)
        if (item && !item.disabled) togglePicker(picker, item.value)
        return
      }
      if (key.name === 'k') movePicker(picker, -1)
      else if (key.name === 'j') movePicker(picker, 1)
    }
  }

  const openModelPicker = (): void => {
    const llm = getLlm()
    if (!llm) {
      channel.pushSystem('kernel service `llm` 未挂载：无法枚举模型')
      return
    }
    const stage: PickerStage = { kind: 'providers' }
    pickerStage = stage
    picker = openPicker('选择 Provider', loadingItems(), selection?.provider)
    void (async (): Promise<void> => {
      try {
        const providers = await Promise.resolve(llm.listProviders())
        if (stage !== pickerStage) return
        if (!providers || providers.length === 0) {
          channel.pushSystem('没有可用的 provider')
          closePicker()
          return
        }
        picker = openPicker(
          '选择 Provider',
          providers.map((p) => itemOf(p.name || p.id, p.id, p.name && p.name !== p.id ? p.id : undefined)),
          selection?.provider,
        )
      } catch (error) {
        pickFailed(error)
      }
    })()
  }

  // ── /preset picker ────────────────────────────────────────────────────────
  // Single-stage roster browser (unlike /model's three stages): the pick only
  // records `presetSelection` — a preset composes at session creation, so the
  // running session keeps its composition and the next FRESH session mounts
  // the pick (`meta.agentPreset` + factory `setup`). Resume/fork inherit.

  const applyPreset = (id: string): void => {
    dbg(`applyPreset ${id}`)
    presetSelection = id
    channel.pushSystem(`预设已切换：${id} · 下个新会话生效（当前会话保持原组成）`)
  }

  const presetFailed = (error: unknown): void => {
    closePicker()
    channel.pushSystem(`枚举预设失败：${error instanceof Error ? error.message : String(error)}`)
  }

  const openPresetPicker = (): void => {
    const presets = getAgentPresets()
    if (!presets) {
      channel.pushSystem('kernel service `agentPresets` 未挂载：无法枚举预设（profile 需挂载 dsh-agent-presets）')
      return
    }
    const stage: PickerStage = { kind: 'presets' }
    pickerStage = stage
    picker = openPicker('选择 Agent 预设', loadingItems(), livePreset ?? presetSelection ?? undefined)
    void (async (): Promise<void> => {
      try {
        const roster = await presets.list()
        if (stage !== pickerStage) return
        if (roster.length === 0) {
          channel.pushSystem('没有可用的 Agent 预设')
          closePicker()
          return
        }
        const sorted = [...roster].sort(
          (a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || (a.id < b.id ? -1 : 1),
        )
        picker = openPicker(
          '选择 Agent 预设（Enter 切换 · 下个新会话生效）',
          sorted.map((preset) => ({
            value: preset.id,
            label: preset.name ?? preset.id,
            hint: `${preset.trust === 'user' ? '自建' : '内置'}${preset.broken ? ` · 不可用：${preset.broken}` : ''}${preset.description ? ` · ${preset.description}` : ''}`,
            ...(preset.broken ? { disabled: true } : {}),
          })),
          livePreset ?? presetSelection ?? undefined,
        )
      } catch (error) {
        if (stage !== pickerStage) return
        presetFailed(error)
      }
    })()
  }

  const doPreset = (args: string): void => {
    const id = args.trim()
    if (id === '') {
      openPresetPicker()
      return
    }
    const presets = getAgentPresets()
    if (!presets) {
      channel.pushSystem('kernel service `agentPresets` 未挂载：无法切换预设（profile 需挂载 dsh-agent-presets）')
      return
    }
    void (async (): Promise<void> => {
      try {
        const preset = await presets.resolve(id)
        if (preset.broken) {
          channel.pushSystem(`预设 ${preset.id} 不可用：${preset.broken}`)
          return
        }
        applyPreset(preset.id)
      } catch (error) {
        channel.pushSystem(`未知预设：${id}${error instanceof Error ? `（${error.message}）` : ''}`)
      }
    })()
  }

  // ── /resume browser：内核 sessionQuery 列会话，标题/时间/cwd 尽力补全 ───────

  const openResumePicker = (): void => {
    const sessionQuery = getSessionQuery()
    if (!sessionQuery) {
      channel.pushSystem('sessionQuery 服务未挂载：无法浏览历史会话（内核需挂载 dsh-session-query）')
      return
    }
    if (!getAgents()) {
      channel.pushSystem('agents 服务未挂载：无法恢复会话')
      return
    }
    const stage: PickerStage = { kind: 'sessions' }
    pickerStage = stage
    picker = openPicker('历史会话', loadingItems())
    void (async (): Promise<void> => {
      try {
        const records = await sessionQuery.listSessions()
        if (stage !== pickerStage) return
        if (records.length === 0) {
          channel.pushSystem('没有可恢复的历史会话')
          closePicker()
          return
        }
        const ids = records.slice(0, 50).map((record) => record.header.id)
        let titles = new Map<string, string>()
        try {
          const snapshots = await sessionQuery.readTitleSnapshots(ids)
          for (const result of snapshots) {
            if (result.status === 'fulfilled' && result.value.title) {
              titles.set(result.sessionId, result.value.title.title)
            }
          }
        } catch {
          // Titles are best-effort; the browser still lists ids/cwd/time.
        }
        const items = records.slice(0, 50).map((record) => {
          const title = titles.get(record.header.id) ?? shortSessionLabel(record.header.id)
          const cwd = record.header.cwd ? ` · ${shortPath(record.header.cwd)}` : ''
          const when = formatTime(record.header.createdAt)
          return itemOf(`${title}${cwd}`, record.header.id, when)
        })
        picker = openPicker('历史会话（Enter 恢复 · Esc 取消）', items, agent?.session.id)
      } catch (error) {
        if (stage !== pickerStage) return
        closePicker()
        channel.pushSystem(`枚举会话失败：${error instanceof Error ? error.message : String(error)}`)
      }
    })()
  }

  const confirmResumePicker = (): void => {
    if (!picker || pickerStage?.kind !== 'sessions') return
    const item = pickedItem(picker)
    if (!item || item.disabled) return
    const resumeId = item.value
    closePicker()
    if (!resumeId || (agent && resumeId === agent.session.id)) {
      channel.pushSystem('已是当前会话')
      return
    }
    void switchToResume(resumeId)
  }

  const switchToResume = (resumeId: string): Promise<void> => runSessionTask(async (signal) => {
    if (!getAgents()) return
    await releaseAgent()
    if (disposed || signal.aborted) return
    clearProjection()
    welcomed = true
    if (!await createAgent(signal, resumeId)) return
    try {
      const snapshot = await getSessionQuery()?.readTitle(resumeId)
      if (snapshot && !disposed && !signal.aborted) channel.title = snapshot.title
    } catch {
      // Ignored.
    }
  })

  // ── rewind: double-Esc forks to the previous turn boundary (M3) ────────────
  // pi `/tree` + kimi `/undo` spirit, kernel-native via `ctx.sessions.fork`:
  // the child keeps the prefix through the previous turn, later turns stay in
  // the parent log on disk. Idle-only; needs ≥2 observed turns.

  const doRewind = (): Promise<void> => runSessionTask(async (signal) => {
    const agentFactory = getAgents()
    if (!agent || !handle || !agentFactory) {
      channel.pushSystem('agent 未就绪，无法回退')
      return
    }
    const sessions = getSessions()
    if (!sessions) {
      channel.pushSystem('sessions 服务未挂载：无法回退（内核需挂载 dsh-session）')
      return
    }
    if (channel.runState !== 'idle') {
      channel.pushSystem('回合运行中，先按 Esc 打断再双击 Esc 回退')
      return
    }
    const turns = channel.turnSeqs
    if (turns.length < 2) {
      channel.pushSystem('没有可回退的回合（至少需要两轮对话）')
      return
    }
    const boundary = turns[turns.length - 2]
    if (boundary === undefined) {
      channel.pushSystem('没有可回退的回合')
      return
    }
    const childId = mintSessionId()
    let child: { id: string } | null = null
    try {
      child = sessions.fork(agent.session, boundary, childId) as unknown as { id: string }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // dsh-session's SessionForkError carries a typed `code`; the message text
      // never contains the literal 'OPEN_TURN'.
      const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : ''
      if (code === 'OPEN_TURN' || /OPEN_TURN/i.test(message)) {
        channel.pushSystem('回退失败：边界落在未闭合回合内，稍后重试')
      } else {
        channel.pushSystem(`回退失败：${message}`)
      }
      return
    }
    const childSessionId = typeof child?.id === 'string' ? child.id : childId
    await releaseAgent()
    if (disposed || signal.aborted) return
    clearProjection()
    welcomed = true
    dbg('doRewind: start')
    if (!await createAgent(signal, childSessionId)) return
    dbg('doRewind: createAgent done')
    channel.pushSystem(`已回退到上一轮（fork ${shortSessionLabel(childSessionId)}）`)
  })

  // M4 status slot: git branch, cached 2s (file read only, no spawn).
  let branchCache: { readonly at: number; readonly cwd: string; readonly value: string | null } | null = null

  const gitBranch = (cwd: string): string | null => {
    const now = Date.now()
    if (branchCache && branchCache.cwd === cwd && now - branchCache.at < 2000) return branchCache.value
    let value: string | null = null
    try {
      const head = readFileSync(join(cwd, '.git', 'HEAD'), 'utf8').trim()
      const match = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
      value = match?.[1] ?? null
    } catch {
      value = null
    }
    branchCache = { at: now, cwd, value }
    return value
  }

  // Title for the footer: channel.title (event fold) wins; the service is a
  // 1s-cached fallback so the 30fps render never folds the log per tick.
  let titleCache: { readonly at: number; readonly value: string | null } | null = null

  const safeTitleGetCached = (): string | null => {
    const now = Date.now()
    if (titleCache && now - titleCache.at < 1000) return titleCache.value
    const value = safeTitleGet()
    titleCache = { at: now, value }
    return value
  }

  // ── agent lifecycle ───────────────────────────────────────────────────────

  const start = async (signal: AbortSignal): Promise<void> => {
    const resumeId = process.env['ORCA_RESUME_SESSION']
    // Loader entries activate concurrently, so the factory and the default
    // model service may not exist yet when apply() runs. Await full plugin
    // activation first — the canonical pattern (dsh-headless) — and keep the
    // targeted factory retry in createAgent as a safety net.
    const loader = ctx.get<KernelLoader>('loader', false)
    if (loader) await waitUntilAborted(loader.await(), signal)
    if (disposed || signal.aborted) return
    if (!resumeId && (await trySilentRemount(signal))) return
    await createAgent(signal, resumeId)
  }

  let editor = ''
  /** Logical editor cursor — a code-point offset into `editor` (left/right/
   *  Home/End/editing chords; the render highlights the char under it). */
  let cursorPos = 0
  /**
   * Sticky column for vertical motion in the multi-line editor: ↑/↓ keep the
   * column they started from, so crossing a short line does not drag the
   * cursor left. Any horizontal move or edit clears it.
   */
  let preferredColumn: number | null = null
  /**
   * Alt-screen mouse selection (1-based screen cells) and its drag state.
   * Only ever set in fullscreen mode: inline mode leaves the mouse to the
   * terminal so its native selection keeps working.
   */
  let mouseSelection: Selection | null = null
  let mouseDragging = false
  /**
   * Fullscreen transcript scroll: the absolute line index the window starts
   * at, or null while it follows the live tail. Absolute (not "lines above
   * the bottom") so streaming output does not drag the reader's view.
   */
  let scrollTop: number | null = null
  /** Latest window geometry reported by the frame builder (wheel clamping). */
  let lastWindowTop = 0
  let lastWindowMaxTop = 0
  /** Last painted frame lines, SGR intact — the source for copy extraction. */
  let lastFrameLines: readonly string[] = []
  let lastEscAt = 0
  /** Double-Ctrl+C exit window (mainstream shell behavior): the first press
   *  interrupts the running turn or clears the editor, the second exits. */
  let lastExitAt = 0
  // Chrome 恒钉底——render 内 `anchorChrome` 恒为 true（M6 的 picker 闩锁已退役，
  // 不再有"浮动→钉底"跳变需要闩）。
  /** Ctrl+O: full thinking text instead of the short live preview (kimi expand). */
  let thoughtExpanded = false
  /** Nerd Font branch icon in footer (ORCA_NERD_FONT env or `/nerdfont`). */
  let nerdFont = process.env['ORCA_NERD_FONT'] === '1' || readOrcaSettings().nerdFont === true
  /** Submitted prompts (slash commands excluded) — ↑ recalls, ↓ returns. */
  const promptHistory: string[] = []
  let historyIndex: number | null = null
  /**
   * Pending attachments for the NEXT message: durable refs, in the order
   * their inline tokens appear. The kernel's only attachment kinds are
   * `image` (raster, dsh-llm `ImageBlock`) and `file` (everything else,
   * dsh-llm `FileBlock`, 0.1.5).
   */
  type PendingAttachment =
    | { readonly kind: 'image'; readonly ref: ImageAttachmentRef; readonly label: string }
    | { readonly kind: 'file'; readonly ref: FileAttachmentRef; readonly label: string }

  const pendingAttachments: PendingAttachment[] = []

  const imageCount = (): number => pendingAttachments.filter((item) => item.kind === 'image').length
  const imageBytes = (): number =>
    pendingAttachments.reduce((sum, item) => (item.kind === 'image' ? sum + item.ref.bytes : sum), 0)
  /** Active `@path` completion menu (kernel `fileReferences` or local fallback). */
  let atMenu: PickerState | null = null
  const atCandidates: FileReferenceCandidate[] = []
  let atIndex = 0
  let atQueryKey = ''
  let atFetchSeq = 0
  let atTimer: NodeJS.Timeout | null = null
  /**
   * Token query that was just completed with a FILE candidate (directories
   * stay exempt — their trailing `/` means "keep enumerating inside").
   * Until the query changes, the menu must stay closed, otherwise the fetch
   * re-opens it and Enter completes instead of submitting — forever.
   */
  let atDoneQuery: string | null = null

  // ── editor helpers (code-point based; cursor is an index into chars) ──────
  // Attachments are inline sentinel chars (IMAGE_SENTINEL / FILE_SENTINEL).
  // They render as `[image #N]` / `[file #N]` in chat.ts and are atomic for
  // editing: backspace/delete remove the whole token and the matching pending
  // attachment. Each sentinel counts only its OWN kind, in document order, so
  // the editor and `pendingAttachments` can never drift apart.

  const codeLen = (text: string): number => Array.from(text).length

  const isAttachmentSentinel = (ch: string): boolean => ch === IMAGE_SENTINEL || ch === FILE_SENTINEL

  /** The editor's TEXT with attachment tokens removed (menu/command parsing). */
  const stripAttachmentTokens = (text: string): string =>
    Array.from(text).filter((ch) => !isAttachmentSentinel(ch)).join('')

  /** Index of this sentinel within its own kind, among chars[0..pos). */
  const kindIndexBefore = (chars: readonly string[], pos: number, sentinel: string): number => {
    let n = 0
    for (let i = 0; i < pos; i++) if (chars[i] === sentinel) n++
    return n
  }

  /** Position of one (kind, kindIndex) pair inside `pendingAttachments`. */
  const pendingIndexOf = (kind: 'image' | 'file', kindIndex: number): number => {
    let seen = 0
    for (let i = 0; i < pendingAttachments.length; i++) {
      if (pendingAttachments[i]?.kind !== kind) continue
      if (seen === kindIndex) return i
      seen++
    }
    return -1
  }

  /** Remove pending attachments whose sentinels lie in chars[start..end). */
  const removePendingAttachmentsInRange = (chars: readonly string[], start: number, end: number): void => {
    const indexes: number[] = []
    for (let i = start; i < end; i++) {
      const ch = chars[i] ?? ''
      if (!isAttachmentSentinel(ch)) continue
      const kind = ch === IMAGE_SENTINEL ? 'image' : 'file'
      const index = pendingIndexOf(kind, kindIndexBefore(chars, i, ch))
      if (index !== -1) indexes.push(index)
    }
    indexes.sort((a, b) => b - a)
    for (const index of indexes) pendingAttachments.splice(index, 1)
  }

  /** Insert one inline attachment token at the cursor (call after the push). */
  const insertAttachmentToken = (kind: 'image' | 'file'): void => {
    const chars = Array.from(editor)
    chars.splice(cursorPos, 0, kind === 'image' ? IMAGE_SENTINEL : FILE_SENTINEL)
    editor = chars.join('')
    cursorPos += 1
    scheduleAtFetch()
  }

  /** Split editor into plain text + ordered attachment refs for submission. */
  const collectSubmission = (): {
    readonly text: string
    readonly images: ImageAttachmentRef[]
    readonly files: FileAttachmentRef[]
  } => {
    const chars = Array.from(editor)
    let text = ''
    const images: ImageAttachmentRef[] = []
    const files: FileAttachmentRef[] = []
    let imageIndex = 0
    let fileIndex = 0
    for (const ch of chars) {
      if (ch === IMAGE_SENTINEL) {
        const item = pendingAttachments[pendingIndexOf('image', imageIndex)]
        if (item?.kind === 'image') images.push(item.ref)
        imageIndex++
      } else if (ch === FILE_SENTINEL) {
        const item = pendingAttachments[pendingIndexOf('file', fileIndex)]
        if (item?.kind === 'file') files.push(item.ref)
        fileIndex++
      } else {
        text += ch
      }
    }
    return { text: text.trim(), images, files }
  }

  /** Insert text at the cursor; CRLF folds to LF, real newlines are KEPT. */
  const insertText = (seq: string): void => {
    const clean = seq.replace(/\r\n?/g, '\n').replace(/[\uE000\uE001]/g, '')
    if (clean === '') return
    const chars = Array.from(editor)
    const ins = Array.from(clean)
    chars.splice(cursorPos, 0, ...ins)
    editor = chars.join('')
    cursorPos += ins.length
    preferredColumn = null
    menuIndex = 0
    scheduleAtFetch()
  }

  /** Insert a hard line break (Alt+Enter / Shift+Enter / Ctrl+J). */
  const insertNewline = (): void => {
    const chars = Array.from(editor)
    chars.splice(cursorPos, 0, '\n')
    editor = chars.join('')
    cursorPos += 1
    preferredColumn = null
    menuIndex = 0
    scheduleAtFetch()
  }

  const deleteBefore = (word = false): void => {
    const chars = Array.from(editor)
    if (cursorPos === 0) return
    let from = cursorPos - 1
    if (word) {
      while (from > 0 && (chars[from] ?? '') === ' ') from--
      while (from > 0 && (chars[from - 1] ?? '') !== ' ') from--
    }
    removePendingAttachmentsInRange(chars, from, cursorPos)
    editor = [...chars.slice(0, from), ...chars.slice(cursorPos)].join('')
    cursorPos = from
    preferredColumn = null
    scheduleAtFetch()
  }

  const deleteAt = (): void => {
    const chars = Array.from(editor)
    if (cursorPos >= chars.length) return
    removePendingAttachmentsInRange(chars, cursorPos, cursorPos + 1)
    editor = [...chars.slice(0, cursorPos), ...chars.slice(cursorPos + 1)].join('')
    preferredColumn = null
    scheduleAtFetch()
  }

  /** `[start, end)` of the logical line containing `pos` (newline excluded). */
  const lineBounds = (pos: number): { readonly start: number; readonly end: number } => {
    const chars = Array.from(editor)
    const at = Math.max(0, Math.min(chars.length, pos))
    let start = at
    while (start > 0 && (chars[start - 1] ?? '') !== '\n') start--
    let end = at
    while (end < chars.length && (chars[end] ?? '') !== '\n') end++
    return { start, end }
  }

  /** Ctrl+U — kill from the cursor back to the start of the CURRENT line. */
  const killToStart = (): void => {
    const { start } = lineBounds(cursorPos)
    const chars = Array.from(editor)
    removePendingAttachmentsInRange(chars, start, cursorPos)
    editor = [...chars.slice(0, start), ...chars.slice(cursorPos)].join('')
    cursorPos = start
    preferredColumn = null
    scheduleAtFetch()
  }

  /** Ctrl+K — kill from the cursor to the end of the CURRENT line. */
  const killToEnd = (): void => {
    const { end } = lineBounds(cursorPos)
    const chars = Array.from(editor)
    removePendingAttachmentsInRange(chars, cursorPos, end)
    editor = [...chars.slice(0, cursorPos), ...chars.slice(end)].join('')
    preferredColumn = null
    scheduleAtFetch()
  }

  const moveCursor = (delta: number): void => {
    cursorPos = Math.max(0, Math.min(codeLen(editor), cursorPos + delta))
    preferredColumn = null
    scheduleAtFetch()
  }

  const moveTo = (pos: number): void => {
    cursorPos = Math.max(0, Math.min(codeLen(editor), pos))
    preferredColumn = null
    scheduleAtFetch()
  }

  /**
   * Vertical cursor motion inside a multi-line editor, keeping the preferred
   * visual column (sticky like every real editor: a short line does not pull
   * the column back). Returns false when there is no line in that direction —
   * the caller then treats Up/Down as history recall, which is exactly the
   * single-line behavior.
   */
  const moveVertical = (delta: number): boolean => {
    const { start, end } = lineBounds(cursorPos)
    const column = preferredColumn ?? (cursorPos - start)
    if (delta < 0) {
      if (start === 0) return false
      const above = lineBounds(start - 1)
      cursorPos = Math.min(above.end, above.start + column)
    } else {
      if (end >= codeLen(editor)) return false
      const below = lineBounds(end + 1)
      cursorPos = Math.min(below.end, below.start + column)
    }
    preferredColumn = column
    scheduleAtFetch()
    return true
  }

  /** Move one word to the left (readline backward-word). */
  const wordLeft = (): void => {
    const chars = Array.from(editor)
    let i = cursorPos
    while (i > 0 && (chars[i - 1] ?? '') === ' ') i--
    while (i > 0 && (chars[i - 1] ?? '') !== ' ') i--
    moveTo(i)
  }

  /** Move one word to the right (readline forward-word). */
  const wordRight = (): void => {
    const chars = Array.from(editor)
    let i = cursorPos
    while (i < chars.length && (chars[i] ?? '') === ' ') i++
    while (i < chars.length && (chars[i] ?? '') !== ' ') i++
    moveTo(i)
  }

  // ── @path completion (kernel `fileReferences` seam, local fallback) ───────

  interface AtToken {
    readonly start: number
    readonly query: string
    readonly quoted: boolean
  }

  /**
   * The active `@path` / `@"path with spaces` token at the cursor — the
   * simplified editor-side twin of dsh-file-reference's `activeAtToken`
   * grammar. An `@` glued into another word (email) never triggers.
   */
  const activeAtToken = (text: string, cursor: number): AtToken | undefined => {
    const chars = Array.from(text)
    // Quoted: the last `@"` whose run to the cursor carries no closing quote.
    for (let i = cursor - 1; i >= 0; i--) {
      const ch = chars[i] ?? ''
      if (ch === '"') break
      if (ch === '@' && (chars[i + 1] ?? '') === '"') {
        return { start: i, query: chars.slice(i + 2, cursor).join(''), quoted: true }
      }
    }
    // Unquoted: a run of non-space chars back to an `@` at a token boundary.
    let begin = cursor
    while (begin > 0 && (chars[begin - 1] ?? '') !== ' ') begin--
    if (begin < cursor && chars[begin] === '@' && (begin === 0 || (chars[begin - 1] ?? ' ') === ' ')) {
      return { start: begin, query: chars.slice(begin + 1, cursor).join(''), quoted: false }
    }
    return undefined
  }

  /** The insertion value for a completed candidate (kernel grammar twin). */
  const formatFileMention = (candidate: FileReferenceCandidate): string => {
    const quoted = /\s/.test(candidate.path)
    if (candidate.kind === 'directory') {
      const body = candidate.path.endsWith('/') ? candidate.path : candidate.path + '/'
      return quoted ? `@"${body}` : '@' + body
    }
    return quoted ? `@"${candidate.path}"` : '@' + candidate.path
  }

  const currentAtMenu = (): { readonly items: readonly PickerItem[]; readonly index: number } | null => {
    if (picker || !atMenu || atMenu.items.length === 0) return null
    return { items: atMenu.items, index: Math.max(0, Math.min(atMenu.items.length - 1, atIndex)) }
  }

  /** Shallow local scan fallback when `fileReferences` is not mounted. */
  const localFileCandidates = (query: string): FileReferenceCandidate[] => {
    const lowered = query.toLowerCase().replaceAll('\\', '/')
    const slash = lowered.lastIndexOf('/')
    const dir = slash === -1 ? process.cwd() : resolve(process.cwd(), query.slice(0, slash + 1))
    const base = slash === -1 ? lowered : lowered.slice(slash + 1)
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const out: FileReferenceCandidate[] = []
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const name = entry.name.toLowerCase()
      if (base !== '' && !name.startsWith(base)) continue
      out.push({ path: (slash === -1 ? '' : query.slice(0, slash + 1)) + entry.name, kind: entry.isDirectory() ? 'directory' : 'file' })
      if (out.length >= 50) break
    }
    return out
  }

  const fetchAt = async (query: string, seq: number): Promise<void> => {
    let candidates: FileReferenceCandidate[] = []
    const service = agent ? getFileReferences() : undefined
    if (service && agent) {
      try {
        candidates = await service.list(agent, query, new AbortController().signal)
      } catch {
        candidates = []
      }
    } else {
      candidates = localFileCandidates(query)
    }
    if (seq !== atFetchSeq) return
    atCandidates.length = 0
    atCandidates.push(...candidates)
    if (!activeAtToken(editor, cursorPos) || candidates.length === 0) {
      atMenu = null
      return
    }
    atMenu = openPicker(
      '文件',
      candidates.slice(0, 8).map((candidate) =>
        itemOf(candidate.path + (candidate.kind === 'directory' ? '/' : ''), candidate.path, candidate.kind === 'directory' ? '目录' : undefined),
      ),
    )
    atIndex = 0
  }

  /** Debounced re-fetch of candidates for the live `@` token. */
  const scheduleAtFetch = (): void => {
    const token = activeAtToken(editor, cursorPos)
    if (!token) {
      atMenu = null
      atDoneQuery = null
      return
    }
    if (token.query === atDoneQuery) {
      // Just completed with a file candidate — keep the menu closed until
      // the query changes (typing/deleting reopens it naturally).
      atMenu = null
      return
    }
    atDoneQuery = null
    if (token.query === atQueryKey && atMenu !== null) return
    atQueryKey = token.query
    const seq = ++atFetchSeq
    if (atTimer !== null) clearTimeout(atTimer)
    atTimer = setTimeout(() => {
      atTimer = null
      void fetchAt(token.query, seq)
    }, 120)
  }

  /** Replace the live `@` token with the highlighted candidate. */
  const completeAt = (): boolean => {
    const menu = currentAtMenu()
    if (!menu) return false
    const token = activeAtToken(editor, cursorPos)
    const item = menu.items[menu.index]
    const candidate = atCandidates[menu.index]
    if (!token || !item || !candidate) {
      atMenu = null
      return true
    }
    const mention = Array.from(formatFileMention(candidate))
    const chars = Array.from(editor)
    removePendingAttachmentsInRange(chars, token.start, cursorPos)
    editor = [...chars.slice(0, token.start), ...mention, ...chars.slice(cursorPos)].join('')
    cursorPos = token.start + mention.length
    atMenu = null
    atQueryKey = '\u0000reset'
    // Files finish the mention; suppress the immediate re-fetch so Enter
    // submits instead of re-completing the same token (directories keep
    // enumerating inside).
    atDoneQuery = candidate.kind === 'directory' ? null : candidate.path
    scheduleAtFetch()
    return true
  }

  /** Clear the editor state (Esc): text, cursor, menus, pending attachments. */
  const resetEditor = (): void => {
    editor = ''
    cursorPos = 0
    preferredColumn = null
    menuIndex = 0
    atMenu = null
    historyIndex = null
    pendingAttachments.length = 0
  }

  /**
   * Drop the editor's TEXT but keep its attachment tokens (and the pending
   * refs they stand for). Used when a slash command consumes the line: the
   * attachments belong to the next message, not to the command.
   */
  const clearEditorText = (): void => {
    const kept = Array.from(editor).filter(isAttachmentSentinel)
    editor = kept.join('')
    cursorPos = kept.length
    menuIndex = 0
    atMenu = null
    historyIndex = null
  }

  // ── prompt history recall (↑ on an empty editor) ──────────────────────────

  const historyRecall = (delta: -1 | 1): void => {
    if (promptHistory.length === 0) return
    if (historyIndex === null) {
      if (editor !== '' || delta === 1) return
      historyIndex = promptHistory.length - 1
    } else {
      const next = historyIndex + delta
      if (next < 0) return
      if (next >= promptHistory.length) {
        historyIndex = null
        editor = ''
        cursorPos = 0
        pendingAttachments.length = 0
        return
      }
      historyIndex = next
    }
    const entry = historyIndex !== null ? promptHistory[historyIndex] : undefined
    editor = entry ?? ''
    cursorPos = codeLen(editor)
    // History entries are text-only; drop any inline image tokens that were
    // pending so the editor and pendingAttachments never drift apart.
    pendingAttachments.length = 0
    menuIndex = 0
  }
  // ── image attachments (kernel `attachments` seam, dsh-attachment) ─────────

  const IMAGE_MEDIA_TYPES: Readonly<Record<string, ImageMediaType>> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  }

  const imageMediaTypeOf = (path: string): ImageMediaType | undefined => {
    const dot = path.toLowerCase().lastIndexOf('.')
    return dot === -1 ? undefined : IMAGE_MEDIA_TYPES[path.slice(dot)]
  }

  /** Extension test only — no whitespace guard (file URLs decode to spaced paths). */
  function hasImageExtension(text: string): boolean {
    const lower = text.trim().toLowerCase()
    return (
      lower.endsWith('.png') ||
      lower.endsWith('.jpg') ||
      lower.endsWith('.jpeg') ||
      lower.endsWith('.webp') ||
      lower.endsWith('.gif')
    )
  }

  function looksLikeImagePath(text: string): boolean {
    const trimmed = text.trim()
    // Windows Explorer 复制文件后粘贴进终端，路径常带引号（尤其含空格时）；
    // 去掉首尾引号再判断，否则“粘贴图片路径”会完全没反应。
    const unquoted = trimmed.replace(/^"(.*)"$/, '$1').trim()
    if (!hasImageExtension(unquoted)) return false
    // 无空格路径直接收；带空格路径必须原本带引号，避免把普通句子误判成图片。
    return !/\s/.test(unquoted) || /^".*"$/.test(trimmed)
  }

  /** Expand `~` and make relative paths cwd-absolute. */
  function resolvePath(raw: string): string {
    const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? ''
    const expanded = home !== '' && (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) ? join(home, raw.slice(1)) : raw
    return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded)
  }

  /**
   * Read, admit and durably store ONE local path; it rides the next message.
   * Images become image blocks, every other file a ile block.
   */
  const attachLocalPath = async (rawPath: string): Promise<void> => {
    const attachments = getAttachments()
    if (!attachments) {
      channel.pushSystem('attachments 服务未挂载：无法附加文件（内核需挂载 dsh-attachment-local）')
      return
    }
    const abs = resolvePath(rawPath.replace(/^"|"$/g, '').trim())
    let data: Buffer
    try {
      data = readFileSync(abs)
    } catch (error) {
      channel.pushSystem(`读取失败：${basename(abs)}（${error instanceof Error ? error.message : String(error)}）`)
      return
    }
    const name = basename(abs)
    const mediaType = imageMediaTypeOf(abs)
    const limits = attachments.imageLimits
    // An image is admitted only when this deployment accepts its media type:
    // the kernel's own `mediaTypes` list is the authority, not our extension
    // table (a narrowed deployment must not fail later at saveImage).
    if (mediaType && !limits.mediaTypes.includes(mediaType)) {
      channel.pushSystem(`该部署不接受 ${mediaType} 图片：${name}（可接受：${limits.mediaTypes.join('/') || '无'}）`)
      return
    }
    if (mediaType) {
      const pendingBytes = imageBytes()
      if (data.length > limits.maxImageBytes) {
        channel.pushSystem(`图片过大：${name} 超出单图上限（${Math.round(limits.maxImageBytes / 1048576)} MiB）`)
        return
      }
      if (imageCount() >= limits.maxImagesPerMessage) {
        channel.pushSystem(`图片数量已达上限（${limits.maxImagesPerMessage}）`)
        return
      }
      // The per-image cap cannot catch the AGGREGATE limit; enforce it here so
      // the batch can never exceed what the kernel would accept at admission.
      if (pendingBytes + data.length > limits.maxMessageImageBytes) {
        channel.pushSystem(
          `本条消息的图片总量将超出上限（${Math.round(limits.maxMessageImageBytes / 1048576)} MiB）：${name}`,
        )
        return
      }
    } else if (!attachments.saveFile) {
      channel.pushSystem(`内核未提供文件附件通路：${name}（需 dsh-attachment ≥ 0.1.5，或用图片格式）`)
      return
    }
    try {
      if (mediaType) {
        const ref = await attachments.saveImage({ data: new Uint8Array(data), mediaType, name })
        pendingAttachments.push({ kind: 'image', ref, label: ref.name ?? name })
      } else {
        const ref = await attachments.saveFile!({ data: new Uint8Array(data), name })
        pendingAttachments.push({ kind: 'file', ref, label: ref.name || name })
      }
      insertAttachmentToken(mediaType ? 'image' : 'file')
    } catch (error) {
      channel.pushSystem(`${mediaType ? '图片' : '文件'}附加失败：${attachmentErrorText(attachments, error)}`)
    }
  }

  /** Human-readable failure: the kernel's stable code when it is an AttachmentError. */
  const attachmentErrorText = (attachments: KernelAttachmentStore, error: unknown): string => {
    const detail = error instanceof Error ? error.message : String(error)
    try {
      if (attachments.isAttachmentError?.(error)) return `${error.code}（${detail}）`
    } catch {
      // Fall through to the raw message.
    }
    return detail
  }

  /**
   * Ctrl+V / Alt+V: read the system clipboard (see `clipboard.ts` — PowerShell
   * on Windows, pngpaste/pbpaste on macOS, wl-paste/xclip on Linux). An image
   * goes through the attachment path; an image-file PATH sitting in the text
   * clipboard attaches directly (that is how every file manager copies a
   * picture). Failures degrade to a notice; never break the TUI. Alt+V is the
   * Windows Terminal escape hatch because it consumes Ctrl+V for its own paste.
   */
  const pasteClipboardImage = (): void => {
    void readClipboard().then((result) => {
      if (disposed) return
      switch (result.kind) {
        case 'image': {
          const file = result.file
          void attachLocalPath(file).finally(() => {
            try {
              unlinkSync(file) // temp bytes only — the durable ref stays valid
            } catch {
              // Already gone or never written — nothing to clean.
            }
          })
          return
        }
        case 'text': {
          const single = result.text.trim().split(/\r?\n/)[0]?.trim() ?? ''
          const url = fileUrlToPath(single)
          const path = url ?? single
          // A file URL is already a path the user copied deliberately, so it
          // skips the "spaces need quotes" heuristic that plain text needs.
          if (hasImageExtension(path) && (url !== null || looksLikeImagePath(path))) {
            void attachLocalPath(path)
            return
          }
          channel.pushSystem('剪贴板里没有图片（复制文件或截图后再按 Ctrl+V/Alt+V；文本请用终端粘贴）')
          return
        }
        case 'unavailable':
          channel.pushSystem(result.message)
          return
        default:
          channel.pushSystem('剪贴板里没有图片（复制文件或截图后再按 Ctrl+V/Alt+V；文本请用终端粘贴）')
      }
    }).catch((error: unknown) => {
      channel.pushSystem(`剪贴板读取失败：${error instanceof Error ? error.message : String(error)}；可用 /img <路径>`)
    })
  }

  /**
   * Bracketed paste (200~ … 201~): one burst. A pasted image path attaches
   * instead of landing in the prompt; anything else keeps its line structure
   * (the editor is multi-line now), minus the trailing newline every copy
   * tends to carry. Terminals without the mode fall back to the submit-path
   * detection below.
   */
  function handlePaste(text: string): void {
    const cleaned = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '')
    const trimmed = cleaned.trim()
    if (looksLikeImagePath(trimmed)) {
      void attachLocalPath(trimmed)
      return
    }
    // A pathological paste (a whole file) must not wedge the editor or the
    // frame builder; truncate with a visible notice instead of freezing.
    const chars = Array.from(cleaned)
    if (chars.length > PASTE_MAX_CHARS) {
      insertText(chars.slice(0, PASTE_MAX_CHARS).join(''))
      channel.pushSystem(`粘贴内容过长，已截断到 ${PASTE_MAX_CHARS} 字符`)
      return
    }
    insertText(cleaned)
  }

  /** OSC 52 copy + a notice either way (a terminal may ignore the sequence). */
  const copyToClipboard = (text: string): void => {
    const chars = Array.from(text).length
    if (renderer.copyToClipboard(text)) {
      channel.pushSystem(`已复制 ${chars} 字符到剪贴板（终端若禁用 OSC 52，可 Shift+拖拽 走原生选择）`)
      return
    }
    channel.pushSystem(`选择过长（${chars} 字符）未复制；缩小范围，或 Shift+拖拽 走原生选择`)
  }

  /**
   * Alt-screen mouse: drag selects (reverse video overlay), release copies
   * through OSC 52, wheel scrolls the transcript window. Inline mode never
   * receives these events — there the terminal keeps its own selection.
   */
  const handleMouse = (event: MouseReport): void => {
    if (config.fullscreen !== true) return
    switch (event.kind) {
      case 'wheel': {
        const step = event.button === 0 ? -WHEEL_LINES : WHEEL_LINES
        const next = Math.max(0, Math.min(lastWindowTop + step, lastWindowMaxTop))
        scrollTop = next >= lastWindowMaxTop ? null : next
        mouseSelection = null
        mouseDragging = false
        render()
        return
      }
      case 'press': {
        if (event.button !== 0) return
        mouseSelection = { anchor: { row: event.y, col: event.x }, focus: { row: event.y, col: event.x } }
        mouseDragging = true
        render()
        return
      }
      case 'move': {
        if (!mouseDragging || mouseSelection === null) return
        mouseSelection = { anchor: mouseSelection.anchor, focus: { row: event.y, col: event.x } }
        render()
        return
      }
      default: {
        if (!mouseDragging || mouseSelection === null) return
        mouseDragging = false
        const text = selectionText(lastFrameLines, mouseSelection)
        // Drop the highlight BEFORE repainting: the notice row about to be
        // pushed shifts nothing (fullscreen windows scroll), but a stale
        // highlight over moved content would misrepresent what was copied.
        mouseSelection = null
        if (text !== '') copyToClipboard(text)
        render()
      }
    }
  }

  const keyboard = new Keyboard(
    stdin,
    (key) => {
      // Thinking expand/collapse is a pure view toggle — works everywhere,
      // including while a picker or the approval panel is on screen.
      if (key.ctrl && key.name === 'o') {
        thoughtExpanded = !thoughtExpanded
        return
      }
      // The picker captures every key except the exit chord.
      if (picker && classify(key) !== 'exit') {
        handlePickerKey(key)
        return
      }
      // Ctrl+V / Alt+V: attach the clipboard image. Windows Terminal never
      // delivers Ctrl+V to the TUI (it consumes it for bracketed paste), so
      // Alt+V is the reliable in-app image-paste hotkey there.
      if ((key.ctrl || key.alt) && key.name === 'v') {
        void pasteClipboardImage()
        return
      }
      // Tab completes the inline menus (slash first, then @path; no-op
      // without either). Shift+Tab toggles yolo (mainstream mode cycling).
      if (key.name === 'tab' && !picker) {
        if (key.shift) {
          doYolo(yoloMode ? 'off' : 'on')
          return
        }
        if (!completeAt()) completeMenu()
        return
      }
      switch (classify(key)) {
        case 'exit': {
          // Double-Ctrl+C exits; the first press interrupts a running turn
          // or clears editor state, and never kills the session by accident.
          const now = Date.now()
          const idleAndClean = editor === '' && cursorPos === 0 && pendingAttachments.length === 0 && channel.runState === 'idle'
          if (now - lastExitAt < 1200 || idleAndClean) {
            const exit = ctx.get<KernelAppExit>('appExit', false)
            if (typeof exit === 'function') exit(0)
            else void dispose().then(() => { process.exitCode = 0 })
            break
          }
          lastExitAt = now
          if (channel.runState !== 'idle') agent?.cancel({ kind: 'user' })
          else resetEditor()
          channel.pushSystem('再按一次 Ctrl+C 退出（Ctrl+C 已打断/清空）')
          break
        }
        case 'cancel': {
          if (pendingQuestion) {
            cancelPendingQuestion()
            resetEditor()
            break
          }
          if (editor || cursorPos !== 0 || pendingAttachments.length > 0) {
            resetEditor()
            break
          }
          if (picker) {
            // Approval Esc is handled inside handlePickerKey (explicit
            // reject); other pickers just close here.
            handlePickerKey(key)
            break
          }
          // Double-Esc on an empty idle editor = rewind to the previous turn
          // (pi /tree + kimi /undo spirit). Single Esc still cancels the turn.
          const now = Date.now()
          const doubleEsc = now - lastEscAt < 600
          lastEscAt = now
          if (doubleEsc && channel.runState === 'idle') {
            void doRewind()
          } else {
            agent?.cancel({ kind: 'user' })
          }
          break
        }
        case 'submit': {
          // Agent-initiated question: capture the answer instead of sending.
          if (pendingQuestion) {
            const answer = editor.trim()
            const forceCustom = questionCustomMode
            const baseSelected = questionDraftSelected
            resetEditor()
            questionCustomMode = false
            questionDraftSelected = []
            answerCurrentQuestion(answer, forceCustom, baseSelected)
            break
          }
          // A visible @ menu completes first; Enter never submits through it.
          if (completeAt()) break
          const { text: submitted, images, files } = collectSubmission()
          const text = submitted
          // Partial slash input completes from the menu first (kimi behavior);
          // a second Enter dispatches the completed command.
          if (text.startsWith('/') && !text.includes(' ') && !picker) {
            const slash = parseSlash(text)
            if (slash && !findSlash(slash.name)) {
              if (completeMenu()) break
            }
          }
          // A known slash command consumes only its own line: pending
          // attachments stay attached to the NEXT message (kimi behavior).
          // Wiping them here used to make `/img a.png` followed by
          // `/img b.pdf` silently drop the first file.
          const ownCommand = text.startsWith('/') ? findSlash(parseSlash(text)?.name ?? '') : undefined
          if (ownCommand) {
            clearEditorText()
            historyIndex = null
            submit(text, [], [])
            break
          }
          // Detach the pending attachments BEFORE resetEditor wipes them —
          // the refs must ride THIS message, and Esc-cancel still clears the
          // rest of the editor state.
          resetEditor()
          historyIndex = null
          if (submitted || images.length > 0 || files.length > 0) {
            if (submitted && !submitted.startsWith('/')) {
              promptHistory.push(submitted)
              if (promptHistory.length > 100) promptHistory.shift()
            }
            submit(submitted, images, files)
          }
          break
        }
        case 'backspace': {
          if (key.ctrl) deleteBefore(true)
          else deleteBefore()
          break
        }
        case 'text': {
          insertText(key.sequence)
          break
        }
        case 'newline': {
          insertNewline()
          break
        }
        case 'navigate': {
          if (key.name === 'up' || key.name === 'down') {
            const atState = currentAtMenu()
            const menu = currentMenu()
            if (atState && atState.items.length > 1) {
              const delta = key.name === 'down' ? 1 : -1
              atIndex = (atState.index + delta + atState.items.length) % atState.items.length
            } else if (menu && menu.items.length > 1) {
              const delta = key.name === 'down' ? 1 : -1
              menuIndex = (menu.index + delta + menu.items.length) % menu.items.length
            } else if (moveVertical(key.name === 'down' ? 1 : -1)) {
              // Moved a line inside the multi-line editor — history stays put.
            } else if (key.name === 'up') {
              historyRecall(-1)
            } else if (historyIndex !== null) {
              historyRecall(1)
            }
            break
          }
          if (key.name === 'left') {
            if (key.ctrl) wordLeft()
            else moveCursor(-1)
          } else if (key.name === 'right') {
            if (key.ctrl) wordRight()
            else moveCursor(1)
          } else if (key.name === 'home') {
            moveTo(lineBounds(cursorPos).start)
          } else if (key.name === 'end') {
            moveTo(lineBounds(cursorPos).end)
          } else if (key.name === 'delete') {
            deleteAt()
          }
          break
        }
        case 'ignore': {
          if (!key.ctrl || key.alt) break
          switch (key.name) {
            case 'a':
              moveTo(lineBounds(cursorPos).start)
              break
            case 'e':
              moveTo(lineBounds(cursorPos).end)
              break
            case 'k':
              killToEnd()
              break
            case 'u':
              killToStart()
              break
            case 'w':
              deleteBefore(true)
              break
          }
          break
        }
      }
    },
    handlePaste,
    handleMouse,
  )

  let flushedSealed = 0
  let flushedLine = 0
  let lastFlushWidth = 0
  let welcomed = false
  let lastRouteKey = ''
  // Visible transcript rows at the head of the last live frame — kept on exit
  // so recent history survives instead of being cleared with the chrome.
  let lastTranscriptKeep = 0
  // Live-pinned notices (welcome card + route slim lines): built once at
  // One-time notices are CHANNEL rows now (M8 unified pipeline): the
  // welcome card and the connect-time route line are pushed PINNED — they
  // hold the channel seal until the first turn/start, then stay in the live
  // sliding window (visible) until they age out into scrollback in log order.
  // Mid-session route changes are unpinned and age out the same way once the
  // viewport overflows (the footer always shows the live route). Inline and
  // fullscreen share the same path; the painter guarantees no loss on either.
  const render = (): void => {
    const fullscreen = config.fullscreen === true
    const route = selection ?? channel.route
    const cwd = process.cwd()
    const title = channel.title ?? safeTitleGetCached()
    // A session switch cleared the channel rows out from under the flush
    // cursor — rows pushed AFTER the clear would fall between the stale
    // cursor and the fresh seal and never reach the screen.
    if (flushedSealed > channel.rows.length) {
      flushedSealed = 0
      flushedLine = 0
    }
    const frameWidth = stdout.columns ?? 80
    // Rewrap invalidates line offsets: snap to the row start (rare, brief
    // duplication of a partial row across the resize is acceptable).
    if (lastFlushWidth !== 0 && frameWidth !== lastFlushWidth) flushedLine = 0
    lastFlushWidth = frameWidth
    if (!welcomed && agent) {
      welcomed = true
      const routeModel = route ? `${route.provider}/${route.model}${route.reasoningEffort ? `(${route.reasoningEffort})` : ''}` : null
      channel.pushRaw(welcomeCard(process.cwd(), agent.session.id, routeModel, stdout.columns ?? 80, currentOrcaVersion()), true)
      if (route) {
        channel.pushRaw([routeLine(route)], true)
        lastRouteKey = routeKey(route)
      }
    } else if (welcomed && route) {
      const key = routeKey(route)
      if (key !== lastRouteKey) {
        lastRouteKey = key
        channel.pushRaw([routeLine(route)])
      }
    }
    const frame = buildFrame({
      channel,
      sealedFrom: flushedSealed,
      sealedFromLine: flushedLine,
      editorText: editor,
      editorCursor: cursorPos,
      attachments: [], // images are inline IMAGE_SENTINEL tokens in editorText
      atMenu: currentAtMenu(),
      width: frameWidth,
      height: stdout.rows ?? 24,
      anchorChrome: true,
      fullscreen,
      cwd,
      sessionId: agent?.session.id ?? null,
      route,
      usage: channel.usage,
      now: Date.now(),
      picker,
      preset: livePreset,
      commandMenu: currentMenu(),
      thoughtExpanded,
      connecting: agent === null,
      title,
      policy: approvalPolicy,
      yolo: yoloMode,
      planMode: planActive(),
      askMode,
      branch: gitBranch(cwd),
      nerdFont,
      scrollTop: fullscreen ? scrollTop : null,
    })
    // Selection is an alt-screen affordance: the highlight is spliced into
    // the frame, the raw lines are kept for the copy (SGR-free extraction).
    lastFrameLines = frame.live
    const painted = paintSelection(frame.live, mouseSelection, theme.selection)
    renderer.render(painted, frame.stream, frame.cursor)
    // Advance only past lines the frame actually sedimented. Unflushed sealed
    // lines stay in the live window (visible) and age out a few lines per
    // tick — the 1:1 squeeze instead of a whole-row jump.
    flushedSealed = Math.max(0, Math.min(frame.nextSealedFrom, channel.rows.length))
    flushedLine = flushedSealed !== frame.nextSealedFrom ? 0 : Math.max(0, frame.nextSealedFromLine)
    if (flushedSealed >= channel.rows.length) flushedLine = 0
    lastTranscriptKeep = config.fullscreen === true ? 0 : Math.max(0, frame.transcriptLen)
    lastWindowTop = frame.windowTop
    lastWindowMaxTop = frame.windowMaxTop
  }

  // ~30fps render tick; the diff painter collapses no-op frames to zero
  // writes, so a fixed tick is cheap even while idle.
  const tick = setInterval(() => {
    try {
      render()
    } catch (error) {
      dbg(`render 失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
    }
  }, 33)
  // Own the screen: clear the viewport so orca starts from a clean slate
  // (shell residue stays in scrollback, one scroll away). In fullscreen
  // mode take the alternate buffer instead — the pre-orca screen is
  // restored verbatim on exit. Bracketed paste (2004) is enabled so pastes
  // arrive as one 200~/201~ burst instead of a keystroke replay.
  //
  // Mouse tracking (1002 = button events + drag, 1006 = SGR coordinates) is
  // enabled ONLY in the alternate screen: there Orca owns every cell and the
  // terminal's own selection cannot reach the transcript anyway, so drag
  // selection + OSC 52 copy is the only way to get text out. Inline mode
  // leaves the mouse to the terminal so native selection/copy keeps working.
  stdout.write(
    (config.fullscreen ? '\x1b[?1049h' : '') +
      '\x1b[2J\x1b[H\x1b[?2004h' +
      (config.fullscreen ? MOUSE_ON : ''),
  )
  keyboard.start()
  void runSessionTask(start)

  const dispose = (): Promise<void> => {
    if (disposeTask) return disposeTask
    disposed = true
    sessionAbort.abort()
    clearInterval(tick)
    if (atTimer !== null) clearTimeout(atTimer)
    atFetchSeq++
    keyboard.stop()
    // Inline keeps the visible transcript tail; only the spacer/chrome below
    // it is cleared. Fullscreen restores the main screen (alt content is
    // discarded by the terminal itself).
    renderer.disposeKeeping(lastTranscriptKeep)
    if (config.fullscreen) stdout.write(MOUSE_OFF + '\x1b[?1049l')
    stdout.write('\x1b[?2004l')
    // Unblock any pending approval asks — late answers are discarded by the
    // service once the signal fires, but our promise must still settle.
    for (const disposeListener of listenerDisposers) disposeListener()
    restoreLog()
    disposeTask = Promise.allSettled([releaseAgent(), sessionTask]).then(() => {})
    return disposeTask
  }

  return dispose
}

// ── helpers ──────────────────────────────────────────────────────────────────

function loadingItems(): PickerItem[] {
  return [{ value: '', label: '加载中…', disabled: true }]
}

function itemOf(label: string, value: string, hint?: string): PickerItem {
  return hint === undefined ? { value, label } : { value, label, hint }
}

/** The kernel brands `session-<uuid>` strings as SessionId — compile-time only. */
function mintSessionId(): string {
  return `session-${randomUUID()}`
}

/**
 * Build the `UserMessage` the kernel's `followup`/`steer` expect: identified
 * content blocks plus the supplying source. Plain structural object — the
 * kernel validates lossless JSON at the append boundary, brands are
 * compile-time only. Pending images ride as durable `image` blocks after the
 * text block (dsh-llm `ImageBlock`).
 */
function buildUserMessage(
  text: string,
  images: readonly ImageAttachmentRef[] = [],
  files: readonly FileAttachmentRef[] = [],
): UserMessage {
  const content: ContentBlock[] = []
  if (text !== '' || (images.length === 0 && files.length === 0)) content.push({ type: 'text', text })
  for (const attachment of images) content.push({ type: 'image', attachment })
  for (const attachment of files) content.push({ type: 'file', attachment })
  return {
    id: `msg-${randomUUID()}`,
    role: 'user',
    content,
    source: { kind: 'user' },
  }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function shortSessionLabel(id: string): string {
  return id.length > 18 ? '..' + id.slice(-12) : id
}

/**
 * `file://` URL → filesystem path. File managers on Linux copy
 * `text/uri-list` entries and browsers/iOS copy `file://` too, so a pasted
 * picture often arrives as a URL rather than a bare path. Returns null when
 * the text is not a file URL.
 */
export function fileUrlToPath(text: string): string | null {
  const match = /^file:\/\/(.*)$/i.exec(text.trim())
  if (!match) return null
  let rest = match[1] ?? ''
  try {
    rest = decodeURIComponent(rest) // %20 and CJK names
  } catch {
    // Malformed escape — keep the raw form rather than losing the path.
  }
  // file:///C:/dir/x.png → /C:/dir/x.png → C:/dir/x.png on Windows; POSIX
  // paths keep their leading slash.
  if (/^\/[A-Za-z]:\//.test(rest)) rest = rest.slice(1)
  return rest
}

function shortPath(cwd: string): string {
  const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? ''
  const display = home && cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd
  return display.replaceAll('\\', '/')
}

function formatTime(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return ''
  const date = new Date(epochMs)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Override point for tests — the harness sandboxes this to a temp file. */
function lastSessionFile(): string {
  const override = process.env['ORCA_LAST_SESSION_FILE']
  if (override) return override
  const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? ''
  return join(home, '.dsh', 'orca-last-session.json')
}

/**
 * The Workspace registry medium (`dsh-storage-json` single layout), at the
 * path `dsh-home-paths` resolves: `$DSH_HOME/storages/workspace.json`, else
 * `~/.dsh/storages/workspace.json`. `ORCA_WORKSPACE_FILE` is the test
 * override — the smoke harness points it at a temp file, and a deployment
 * with a relocated storage root simply never matches, which only disables the
 * guard (and with it the attach).
 */
function workspaceMediumFile(): string {
  const override = process.env['ORCA_WORKSPACE_FILE']
  if (override) return override
  const home = process.env['DSH_HOME']
  if (home !== undefined && home !== '') return join(home, 'storages', 'workspace.json')
  const profile = process.env['USERPROFILE'] ?? process.env['HOME'] ?? ''
  return join(profile, '.dsh', 'storages', 'workspace.json')
}

/** Field separator for the fingerprints below: no legal JSON string holds it. */
const FP_FIELD = '\u0001'
const FP_ROW = '\u0002'

/**
 * Canonical fingerprint of the workspace DOCUMENT as the medium holds it now:
 * registry order, each record's identity/stamp, and the archive set. Any
 * unreadable, unrecognized, or partially-shaped document yields `null`, which
 * the caller reads as "cannot verify" and therefore "do not write".
 *
 * This is a READ-ONLY guard against clobbering another process's workspace
 * edits; Orca never writes this file itself (all writes go through
 * `workspace.attachSession`, i.e. the kernel's own domain write chain).
 */
function workspaceMediumFingerprint(): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(workspaceMediumFile(), 'utf8'))
  } catch {
    return null
  }
  const document = recordOf(parsed)
  const global = recordOf(document?.['global'])
  const tables = recordOf(document?.['tables'])
  const workspaces = recordOf(tables?.['workspaces'])
  const order = global?.['workspaceIds']
  const archived = global?.['archivedSessionIds']
  if (workspaces === undefined || !Array.isArray(order) || !Array.isArray(archived)) return null
  const rows: string[] = []
  for (const id of order) {
    if (typeof id !== 'string') return null
    const record = recordOf(workspaces[id])
    const path = record?.['path']
    const title = record?.['title']
    const updatedAt = record?.['updatedAt']
    if (typeof path !== 'string' || typeof title !== 'string' || typeof updatedAt !== 'string') return null
    rows.push([id, path, title, updatedAt].join(FP_FIELD))
  }
  for (const id of archived) {
    if (typeof id !== 'string') return null
  }
  return `${rows.join(FP_ROW)}${FP_FIELD}${(archived as string[]).join(FP_ROW)}`
}

/**
 * The same fingerprint built from the LIVE registry this process holds. A
 * mismatch with {@link workspaceMediumFingerprint} means another writer
 * committed after this process read the document.
 */
function workspaceRegistryFingerprint(registry: KernelWorkspaceRegistry): string | null {
  let list: readonly KernelWorkspace[]
  try {
    list = registry.list()
  } catch {
    return null
  }
  const archived = registry.archivedSessionIds
  const rows: string[] = []
  for (const workspace of list) {
    const { id, path, title, updatedAt } = workspace
    if (typeof id !== 'string' || typeof path !== 'string' || typeof title !== 'string' || typeof updatedAt !== 'string') {
      return null
    }
    rows.push([id, path, title, updatedAt].join(FP_FIELD))
  }
  if (archived !== undefined && !Array.isArray(archived)) return null
  const archivedIds = (archived ?? []).filter((id): id is string => typeof id === 'string')
  if (archived !== undefined && archivedIds.length !== archived.length) return null
  return `${rows.join(FP_ROW)}${FP_FIELD}${archivedIds.join(FP_ROW)}`
}

interface LastSessionRecord {
  readonly pid: number
  readonly sessionId: string
}

/** Best-effort read of the last live session marker (null on any failure). */
function readLastSession(): LastSessionRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(lastSessionFile(), 'utf8'))
    const record = recordOf(parsed)
    const pid = record?.['pid']
    const sessionId = record?.['sessionId']
    if (typeof pid === 'number' && Number.isInteger(pid) && typeof sessionId === 'string' && sessionId !== '') {
      return { pid, sessionId }
    }
    return null
  } catch {
    return null
  }
}

/** Best-effort write of the last live session marker (never throws). */
function writeLastSession(sessionId: string): void {
  try {
    writeFileSync(lastSessionFile(), JSON.stringify({ pid: process.pid, sessionId }))
  } catch {
    // Marker loss only costs a silent remount, never the session.
  }
}

interface OrcaSettings {
  readonly nerdFont?: boolean
}

/** Local Orca UI settings file (command-persisted, best-effort). */
function orcaSettingsFile(): string {
  const override = process.env['ORCA_SETTINGS_FILE']
  if (override) return override
  const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? ''
  return join(home, '.dsh', 'orca-settings.json')
}

function readOrcaSettings(): OrcaSettings {
  try {
    const parsed: unknown = JSON.parse(readFileSync(orcaSettingsFile(), 'utf8'))
    const record = recordOf(parsed)
    if (!record) return {}
    const nerdFont = record['nerdFont']
    return typeof nerdFont === 'boolean' ? { nerdFont } : {}
  } catch {
    return {}
  }
}

function writeOrcaSettings(settings: OrcaSettings): void {
  try {
    writeFileSync(orcaSettingsFile(), JSON.stringify(settings))
  } catch {
    // Best-effort: the in-session toggle still works even if persistence fails.
  }
}

function defaultDeps(): AppIoDeps {
  return {
    stdout: () => process.stdout,
    stdin: () => process.stdin,
  }
}
