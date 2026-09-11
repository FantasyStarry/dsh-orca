/**
 * Local permission rule layer (`/perms`).
 *
 * The kernel owns the ASK and the sandbox, but it has no rule engine: verified
 * against @deepseek-ai/dsh 0.1.5-rc.2, `ctx.approval` is policy-level
 * (`ask` | `never`) plus an interactive waterfall. So "don't ask me again for
 * this" can only live in the TUI — this module is that layer, and it is
 * deliberately explicit: every rule has a scope, every auto-answer is reported
 * on screen, and the panel always shows the exact rule text it is about to
 * write.
 *
 * Scopes (highest priority last):
 *   builtin  read-only tools, on by default (`config.autoAllowReadOnly`)
 *   user     `$DSH_HOME/orca/permissions.json`      — this machine
 *   project  `<cwd>/.orca/permissions.json`         — shared with the repo
 *   session  in memory, dies with the session       — the panel's 本会话放行
 *
 * Decision precedence follows Claude Code's documented model — deny > ask >
 * allow — so no allow rule can ever override a deny. Rules answer the kernel's
 * ask; they can never make the kernel run a tool it refused, and yolo / a
 * `never` policy short-circuit BEFORE this layer (both are reported as such).
 *
 * Pattern grammar:
 *   `*`                 every tool
 *   `bash`              every call of one tool (tool names compare CI)
 *   `bash(npm test:*)`  `:*` = prefix match on one of the call's arguments
 *   `edit(src/**)`      glob (`*` does not cross `/`, `**` does, `?` = 1 char)
 *   `edit(src/app.ts)`  exact match
 *
 * A `Tool(spec)` rule matches when the spec matches ANY string value in the
 * call's arguments (top-level + nested, depth-capped). Matching is
 * case-sensitive: on a case-insensitive filesystem, write the glob you mean
 * (`edit(SRC/**)` does not match `src/app.ts`).
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type RuleDecision = 'allow' | 'deny' | 'ask'
export type RuleScope = 'session' | 'project' | 'user' | 'builtin'

export interface PermissionRule {
  readonly decision: RuleDecision
  readonly scope: RuleScope
  /** `*`, `Tool` or `Tool(spec)` — see the module header. */
  readonly pattern: string
  readonly reason?: string
}

/**
 * Tools that only read. Auto-allowed by default: a permission prompt per file
 * read is noise, and Claude Code does not prompt for its read-only tools
 * either. Anything that writes, runs a process or reaches the network is NOT
 * here — deny/ask rules beat the builtin allows anyway (see precedence above).
 */
export const READ_ONLY_TOOLS: readonly string[] = [
  'read',
  'read_image',
  'glob',
  'grep',
  'job_list',
  'job_output',
  'get_goal',
  'list_subagent_models',
]

/** Tools whose first argument is a shell command line. */
const SHELL_TOOLS = new Set(['bash', 'bash_persistent', 'pwsh', 'pwsh_persistent', 'shell', 'run_command'])

export function builtinRules(autoAllowReadOnly: boolean): readonly PermissionRule[] {
  if (!autoAllowReadOnly) return []
  return READ_ONLY_TOOLS.map((tool) => ({ decision: 'allow' as const, scope: 'builtin' as const, pattern: tool, reason: '只读工具' }))
}

/** Scope priority for tie-breaking: the LATER entry wins. */
const SCOPE_RANK: Record<RuleScope, number> = { builtin: 0, user: 1, project: 2, session: 3 }
/** Decision priority: a deny always beats an ask, which always beats an allow. */
const DECISION_RANK: Record<RuleDecision, number> = { deny: 0, ask: 1, allow: 2 }

/** Bounded walk over the call's arguments. */
const MAX_VALUES = 64
const MAX_VALUE_CHARS = 4096
const MAX_DEPTH = 4

export interface ParsedPattern {
  /** `*` or a tool name. */
  readonly tool: string
  /** Argument spec, absent for a tool-wide rule. */
  readonly spec?: string
}

/**
 * Parse a rule pattern. Returns undefined for anything malformed — a rule the
 * user cannot read in `/perms` is a rule they cannot trust, so nothing is
 * guessed into existence.
 */
export function parseRulePattern(text: string): ParsedPattern | undefined {
  const raw = text.trim()
  if (raw === '') return undefined
  if (raw === '*') return { tool: '*' }
  const open = raw.indexOf('(')
  if (open === -1) {
    return /^[A-Za-z0-9_.:-]+$/.test(raw) ? { tool: raw } : undefined
  }
  if (!raw.endsWith(')')) return undefined
  const tool = raw.slice(0, open).trim()
  const spec = raw.slice(open + 1, -1).trim()
  if (!/^[A-Za-z0-9_.:-]+$/.test(tool)) return undefined
  if (spec === '') return { tool }
  return { tool, spec }
}

/** Canonical display text for one rule. */
export function ruleText(rule: PermissionRule): string {
  return `${rule.decision} ${rule.pattern}`
}

function normalizePath(value: string): string {
  let out = value.replace(/\\/g, '/')
  while (out.startsWith('./')) out = out.slice(2)
  return out
}

function globToRegExp(glob: string): RegExp {
  let out = ''
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]
    if (char === undefined) break
    if (char === '*') {
      if (glob[index + 1] === '*') {
        // `**` crosses separators; a trailing `**` also matches the bare dir.
        out += '.*'
        index++
      } else {
        out += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      out += '[^/]'
      continue
    }
    out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

function specMatches(spec: string, candidates: readonly string[]): boolean {
  if (spec.endsWith(':*')) {
    const prefix = spec.slice(0, -2).trim()
    if (prefix === '') return true
    return candidates.some((candidate) => candidate.trimStart().startsWith(prefix))
  }
  if (spec.includes('*') || spec.includes('?')) {
    const pattern = globToRegExp(normalizePath(spec))
    return candidates.some((candidate) => pattern.test(normalizePath(candidate)))
  }
  const wanted = normalizePath(spec)
  return candidates.some((candidate) => normalizePath(candidate) === wanted)
}

export function toolMatches(patternTool: string, toolName: string): boolean {
  if (patternTool === '*') return true
  return patternTool.toLowerCase() === toolName.toLowerCase()
}

export function ruleMatches(rule: PermissionRule, toolName: string, argsText: string | undefined): boolean {
  const parsed = parseRulePattern(rule.pattern)
  if (!parsed) return false
  if (!toolMatches(parsed.tool, toolName)) return false
  if (parsed.spec === undefined) return true
  return specMatches(parsed.spec, argumentStrings(argsText))
}

/**
 * Every string value carried by the call, in document order. A JSON payload is
 * walked (depth/value capped); a non-JSON payload is matched as one string.
 */
export function argumentStrings(argsText: string | undefined): string[] {
  const raw = (argsText ?? '').trim()
  if (raw === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return [raw]
  }
  const out: string[] = []
  const walk = (value: unknown, depth: number): void => {
    if (out.length >= MAX_VALUES || depth > MAX_DEPTH) return
    if (typeof value === 'string') {
      if (value !== '' && value.length <= MAX_VALUE_CHARS) out.push(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1)
      return
    }
    if (typeof value === 'object' && value !== null) {
      for (const item of Object.values(value as Record<string, unknown>)) walk(item, depth + 1)
    }
  }
  walk(parsed, 0)
  return out
}

export interface RuleMatch {
  readonly decision: RuleDecision
  readonly rule: PermissionRule
}

/**
 * Decide one ask. `rules` is the flattened stack (builtin → user → project →
 * session); ties inside the winning decision are broken by scope rank, so a
 * session rule always explains itself over a user rule saying the same thing.
 */
export function evaluateCall(
  rules: readonly PermissionRule[],
  toolName: string,
  argsText: string | undefined,
): RuleMatch | undefined {
  let best: RuleMatch | undefined
  let bestDecision = Number.POSITIVE_INFINITY
  let bestScope = -1
  for (const rule of rules) {
    if (!ruleMatches(rule, toolName, argsText)) continue
    const decision = DECISION_RANK[rule.decision]
    const scope = SCOPE_RANK[rule.scope]
    if (decision > bestDecision) continue
    if (decision === bestDecision && scope < bestScope) continue
    best = { decision: rule.decision, rule }
    bestDecision = decision
    bestScope = scope
  }
  return best
}

/** First string that describes "what this call is about", for rule capture. */
function primaryArgument(toolName: string, argsText: string | undefined): string | undefined {
  const values = argumentStrings(argsText)
  if (values.length === 0) return undefined
  if (SHELL_TOOLS.has(toolName.toLowerCase())) return commandPrefix(values[0] ?? '')
  return values[0]
}

/** The command line up to its first sequencing operator — `a && b` → `a`. */
function commandPrefix(command: string): string {
  const head = command.split(/\n|&&|\|\||;|\|/)[0] ?? ''
  return head.trim()
}

/**
 * The narrowest rule that still covers the call being approved. The panel
 * prints this text verbatim before writing it, so a wrong guess is visible
 * rather than silent; `undefined` falls back to the tool-wide rule.
 */
export function suggestPattern(toolName: string, argsText: string | undefined): string {
  const tool = toolName.trim() === '' ? 'tool' : toolName.trim()
  const primary = primaryArgument(tool, argsText)
  if (primary === undefined || primary === '') return tool
  if (primary.includes('*') || primary.includes('?') || primary.includes('\0')) return tool
  if (SHELL_TOOLS.has(tool.toLowerCase())) {
    if (primary.length > 200 || /\s$/.test(primary)) return tool
    return `${tool}(${primary}:*)`
  }
  if (/\s/.test(primary) || primary.length > 160) return tool
  return `${tool}(${primary})`
}

// ── persistence ────────────────────────────────────────────────────────────

export interface RulesFile {
  readonly path: string
  readonly rules: readonly PermissionRule[]
  /** Set when the file exists but could not be used (bad JSON / bad shape). */
  readonly error?: string
}

function normalizeRules(value: unknown): readonly PermissionRule[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: PermissionRule[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const decision = record['decision']
    const pattern = record['pattern']
    if (decision !== 'allow' && decision !== 'deny' && decision !== 'ask') continue
    if (typeof pattern !== 'string' || parseRulePattern(pattern) === undefined) continue
    const reason = typeof record['reason'] === 'string' && record['reason'].trim() !== '' ? record['reason'] : undefined
    out.push({ decision, scope: 'project', pattern: pattern.trim(), ...(reason === undefined ? {} : { reason }) })
  }
  return out
}

/**
 * Read one rules file. A missing file is the normal case (no rules yet); a
 * BROKEN file reports `error` so the caller can say so out loud instead of
 * silently ignoring rules the user wrote.
 */
export function readRulesFile(path: string, scope: 'user' | 'project'): RulesFile {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { path, rules: [] }
  }
  try {
    const parsed: unknown = JSON.parse(text)
    const document = parsed as { rules?: unknown }
    const rules = normalizeRules(Array.isArray(parsed) ? parsed : document?.rules)
    if (!rules) return { path, rules: [], error: 'rules 字段不是数组' }
    return { path, rules: rules.map((rule) => ({ ...rule, scope })) }
  } catch (error) {
    return { path, rules: [], error: error instanceof Error ? error.message : String(error) }
  }
}

export type WriteResult = { readonly ok: true } | { readonly ok: false; readonly error: string }

/** Atomic write (tmp + rename) so a crash never leaves a half-written file. */
export function writeRulesFile(path: string, rules: readonly PermissionRule[]): WriteResult {
  const document = {
    version: 1,
    note: 'dsh-orca 审批规则（/perms）。decision: allow|deny|ask；pattern: Tool 或 Tool(参数模式)。',
    rules: rules.map((rule) => ({
      decision: rule.decision,
      pattern: rule.pattern,
      ...(rule.reason === undefined ? {} : { reason: rule.reason }),
    })),
  }
  const temporary = `${path}.tmp-${String(process.pid)}`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, path)
    return { ok: true }
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // The temp file may never have been created; nothing to clean up.
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Default locations, independent of the user's real `~` during tests. */
export function rulesPaths(cwd: string): { readonly user: string; readonly project: string } {
  const home = process.env['DSH_HOME']?.trim()
  const base = home !== undefined && home !== '' ? home : join(process.env['USERPROFILE'] ?? process.env['HOME'] ?? '.', '.dsh')
  const user = process.env['ORCA_PERMISSIONS_USER_FILE']?.trim()
  const project = process.env['ORCA_PERMISSIONS_FILE']?.trim()
  return {
    user: user !== undefined && user !== '' ? user : join(base, 'orca', 'permissions.json'),
    project: project !== undefined && project !== '' ? project : join(cwd, '.orca', 'permissions.json'),
  }
}
