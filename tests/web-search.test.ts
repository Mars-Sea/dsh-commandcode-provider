/**
 * Web-search provider tests (node:test). Run with `npm test`.
 *
 * The first half drives `CommandCodeSearchProvider` against a stubbed fetch,
 * pinning the `/alpha/web-search` wire contract (POST body, `Authorization:
 * Bearer` + `x-command-code-version` headers), the result mapping and the
 * failure taxonomy — no engine involved.
 *
 * The second half covers the SELECTION seam on the REAL rc.2+ engine:
 * `boot()` mounts a real Loader over a throwaway profile directory with the
 * real `@deepseek-ai/dsh-config-editor` and `@deepseek-ai/dsh-settings`, and a
 * real `WebRuntime` that resolves `searchProvider` per call. Assertions read
 * that runtime's `config.searchProvider.get()` — the value `search()` actually
 * uses — plus the profile document the write lands in. A regression that writes
 * a field the running engine does not read fails these tests, which is exactly
 * what the rc.2 breakage did under the previous fixture.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'
import type { WebRuntime } from '@deepseek-ai/dsh-web'
import {
  CommandCodeSearchProvider, SEARCH_MAX_ATTEMPTS, createCommandCodeSearchSelection, searchRetryDelayMs, searchRetryWait,
} from '../src/web-search.ts'
import type { WebSelectionSettings } from '../src/web-search.ts'
import { volatileWrite } from '../src/config-volatile.ts'
import { COMMAND_CODE_CLI_VERSION } from '../src/adapter.ts'

test('搜索把已捕获的网关交给账号解析，等待后不读取新地址', async () => {
  let base = 'https://search-scope-a.invalid'
  let scoped = '', sent = ''
  const provider = new CommandCodeSearchProvider({
    apiBase: () => base,
    resolveKey: async captured => { scoped = captured ?? ''; base = 'https://search-scope-b.invalid'; return 'synthetic-key' },
    fetchImpl: (async input => { sent = String(input); return new Response(JSON.stringify({ results: [] })) }) as typeof fetch,
  })
  await provider.search({ query: '合成查询' })
  assert.equal(scoped, 'https://search-scope-a.invalid')
  assert.equal(sent, 'https://search-scope-a.invalid/alpha/web-search')
})

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

/** Node's `fetch` rejection shape: a bare `TypeError` with the real code one level down. */
function fetchFailure(code: string): TypeError {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error(`synthetic ${code}`), { code }),
  })
}

test('retries a fetch that got no response and resolves the key only once', async () => {
  // issue #117: one transient connection failure used to fail the whole
  // multi-query batch, and the same query succeeded when retried by hand.
  let calls = 0
  let resolves = 0
  const stub = makeFetch(() => {
    calls += 1
    if (calls === 1) throw fetchFailure('UND_ERR_CONNECT_TIMEOUT')
    return asResponse(okBody([{ title: 'T', url: 'https://a.example', snippet: 'S' }]))
  })
  const provider = new CommandCodeSearchProvider({
    resolveKey: async () => { resolves += 1; return 'cc-key-123' },
    apiBase: () => 'https://api.commandcode.ai',
    fetchImpl: stub.fetchImpl,
    retryWait: async () => {},
  })
  const result = await provider.search({ query: 'q' })

  assert.equal(calls, 2)
  assert.equal(resolves, 1, '账号解析只在进入重试前做一次')
  assert.deepEqual(result.sources, [{ url: 'https://a.example', title: 'T', snippet: 'S' }])
})

test('stops at SEARCH_MAX_ATTEMPTS and names the cause, target and attempt count', async () => {
  let calls = 0
  const stub = makeFetch(() => {
    calls += 1
    throw fetchFailure('UND_ERR_CONNECT_TIMEOUT')
  })
  const provider = new CommandCodeSearchProvider({
    resolveKey: async () => 'cc-key-123',
    apiBase: () => 'https://api.commandcode.ai',
    fetchImpl: stub.fetchImpl,
    retryWait: async () => {},
  })
  await assert.rejects(
    () => provider.search({ query: 'q' }),
    (error: unknown) => {
      const e = error as { code?: string; message?: string }
      assert.equal(e.code, 'WEB_PROVIDER_ERROR')
      assert.equal(calls, SEARCH_MAX_ATTEMPTS)
      assert.match(e.message ?? '', /Command Code web search request failed: fetch failed/)
      assert.match(e.message ?? '', /连接超时（UND_ERR_CONNECT_TIMEOUT）/)
      assert.match(e.message ?? '', /目标 https:\/\/api\.commandcode\.ai/)
      assert.match(e.message ?? '', new RegExp(`已尝试 ${SEARCH_MAX_ATTEMPTS} 次`))
      return true
    },
  )
})

test('does not retry once an HTTP status arrived: a 403 is an answer, not a blip', async () => {
  let calls = 0
  const stub = makeFetch(() => {
    calls += 1
    return asResponse({ status: 403, body: { error: 'upgrade_required' } })
  })
  const provider = new CommandCodeSearchProvider({
    resolveKey: async () => 'cc-key-123',
    apiBase: () => 'https://api.commandcode.ai',
    fetchImpl: stub.fetchImpl,
    retryWait: async () => { throw new Error('a received response must never be retried') },
  })
  await assert.rejects(
    () => provider.search({ query: 'q' }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'WEB_PROVIDER_ERROR')
      return true
    },
  )
  assert.equal(calls, 1)
})

test('an upstream search timeout stays a WEB_PROVIDER_ERROR and is not converted to a model token limit', async () => {
  let calls = 0
  const provider = new CommandCodeSearchProvider({
    resolveKey: async () => 'synthetic-key',
    apiBase: () => 'https://api.commandcode.ai',
    fetchImpl: (async () => {
      calls += 1
      return Response.json({ error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Request timed out performing the search. Please try again later.',
      } }, { status: 504 })
    }) as typeof fetch,
    retryWait: async () => { throw new Error('a received response must never be retried') },
  })
  await assert.rejects(() => provider.search({ query: 'q' }), (error: unknown) => {
    const e = error as { code?: string; message?: string }
    assert.equal(e.code, 'WEB_PROVIDER_ERROR')
    assert.equal(e.message, 'Command Code web search failed (HTTP 504): INTERNAL_SERVER_ERROR — Request timed out performing the search. Please try again later.')
    return true
  })
  assert.equal(calls, 1)
})

test('an abort during the retry wait stops it instead of making another request', async () => {
  let calls = 0
  const stub = makeFetch(() => { calls += 1; throw fetchFailure('ECONNRESET') })
  const controller = new AbortController()
  let waitStarted!: () => void
  const started = new Promise<void>(resolve => { waitStarted = resolve })
  const provider = new CommandCodeSearchProvider({
    resolveKey: async () => 'cc-key-123',
    apiBase: () => 'https://api.commandcode.ai',
    fetchImpl: stub.fetchImpl,
    // Delegate to the production wait and signal when it is armed, so the test
    // never races a real 500 ms timer against a short abort timer.
    retryWait: async (delayMs, signal) => {
      waitStarted()
      return searchRetryWait(delayMs, signal)
    },
  })
  const pending = provider.search({ query: 'q' }, controller.signal)
  await started
  controller.abort()
  await assert.rejects(
    () => pending,
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'WEB_ABORTED')
      return true
    },
  )
  assert.equal(calls, 1, '取消后不得再发请求')
})

test('the default retry wait (no injected seam) is abortable', { timeout: 5000 }, async (t) => {
  // The injected-seam test above proves the cancellation semantics of the
  // production wait; this one keeps the `retryWait ?? searchRetryWait` default
  // itself covered. Timers are faked so the 500 ms wait cannot fire, and a
  // captured real timer guards against a regression that would hang instead.
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const stub = makeFetch(() => { calls += 1; throw fetchFailure('ECONNRESET') })
  const provider = new CommandCodeSearchProvider({
    resolveKey: async () => 'cc-key-123',
    apiBase: () => 'https://api.commandcode.ai',
    fetchImpl: stub.fetchImpl,
  })
  const controller = new AbortController()
  const pending = provider.search({ query: 'q' }, controller.signal)
  // Let the first rejection reach the default wait and arm the faked timer.
  await new Promise(resolve => setImmediate(resolve))
  let guardTimer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<never>((_, reject) => {
    guardTimer = realSetTimeout(() => reject(new Error('默认等待未响应取消')), 1000)
  })
  try {
    controller.abort()
    await assert.rejects(
      () => Promise.race([pending, guard]),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'WEB_ABORTED')
        return true
      },
    )
  } finally {
    if (guardTimer !== undefined) realClearTimeout(guardTimer)
  }
  assert.equal(calls, 1, '取消后不得再发请求')
})

test('retry backoff doubles from 500 ms and stays inside the jitter bound', () => {
  for (let round = 0; round < 50; round += 1) {
    const first = searchRetryDelayMs(1)
    const second = searchRetryDelayMs(2)
    assert.ok(first >= 400 && first <= 600, `first wait ${first}`)
    assert.ok(second >= 800 && second <= 1200, `second wait ${second}`)
  }
})

test('the retry wait receives the 500 ms then 1 s sequence, not a fixed delay', async () => {
  let calls = 0
  const delays: number[] = []
  const stub = makeFetch(() => { calls += 1; throw fetchFailure('ECONNRESET') })
  const provider = new CommandCodeSearchProvider({
    resolveKey: async () => 'cc-key-123',
    apiBase: () => 'https://api.commandcode.ai',
    fetchImpl: stub.fetchImpl,
    retryWait: async (delayMs) => { delays.push(delayMs) },
  })
  await assert.rejects(() => provider.search({ query: 'q' }))
  assert.equal(calls, SEARCH_MAX_ATTEMPTS)
  assert.equal(delays.length, SEARCH_MAX_ATTEMPTS - 1)
  assert.ok(delays[0]! >= 400 && delays[0]! <= 600, `first wait ${delays[0]}`)
  assert.ok(delays[1]! >= 800 && delays[1]! <= 1200, `second wait ${delays[1]}`)
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

// ───────────────────────────────────────────────────────────────────────────
// 选择契约（0.2.1-rc.2）：真实 Loader + 真实 settings + 真实 WebRuntime
// ───────────────────────────────────────────────────────────────────────────

/** 记录日志行的假 sink：「当前后端由官方设置接管」这类事实必须可断言。 */
interface LogSink {
  info: string[]
  warn: string[]
  logger: { info(message: string): void; warn(message: string): void }
}

function logSink(): LogSink {
  const info: string[] = []
  const warn: string[] = []
  return { info, warn, logger: { info: (message) => { info.push(message) }, warn: (message) => { warn.push(message) } } }
}

/**
 * 一条 settings 描述行里本测试读到的字段。真实 `describe()` 返回宿主侧未脱敏
 * 的完整描述符；这里只声明被断言到的成员。
 */
interface SelectionRow {
  ns: string
  value?: Record<string, unknown> | undefined
  base?: Record<string, unknown> | undefined
  user?: Record<string, unknown> | undefined
  revision?: number | undefined
}

/**
 * 运行中的 `WebRuntime` 面：0.2.1-rc.2 把选择存成构造参数属性 `config`，其中
 * `searchProvider` 是每次 `search()` 都读一次的易变引用。这里按运行时形状读取，
 * 断言落在 `search()` 真正会用的那个值上。
 */
function runtimeConfig(web: WebRuntime): { searchProvider: { get(): unknown } } {
  return (web as unknown as { config: { searchProvider: { get(): unknown } } }).config
}

/** `search()` 会选中的后端 id；字段未设置时为 `undefined`。 */
function runtimeSelection(web: WebRuntime): string | undefined {
  const value: unknown = runtimeConfig(web).searchProvider.get()
  return typeof value === 'string' ? value : undefined
}

/** 真实 rc.2 选择沙箱。 */
interface SelectionSandbox {
  ctx: Context
  web: WebRuntime
  /** 真实 settings 服务（结构性视图；测试可再包一层计数/故障）。 */
  settings(): WebSelectionSettings
  /** 真实 settings 服务的完整面，用来扮演「官方网页搜索设置页」的写入方。 */
  admin: WebSelectionSettings & { describe(): SelectionRow[] }
  /** profile patch 文档内容（`ConfigEditor` 写入的那个文件）。 */
  patch(): Promise<string>
  /** 载入的 `web` 条目 fiber 与易变引用，用于证明写入不会重挂载。 */
  identity(): { fiber: unknown; ref: unknown }
  dispose(): Promise<void>
}

/** 把一条 `- insert:` 行渲染成 YAML；值都是标量，够本测试用。 */
function insertRow(id: string, name: string, config?: Record<string, unknown>): string {
  const lines = ['- insert:', `    - id: ${id}`, `      name: "${name}"`]
  if (config !== undefined && Object.keys(config).length > 0) {
    lines.push('      config:')
    for (const [key, value] of Object.entries(config)) lines.push(`        ${key}: ${String(value)}`)
  }
  return `${lines.join('\n')}\n`
}

/** 把一条 profile 用户层覆盖渲染成 YAML（`ConfigEditor` 写出来的形状）。 */
function userPatch(id: string, name: string, config: Record<string, unknown>): string {
  const lines = [`- id: ${id}`, `  name: "${name}"`, '  config:']
  for (const [key, value] of Object.entries(config)) lines.push(`    ${key}: ${String(value)}`)
  return `${lines.join('\n')}\n`
}

/**
 * 起一个真实 0.2.1-rc.2 选择沙箱。
 *
 * 组成：真实 `boot()` + 真实 Loader（根 Include 上叠一层伪 bundle 补丁）+
 * 真实 `@deepseek-ai/dsh-config-editor` + 真实 `@deepseek-ai/dsh-settings` +
 * 真实 `WebRuntime`。伪 bundle 提供 `web` 条目的组合基值，等价于 `dsh-base`
 * 里那一行；`cordis.patch.yml` 既是 `ConfigEditor` 写入的文档，也是
 * `loadProfileDirectory` 读取的文件名，所以断言能直接看到用户层。
 *
 * @param options - `base` 是该条目的组合配置，默认即 `dsh-base` 出厂的那两个值；
 * 显式传 `{}` 表示两层都没有配置。`user` 预置 profile 用户层覆盖（例如上一次运行
 * 留下的 `commandcode`）。
 */
async function selectionSandbox(
  options: { base?: Record<string, unknown>; user?: Record<string, unknown> } = {},
): Promise<SelectionSandbox> {
  const base = options.base ?? { searchProvider: 'deepseek-official', fetchProvider: 'http' }
  const root = fileURLToPath(new URL('..', import.meta.url))
  const { boot, readProfilePatches } = await import('@deepseek-ai/dsh-app-boot')
  const ConfigEditor = (await import('@deepseek-ai/dsh-config-editor')).default
  const SettingsForms = (await import('@deepseek-ai/dsh-settings')).default
  const { WebRuntime } = await import('@deepseek-ai/dsh-web')

  const home = await mkdtemp(join(tmpdir(), 'dsh-commandcode-selection-'))
  const dir = join(home, 'profiles', 'probe')
  const bundleDir = join(dir, 'node_modules', 'probe-base')
  await mkdir(bundleDir, { recursive: true })
  await writeFile(join(bundleDir, 'package.json'), JSON.stringify({
    name: 'probe-base', version: '0.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  await writeFile(join(bundleDir, 'cordis.patch.yml'), insertRow('web', 'cordis:web', base))
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-probe', dsh: { profile: { bundles: ['probe-base'] } },
  }))
  const patchPath = join(dir, 'cordis.patch.yml')
  await writeFile(patchPath, options.user === undefined ? '[]\n' : userPatch('web', 'cordis:web', options.user))
  const configPath = join(dir, 'cordis.yml')
  await writeFile(configPath, '[]\n')

  const profileContext = {
    name: 'probe', dir, patchPath, installAnchor: join(root, 'package.json'), cwd: root, home,
    startedBundles: ['probe-base'], overlays: [], telemetryDisabledEnv: undefined,
  }
  const ctx = await boot('probe', configPath, readProfilePatches('probe', profileContext as never), (inner: Context) => {
    inner.loader.builtins.web = WebRuntime
  })
  ctx.provide('profileContext', profileContext as never)
  // 插件声明 inject = ['llm']；这里只提供它 boot 期真正调用的两个入口。
  ctx.provide('llm', { registerConfigurableProviders: () => {}, registerAdapter: () => {} } as never)
  await ctx.plugin(ConfigEditor)
  await ctx.plugin(SettingsForms)
  await new Promise((resolve) => setImmediate(resolve))

  const web = ctx.get('web') as WebRuntime
  const admin = ctx.get('settings') as unknown as SelectionSandbox['admin']
  const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === 'web')

  return {
    ctx,
    web,
    settings: () => admin,
    admin,
    patch: () => readFile(patchPath, 'utf8'),
    identity: () => ({ fiber: entry?.fiber, ref: runtimeConfig(web).searchProvider }),
    dispose: async () => {
      await ctx.fiber.dispose()
      await rm(home, { recursive: true, force: true })
    },
  }
}

/**
 * A config object shaped the way the rc.2 loader hands it to `apply()`: every
 * field marked volatile in the schema is a frozen `{ get() }` reference whose
 * value the loader commits in place, and `set()` stands in for that commit.
 */
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

/**
 * 把真实插件挂到沙箱上：`apply()` 本身不变，只是挂在子 fiber 上，于是
 * `fiber.dispose()` 就是生产里的卸载路径。
 */
async function mountHost(
  sandbox: SelectionSandbox,
  values: Record<string, unknown>,
): Promise<{ fiber: { dispose(): Promise<void> | void }; config: { plain: Record<string, unknown>; set(field: string, value: unknown): void } }> {
  const { apply } = await import('../src/index.ts')
  const config = volatileProbeConfig(values)
  const fiber = await sandbox.ctx.plugin({
    name: 'probe-commandcode',
    apply: (inner: Context) => {
      apply(inner, config.plain as never)
    },
  })
  return { fiber, config }
}

/**
 * 通知 `llm-commandcode` 自己的条目：loader 在易变提交后向 OWNING fiber 派发
 * `loader/volatile-update`（`Context.filter` 只放行那一个 fiber）。
 *
 * 测试里的插件挂在手工 ctx 上、没有真实条目 fiber，因此在插件自己的 context 上
 * 派发等价事件。这不覆盖「跨条目」方向：官方设置页改了 `web` 条目这件事一律用
 * 真实 settings 写入构造（见沙箱的 `admin`），不靠伪造事件。
 */
function notifyOwnEntry(ctx: unknown): void {
  (ctx as { emit(event: string, paths: readonly (readonly string[])[]): void })
    .emit('loader/volatile-update', [['webSearch']])
}

/** 轮询等待异步写入落定（真实文件写入 + loader 提交跨多个 tick）。 */
async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(message)
}

/** 给可能排队的异步写入一个落定窗口；只用于「不应发生」的断言。 */
async function quietWindow(): Promise<void> {
  for (let tick = 0; tick < 4; tick += 1) await new Promise((resolve) => setTimeout(resolve, 15))
}

test('volatileWrite 直写运行中的易变引用，读回不符或协议缺失时报失败', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { WebRuntime } = await import('@deepseek-ai/dsh-web')
  const ctx = new Context()
  try {
    await ctx.plugin(WebRuntime, { searchProvider: 'modsearch' })
    const ref: unknown = runtimeConfig(ctx.get('web') as WebRuntime).searchProvider
    assert.equal(volatileWrite(ref, 'commandcode'), true)
    assert.equal((ref as { get(): unknown }).get(), 'commandcode')
    assert.equal(volatileWrite(ref, undefined), true)
    assert.equal((ref as { get(): unknown }).get(), undefined)
  } finally {
    await ctx.fiber.dispose()
  }
  // 非引用、以及「冻结但缺少写入协议」的引用：一律失败而不是假装写入成功。
  assert.equal(volatileWrite({}, 'x'), false)
  assert.equal(volatileWrite(null, 'x'), false)
  assert.equal(volatileWrite(Object.freeze({ get: () => 'old' }), 'new'), false)
  const hostile = Object.freeze({
    get: () => 'old',
    [Symbol.for('cosmokit.volatile.write')]: () => { throw new Error('协议拒绝写入') },
  })
  assert.equal(volatileWrite(hostile, 'new'), false)
})

test('rc.2 契约自检：settings 写入直接改运行中的引用，且不重挂载 web 条目', async () => {
  // 这条用例钉的是本插件依赖的上游机制本身：官方 settings 写盘 → loader 原地
  // 提交易变引用（fiber 与引用标识都不变）→ 下次 search 读到新值。
  const sandbox = await selectionSandbox()
  try {
    const runtime = runtimeConfig(sandbox.web)
    const before = sandbox.identity()
    assert.equal(runtimeSelection(sandbox.web), 'deepseek-official')

    await sandbox.admin.update('web', { searchProvider: 'commandcode' })
    assert.equal(runtime.searchProvider.get(), 'commandcode')
    assert.equal(Object.is(sandbox.identity().fiber, before.fiber), true)
    assert.equal(Object.is(sandbox.identity().ref, before.ref), true)
    assert.match(await sandbox.patch(), /searchProvider: commandcode/)

    // 归还为组合基值：覆盖整行被删除，而不是留一个等值副本。
    await sandbox.admin.replace('web', { searchProvider: 'deepseek-official', fetchProvider: 'http' })
    assert.equal(runtime.searchProvider.get(), 'deepseek-official')
    assert.equal(await sandbox.patch(), '[]\n')
  } finally {
    await sandbox.dispose()
  }
})

test('选择端口：夺取写盘、关闭归还组合基值、再打开重新夺取', async () => {
  const sandbox = await selectionSandbox()
  const sink = logSink()
  try {
    const handle = createCommandCodeSearchSelection({ web: sandbox.web, settings: () => sandbox.settings(), logger: sink.logger })
    assert.equal(runtimeSelection(sandbox.web), 'deepseek-official')

    handle.apply(true)
    await handle.settled()
    assert.equal(runtimeSelection(sandbox.web), 'commandcode')
    assert.match(await sandbox.patch(), /searchProvider: commandcode/)
    assert.deepEqual(handle.state, {
      owner: true, preexisting: false, foreign: undefined, displaced: 'deepseek-official',
    })

    handle.apply(false)
    await handle.settled()
    assert.equal(runtimeSelection(sandbox.web), 'deepseek-official')
    assert.equal(await sandbox.patch(), '[]\n')
    assert.equal(handle.state.owner, false)

    handle.apply(true)
    await handle.settled()
    assert.equal(runtimeSelection(sandbox.web), 'commandcode')
    assert.equal(sink.warn.length, 0)
  } finally {
    await sandbox.dispose()
  }
})

test('他人显式 pin（官方设置页写的 deepseek-search-api）不被夺取，状态可读且只记一次 info', async () => {
  const sandbox = await selectionSandbox()
  const sink = logSink()
  try {
    // 官方「网页搜索」设置页写的就是这个字段、这个服务。
    await sandbox.admin.update('web', { searchProvider: 'deepseek-search-api', fetchProvider: 'deepseek-fetch-api' })
    const handle = createCommandCodeSearchSelection({ web: sandbox.web, settings: () => sandbox.settings(), logger: sink.logger })

    handle.apply(true)
    await handle.settled()
    assert.equal(runtimeSelection(sandbox.web), 'deepseek-search-api')
    assert.equal(handle.state.owner, false)
    assert.equal(handle.state.foreign, 'deepseek-search-api')
    assert.equal(sink.warn.length, 0)
    assert.equal(sink.info.length, 1)
    assert.match(sink.info[0]!, /deepseek-search-api/)

    // 关闭同样不能动它：这个选择从来不是本插件写进去的。
    handle.apply(false)
    await handle.settled()
    assert.equal(runtimeSelection(sandbox.web), 'deepseek-search-api')
    assert.match(await sandbox.patch(), /searchProvider: deepseek-search-api/)
  } finally {
    await sandbox.dispose()
  }
})

test('组合基值已经是 commandcode 时记作 preexisting：关闭既不写盘也不改运行值', async () => {
  const sandbox = await selectionSandbox({ base: { searchProvider: 'commandcode', fetchProvider: 'http' } })
  const sink = logSink()
  try {
    const handle = createCommandCodeSearchSelection({ web: sandbox.web, settings: () => sandbox.settings(), logger: sink.logger })
    handle.apply(true)
    await handle.settled()
    assert.equal(handle.state.owner, false)
    assert.equal(handle.state.preexisting, true)
    assert.equal(runtimeSelection(sandbox.web), 'commandcode')

    handle.apply(false)
    await handle.settled()
    assert.equal(runtimeSelection(sandbox.web), 'commandcode')
    assert.equal(await sandbox.patch(), '[]\n')
  } finally {
    await sandbox.dispose()
  }
})

test('组合未设置 searchProvider 时，归还让字段回到未设置而不是写一个副本', async () => {
  const sandbox = await selectionSandbox({ base: { fetchProvider: 'http' } })
  try {
    const handle = createCommandCodeSearchSelection({ web: sandbox.web, settings: () => sandbox.settings(), logger: logSink().logger })
    assert.equal(runtimeSelection(sandbox.web), undefined)

    handle.apply(true)
    await handle.settled()
    assert.equal(runtimeSelection(sandbox.web), 'commandcode')
    assert.equal(handle.state.displaced, undefined)

    handle.apply(false)
    await handle.settled()
    assert.equal(runtimeSelection(sandbox.web), undefined)
    assert.equal(await sandbox.patch(), '[]\n')
  } finally {
    await sandbox.dispose()
  }
})

test('从未夺取时关闭是空操作', async () => {
  const sandbox = await selectionSandbox()
  try {
    const before = await sandbox.patch()
    const handle = createCommandCodeSearchSelection({ web: sandbox.web, settings: () => sandbox.settings(), logger: logSink().logger })
    handle.apply(false)
    await handle.settled()
    assert.equal(runtimeSelection(sandbox.web), 'deepseek-official')
    assert.equal(await sandbox.patch(), before)
  } finally {
    await sandbox.dispose()
  }
})

test('settings 写入抛错时降级到内存直写：不抛、记一条 warn、profile 不变', async () => {
  const sandbox = await selectionSandbox()
  const sink = logSink()
  try {
    const failing: WebSelectionSettings = {
      describe: () => sandbox.admin.describe(),
      update: () => Promise.reject(new Error('注入的设置写入失败')),
      replace: () => Promise.reject(new Error('注入的设置写入失败')),
    }
    const handle = createCommandCodeSearchSelection({ web: sandbox.web, settings: () => failing, logger: sink.logger })

    handle.apply(true)
    await handle.settled()
    assert.equal(runtimeSelection(sandbox.web), 'commandcode')
    assert.equal(await sandbox.patch(), '[]\n')
    assert.equal(sink.warn.length, 1)
    assert.match(sink.warn[0]!, /falling back to the running config/)

    handle.apply(false)
    await handle.settled()
    assert.equal(runtimeSelection(sandbox.web), 'deepseek-official')
  } finally {
    await sandbox.dispose()
  }
})

test('settings 服务缺失时只走内存路径：夺取与归还都作用于运行中的引用', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { WebRuntime } = await import('@deepseek-ai/dsh-web')
  const ctx = new Context()
  const sink = logSink()
  try {
    await ctx.plugin(WebRuntime, { searchProvider: 'modsearch', fetchProvider: 'http' })
    const web = ctx.get('web') as WebRuntime
    const handle = createCommandCodeSearchSelection({ web, settings: () => undefined, logger: sink.logger })

    handle.apply(true)
    await handle.settled()
    assert.equal(runtimeSelection(web), 'commandcode')

    handle.apply(false)
    await handle.settled()
    assert.equal(runtimeSelection(web), 'modsearch')
    assert.equal(sink.warn.length, 0)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('settings 不可用时重复打开不丢失被顶掉的后端', async () => {
  // 内存路径上没有用户层 pin，`view.pinned` 恒为 undefined，于是「已经等于
  // 目标值」这个观察必须靠 `state.owner` 保住所有权。
  // 真实宿主里配置每次 reload／易变提交都会重跑 effect（重复 apply(true)），
  // 一旦第二次打开把自己写的值误判成部署基值，关闭就不再归还，搜索永久卡在
  // commandcode 上。
  const { Context } = await import('@deepseek-ai/cordis')
  const { WebRuntime } = await import('@deepseek-ai/dsh-web')
  const ctx = new Context()
  try {
    await ctx.plugin(WebRuntime, { searchProvider: 'modsearch', fetchProvider: 'http' })
    const web = ctx.get('web') as WebRuntime
    const handle = createCommandCodeSearchSelection({ web, settings: () => undefined, logger: logSink().logger })

    handle.apply(true)
    await handle.settled()
    assert.equal(runtimeSelection(web), 'commandcode')

    handle.apply(true)
    await handle.settled()
    assert.equal(runtimeSelection(web), 'commandcode')

    handle.apply(false)
    await handle.settled()
    assert.equal(runtimeSelection(web), 'modsearch')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('release() 不写盘：只把运行中的引用交还，profile 覆盖保持不动', async () => {
  const sandbox = await selectionSandbox()
  try {
    const counters = { update: 0, replace: 0 }
    const counting: WebSelectionSettings = {
      describe: () => sandbox.admin.describe(),
      update: (ns, patch) => { counters.update += 1; return sandbox.admin.update(ns, patch) },
      replace: (ns, section) => { counters.replace += 1; return sandbox.admin.replace(ns, section) },
    }
    const handle = createCommandCodeSearchSelection({ web: sandbox.web, settings: () => counting, logger: logSink().logger })
    handle.apply(true)
    await handle.settled()
    assert.equal(counters.update, 1)
    const persisted = await sandbox.patch()

    handle.release()
    await quietWindow()
    // 卸载路径刻意不碰 profile：写盘需要 ACTIVE 的条目 fiber 和 HMR 独占锁。
    // 代价是文档里的覆盖会留到下次启动，交由下次 boot 重新对齐。
    assert.equal(counters.update, 1)
    assert.equal(counters.replace, 0)
    assert.equal(await sandbox.patch(), persisted)
    assert.equal(runtimeSelection(sandbox.web), 'deepseek-official')

    // 释放后的调用不再排任何写入。
    handle.apply(true)
    await quietWindow()
    assert.equal(counters.update, 1)
  } finally {
    await sandbox.dispose()
  }
})

test('重启后：用户层里的 commandcode 认作本插件的选择，关闭时整行归还组合基值', async () => {
  // 只有本插件会写这个 id，所以用户层里的 `commandcode` 必然来自上一次运行或用户
  // 手工 pin；两种情况下「关闭」都应当把字段交还给组合基值，否则 profile 会永远
  // 钉着 Command Code（那条命令的注释承诺的正是「恢复原搜索后端」）。
  const sandbox = await selectionSandbox({ user: { searchProvider: 'commandcode', fetchProvider: 'http' } })
  try {
    assert.equal(runtimeSelection(sandbox.web), 'commandcode')
    const persisted = await sandbox.patch()

    const handle = createCommandCodeSearchSelection({ web: sandbox.web, settings: () => sandbox.settings(), logger: logSink().logger })
    handle.apply(true)
    await handle.settled()
    assert.equal(handle.state.owner, true)
    assert.equal(handle.state.preexisting, false)
    assert.equal(handle.state.displaced, 'deepseek-official')
    assert.equal(await sandbox.patch(), persisted)

    handle.apply(false)
    await handle.settled()
    assert.equal(runtimeSelection(sandbox.web), 'deepseek-official')
    assert.equal(await sandbox.patch(), '[]\n')
  } finally {
    await sandbox.dispose()
  }
})

test('host apply()：webSearch 开夺取、关归还、再开重新夺取', async () => {
  const sandbox = await selectionSandbox()
  try {
    const { fiber, config } = await mountHost(sandbox, { webSearch: true })
    await waitFor(() => runtimeSelection(sandbox.web) === 'commandcode', 'boot 时没有夺取 commandcode')
    assert.match(await sandbox.patch(), /searchProvider: commandcode/)

    config.set('webSearch', false)
    notifyOwnEntry(sandbox.ctx)
    await waitFor(() => runtimeSelection(sandbox.web) === 'deepseek-official', '关闭后没有归还组合基值')
    assert.equal(await sandbox.patch(), '[]\n')

    config.set('webSearch', true)
    notifyOwnEntry(sandbox.ctx)
    await waitFor(() => runtimeSelection(sandbox.web) === 'commandcode', '重新打开后没有再次夺取')

    await fiber.dispose()
  } finally {
    await sandbox.dispose()
  }
})

test('host apply()：组合已 pin commandcode 时，关闭不动它', async () => {
  // 这条路径不能用 undefined 归还：dsh-web 会把「未设置」读成自动选择，而第二个
  // 可用提供方一出现，之后每次搜索都是 WEB_PROVIDER_AMBIGUOUS（issue #26）。
  const sandbox = await selectionSandbox({ base: { searchProvider: 'commandcode', fetchProvider: 'http' } })
  try {
    const { fiber, config } = await mountHost(sandbox, { webSearch: true })
    await quietWindow()
    assert.equal(runtimeSelection(sandbox.web), 'commandcode')

    config.set('webSearch', false)
    notifyOwnEntry(sandbox.ctx)
    await quietWindow()
    assert.equal(runtimeSelection(sandbox.web), 'commandcode')
    assert.equal(await sandbox.patch(), '[]\n')

    await fiber.dispose()
  } finally {
    await sandbox.dispose()
  }
})

test('host apply()：官方设置页已 pin 时 boot 不夺取，也不动 profile', async () => {
  const sandbox = await selectionSandbox()
  try {
    await sandbox.admin.update('web', { searchProvider: 'deepseek-search-api', fetchProvider: 'deepseek-fetch-api' })
    const persisted = await sandbox.patch()

    const { fiber } = await mountHost(sandbox, { webSearch: true })
    await quietWindow()
    assert.equal(runtimeSelection(sandbox.web), 'deepseek-search-api')
    assert.equal(await sandbox.patch(), persisted)

    await fiber.dispose()
  } finally {
    await sandbox.dispose()
  }
})

test('host apply()：卸载只交还运行中的引用，不调用 settings', async () => {
  const sandbox = await selectionSandbox()
  try {
    const { fiber } = await mountHost(sandbox, { webSearch: true })
    await waitFor(() => runtimeSelection(sandbox.web) === 'commandcode', 'boot 时没有夺取 commandcode')
    const persisted = await sandbox.patch()
    assert.match(persisted, /searchProvider: commandcode/)

    await fiber.dispose()
    await quietWindow()
    // 运行中的引用被交还（不然 commandcode 提供方注销后，每次搜索都会
    // WEB_PROVIDER_CONFIGURED_MISSING），而 profile 覆盖保持不动 —— 归还写盘
    // 会把整行删掉，所以这份文档本身就是「卸载不写盘」的证据。
    assert.equal(runtimeSelection(sandbox.web), 'deepseek-official')
    assert.equal(await sandbox.patch(), persisted)
  } finally {
    await sandbox.dispose()
  }
})

// ───────────────────────────────────────────────────────────────────────────
// 加固运行面：没有可写的选择面时，handle 必须退化成「未应用」而不是抛错
// ───────────────────────────────────────────────────────────────────────────

test('没有可写的选择面时不抛错、不产生副作用', async () => {
  // 加固过的运行面（冻结、没有 config）必须退化成「未应用」，而不是在 apply 里
  // 抛出、或往实例上塞字段：handle 的成员契约定死为不抛。这是 memoryWrite 最后
  // 一道降级路径的契约测试，与引擎版本无关。
  const web = Object.freeze({}) as unknown as WebRuntime
  const handle = createCommandCodeSearchSelection({ web, settings: () => undefined, logger: logSink().logger })

  assert.doesNotThrow(() => handle.apply(true))
  await handle.settled()
  assert.doesNotThrow(() => handle.apply(false))
  await handle.settled()
  assert.deepEqual(Reflect.ownKeys(web), [])
})
