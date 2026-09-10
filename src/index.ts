/**
 * Orca — a self-owned in-process TUI front door for DeepSeek Harness.
 *
 * Cordis plugin contract (dsh-ecosystem-spec): the package root exports
 * exactly `name`, `Config`, `apply` — no default export. Every config key
 * carries a default so a missing/misconfigured plugin degrades to "nothing
 * happened", never a failed boot.
 *
 * `Config` implements the Standard Schema v1 interface (`~standard.validate`)
 * — that is what cordis's `resolveConfig` calls before starting the plugin
 * (verified against @deepseek-ai/cordis 4.0.2, shipped with dsh
 * v0.1.5-rc.1). A plain defaults table fails the boot with
 * `Cannot read properties of undefined (reading 'validate')`. We implement
 * the interface by hand instead of importing schemastery: zero extra
 * runtime deps, and validation coerces wrong-typed keys back to defaults —
 * the gentlest possible failure mode.
 */

import { bootstrapApp } from './app.js'
import type { KernelContext } from './kernel/types.js'

export const name = 'orca'

export interface OrcaConfig {
  /** LLM provider route override; empty = composition default (agentDefaultModel). */
  provider: string
  /** Model id override; empty = composition default. Must be set with provider. */
  model: string
  /** Alternate-screen fullscreen (target experience) vs inline main screen. */
  fullscreen: boolean
}

const DEFAULTS: OrcaConfig = {
  provider: '',
  model: '',
  fullscreen: false,
}

/** Minimal Standard Schema v1 types (https://standardschema.dev). */
interface StandardIssue {
  readonly message: string
  readonly path?: readonly (string | number | symbol)[]
}

interface StandardResult {
  readonly value?: unknown
  readonly issues?: readonly StandardIssue[]
}

interface StandardSchema {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (value: unknown) => StandardResult
  }
}

function validateConfig(value: unknown): StandardResult {
  const raw = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const provider = typeof raw['provider'] === 'string' ? raw['provider'] : DEFAULTS.provider
  const model = typeof raw['model'] === 'string' ? raw['model'] : DEFAULTS.model
  const fullscreen = typeof raw['fullscreen'] === 'boolean' ? raw['fullscreen'] : DEFAULTS.fullscreen
  return { value: { provider, model, fullscreen } satisfies OrcaConfig }
}

export const Config: StandardSchema = {
  '~standard': {
    version: 1,
    vendor: 'dsh-orca',
    validate: validateConfig,
  },
}

/**
 * Live app in this process, if any. `patchReload: live` profiles re-apply
 * the plugin on every rebuild while the old render loop may still be
 * painting: two loops on one stdout tear frames and stack welcomes/sessions
 * (verified in the scrollback-stacking repro). A terminal has exactly one
 * owner, so re-mounts single-flight through here — the previous instance is
 * torn down before the new one paints, even if the host disposes effects
 * late. Disposers are idempotent, so every ordering is safe.
 */
let liveDispose: (() => Promise<void>) | null = null
let lastTeardown: Promise<void> = Promise.resolve()

export function apply(ctx: KernelContext, config: Partial<OrcaConfig> = {}): void {
  const resolved: OrcaConfig = { ...DEFAULTS, ...config }

  // The whole app tree hangs off one effect: plugin unload (hot reload,
  // profile teardown) unmounts the TUI, restores the terminal, disposes the
  // agent — and never leaves the process wedged in raw mode.
  ctx.effect(() => {
    // TTY gate: without a terminal there is nothing to render and nothing to
    // drive; stay silent so headless compositions keep working.
    if (!process.stdout.isTTY || !process.stdin.isTTY) {
      return undefined
    }
    const previous = liveDispose?.() ?? lastTeardown
    lastTeardown = previous
    liveDispose = null
    const dispose = bootstrapApp(ctx, resolved, undefined, previous)
    liveDispose = dispose
    return () => {
      const pending = dispose()
      if (liveDispose === dispose) {
        liveDispose = null
        lastTeardown = pending
      }
      return pending
    }
  })
}
