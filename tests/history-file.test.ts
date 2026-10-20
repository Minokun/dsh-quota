import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { historyFilePath, loadHistoryFile, parseHistoryFile, saveHistoryFile } from '../src/history-file.ts'

test('historyFilePath: env override → DSH_HOME → ~/.dsh', () => {
  assert.equal(
    historyFilePath({ DSH_QUOTA_HISTORY_FILE: '/tmp/x.json', DSH_HOME: '/h' } as NodeJS.ProcessEnv, '/home/u'),
    '/tmp/x.json',
  )
  assert.equal(
    historyFilePath({ DSH_HOME: '/h' } as NodeJS.ProcessEnv, '/home/u'),
    join('/h', 'dsh-quota', 'history.json'),
  )
  assert.equal(
    historyFilePath({} as NodeJS.ProcessEnv, '/home/u'),
    join('/home/u', '.dsh', 'dsh-quota', 'history.json'),
  )
})

test('parseHistoryFile keeps well-formed points and drops junk', () => {
  assert.deepEqual(
    parseHistoryFile(JSON.stringify({ version: 1, history: { k: [[1, 2], [3, 'x'], [4], [5, 6]] } })),
    { k: [[1, 2], [5, 6]] },
  )
  // 损坏的 JSON / 非对象都回退空历史，不抛错
  assert.deepEqual(parseHistoryFile('{not json'), {})
  assert.deepEqual(parseHistoryFile('[]'), {})
  // 兼容裸映射（没有 envelope）
  assert.deepEqual(parseHistoryFile(JSON.stringify({ k: [[1, 2]] })), { k: [[1, 2]] })
})

test('saveHistoryFile round-trips through an atomic write', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-quota-history-'))
  try {
    const path = join(dir, 'nested', 'history.json')
    await saveHistoryFile(path, { k: [[1, 2], [3, 4]] })
    assert.deepEqual(await loadHistoryFile(path), { k: [[1, 2], [3, 4]] })
    // 不存在的文件当作空历史
    assert.deepEqual(await loadHistoryFile(join(dir, 'missing.json')), {})
    assert.match(await readFile(path, 'utf8'), /"version":1/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
