import assert from 'node:assert/strict'
import test from 'node:test'
import { configuredMcpServers, mcpServersFromEntries, type LoaderEntryLike } from '../src/dsh-config.ts'
import { MCP_ADAPTERS, mcpServerNames, selectConfiguredAdapters } from '../src/mcp.ts'

function mcpEntry(serverName: string, extra: Partial<LoaderEntryLike['options']> = {}): LoaderEntryLike {
  return { options: { name: '@deepseek-ai/dsh-mcp-client', config: { serverName }, ...extra } }
}

test('mcpServersFromEntries reads serverName from dsh-mcp-client entries', () => {
  const names = mcpServersFromEntries([
    mcpEntry('bigmodel'),
    mcpEntry('qianwenai'),
    mcpEntry('tokenrouter'),
    { options: { name: '@deepseek-ai/dsh-quota', config: { serverName: 'not-an-mcp' } } },
    { options: { name: 'file:///somewhere/dsh-mcp-client/lib/index.js', config: { serverName: 'versioned' } } },
    { options: { name: 'dsh-mcp-client' } }, // malformed: no serverName
  ])
  assert.deepEqual([...names].sort(), ['bigmodel', 'qianwenai', 'tokenrouter', 'versioned'])
})

test('mcpServersFromEntries skips disabled entries and survives a throwing getter', () => {
  const throwing: LoaderEntryLike = Object.defineProperty(
    { options: { name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'unevaluable' } } },
    'disabled',
    { get() { throw new Error('not initialised') } },
  )
  const names = mcpServersFromEntries([
    { ...mcpEntry('off'), disabled: true },
    mcpEntry('on'),
    throwing,
  ])
  // The throwing getter must not crash the scan; with no explicit disabled
  // flag the entry counts as enabled (fail open, the platform then reports
  // its own error visibly instead of silently disappearing).
  assert.deepEqual([...names].sort(), ['on', 'unevaluable'])
})

test('configuredMcpServers returns undefined when the loader service is unavailable', () => {
  assert.equal(configuredMcpServers({ get: () => undefined }), undefined)
  assert.equal(configuredMcpServers({ get: () => ({}) }), undefined)
  assert.equal(configuredMcpServers({ get: () => { throw new Error('no service') } }), undefined)
})

test('configuredMcpServers enumerates the loader entry tree', () => {
  const ctx = { get: () => ({ entries: () => [mcpEntry('scnet'), mcpEntry('supawriter')] }) }
  assert.deepEqual([...configuredMcpServers(ctx)!].sort(), ['scnet', 'supawriter'])
})

test('mcpServerNames parses the server out of qualified tool names', () => {
  const qianwen = MCP_ADAPTERS.find((a) => a.id === 'qianwen')!
  assert.deepEqual(mcpServerNames(qianwen), ['qianwenai'])
  assert.deepEqual(mcpServerNames({ id: 'x', label: 'X', calls: [{ name: 'mcp__a__t1' }, { name: 'mcp__b__t2' }, { name: 'not_mcp' }], parse: () => [] }), ['a', 'b'])
})

test('selectConfiguredAdapters keeps only adapters DSH is configured to run', () => {
  // loader available, only two servers declared → other built-ins are dropped
  const kept = selectConfiguredAdapters(MCP_ADAPTERS, new Set(['scnet', 'supawriter']))
  assert.deepEqual(kept.map((a) => a.id).sort(), ['scnet', 'supawriter'])

  // no MCP server declared at all → no MCP platform is queried
  assert.deepEqual(selectConfiguredAdapters(MCP_ADAPTERS, new Set()), [])

  // loader unavailable → previous behaviour (tool registry decides)
  assert.deepEqual(selectConfiguredAdapters(MCP_ADAPTERS, undefined), MCP_ADAPTERS)
})
