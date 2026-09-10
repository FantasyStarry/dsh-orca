/**
 * Display formatting shared by the chrome (footer) and the transcript rows
 * (turn summary). One formatter, one convention: whatever the footer shows for
 * a count, a transcript row shows the same string — otherwise the same number
 * reads `4.1k` in one place and `4115` in another.
 */

/**
 * Compact token count: `999` → `999`, `4115` → `4.1k`, `170000` → `170k`.
 * Below 1000 the exact value is kept (small counts are meaningful as-is).
 */
export function formatTokenCount(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '0'
  if (count >= 100_000) return `${Math.round(count / 1000)}k`
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`
  return String(Math.round(count))
}

/**
 * The bare model id of a `provider/model` route — the provider prefix is the
 * deployment's routing detail, already carried by the footer's live route and
 * by the session's route line; repeating it on every turn summary row is the
 * redundancy that made the row read as noise.
 */
export function shortModelName(model: string, provider = ''): string {
  if (provider !== '' && model.startsWith(`${provider}/`)) return model.slice(provider.length + 1)
  const slash = model.lastIndexOf('/')
  return slash === -1 ? model : model.slice(slash + 1)
}
