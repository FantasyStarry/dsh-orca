/**
 * System clipboard access for image paste — one small strategy per platform.
 *
 * Orca links no native clipboard library: each platform is asked through the
 * tool its users already have, and every failure degrades to a notice — the
 * TUI must never break (or block) because a helper binary is missing.
 *
 *   Windows  PowerShell + System.Windows.Forms (always present)
 *   macOS    `pngpaste` for images (Homebrew), `pbpaste` for text
 *   Linux    `wl-paste` (Wayland) / `xclip` (X11) for both
 *
 * A clipboard "image" is materialized into a PNG file under the OS temp dir
 * (or `options.imageFile`); text is returned verbatim so the caller can spot a
 * copied image PATH, which is how every file manager copies a picture.
 */

import { spawn } from 'node:child_process'
import { statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type ClipboardRead =
  /** An image was written to `file` (PNG bytes). */
  | { readonly kind: 'image'; readonly file: string }
  /** The clipboard held text (possibly a path — the caller decides). */
  | { readonly kind: 'text'; readonly text: string }
  /** Nothing usable on the clipboard. */
  | { readonly kind: 'none' }
  /** No helper for this platform/clipboard — `message` is user-facing. */
  | { readonly kind: 'unavailable'; readonly message: string }

export interface ClipboardOptions {
  /** Hard cap per helper invocation (a wedged helper must not wedge the TUI). */
  readonly timeoutMs?: number
  /** Where a read image lands; defaults to a unique file in the temp dir. */
  readonly imageFile?: string
  /** Test seam — defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform
}

interface RunResult {
  readonly ok: boolean
  /** The binary itself is missing (ENOENT) — try the next strategy. */
  readonly missing: boolean
  /** Raw stdout: image payloads are BINARY, so this stays a Buffer. */
  readonly stdout: Buffer
  readonly stderr: string
}

/** Spawn once, capture stdout, never throw. */
function run(command: string, args: readonly string[], timeoutMs: number): Promise<RunResult> {
  return new Promise<RunResult>((settle) => {
    const chunks: Buffer[] = []
    let err = ''
    let done = false
    const finish = (result: RunResult): void => {
      if (done) return
      done = true
      settle(result)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, [...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      finish({ ok: false, missing: (error as NodeJS.ErrnoException).code === 'ENOENT', stdout: Buffer.alloc(0), stderr: '' })
      return
    }
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => { err += chunk.toString('utf8') })
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      finish({ ok: false, missing: error.code === 'ENOENT', stdout: Buffer.alloc(0), stderr: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish({ ok: code === 0, missing: false, stdout: Buffer.concat(chunks), stderr: err })
    })
  })
}

/** Spawn once and write raw stdout (image bytes) to `file`. */
async function runToFile(command: string, args: readonly string[], file: string, timeoutMs: number): Promise<boolean> {
  const result = await run(command, args, timeoutMs)
  if (!result.ok || result.stdout.length === 0) return false
  try {
    writeFileSync(file, result.stdout)
    return statSync(file).size > 0
  } catch {
    return false
  }
}

function defaultImageFile(): string {
  return join(tmpdir(), `orca-clip-${process.pid}-${Date.now()}.png`)
}

/** PowerShell reads BOTH image and text in one spawn (no way to ask twice cheaply). */
async function readWindows(imageFile: string, timeoutMs: number): Promise<ClipboardRead> {
  const escaped = imageFile.replaceAll('\\', '\\\\').replaceAll("'", "''")
  // Joined with NEWLINES: PowerShell rejects `... }; else { ... }` — a `;`
  // before `else` is a parse error, which the old one-liner silently ate
  // (empty stdout → "no image on the clipboard", for every paste).
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$img = [System.Windows.Forms.Clipboard]::GetImage()',
    `if ($img) { $img.Save('${escaped}', [System.Drawing.Imaging.ImageFormat]::Png); 'image' }`,
    "else { $t = [System.Windows.Forms.Clipboard]::GetText(); if ($t) { 'text:' + $t } else { 'none' } }",
  ].join('\n')
  const result = await run('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-Command', script], timeoutMs)
  if (!result.ok && result.missing) {
    return { kind: 'unavailable', message: '剪贴板读取失败（powershell 不可用）；可用 /img <路径> 附加图片' }
  }
  const text = result.stdout.toString('utf8').trim()
  if (text === 'image') return { kind: 'image', file: imageFile }
  if (text.startsWith('text:')) return { kind: 'text', text: text.slice(5) }
  return { kind: 'none' }
}

async function readDarwin(imageFile: string, timeoutMs: number): Promise<ClipboardRead> {
  // pngpaste is a Homebrew extra; when it is absent fall through to text so a
  // copied image PATH still works, and say what to install for real images.
  const png = await run('pngpaste', [imageFile], timeoutMs)
  if (png.ok) {
    try {
      if (statSync(imageFile).size > 0) return { kind: 'image', file: imageFile }
    } catch {
      // Empty/failed write — fall through to text.
    }
  }
  const pbpaste = await run('pbpaste', [], timeoutMs)
  if (pbpaste.ok && pbpaste.stdout.toString('utf8').trim() !== '') return { kind: 'text', text: pbpaste.stdout.toString('utf8') }
  if (png.missing) {
    return { kind: 'unavailable', message: '剪贴板图片需要 pngpaste（brew install pngpaste），或改用 /img <路径>' }
  }
  return { kind: 'none' }
}

/** Wayland first when the session is Wayland, X11 first otherwise. */
function linuxCandidates(wayland: boolean): {
  readonly image: { readonly command: string; readonly args: readonly string[] }
  readonly text: { readonly command: string; readonly args: readonly string[] }
}[] {
  const wl = {
    image: { command: 'wl-paste', args: ['--type', 'image/png'] },
    text: { command: 'wl-paste', args: ['--no-newline'] },
  }
  const xclip = {
    image: { command: 'xclip', args: ['-selection', 'clipboard', '-t', 'image/png', '-o'] },
    text: { command: 'xclip', args: ['-selection', 'clipboard', '-o'] },
  }
  return wayland ? [wl, xclip] : [xclip, wl]
}

async function readLinux(imageFile: string, timeoutMs: number): Promise<ClipboardRead> {
  const wayland = (process.env['WAYLAND_DISPLAY'] ?? '') !== ''
  const candidates = linuxCandidates(wayland)
  let anyHelper = false
  for (const candidate of candidates) {
    const image = await runToFile(candidate.image.command, candidate.image.args, imageFile, timeoutMs)
    if (image) return { kind: 'image', file: imageFile }
    const text = await run(candidate.text.command, candidate.text.args, timeoutMs)
    if (!text.missing) anyHelper = true
    if (text.ok && text.stdout.toString('utf8').trim() !== '') return { kind: 'text', text: text.stdout.toString('utf8') }
  }
  if (!anyHelper) {
    return { kind: 'unavailable', message: '剪贴板需要 wl-clipboard（wl-paste）或 xclip，或改用 /img <路径>' }
  }
  return { kind: 'none' }
}

/**
 * Read the clipboard: an image wins over text (a screenshot plus a stray text
 * flavor must still paste as the picture the user just took).
 */
export async function readClipboard(options: ClipboardOptions = {}): Promise<ClipboardRead> {
  const timeoutMs = options.timeoutMs ?? 8000
  const platform = options.platform ?? process.platform
  const imageFile = options.imageFile ?? defaultImageFile()
  if (platform === 'win32') return readWindows(imageFile, timeoutMs)
  if (platform === 'darwin') return readDarwin(imageFile, timeoutMs)
  if (platform === 'linux') return readLinux(imageFile, timeoutMs)
  return { kind: 'unavailable', message: `剪贴板读取暂不支持 ${platform}；请用 /img <路径>` }
}
