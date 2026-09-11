#!/usr/bin/env node
/**
 * Mutation check for the approval-rule layer (phase13 assertions).
 *
 * AGENTS.md: 「新增断言要做变异验证」—— every assertion must be shown to go RED
 * when the behaviour it owns is broken. This driver breaks ONE behaviour at a
 * time, runs the owning suite, and requires BOTH a non-zero exit AND the
 * owning message in the output; anything else is a failed check.
 *
 * Why this is a script and not a shell one-liner: a checker that is itself
 * unreliable is worse than no checker. The failure mode this exists to prevent
 * was observed for real — a mutated tree makes the smoke harness hang (a broken
 * rule gate sends the ask to the interactive panel instead of answering it),
 * the run gets killed from outside, and the mutated source stays on disk
 * because nothing restored it. So:
 *
 *   - every touched file is snapshotted by BYTES before anything is written;
 *   - each mutation is restored in a `finally`, and any crash / SIGINT /
 *     SIGTERM / timeout restores everything through one exit path;
 *   - a leftover mutation from an earlier killed run is detected at startup and
 *     healed (loudly) instead of being committed by accident;
 *   - every suite runs under a hard timeout, killed as a whole process tree
 *     (a hung child must not strand the tree in a mutated state);
 *   - output is streamed, never piped into `tail` (buffering hides progress
 *     until the process exits — which is exactly the "no output" symptom).
 *
 * Usage: node scripts/mutation-check.mjs [<label substring>]
 * Exit:  0 = every mutation went red, 1 = something did not.
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const LOG_DIR = join(ROOT, '.probe', 'mutation')
/** Backstop only: a healthy `pnpm dev` run is ~40s. */
const SUITE_TIMEOUT_MS = 300_000

const SRC = {
  app: 'src/app.ts',
  rules: 'src/permission-rules.ts',
}

const MUTATIONS = [
  {
    label: 'rule gate removed',
    file: SRC.app,
    from: `    if (match && match.decision !== 'ask') {
      noteRuleHit(match.rule, name)
      return Promise.resolve(match.decision === 'allow' ? 'allowed-once' : 'rejected')
    }`,
    to: `    if (false && match) {
      noteRuleHit(match.rule, name)
      return Promise.resolve('allowed-once')
    }`,
    needle: '规则 allow 未自动放行',
    suite: 'dev',
  },
  {
    label: 'deny no longer outranks allow',
    file: SRC.rules,
    from: `const DECISION_RANK: Record<RuleDecision, number> = { deny: 0, ask: 1, allow: 2 }`,
    to: `const DECISION_RANK: Record<RuleDecision, number> = { deny: 2, ask: 1, allow: 0 }`,
    needle: 'precedence: deny beats ask',
    suite: 'test',
  },
  {
    label: 'captured rule not persisted',
    file: SRC.app,
    from: `    const written = writeRulesFile(path, next)
    if (!written.ok) return { ok: false, detail: \`\${path}：\${written.error}\` }`,
    to: `    const written = { ok: true as const }
    if (!written.ok) return { ok: false, detail: \`\${path}：\` }`,
    needle: '/perms allow 未写入项目规则文件',
    suite: 'dev',
  },
  {
    label: '/perms rm does not remove',
    file: SRC.app,
    from: `      const next = from.filter((rule) => rule !== target)`,
    to: `      const next = [...from]`,
    needle: '/perms rm 未删除规则',
    suite: 'dev',
  },
  {
    label: 'Ctrl-E expansion removed',
    file: SRC.app,
    from: `      if (key.ctrl && key.name === 'e') {
        expandApproval()
        return
      }`,
    to: `      if (false) {
        expandApproval()
        return
      }`,
    needle: 'Ctrl-E 未展开完整参数',
    suite: 'dev',
  },
  {
    label: 'read-only switch ignored',
    file: SRC.app,
    from: `      autoAllowReadOnly = choice === 'on'`,
    to: `      autoAllowReadOnly = true`,
    needle: 'phase13：/perms reads off 未回执',
    suite: 'dev',
  },
  {
    label: 'suggested pattern degraded to whole tool',
    file: SRC.rules,
    from: `  if (SHELL_TOOLS.has(tool.toLowerCase())) {
    if (primary.length > 200 || /\\s$/.test(primary)) return tool
    return \`\${tool}(\${primary}:*)\`
  }`,
    to: `  if (SHELL_TOOLS.has(tool.toLowerCase())) {
    return tool
  }`,
    needle: '面板未给出可复核的窄规则',
    suite: 'dev',
  },
  {
    // The anchor carries its own `} catch (error) {` line on purpose: a bare
    // `return { path, rules: [] }` also occurs legitimately (the missing-file
    // branch), and a mutation whose "broken" text is not unique can neither be
    // applied nor healed back with confidence.
    label: 'broken rules file silently ignored',
    file: SRC.rules,
    from: `  } catch (error) {
    return { path, rules: [], error: error instanceof Error ? error.message : String(error) }
  }`,
    to: `  } catch (error) {
    return { path, rules: [] }
  }`,
    needle: '损坏的规则文件未报告',
    suite: 'dev',
  },
]

const occurrences = (haystack, needle) => haystack.split(needle).length - 1

const log = (line = '') => process.stdout.write(`${line}\n`)

/** Byte-exact snapshots taken before ANY write; the single restore source. */
const snapshots = new Map()
const restoreAll = () => {
  for (const [file, bytes] of snapshots) {
    try {
      if (readFileSync(file).equals(bytes)) continue
      writeFileSync(file, bytes)
      log(`↩ 已还原 ${file}`)
    } catch (error) {
      log(`‼ 还原 ${file} 失败：${String(error)}`)
    }
  }
}

let done = false
const bail = (why) => {
  log(`\n‼ ${why}`)
  restoreAll()
  process.exit(1)
}
process.on('SIGINT', () => bail('收到 SIGINT，还原源码后退出'))
process.on('SIGTERM', () => bail('收到 SIGTERM，还原源码后退出'))
process.on('uncaughtException', (error) => bail(`未捕获异常：${String(error)}`))
process.on('unhandledRejection', (error) => bail(`未处理的 Promise 拒绝：${String(error)}`))

/**
 * Kill the whole tree: `pnpm` on Windows is a shell wrapper, so killing the
 * direct child alone would leave the real `node` process running (and holding
 * a mutated source tree hostage).
 */
function killTree(child) {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {}
  }
}

/** Run one suite; resolve { code, out, timedOut } — never throws on failure. */
function runSuite(suite, logPath) {
  return new Promise((resolve) => {
    const child = spawn(`pnpm ${suite}`, [], {
      cwd: ROOT,
      shell: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    })
    const chunks = []
    let timedOut = false
    const stream = process.env['MUTATION_VERBOSE'] === '1'
    const collect = (buf) => {
      chunks.push(buf)
      if (stream) process.stderr.write(buf)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = setTimeout(() => {
      timedOut = true
      process.stderr.write(`\n⏱ pnpm ${suite} 超过 ${SUITE_TIMEOUT_MS / 1000}s，杀掉整棵进程树\n`)
      killTree(child)
    }, SUITE_TIMEOUT_MS)
    child.on('close', (code) => {
      clearTimeout(timer)
      const out = Buffer.concat(chunks).toString('utf8')
      try {
        writeFileSync(logPath, out)
      } catch {}
      resolve({ code: code ?? -1, out, timedOut })
    })
  })
}

async function main() {
  const filter = process.argv[2]
  mkdirSync(LOG_DIR, { recursive: true })

  // Heal leftovers from a run that was killed before it could restore them
  // (that is not hypothetical: a SIGKILL — an outer `timeout`, a closed
  // terminal — runs no handler at all). Healing only ever touches a file whose
  // broken text occurs EXACTLY once: anything else is ambiguous and gets
  // reported instead of guessed at.
  let healed = 0
  for (const mutation of MUTATIONS) {
    const path = join(ROOT, mutation.file)
    const text = readFileSync(path, 'utf8')
    if (occurrences(text, mutation.from) === 1) continue
    const broken = occurrences(text, mutation.to)
    if (broken === 0) continue // Stale anchor after an implementation change; reported per entry below.
    if (broken === 1) {
      writeFileSync(path, text.replace(mutation.to, () => mutation.from))
      healed += 1
      log(`⚠ 发现上一次被中断留下的变异并已还原：${mutation.label}（${mutation.file}）`)
      continue
    }
    bail(
      `${mutation.file} 里「${mutation.label}」的变异后文本出现 ${broken} 次（不止一处合法出现），` +
        '无法判断哪一处是上次残留，未做任何修改。先手工核对再重跑。',
    )
  }
  if (healed > 0) log('（被杀掉也请重跑一次：脚本会自己收尾）\n')

  // Snapshot AFTER healing — the snapshot is what "restored" means for the
  // rest of this run, so it must never be the broken text we just repaired.
  for (const file of new Set(MUTATIONS.map((m) => m.file))) {
    snapshots.set(join(ROOT, file), readFileSync(join(ROOT, file)))
  }

  const failures = []

  for (const [index, mutation] of MUTATIONS.entries()) {
    if (filter !== undefined && !mutation.label.includes(filter)) continue
    const number = index + 1
    const path = join(ROOT, mutation.file)
    const original = snapshots.get(path)

    log(`\n───────── [${number}/${MUTATIONS.length}] ${mutation.label} ─────────`)
    log(`文件 ${mutation.file} ｜ 载体 pnpm ${mutation.suite} ｜ 期望 needle ${mutation.needle}`)

    const originalText = original.toString('utf8')
    if (occurrences(originalText, mutation.from) !== 1) {
      const hits = occurrences(originalText, mutation.from)
      log(`✘ 锚点命中 ${hits} 次（需要恰好 1 次）—— 实现改过就该同步改这张表`)
      failures.push(`${mutation.label}：锚点命中 ${hits} 次`)
      continue
    }

    const started = Date.now()
    let result
    try {
      // Belt and braces: the in-memory snapshot restores us on every path we
      // can still run code on; this on-disk copy is what a human needs if we
      // are SIGKILLed between the write and the restore.
      writeFileSync(join(LOG_DIR, `backup-${number}-${mutation.file.split('/').pop()}.orig`), original)
      writeFileSync(path, originalText.replace(mutation.from, () => mutation.to))
      result = await runSuite(mutation.suite, join(LOG_DIR, `${number}-${mutation.suite}.log`))
    } finally {
      writeFileSync(path, original)
      if (!readFileSync(path).equals(original)) bail(`还原 ${mutation.file} 失败，已中止`)
    }

    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    const red = result.code !== 0 && result.out.includes(mutation.needle)
    if (red) {
      log(`✔ 变红 | ${mutation.label} | exit=${result.code} | ${seconds}s`)
      continue
    }

    const reason = result.timedOut
      ? `超时 ${SUITE_TIMEOUT_MS / 1000}s 仍未变红（断言挂住了，不是失败）`
      : result.code === 0
        ? '实现改坏了但载体仍然通过'
        : `退出码 ${result.code}，但输出里没有 ${JSON.stringify(mutation.needle)}`
    log(`✘ 未变红 | ${mutation.label} | ${reason} | ${seconds}s`)
    const tail = result.out.trim().split('\n').slice(-8).join('\n')
    log(`    输出末尾：\n${tail.split('\n').map((l) => `    │ ${l}`).join('\n')}`)
    log(`    完整输出：${join('.probe', 'mutation', `${number}-${mutation.suite}.log`)}`)
    failures.push(`${mutation.label}：${reason}`)
  }

  done = true
  restoreAll()
  log('')
  if (failures.length > 0) {
    log(`变异验证失败（${failures.length} 条未变红）：`)
    for (const item of failures) log(`  - ${item}`)
    process.exit(1)
  }
  log(`变异验证通过 ✔ 每个变异都让对应断言变红（共 ${MUTATIONS.filter((m) => filter === undefined || m.label.includes(filter)).length} 条）`)
  process.exit(0)
}

process.on('exit', () => {
  if (!done) restoreAll()
})

await main()
