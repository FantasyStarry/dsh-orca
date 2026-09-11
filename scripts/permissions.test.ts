/**
 * Unit tests for the local approval rule layer (`src/permission-rules.ts`).
 *
 * The layer answers kernel asks, so the assertions that matter are the ones
 * about SAFETY: a deny must always beat an allow, `ask` must still reach the
 * panel, `allow *` must never be inferred from a malformed pattern, and a
 * broken rules file must be reported instead of silently ignored. Everything
 * runs against temp paths — the user's real `~/.dsh` is never touched.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  argumentStrings,
  builtinRules,
  evaluateCall,
  parseRulePattern,
  readRulesFile,
  suggestPattern,
  writeRulesFile,
} from '../src/permission-rules.js'
import type { PermissionRule, RuleDecision, RuleScope } from '../src/permission-rules.js'

function rule(decision: RuleDecision, pattern: string, scope: RuleScope = 'user'): PermissionRule {
  return { decision, pattern, scope }
}

/** The flattened stack the app builds: builtin → user → project → session. */
function stack(...groups: readonly PermissionRule[][]): PermissionRule[] {
  return groups.flat()
}

test('pattern grammar: tool, argument spec, glob and rejections', () => {
  assert.deepEqual(parseRulePattern('*'), { tool: '*' })
  assert.deepEqual(parseRulePattern('bash'), { tool: 'bash' })
  assert.deepEqual(parseRulePattern(' bash '), { tool: 'bash' })
  assert.deepEqual(parseRulePattern('bash(npm test:*)'), { tool: 'bash', spec: 'npm test:*' })
  assert.deepEqual(parseRulePattern('edit(src/**)'), { tool: 'edit', spec: 'src/**' })
  assert.deepEqual(parseRulePattern('bash()'), { tool: 'bash' })
  // Malformed patterns are undefined, never guessed: a rule the user cannot
  // read back is a rule they cannot trust.
  assert.equal(parseRulePattern(''), undefined)
  assert.equal(parseRulePattern('   '), undefined)
  assert.equal(parseRulePattern('bash(npm test'), undefined)
  assert.equal(parseRulePattern('有空格'), undefined)
  assert.equal(parseRulePattern('bash(x) extra'), undefined)
})

test('argument values are collected from JSON payloads, depth- and size-capped', () => {
  assert.deepEqual(argumentStrings('{"command":"npm test"}'), ['npm test'])
  assert.deepEqual(argumentStrings('{"a":"x","b":{"c":"y"},"d":["z"]}'), ['x', 'y', 'z'])
  // Non-JSON payloads are matched as one opaque string rather than dropped.
  assert.deepEqual(argumentStrings('npm test'), ['npm test'])
  assert.deepEqual(argumentStrings(''), [])
  assert.deepEqual(argumentStrings(undefined), [])
})

test('tool-wide rules match any call; argument rules need the argument', () => {
  const args = '{"command":"npm test -- --watch"}'
  assert.equal(evaluateCall([rule('allow', 'bash')], 'bash', args)?.decision, 'allow')
  assert.equal(evaluateCall([rule('allow', 'bash')], 'Bash', args)?.decision, 'allow')
  // `:*` is a prefix match, so a longer command line still hits the rule.
  assert.equal(evaluateCall([rule('allow', 'bash(npm test:*)')], 'bash', args)?.decision, 'allow')
  assert.equal(evaluateCall([rule('allow', 'bash(npm test:*)')], 'bash', '{"command":"npm run lint"}'), undefined)
  // A different tool is never matched by a tool-scoped rule.
  assert.equal(evaluateCall([rule('allow', 'bash(npm test:*)')], 'write', args), undefined)
  // `*` covers every tool.
  assert.equal(evaluateCall([rule('allow', '*')], 'anything', undefined)?.decision, 'allow')
  // No arguments available ⇒ only tool-wide rules can match.
  assert.equal(evaluateCall([rule('allow', 'bash(npm test:*)')], 'bash', undefined), undefined)
})

test('globs: `*` stays inside a segment, `**` crosses, `./` is normalized', () => {
  const args = '{"path":"src/deep/app.ts"}'
  assert.equal(evaluateCall([rule('deny', 'edit(src/**)')], 'edit', args)?.decision, 'deny')
  assert.equal(evaluateCall([rule('deny', 'edit(src/**)')], 'edit', '{"path":"docs/x.md"}'), undefined)
  assert.equal(evaluateCall([rule('deny', 'edit(src/*)')], 'edit', args), undefined)
  assert.equal(evaluateCall([rule('deny', 'edit(src/*)')], 'edit', '{"path":"./src/app.ts"}')?.decision, 'deny')
  assert.equal(evaluateCall([rule('deny', 'edit(**/*.env)')], 'edit', '{"path":"a/.env"}')?.decision, 'deny')
  assert.equal(evaluateCall([rule('deny', 'edit(src/app.ts)')], 'edit', '{"path":"src/app.ts"}')?.decision, 'deny')
  // Case-sensitive by design: on a case-insensitive filesystem the user must
  // write the case they mean.
  assert.equal(evaluateCall([rule('deny', 'edit(SRC/**)')], 'edit', args), undefined)
})

test('precedence: deny beats ask beats allow, session explains itself', () => {
  const user = [rule('allow', 'bash(npm test:*)', 'user')]
  const project = [rule('ask', 'bash(npm test:*)', 'project')]
  const session = [rule('allow', 'bash', 'session')]
  const args = '{"command":"npm test"}'
  // ask outranks the session allow (decision precedence first)…
  const asked = evaluateCall(stack(user, project, session), 'bash', args)
  assert.equal(asked?.decision, 'ask')
  assert.equal(asked?.rule.scope, 'project')
  // …but a deny anywhere wins over both.
  const denied = evaluateCall(stack(user, [rule('deny', 'bash', 'user')], project, session), 'bash', args)
  assert.equal(denied?.decision, 'deny')
  assert.equal(denied?.rule.pattern, 'bash')
  // Same decision ⇒ the later/higher scope is the one reported.
  const allowed = evaluateCall(stack([rule('allow', 'bash', 'user')], [rule('allow', 'bash', 'project')]), 'bash', args)
  assert.equal(allowed?.rule.scope, 'project')
})

test('builtin read-only allows are rules like any other — and lose to deny', () => {
  const builtin = builtinRules(true)
  assert.equal(evaluateCall(builtin, 'read', '{"path":"src/app.ts"}')?.decision, 'allow')
  assert.equal(evaluateCall(builtin, 'write', '{"path":"src/app.ts"}'), undefined)
  // The switch really removes them.
  assert.deepEqual(builtinRules(false), [])
  // A user deny still wins over the builtin allow.
  const mixed = stack(builtin, [rule('deny', 'read(./secrets/**)', 'project')])
  assert.equal(evaluateCall(mixed, 'read', '{"path":"./secrets/key.txt"}')?.decision, 'deny')
  assert.equal(evaluateCall(mixed, 'read', '{"path":"src/app.ts"}')?.decision, 'allow')
  // An explicit ask rule can force a read prompt back on.
  assert.equal(evaluateCall(stack(builtin, [rule('ask', 'read', 'user')]), 'read', '{"path":"x"}')?.decision, 'ask')
})

test('suggested patterns stay as narrow as the call itself', () => {
  // Shell: the command head, prefix-matched so flags/args stay covered.
  assert.equal(suggestPattern('bash', '{"command":"npm test && npm run build"}'), 'bash(npm test:*)')
  assert.equal(suggestPattern('bash', '{"command":"ls -la"}'), 'bash(ls -la:*)')
  // File tools: the exact path, no glob invented for the user.
  assert.equal(suggestPattern('edit', '{"path":"src/app.ts"}'), 'edit(src/app.ts)')
  // Nothing usable ⇒ the honest fallback is the whole tool.
  assert.equal(suggestPattern('bash', undefined), 'bash')
  assert.equal(suggestPattern('bash', '{"command":""}'), 'bash')
  assert.equal(suggestPattern('bash', '{"command":"rm -rf *"}'), 'bash')
  assert.equal(suggestPattern('write', '{"path":"含有 空格 的路径"}'), 'write')
})

test('rules files round-trip and a broken file is reported, not ignored', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-perms-'))
  const path = join(root, 'nested', 'permissions.json')
  try {
    // Missing file = no rules, no error (the normal state).
    assert.deepEqual(readRulesFile(path, 'project'), { path, rules: [] })

    const written = writeRulesFile(path, [
      { decision: 'allow', scope: 'project', pattern: 'bash(npm test:*)', reason: '常用' },
      { decision: 'deny', scope: 'project', pattern: 'bash(rm -rf /*:*)' },
    ])
    assert.equal(written.ok, true)
    const read = readRulesFile(path, 'project')
    assert.equal(read.error, undefined)
    assert.deepEqual(
      read.rules.map((entry) => `${entry.scope} ${entry.decision} ${entry.pattern}`),
      ['project allow bash(npm test:*)', 'project deny bash(rm -rf /*:*)'],
    )
    assert.equal(read.rules[0]?.reason, '常用')
    // The file is meant to be hand-edited, so it must be plain JSON.
    const document = JSON.parse(readFileSync(path, 'utf8')) as { rules: unknown[] }
    assert.equal(document.rules.length, 2)

    writeFileSync(path, '{ 坏掉的 json')
    const broken = readRulesFile(path, 'project')
    assert.equal(broken.rules.length, 0)
    assert.notEqual(broken.error, undefined)

    // Junk entries are dropped individually; a valid neighbour survives.
    writeFileSync(path, JSON.stringify({ rules: [{ decision: 'maybe', pattern: 'x' }, { decision: 'deny', pattern: 'write' }] }))
    assert.deepEqual(readRulesFile(path, 'project').rules.map((entry) => entry.pattern), ['write'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
