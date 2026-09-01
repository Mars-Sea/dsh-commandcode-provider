/**
 * Web-search provider tests (node:test, zero deps). Run with `npm test`.
 *
 * These drive the `CommandCodeSearchProvider` against a stubbed fetch,
 * pinning the official Command Code `/alpha/web-search` wire contract:
 * - POST body `{ query, numResults }` on `{apiBase}/alpha/web-search`
 * - `Authorization: Bearer <key>` + `x-command-code-version` + CLI-environment
 * - the result mapping (`{ title, url, snippet }` → `WebSearchSource`)
 * - the missing-credential / non-2xx / unparseable / abort failure taxonomy.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CommandCodeSearchProvider, selectCommandCodeSearchProvider, COMMANDCODE_SEARCH_PROVIDER_ID, DEFAULT_WEB_SEARCH_PROVIDER_ID } from '../src/web-search.ts'
import { COMMAND_CODE_CLI_VERSION } from '../src/adapter.ts'

/** A fetch stub that records the request and returns a scripted response. */
interface Stub {
  fetchImpl: typeof fetch
  lastInit: RequestInit | undefined
  lastUrl: string | undefined
  lastBody: Record<string, unknown> | undefined
  keys: string[]
}

function makeFetch(impl: (init: RequestInit & { url: string }) => Response): Stub {
  const stub: Stub = {
    fetchImpl: undefined!,
    lastInit: undefined,
    lastUrl: undefined,
    lastBody: undefined,
    keys: [],
  }
  stub.fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(_input)
    stub.lastUrl = url
    stub.lastInit = init
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
    stub.lastBody = body
    const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '')
    stub.keys.push(auth.replace(/^Bearer /, ''))
    return impl({ ...init, url } as RequestInit & { url: string })
  }) as typeof fetch
  return stub
}

function makeProvider(overrides?: {
  key?: string | null   // null → resolveKey returns undefined (no key)
  apiBase?: string
  fetchImpl?: typeof fetch
}): { provider: CommandCodeSearchProvider; key: string | undefined; apiBase: string } {
  const apiBase = overrides?.apiBase ?? 'https://api.commandcode.ai'
  const key = overrides?.key === null ? undefined : (overrides?.key ?? 'cc-key-123')
  const provider = new CommandCodeSearchProvider({
    resolveKey: async () => key,
    apiBase: () => apiBase,
    fetchImpl: overrides?.fetchImpl,
  })
  return { provider, key, apiBase }
}

/** A successful Command Code search response. */
function okBody(results: Array<{ title: string; url: string; snippet: string }>): ResponseInit & { body: unknown } {
  return { status: 200, body: { results } }
}

function asResponse(init: ResponseInit & { body?: unknown }): Response {
  return {
    status: init.status ?? 200,
    ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
    json: async () => init.body,
  } as Response
}

test('sends the CLI web-search POST with the Command Code key and version header', async () => {
  const { provider, key } = makeProvider()
  const stub = makeFetch(() => asResponse(okBody([{ title: 't', url: 'https://a.example', snippet: 's' }])))
  const tied = new CommandCodeSearchProvider({
    resolveKey: async () => key,
    apiBase: () => 'https://api.commandcode.ai',
    fetchImpl: stub.fetchImpl,
  })
  await tied.search({ query: 'latest model 2026' }, undefined)

  assert.equal(stub.lastUrl, 'https://api.commandcode.ai/alpha/web-search')
  const headers = stub.lastInit?.headers as Record<string, string>
  assert.equal(headers?.Authorization, `Bearer ${key}`)
  assert.equal(headers?.['x-command-code-version'], COMMAND_CODE_CLI_VERSION)
  assert.equal(headers?.['x-cli-environment'], 'production')
  assert.equal(headers?.['Content-Type'], 'application/json')
  assert.deepEqual(stub.lastBody, { query: 'latest model 2026', numResults: 5 })
})

test('maps the results array to WebSearchSource and omits empty optional fields', async () => {
  const { provider, key } = makeProvider()
  const stub = makeFetch(() => asResponse(okBody([
    { title: 'T1', url: 'https://a.example/1', snippet: 'S1' },
    { title: 'T2', url: 'https://b.example/2', snippet: '' },
    { title: '', url: 'https://c.example', snippet: 'only-url' },
    { title: 'dup', url: 'https://a.example/1', snippet: 'ignored' },
    { title: 'no-url', url: '', snippet: 'dropped' },
  ])))
  const tied = new CommandCodeSearchProvider({
    resolveKey: async () => key,
    apiBase: () => 'https://api.commandcode.ai',
    fetchImpl: stub.fetchImpl,
  })
  const result = await tied.search({ query: 'q' }, undefined)

  assert.equal(result.truncated, false)
  assert.deepEqual(result.sources, [
    { url: 'https://a.example/1', title: 'T1', snippet: 'S1' },
    { url: 'https://b.example/2', title: 'T2' },
    { url: 'https://c.example', snippet: 'only-url' },
  ])
})

test('clamps the maxResults bound into Command Code numResults range', async () => {
  const { provider } = makeProvider()
  // Over-bounds → 10 (floor), under-bounds → 1 (ceil).
  const high = makeFetch(() => asResponse(okBody([{ title: 'x', url: 'u', snippet: 's' }])))
  await new CommandCodeSearchProvider({
    resolveKey: async () => 'k',
    apiBase: () => 'https://api.commandcode.ai',
    fetchImpl: high.fetchImpl,
  }).search({ query: 'q', maxResults: 42 }, undefined)
  assert.equal((high.lastBody?.numResults as number), 10)

  const low = makeFetch(() => asResponse(okBody([{ title: 'x', url: 'u', snippet: 's' }])))
  await new CommandCodeSearchProvider({
    resolveKey: async () => 'k',
    apiBase: () => 'https://api.commandcode.ai',
    fetchImpl: low.fetchImpl,
  }).search({ query: 'q', maxResults: 0 }, undefined)
  assert.equal((low.lastBody?.numResults as number), 1)
})

test('throws WEB_PROVIDER_CREDENTIAL_MISSING when no key can be resolved', async () => {
  const { provider } = makeProvider({ key: null })
  await assert.rejects(
    () => provider.search({ query: 'q' }),
    (error: unknown) => {
      const e = error as { code?: string }
      assert.equal(e.code, 'WEB_PROVIDER_CREDENTIAL_MISSING')
      return true
    },
  )
})

test('preserves the plugin RATE_LIMIT cause with WEB_PROVIDER_ERROR code', async () => {
  const { provider } = makeProvider()
  const stub = makeFetch(() => asResponse(okBody([{ title: 'x', url: 'u', snippet: 's' }])))
  const failing = new CommandCodeSearchProvider({
    resolveKey: async () => { throw Object.assign(new Error('llm-commandcode: all accounts exhausted'), { code: 'RATE_LIMIT' }) },
    apiBase: () => 'https://api.commandcode.ai',
    fetchImpl: stub.fetchImpl,
  })
  await assert.rejects(
    () => failing.search({ query: 'q' }),
    (error: unknown) => {
      const e = error as { code?: string; message?: string }
      assert.equal(e.code, 'WEB_PROVIDER_ERROR')
      assert.match(e.message ?? '', /all accounts exhausted/)
      return true
    },
  )
})

test('throws WEB_PROVIDER_ERROR on a non-2xx response and surfaces the error detail', async () => {
  const { key } = makeProvider()
  const stub = makeFetch(() => asResponse({
    status: 403,
    body: { error: { code: 'MODEL_NOT_IN_PLAN', message: 'model not in plan' } },
  }))
  const tied = new CommandCodeSearchProvider({
    resolveKey: async () => key,
    apiBase: () => 'https://api.commandcode.ai',
    fetchImpl: stub.fetchImpl,
  })
  await assert.rejects(
    () => tied.search({ query: 'q' }),
    (error: unknown) => {
      const e = error as { code?: string; message?: string }
      assert.equal(e.code, 'WEB_PROVIDER_ERROR')
      assert.match(e.message ?? '', /403/)
      assert.match(e.message ?? '', /MODEL_NOT_IN_PLAN/)
      return true
    },
  )
})

test('throws WEB_PROVIDER_ERROR when the response body is unparseable', async () => {
  const { key } = makeProvider()
  const stub = makeFetch(() => ({
    status: 200,
    ok: true,
    json: async () => { throw new SyntaxError('bad json') },
  }) as unknown as Response)
  const tied = new CommandCodeSearchProvider({
    resolveKey: async () => key,
    apiBase: () => 'https://api.commandcode.ai',
    fetchImpl: stub.fetchImpl,
  })
  await assert.rejects(
    () => tied.search({ query: 'q' }),
    (error: unknown) => {
      const e = error as { code?: string }
      assert.equal(e.code, 'WEB_PROVIDER_ERROR')
      return true
    },
  )
})

test('throws WEB_PROVIDER_ERROR when the response has no results array', async () => {
  const { key } = makeProvider()
  const stub = makeFetch(() => asResponse({ status: 200, body: { formatted: 'no results' } }))
  const tied = new CommandCodeSearchProvider({
    resolveKey: async () => key,
    apiBase: () => 'https://api.commandcode.ai',
    fetchImpl: stub.fetchImpl,
  })
  await assert.rejects(
    () => tied.search({ query: 'q' }),
    (error: unknown) => {
      const e = error as { code?: string }
      assert.equal(e.code, 'WEB_PROVIDER_ERROR')
      return true
    },
  )
})

test('throws WEB_ABORTED when the caller aborts mid-flight', async () => {
  const { provider } = makeProvider()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => provider.search({ query: 'q' }, controller.signal),
    (error: unknown) => {
      const e = error as { code?: string }
      assert.equal(e.code, 'WEB_ABORTED')
      return true
    },
  )
})

test('available() is false for a blank or non-parseable apiBase', async () => {
  const bad = new CommandCodeSearchProvider({
    resolveKey: async () => 'k', apiBase: () => '', fetchImpl: makeFetch(() => asResponse(okBody([]))).fetchImpl,
  })
  assert.equal(bad.available(), false)

  const good = new CommandCodeSearchProvider({
    resolveKey: async () => 'k', apiBase: () => 'https://api.commandcode.ai', fetchImpl: makeFetch(() => asResponse(okBody([]))).fetchImpl,
  })
  assert.equal(good.available(), true)
})

test('selectCommandCodeSearchProvider rewrites the runtime selection field', () => {
  // A minimal structural stand-in for WebRuntime: the runtime selection field
  // is a plain writable property (see web-search.ts for the rationale).
  const web = { searchProviderId: 'deepseek-official' } as unknown as { searchProviderId?: string }

  const prior = selectCommandCodeSearchProvider(web as never, true)
  assert.equal(prior, 'deepseek-official')
  assert.equal((web as { searchProviderId?: string }).searchProviderId, COMMANDCODE_SEARCH_PROVIDER_ID)

  // Disabling restores the shipped default.
  selectCommandCodeSearchProvider(web as never, false)
  assert.equal((web as { searchProviderId?: string }).searchProviderId, DEFAULT_WEB_SEARCH_PROVIDER_ID)
})

test('selectCommandCodeSearchProvider keeps an undefined field when prior was undefined', () => {
  const web = {} as { searchProviderId?: string }
  const prior = selectCommandCodeSearchProvider(web as never, true)
  assert.equal(prior, undefined)
  assert.equal(web.searchProviderId, COMMANDCODE_SEARCH_PROVIDER_ID)
})
