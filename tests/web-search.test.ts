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

import { CommandCodeSearchProvider, applyCommandCodeSearchSelection, commandCodeSearchSelection, COMMANDCODE_SEARCH_PROVIDER_ID } from '../src/web-search.ts'
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
    // Omitted (never explicitly `undefined`) when the caller supplies no stub:
    // `exactOptionalPropertyTypes` forbids an undefined-valued optional field.
    ...(overrides?.fetchImpl === undefined ? {} : { fetchImpl: overrides.fetchImpl }),
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
  const { key } = makeProvider()
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
  assert.equal(headers?.['accept-encoding'], 'identity')
  assert.deepEqual(stub.lastBody, { query: 'latest model 2026', numResults: 5 })
})

test('maps the results array to WebSearchSource and omits empty optional fields', async () => {
  const { key } = makeProvider()
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

test('applyCommandCodeSearchSelection restores a sibling pin (e.g. modsearch) on disable', () => {
  // The issue #26 repro: a sibling plugin pinned `searchProvider: modsearch`
  // at construction time. Enabling must remember it; disabling must hand the
  // selection back to it — never to the factory default.
  const web = { searchProviderId: 'modsearch' } as unknown as Parameters<typeof applyCommandCodeSearchSelection>[0]
  const state = commandCodeSearchSelection()

  applyCommandCodeSearchSelection(web, state, true)
  assert.equal((web as unknown as { searchProviderId?: string }).searchProviderId, COMMANDCODE_SEARCH_PROVIDER_ID)

  applyCommandCodeSearchSelection(web, state, false)
  assert.equal((web as unknown as { searchProviderId?: string }).searchProviderId, 'modsearch')
})

test('applyCommandCodeSearchSelection leaves an unconfigured field alone when never enabled', () => {
  // A fresh boot straight into `webSearch: false`: nothing displaced, nothing
  // to restore — the runtime's own value (sibling pin or unset auto-select)
  // already says what the user wants.
  const pinned = { searchProviderId: 'modsearch' } as unknown as Parameters<typeof applyCommandCodeSearchSelection>[0]
  applyCommandCodeSearchSelection(pinned, commandCodeSearchSelection(), false)
  assert.equal((pinned as unknown as { searchProviderId?: string }).searchProviderId, 'modsearch')

  const unset = {} as unknown as Parameters<typeof applyCommandCodeSearchSelection>[0]
  applyCommandCodeSearchSelection(unset, commandCodeSearchSelection(), false)
  assert.equal((unset as unknown as { searchProviderId?: string }).searchProviderId, undefined)
})

test('applyCommandCodeSearchSelection keeps the displaced backend across re-enables', () => {
  // Settings saves re-apply while still on: the field currently holds our own
  // id, which must never overwrite the remembered backend.
  const web = { searchProviderId: 'modsearch' } as unknown as Parameters<typeof applyCommandCodeSearchSelection>[0]
  const state = commandCodeSearchSelection()

  applyCommandCodeSearchSelection(web, state, true)
  applyCommandCodeSearchSelection(web, state, true)
  applyCommandCodeSearchSelection(web, state, false)
  assert.equal((web as unknown as { searchProviderId?: string }).searchProviderId, 'modsearch')
})

test('applyCommandCodeSearchSelection treats a pre-set commandcode pin as nothing to restore', () => {
  // The field already read `commandcode` before we ever touched it (manual
  // `searchProvider: commandcode` pin or a surviving runtime): disabling is a
  // no-op rather than a guess at the factory default. A no-op means the field
  // keeps the user's OWN id — writing `undefined` back would hand the
  // selection to dsh-web's auto-select, where a second usable provider turns
  // every later search into `WEB_PROVIDER_AMBIGUOUS`.
  const web = { searchProviderId: COMMANDCODE_SEARCH_PROVIDER_ID } as unknown as Parameters<typeof applyCommandCodeSearchSelection>[0]
  const state = commandCodeSearchSelection()

  applyCommandCodeSearchSelection(web, state, true)
  applyCommandCodeSearchSelection(web, state, false)
  assert.equal(
    (web as unknown as { searchProviderId?: string }).searchProviderId,
    COMMANDCODE_SEARCH_PROVIDER_ID,
  )
})

test('applyCommandCodeSearchSelection still clears a field that never read our id', () => {
  // The mirror image: the field was UNSET (auto-select) when we took over, so
  // disabling must give that back — leaving `commandcode` in place there would
  // keep Command Code serving with the toggle off.
  const web = {} as unknown as Parameters<typeof applyCommandCodeSearchSelection>[0]
  const state = commandCodeSearchSelection()

  applyCommandCodeSearchSelection(web, state, true)
  assert.equal((web as unknown as { searchProviderId?: string }).searchProviderId, COMMANDCODE_SEARCH_PROVIDER_ID)
  applyCommandCodeSearchSelection(web, state, false)
  assert.equal((web as unknown as { searchProviderId?: string }).searchProviderId, undefined)
})

test('applyCommandCodeSearchSelection never throws on a hardened runtime', () => {
  const frozen = Object.freeze({}) as unknown as Parameters<typeof applyCommandCodeSearchSelection>[0]
  const state = commandCodeSearchSelection()
  // In strict-mode ESM assignment to a frozen object throws inside; the
  // helper must swallow it and degrade to registered-but-unselected.
  applyCommandCodeSearchSelection(frozen, state, true)
  applyCommandCodeSearchSelection(frozen, state, false)
})


/**
 * One config object shaped the way dsh 0.1.7's loader hands it to `apply()`:
 * every marked field is a frozen `{ get() }` reference whose value the loader
 * commits in place. `plain` is the reference-carrying object; `set()` stands in
 * for a settings write, and the caller then dispatches `loader/volatile-update`
 * exactly as `cordis-plugin-loader` does.
 */
/**
 * Dispatch `loader/volatile-update`, the event `cordis-plugin-loader` raises on
 * the owning fiber after committing a settings write in place. Typed events do
 * not declare it (the loader is not a peer of this bundle), so the dispatch goes
 * through a structural view, exactly as the plugin's own listener does.
 */
function emitVolatileUpdate(ctx: unknown): void {
  (ctx as { emit(event: string, paths: readonly (readonly string[])[]): void })
    .emit('loader/volatile-update', [['webSearch']])
}

function volatileProbeConfig(values: Record<string, unknown>): {
  plain: Record<string, unknown>
  set(field: string, value: unknown): void
} {
  const live = new Map(Object.entries(values))
  const plain: Record<string, unknown> = {}
  for (const field of live.keys()) {
    plain[field] = Object.freeze({ get: () => live.get(field) })
  }
  return {
    plain,
    set(field, value) {
      live.set(field, value)
    },
  }
}

test('host apply() hands the selection back to the prior backend when webSearch turns off', async () => {
  // End-to-end over the real plugin boot: the `web` service starts with a
  // sibling's pin (`modsearch`, as its own cordis patch would leave it).
  // Booting with webSearch on displaces it; flipping the volatile `webSearch`
  // field and dispatching `loader/volatile-update` — the event dsh 0.1.7's
  // loader raises after committing a settings write in place — restores it,
  // which is the exact issue #26 flow.
  const { Context } = await import('@deepseek-ai/cordis')
  const { apply } = await import('../src/index.ts')
  const { WebRuntime } = await import('@deepseek-ai/dsh-web')

  const ctx = new Context()
  ctx.provide('llm', {
    registerConfigurableProviders: () => {},
    registerAdapter: () => {},
  })
  await ctx.plugin(WebRuntime, { searchProvider: 'modsearch' })

  // A settings service stub: the plugin declares its auto-form policy on it,
  // and this records that declaration.
  const policies: unknown[] = []
  ctx.provide('settings', {
    configure: (presentation: unknown) => {
      policies.push(presentation)
      return () => {}
    },
  })

  const config = volatileProbeConfig({ webSearch: true })
  apply(ctx, config.plain as never)

  // The settings inject resolves on its own tick; the policy declaration is
  // an effect on the settings child, so let it run before asserting.
  await new Promise((resolve) => setImmediate(resolve))
  const web = ctx.get('web') as unknown as { searchProviderId?: string }
  assert.deepEqual(policies, [{ auto: false }])
  assert.equal(web.searchProviderId, 'commandcode')

  // The loader commits a settings write in place and notifies the owning
  // fiber; the plugin re-applies the facts config alone cannot carry.
  config.set('webSearch', false)
  emitVolatileUpdate(ctx)
  assert.equal(web.searchProviderId, 'modsearch')

  // And back on: the remembered backend is displaced again.
  config.set('webSearch', true)
  emitVolatileUpdate(ctx)
  assert.equal(web.searchProviderId, 'commandcode')
})

test('host apply() leaves a pre-existing commandcode pin alone when webSearch turns off', async () => {
  // The durable selection this repo documents: the profile pins
  // `searchProvider: commandcode` itself (or exports
  // `$DSH_WEB_SEARCH_PROVIDER=commandcode`). Turning the plugin's toggle off
  // must NOT clear that pin: dsh-web reads a cleared `searchProviderId` as
  // auto-select, and with a second usable provider registered (the shipped
  // `deepseek-official` is usable whenever a DeepSeek key resolves) EVERY
  // later search throws `WEB_PROVIDER_AMBIGUOUS`. The plugin's own provider
  // stays registered either way, so leaving the field alone is the only
  // outcome that keeps the user's own configuration intact.
  const { Context } = await import('@deepseek-ai/cordis')
  const { apply } = await import('../src/index.ts')
  const { WebRuntime } = await import('@deepseek-ai/dsh-web')

  const ctx = new Context()
  ctx.provide('llm', {
    registerConfigurableProviders: () => {},
    registerAdapter: () => {},
  })
  await ctx.plugin(WebRuntime, { searchProvider: 'commandcode' })

  const config = volatileProbeConfig({ webSearch: true })
  apply(ctx, config.plain as never)

  const web = ctx.get('web') as unknown as { searchProviderId?: string }
  assert.equal(web.searchProviderId, 'commandcode')

  config.set('webSearch', false)
  emitVolatileUpdate(ctx)
  assert.equal(web.searchProviderId, 'commandcode')
})
