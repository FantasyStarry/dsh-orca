/**
 * User-authored slash commands: Markdown prompt templates on disk.
 *
 * Roots, project first (a project file shadows the user file of the same
 * name):
 *
 *   <cwd>/.orca/commands/**\/*.md      (override: `ORCA_COMMANDS_DIR`)
 *   $DSH_HOME/orca/commands/**\/*.md   (default `~/.dsh/orca/commands`)
 *
 * `deploy.md` becomes `/deploy`; a file in a subdirectory is namespaced with
 * `:` — `db/migrate.md` becomes `/db:migrate` (Claude Code's namespacing).
 * Frontmatter is the small `key: value` subset that matters here:
 * `description` (menu copy) and `argument-hint` (shown beside the name);
 * every other key is ignored rather than rejected, so a file written for
 * Claude Code / Kimi Code still loads.
 *
 * The body is a PROMPT TEMPLATE, not code: `$ARGUMENTS` is substituted when
 * present, otherwise a non-empty argument string is appended as a trailing
 * block. Dispatch therefore goes through the ordinary message path — the
 * command is text handed to the model, never a kernel command.
 *
 * Everything here is a pure function over a filesystem snapshot so it stays
 * unit-testable (`scripts/commands.test.ts`) and cannot invent state: a
 * missing directory, an unreadable file or a malformed frontmatter block
 * degrades to "that command does not exist".
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'

/** Hard cap on one command file — a template is UI copy, not a data store. */
export const MAX_COMMAND_BYTES = 64 * 1024
/** Hard cap on scanned files, so a pathological tree cannot stall a tick. */
export const MAX_COMMANDS = 256

export interface CustomCommand {
  /** Command name as typed after `/` (may contain `:` namespaces). */
  readonly name: string
  readonly description: string
  readonly argumentHint?: string
  /** Prompt template body (frontmatter removed). */
  readonly body: string
  /** Absolute source path (shown by `/help` diagnostics). */
  readonly path: string
}

/** Frontmatter plus body split out of one Markdown file. */
export interface ParsedCommandFile {
  readonly data: Readonly<Record<string, string>>
  readonly body: string
}

/**
 * Split an optional leading `---` frontmatter block from the body.
 * Only the flat `key: value` subset is parsed; a block that never closes is
 * treated as body text (better to send the file than to drop it).
 */
export function parseFrontmatter(text: string): ParsedCommandFile {
  const lines = text.split(/\r?\n/)
  if ((lines[0] ?? '').trim() !== '---') return { data: {}, body: text }
  let end = -1
  for (let index = 1; index < lines.length; index++) {
    if ((lines[index] ?? '').trim() === '---') {
      end = index
      break
    }
  }
  if (end === -1) return { data: {}, body: text }
  const data: Record<string, string> = {}
  for (let index = 1; index < end; index++) {
    const line = lines[index] ?? ''
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim().toLowerCase()
    if (key === '') continue
    let value = line.slice(colon + 1).trim()
    const quoted =
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    if (quoted) value = value.slice(1, -1)
    data[key] = value
  }
  return { data, body: lines.slice(end + 1).join('\n') }
}

/** Whether a name is addressable as `/name` (and safe to put in the menu). */
export function isCommandName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_:-]*$/.test(name)
}

/**
 * Command name for one file path relative to its root: directories become
 * `:`-separated namespaces, the extension is dropped.
 */
export function commandNameFor(relativePath: string): string | undefined {
  const parts = relativePath.replace(/\\/g, '/').split('/').filter((part) => part !== '')
  const file = parts.pop()
  if (file === undefined || !file.toLowerCase().endsWith('.md')) return undefined
  const stem = file.slice(0, -3)
  const segments = [...parts, stem].filter((part) => part !== '')
  if (segments.length === 0 || segments.some((part) => part.startsWith('.'))) return undefined
  const name = segments.join(':')
  return isCommandName(name) ? name : undefined
}

function walk(dir: string, prefix: string, out: CustomCommand[], budget: { left: number }): void {
  if (budget.left <= 0) return
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  // Deterministic order: the menu sorts anyway, but a stable scan keeps the
  // project-wins precedence independent of the filesystem's mood.
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (budget.left <= 0) return
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, `${prefix}${entry.name}/`, out, budget)
      continue
    }
    if (!entry.isFile()) continue
    const name = commandNameFor(`${prefix}${entry.name}`)
    if (name === undefined) continue
    try {
      if (statSync(full).size > MAX_COMMAND_BYTES) continue
      const text = readFileSync(full, 'utf8')
      const { data, body } = parseFrontmatter(text)
      const trimmed = body.trim()
      if (trimmed === '') continue
      const article: CustomCommand = {
        name,
        description: data['description'] ?? '',
        ...(data['argument-hint'] ? { argumentHint: data['argument-hint'] } : {}),
        body: trimmed,
        path: full,
      }
      out.push(article)
      budget.left--
    } catch {
      // Unreadable file: skip it, never fail the menu.
    }
  }
}

/**
 * Read every command under the given roots, project roots first. The first
 * root that defines a name wins; later duplicates are ignored.
 */
export function readCustomCommands(roots: readonly string[]): CustomCommand[] {
  const byName = new Map<string, CustomCommand>()
  const budget = { left: MAX_COMMANDS }
  for (const root of roots) {
    if (!root) continue
    const found: CustomCommand[] = []
    walk(root, '', found, budget)
    for (const command of found) {
      const key = command.name.toLowerCase()
      if (!byName.has(key)) byName.set(key, command)
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Expand one command into the prompt text it stands for. */
export function expandCustomCommand(command: CustomCommand, args: string): string {
  const trimmed = args.trim()
  if (command.body.includes('$ARGUMENTS')) return command.body.replaceAll('$ARGUMENTS', trimmed)
  if (trimmed === '') return command.body
  return `${command.body}\n\n${trimmed}`
}
