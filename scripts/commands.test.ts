/**
 * Unit tests for the user-authored command loader (`src/custom-commands.ts`):
 * frontmatter splitting, name namespacing, scan precedence and `$ARGUMENTS`
 * expansion. These run on a temp tree so the repository never needs a
 * `.orca/commands` directory of its own.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_COMMAND_BYTES,
  commandNameFor,
  expandCustomCommand,
  isCommandName,
  parseFrontmatter,
  readCustomCommands,
} from '../src/custom-commands.js'

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'orca-cmd-'))
}

test('frontmatter splits into data plus body, quote-stripped', () => {
  const parsed = parseFrontmatter('---\ndescription: 部署到测试环境\nargument-hint: <service>\n---\n正文第一行\n正文第二行')
  assert.equal(parsed.data['description'], '部署到测试环境')
  assert.equal(parsed.data['argument-hint'], '<service>')
  assert.equal(parsed.body, '正文第一行\n正文第二行')
  assert.equal(parseFrontmatter('没有 frontmatter').body, '没有 frontmatter')
  // An unclosed block is body text, not a parse failure: we'd rather send the
  // file than silently drop the command.
  const unclosed = parseFrontmatter('---\ndescription: x\n正文')
  assert.deepEqual(unclosed.data, {})
  assert.equal(unclosed.body, '---\ndescription: x\n正文')
})

test('names come from paths: subdirectories namespace with a colon', () => {
  assert.equal(commandNameFor('deploy.md'), 'deploy')
  assert.equal(commandNameFor('db/migrate.md'), 'db:migrate')
  assert.equal(commandNameFor('db\\migrate.md'), 'db:migrate')
  assert.equal(commandNameFor('notes.txt'), undefined)
  assert.equal(commandNameFor('.hidden.md'), undefined)
  assert.equal(commandNameFor('db/.draft.md'), undefined)
  assert.equal(isCommandName('db:migrate'), true)
  assert.equal(isCommandName('有空格'), false)
})

test('scan reads nested files, skips junk, and lets the first root win', () => {
  const project = tempRoot()
  const user = tempRoot()
  try {
    writeFileSync(join(project, 'deploy.md'), '---\ndescription: 项目部署\n---\n项目正文')
    writeFileSync(join(project, 'notes.txt'), 'ignored')
    mkdirSync(join(project, 'db'))
    writeFileSync(join(project, 'db', 'migrate.md'), '迁移正文')
    writeFileSync(join(project, 'empty.md'), '\n\n')
    writeFileSync(join(user, 'deploy.md'), '用户正文')
    writeFileSync(join(user, 'release.md'), '发布正文')

    const commands = readCustomCommands([project, user])
    assert.deepEqual(
      commands.map((command) => command.name),
      ['db:migrate', 'deploy', 'release'],
    )
    // Project wins the duplicate name.
    assert.equal(commands.find((command) => command.name === 'deploy')?.body, '项目正文')
    assert.equal(commands.find((command) => command.name === 'deploy')?.description, '项目部署')
    // Missing roots degrade to "no commands".
    assert.deepEqual(readCustomCommands([join(project, 'nope')]), [])
  } finally {
    rmSync(project, { recursive: true, force: true })
    rmSync(user, { recursive: true, force: true })
  }
})

test('oversized command files are skipped instead of truncating a prompt', () => {
  const root = tempRoot()
  try {
    writeFileSync(join(root, 'big.md'), 'x'.repeat(MAX_COMMAND_BYTES + 1))
    writeFileSync(join(root, 'ok.md'), '好的')
    assert.deepEqual(
      readCustomCommands([root]).map((command) => command.name),
      ['ok'],
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('expansion substitutes $ARGUMENTS or appends the argument block', () => {
  const template = (body: string): Parameters<typeof expandCustomCommand>[0] => ({
    name: 't',
    description: '',
    body,
    path: 't.md',
  })
  assert.equal(expandCustomCommand(template('审阅 $ARGUMENTS 的改动'), 'src/app.ts'), '审阅 src/app.ts 的改动')
  assert.equal(expandCustomCommand(template('审阅 $ARGUMENTS'), ''), '审阅 ')
  assert.equal(expandCustomCommand(template('跑一遍测试'), '只跑单测'), '跑一遍测试\n\n只跑单测')
  assert.equal(expandCustomCommand(template('跑一遍测试'), ''), '跑一遍测试')
})
