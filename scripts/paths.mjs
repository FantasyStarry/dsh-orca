/**
 * Machine-independent path resolution shared by the probe/smoke scripts.
 *
 * These scripts were written on one Windows box and used to embed that
 * machine's absolute paths (the dsh install, the repo, scratch dumps), which
 * made them useless in CI and in any other checkout. Every machine-specific
 * path now resolves HERE, in this order:
 *
 *   repo root    this file's own location (`import.meta.url`)
 *   dsh install  `$ORCA_DSH_PKG` → the install whose `dsh` shim is ON PATH →
 *                the usual global npm prefixes → `npm root -g` → a local
 *                resolution (last: a hoisted copy may be a stale generation)
 *   dsh home     `$DSH_HOME` → `~/.dsh`
 *   probe cwd    `$ORCA_E2E_CWD` → the first REGISTERED workspace in the
 *                ledger (so `--state` works out of the box) → `process.cwd()`
 *   scratch dir  `$ORCA_PROBE_DIR` → `<repo>/.probe` (gitignored)
 *
 * Nothing here writes outside the scratch dir; the ledger/home reads are
 * read-only and never fail hard (a missing file just falls through).
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Absolute path of the repository root (this file lives in `<repo>/scripts`). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Scratch directory for probe artifacts (screen dumps, raw logs). */
export const PROBE_DIR = process.env['ORCA_PROBE_DIR'] ?? join(REPO_ROOT, '.probe')

/** Absolute path of a probe artifact; the scratch directory is created on demand. */
export function probePath(name) {
  mkdirSync(PROBE_DIR, { recursive: true })
  return join(PROBE_DIR, name)
}

/** The DSH home the probes read (`DSH_HOME` wins; never a hardcoded user name). */
export const DSH_HOME = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')

const DSH_PACKAGE_REL = join('node_modules', '@deepseek-ai', 'dsh', 'package.json')

/**
 * Directories that hold a `dsh` launcher shim, in PATH order. These are the
 * installs the user actually runs, so they win over anything else.
 * @returns {string[]}
 */
function shimPrefixes() {
  const out = []
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (dir === '') continue
    if (existsSync(join(dir, 'dsh.cmd')) || existsSync(join(dir, 'dsh.exe')) || existsSync(join(dir, 'dsh'))) {
      out.push(dir)
    }
  }
  return out
}

/** The usual global install prefixes when no PATH shim is found. */
function globalPrefixes() {
  return [
    process.env['APPDATA'] ? join(process.env['APPDATA'], 'npm') : undefined,
    process.env['PNPM_HOME'],
    process.env['NVM_SYMLINK'],
    process.env['ProgramFiles'] ? join(process.env['ProgramFiles'], 'nodejs') : undefined,
    process.env['PREFIX'],
    join(homedir(), '.npm-global', 'lib'),
    join(homedir(), '.local'),
    '/usr/local',
    '/usr',
  ].filter((prefix) => typeof prefix === 'string' && prefix !== '')
}

/**
 * Candidate `@deepseek-ai/dsh/package.json` paths, best first.
 *
 * A repo-relative resolution comes LAST on purpose: a hoisted
 * `~/node_modules/@deepseek-ai/dsh` copy can be a stale generation (observed:
 * 0.1.2-alpha.3 sitting next to the real 0.1.5-rc.1 install), and the probes
 * must drive the kernel the `orca` profile actually boots.
 * @returns {string[]}
 */
function dshCandidates() {
  const override = process.env['ORCA_DSH_PKG'] ?? process.env['DSH_PKG']
  if (override) return [resolve(override)]
  const out = []
  for (const prefix of [...shimPrefixes(), ...globalPrefixes()]) {
    out.push(join(prefix, DSH_PACKAGE_REL))
  }
  try {
    out.push(createRequire(join(REPO_ROOT, 'package.json')).resolve('@deepseek-ai/dsh/package.json'))
  } catch {
    // Not installed next to the repo — the prefixes above are the answer.
  }
  return out
}

/** A candidate only counts when the launcher next to it exists too. */
function usableDsh(candidate) {
  return existsSync(candidate) && existsSync(join(dirname(candidate), 'lib', 'bin.js'))
}

let cachedDshPackage

/**
 * Absolute path of the installed `@deepseek-ai/dsh/package.json`.
 * Throws with an actionable message when the kernel is not installed.
 * @returns {string}
 */
export function dshPackagePath() {
  if (cachedDshPackage) return cachedDshPackage
  for (const candidate of dshCandidates()) {
    if (usableDsh(candidate)) {
      cachedDshPackage = candidate
      return candidate
    }
  }
  try {
    const root = execFileSync('npm', ['root', '-g'], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const candidate = join(root, DSH_PACKAGE_REL)
    if (usableDsh(candidate)) {
      cachedDshPackage = candidate
      return candidate
    }
  } catch {
    // npm missing or slow — the error below explains the manual override.
  }
  throw new Error(
    '找不到可用的 @deepseek-ai/dsh 安装（需要 package.json + lib/bin.js）。'
    + '先 `npm install -g @deepseek-ai/dsh`，或用 '
    + 'ORCA_DSH_PKG=<...>/node_modules/@deepseek-ai/dsh/package.json 显式指定。',
  )
}

/** Version string of the resolved dsh install (printed by the probes). */
export function dshVersion() {
  try {
    return JSON.parse(readFileSync(dshPackagePath(), 'utf8')).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Resolve a module from the dsh install (node-pty ships with the kernel). */
export function requireFromDsh(spec) {
  return createRequire(dshPackagePath())(spec)
}

/** Absolute path of the installed dsh launcher (`lib/bin.js`). */
export function dshBinPath() {
  const bin = join(dirname(dshPackagePath()), 'lib', 'bin.js')
  if (!existsSync(bin)) throw new Error(`dsh 安装里找不到 lib/bin.js：${bin}`)
  return bin
}

/** First registered workspace path in the ledger, when it still exists on disk. */
function registeredWorkspacePath() {
  try {
    const doc = JSON.parse(readFileSync(join(DSH_HOME, 'storages', 'workspace.json'), 'utf8'))
    const table = doc?.tables?.workspaces
    if (!table || typeof table !== 'object') return undefined
    for (const record of Object.values(table)) {
      const path = record?.path
      if (typeof path === 'string' && path !== '' && existsSync(path)) return path
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Working directory for the PTY probes. Any directory boots the TUI, but the
 * `--state` assertions need one that resolves to a REGISTERED workspace, so
 * an existing ledger entry beats the caller's cwd.
 * @returns {string}
 */
export function probeCwd() {
  return process.env['ORCA_E2E_CWD'] ?? registeredWorkspacePath() ?? process.cwd()
}
