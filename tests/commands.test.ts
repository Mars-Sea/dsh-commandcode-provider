/**
 * Unit tests for the /commandcode slash command (node:test, zero network).
 * The handler logic is exercised with a stubbed adapter, so plan probing and
 * catalog rendering are pinned without touching the live API.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { commandDefinition } from '../src/commands.ts'
import type { CommandCodeCommandDeps } from '../src/commands.ts'
import { CommandCodeAdapter } from '../src/adapter.ts'
import type { CommandCodeConnectionOptions } from '../src/adapter.ts'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

const CONN: CommandCodeConnectionOptions = {
  apiBase: 'https://api.commandcode.ai',
  workingDir: '/tmp',
  modelsCachePath: '/tmp/cache.json',
}

/** A stub adapter exposing just enough for the commands. */
function stubAdapter(overrides: {
  models?: { id: string; name: string }[]
  streamError?: Error
} = {}): CommandCodeAdapter {
  const models = overrides.models ?? [
    { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    { id: 'claude-opus-5', name: 'Claude Opus 5' },
  ]
  const adapter = {
    listModels: async () => models.map((m) => ({ provider: 'commandcode', id: m.id, name: `${m.name} (CC)`, inputModalities: ['text'] })),
    stream: async function* () {
      if (overrides.streamError) throw overrides.streamError
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  } as unknown as CommandCodeAdapter
  return adapter
}

function makeDeps(overrides: Partial<CommandCodeCommandDeps> = {}): CommandCodeCommandDeps {
  return {
    adapter: stubAdapter(),
    options: () => CONN,
    resolveApiKey: async () => 'user_test_key',
    ...overrides,
  }
}

function invoke(def: ReturnType<typeof commandDefinition>, rawInput: string): Promise<{ kind: string; text: string }> {
  const invocation = {
    commandId: 'c1',
    agent: 'main',
    rawInput,
    signal: new AbortController().signal,
  } as unknown as CommandInvocation
  return def.handler(invocation) as Promise<{ kind: string; text: string }>
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

test('status reports key and catalog', async () => {
  const def = commandDefinition(makeDeps())
  const result = await invoke(def, '')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /api key: configured/)
  assert.match(result.text, /models: 2/)
  assert.match(result.text, /deepseek\/deepseek-v4-flash/)
})

test('status flags a missing key', async () => {
  const def = commandDefinition(makeDeps({ resolveApiKey: async () => undefined }))
  const result = await invoke(def, 'status')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /api key: MISSING/)
})

// ---------------------------------------------------------------------------
// models
// ---------------------------------------------------------------------------

test('models lists all entries without a query', async () => {
  const def = commandDefinition(makeDeps())
  const result = await invoke(def, 'models')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /\(2\):/)
  assert.match(result.text, /claude-opus-5/)
})

test('models filters by query and annotates reasoning models', async () => {
  const def = commandDefinition(makeDeps())
  const result = await invoke(def, 'models opus')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /matching "opus"/)
  assert.match(result.text, /claude-opus-5/)
  assert.doesNotMatch(result.text, /deepseek-v4-flash/)
  // claude-opus-5 has known efforts, so it is annotated as a reasoning model.
  assert.match(result.text, /Reasoning models:/)
})

test('models reports no matches', async () => {
  const def = commandDefinition(makeDeps())
  const result = await invoke(def, 'models zzz-not-a-model')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /No Command Code models match/)
})

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

test('check reports a usable model', async () => {
  const def = commandDefinition(makeDeps())
  const result = await invoke(def, 'check deepseek/deepseek-v4-flash')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /usable/)
})

test('check reports MODEL_NOT_IN_PLAN', async () => {
  const planError = Object.assign(new Error('Command Code API error 403 (MODEL_NOT_IN_PLAN): upgrade'), { code: 'PROVIDER_HTTP_ERROR' })
  const def = commandDefinition(makeDeps({
    adapter: stubAdapter({ streamError: planError }),
  }))
  const result = await invoke(def, 'check claude-opus-5')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /not in your plan/)
})

test('check reports a rejected credential', async () => {
  const authError = Object.assign(new Error('Command Code API error 401 (UNAUTHORIZED): bad key'), { code: 'INVALID_CREDENTIAL' })
  const def = commandDefinition(makeDeps({
    adapter: stubAdapter({ streamError: authError }),
  }))
  const result = await invoke(def, 'check x')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /credential rejected/)
})

test('check requires a model argument', async () => {
  const def = commandDefinition(makeDeps())
  const result = await invoke(def, 'check')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /Usage: \/commandcode check/)
})

test('check fails loudly when no key is configured', async () => {
  const def = commandDefinition(makeDeps({ resolveApiKey: async () => undefined }))
  const result = await invoke(def, 'check deepseek/deepseek-v4-flash')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /No Command Code API key/)
})

// ---------------------------------------------------------------------------
// unknown subcommand
// ---------------------------------------------------------------------------

test('unknown subcommand returns a usage error', async () => {
  const def = commandDefinition(makeDeps())
  const result = await invoke(def, 'frobnicate')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /Unknown \/commandcode subcommand/)
})
