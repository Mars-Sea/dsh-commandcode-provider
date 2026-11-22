/**
 * Web-FETCH provider tests (node:test). Run with `npm test`.
 *
 * The first half drives `CommandCodeFetchProvider` against a stubbed fetch,
 * pinning the `/alpha/web-fetch` wire contract (POST body `{ url, format }`,
 * `Authorization: Bearer` + `x-command-code-version` headers), the result
 * mapping into dsh's CLOSED `WebFetchResult` union, the local URL guard, and the
 * failure taxonomy — no engine involved.
 *
 * The second half covers the SELECTION seam for the fetch capability on the REAL
 * rc.2+ engine, reusing the same sandbox `tests/web-search.test.ts` builds: a
 * real Loader over a throwaway profile, the real settings service, and a real
 * `WebRuntime` that resolves `fetchProvider` per call. The shared seam is
 * field-generic, so these cases are what prove the fetch half actually names
 * `fetchProvider` and leaves `searchProvider` alone.
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
  COMMANDCODE_FETCH_PROVIDER_ID,
  CommandCodeFetchProvider,
  FETCH_ROUTE,
  WEB_FETCH_SELECTION_FIELD,
  createCommandCodeFetchSelection,
  fetchUrlGuard,
} from '../src/web-fetch.ts'
import type { CommandCodeFetchProviderDeps } from '../src/web-fetch.ts'
import { COMMAND_CODE_CLI_VERSION } from '../src/adapter.ts'
import type { WebSelectionSettings } from '../src/web-selection.ts'

// ───────────────────────────────────────────────────────────────────────────
// Wire contract: the provider against a stubbed fetch
// ───────────────────────────────────────────────────────────────────────────

/** A fetch stub that records the request and returns a scripted response. */
interface Stub {
  fetchImpl: typeof fetch
  calls: number
  lastInit: RequestInit | undefined
  lastUrl: string | undefined
  lastBody: Record<string, unknown> | undefined
  lastHeaders: Record<string, string> | undefined
}

/**
 * Build a fetch stub.
 *
 * @param impl - produces the response for each call; it receives the 1-based
 *   attempt number so a test can fail the first N attempts.
 */
function makeFetch(impl: (attempt: number) => Response | Promise<Response>): Stub {
  const stub: Stub = {
    fetchImpl: undefined!,
    calls: 0,
    lastInit: undefined,
    lastUrl: undefined,
    lastBody: undefined,
    lastHeaders: undefined,
  }
  stub.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    stub.calls += 1
    stub.lastUrl = String(input)
    stub.lastInit = init
    stub.lastHeaders = init?.headers as Record<string, string> | undefined
    stub.lastBody = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
    return await impl(stub.calls)
  }) as typeof fetch
  return stub
}

/** A Response double: enough for the provider's status/ok/json/text reads. */
function asResponse(init: ResponseInit & { body?: unknown; text?: string }): Response {
  const status = init.status ?? 200
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => {
      if (init.body === undefined) throw new TypeError('Unexpected token < in JSON')
      return init.body
    },
    text: async () => init.text ?? JSON.stringify(init.body ?? ''),
  } as Response
}

/** A successful `{ content, url, status }` fetch answer. */
function okBody(content: string, url?: string, status?: number): ResponseInit & { body: unknown } {
  return {
    status: 200,
    body: {
      content,
      ...(url === undefined ? {} : { url }),
      ...(status === undefined ? {} : { status }),
    },
  }
}

interface ProviderOverrides {
  /** `null` → resolveKey returns undefined (no key). */
  key?: string | null
  apiBase?: string
  fetchImpl?: typeof fetch
  retryWait?: CommandCodeFetchProviderDeps['retryWait']
}

function makeProvider(overrides: ProviderOverrides = {}): { provider: CommandCodeFetchProvider; key: string | undefined } {
  const key = overrides.key === null ? undefined : (overrides.key ?? 'cc-key-123')
  const provider = new CommandCodeFetchProvider({
    resolveKey: async () => key,
    apiBase: () => overrides.apiBase ?? 'https://api.commandcode.ai',
    ...(overrides.fetchImpl === undefined ? {} : { fetchImpl: overrides.fetchImpl }),
    ...(overrides.retryWait === undefined ? {} : { retryWait: overrides.retryWait }),
  })
  return { provider, key }
}

/** A retry wait that never really sleeps; records the delays it was asked for. */
function instantWaits(): { waits: number[]; retryWait: (delayMs: number) => Promise<void> } {
  const waits: number[] = []
  return { waits, retryWait: async (delayMs: number) => { waits.push(delayMs) } }
}

test('posts the CLI web-fetch body to /alpha/web-fetch with the Command Code headers', async () => {
  const stub = makeFetch(() => asResponse(okBody('# Page\n\nbody', 'https://a.example/doc', 200)))
  const { provider } = makeProvider({ fetchImpl: stub.fetchImpl })

  await provider.fetch({ url: 'https://a.example/doc' })

  assert.equal(stub.calls, 1)
  assert.equal(stub.lastUrl, `https://api.commandcode.ai${FETCH_ROUTE}`)
  assert.equal(FETCH_ROUTE, '/alpha/web-fetch')
  const headers = stub.lastHeaders
  assert.equal(headers?.Authorization, 'Bearer cc-key-123')
  assert.equal(headers?.['x-command-code-version'], COMMAND_CODE_CLI_VERSION)
  assert.equal(headers?.['x-cli-environment'], 'production')
  assert.equal(headers?.['Content-Type'], 'application/json')
  assert.equal(headers?.['accept-encoding'], 'identity')
  // Only the two fields the CLI itself sends: `startIndex` and `timeout` have no
  // seam-given value and must not be invented here.
  assert.deepEqual(stub.lastBody, { url: 'https://a.example/doc', format: 'markdown' })
})

test('maps {content,url,status} into the closed WebFetchResult union as a text body', async () => {
  const stub = makeFetch(() => asResponse(okBody('# Title\n\ntext', 'https://final.example/page', 200)))
  const { provider } = makeProvider({ fetchImpl: stub.fetchImpl })

  const result = await provider.fetch({ url: 'https://a.example/page' })

  assert.deepEqual(result, {
    url: 'https://final.example/page',
    statusCode: 200,
    body: { kind: 'text', content: '# Title\n\ntext' },
    truncated: false,
  })
})

test('falls back to the requested URL and to 200 when the answer omits them', async () => {
  const stub = makeFetch(() => asResponse({ status: 200, body: { content: 'plain' } }))
  const { provider } = makeProvider({ fetchImpl: stub.fetchImpl })

  const result = await provider.fetch({ url: 'https://a.example/page' })

  assert.equal(result.url, 'https://a.example/page')
  assert.equal(result.statusCode, 200)
})

test('a non-2xx upstream status is a RESULT, carrying its status and body', async () => {
  // dsh's seam contract: "a successful network fetch of a non-2xx response is a
  // result, not an error" — the status is part of the fetched resource state.
  const stub = makeFetch(() => asResponse(okBody('Not Found', 'https://a.example/missing', 404)))
  const { provider } = makeProvider({ fetchImpl: stub.fetchImpl })

  const result = await provider.fetch({ url: 'https://a.example/missing' })

  assert.equal(result.statusCode, 404)
  assert.deepEqual(result.body, { kind: 'text', content: 'Not Found' })
})

test('a long page is passed through whole, never cut to the CLI window', async () => {
  // `startIndex` is NOT a wire field: the gateway returns the entire page and the
  // CLI windows it client-side at 100,000 chars. The seam has no continuation
  // parameter, so cutting here would destroy content the caller could never
  // re-read — and it cut below `dsh-tool-web`'s own 200,000-char output cap. The
  // provider therefore forwards the body untouched and reports no truncation.
  for (const length of [99_999, 100_000, 100_005, 250_000]) {
    const stub = makeFetch(() => asResponse(okBody('x'.repeat(length))))
    const result = await makeProvider({ fetchImpl: stub.fetchImpl }).provider.fetch({ url: 'https://a.example/' })
    assert.equal(result.body.content.length, length, `${length}-char page must arrive whole`)
    assert.equal(result.truncated, false, `${length}-char page is not truncated by this provider`)
  }
})

test('an empty page for a 2xx already fails instead of looking like a success', async () => {
  const stub = makeFetch(() => asResponse(okBody('', 'https://a.example/empty', 200)))
  const { provider } = makeProvider({ fetchImpl: stub.fetchImpl })

  await assert.rejects(
    provider.fetch({ url: 'https://a.example/empty' }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'WEB_PROVIDER_ERROR')
      assert.match((error as Error).message, /empty page/i)
      return true
    },
  )
})

test('a body without a content string fails as a provider error', async () => {
  const stub = makeFetch(() => asResponse({ status: 200, body: { url: 'https://a.example/' } }))
  const { provider } = makeProvider({ fetchImpl: stub.fetchImpl })

  await assert.rejects(
    provider.fetch({ url: 'https://a.example/' }),
    (error: unknown) => (error as { code?: string }).code === 'WEB_PROVIDER_ERROR',
  )
})

test('an unparseable body fails as a provider error', async () => {
  const stub = makeFetch(() => asResponse({ status: 200 }))
  const { provider } = makeProvider({ fetchImpl: stub.fetchImpl })

  await assert.rejects(
    provider.fetch({ url: 'https://a.example/' }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'WEB_PROVIDER_ERROR')
      assert.match((error as Error).message, /unparseable/i)
      return true
    },
  )
})

test('a non-success HTTP status throws WEB_PROVIDER_ERROR and surfaces the error detail', async () => {
  const stub = makeFetch(() => asResponse({ status: 402, body: { error: { code: 'insufficient_credits', message: 'no credits' } } }))
  const { provider } = makeProvider({ fetchImpl: stub.fetchImpl })

  await assert.rejects(
    provider.fetch({ url: 'https://a.example/' }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'WEB_PROVIDER_ERROR')
      assert.match((error as Error).message, /HTTP 402/)
      assert.match((error as Error).message, /insufficient_credits/)
      assert.match((error as Error).message, /no credits/)
      return true
    },
  )
  // A received status is the server's answer: never replayed.
  assert.equal(stub.calls, 1)
})

test('a non-JSON error body keeps a truncated slice of it', async () => {
  const stub = makeFetch(() => asResponse({ status: 502, text: '<html><body>Bad Gateway</body></html>' }))
  const { provider } = makeProvider({ fetchImpl: stub.fetchImpl })

  await assert.rejects(
    provider.fetch({ url: 'https://a.example/' }),
    (error: unknown) => {
      assert.match((error as Error).message, /HTTP 502/)
      assert.match((error as Error).message, /Bad Gateway/)
      return true
    },
  )
})

test('throws WEB_PROVIDER_CREDENTIAL_MISSING when no key can be resolved', async () => {
  const stub = makeFetch(() => asResponse(okBody('x')))
  const { provider } = makeProvider({ key: null, fetchImpl: stub.fetchImpl })

  await assert.rejects(
    provider.fetch({ url: 'https://a.example/' }),
    (error: unknown) => (error as { code?: string }).code === 'WEB_PROVIDER_CREDENTIAL_MISSING',
  )
  assert.equal(stub.calls, 0)
})

test('available() is false for a blank or non-parseable apiBase', () => {
  assert.equal(makeProvider({ apiBase: '' }).provider.available(), false)
  assert.equal(makeProvider({ apiBase: 'not a url' }).provider.available(), false)
  assert.equal(makeProvider().provider.available(), true)
})

test('the provider advertises a bilingual description and NO title', () => {
  const { provider } = makeProvider()
  assert.equal(provider.id, COMMANDCODE_FETCH_PROVIDER_ID)
  assert.equal(provider.id, 'commandcode')
  // The shipped web settings page renders `title ?? id`, and the SEARCH provider
  // declares no title (so it shows `commandcode`). A title here would label the
  // two halves of the same route differently in one page.
  assert.equal((provider as unknown as { title?: string }).title, undefined)
  // `LocalizedText` requires an English entry; the settings page shows it under
  // the selected provider.
  assert.equal(typeof provider.description.en, 'string')
  assert.equal(typeof provider.description.zh, 'string')
  assert.ok(provider.description.en.length > 0)

  // 2026-11-16 user requirement: the picker line describes what the provider
  // CAN and CANNOT do, like the shipped local `http` provider's own copy. It
  // must not talk about money — billing lives on the account page, not in a
  // provider picker, and the built-in providers do not mention it either.
  const copy = `${provider.description.en} ${provider.description.zh}`
  assert.doesNotMatch(copy, /charge|cost|bill|费用|收费|计费/i)

  // No JavaScript claim (PR review, 2026-11-22). Upstream's own tool description
  // says its `web_fetch` handles JS-rendered pages, but a live probe returned
  // only the page TITLE for two genuine client-rendered apps (excalidraw.com →
  // 21 chars, app.diagrams.net → 41 chars) while static pages returned thousands.
  // Until someone can demonstrate otherwise, the picker must not promise it.
  assert.doesNotMatch(copy, /javascript|js[- ]rendered|js 渲染|渲染的页面/i)
})

// ───────────────────────────────────────────────────────────────────────────
// The local URL guard: refused BEFORE any billable request
// ───────────────────────────────────────────────────────────────────────────

test('the URL guard upgrades http to https and keeps the rest of the URL', () => {
  assert.deepEqual(fetchUrlGuard('http://example.com/a?b=1#c'), { ok: true, url: 'https://example.com/a?b=1#c' })
  assert.deepEqual(fetchUrlGuard('https://example.com/a'), { ok: true, url: 'https://example.com/a' })
  // Port 80 has no meaning once the scheme is upgraded.
  assert.deepEqual(fetchUrlGuard('http://example.com:80/a'), { ok: true, url: 'https://example.com/a' })
})

test('the URL guard refuses non-http schemes, credentials and private targets', () => {
  const blocked = [
    ['file:///etc/passwd', 'WEB_INVALID_URL'],
    ['ftp://example.com/x', 'WEB_INVALID_URL'],
    ['javascript:alert(1)', 'WEB_INVALID_URL'],
    ['https://user:pass@example.com/', 'WEB_BLOCKED_URL'],
    ['https://user@example.com/', 'WEB_BLOCKED_URL'],
    ['https://localhost/', 'WEB_BLOCKED_URL'],
    ['https://localhost:8080/', 'WEB_BLOCKED_URL'],
    ['https://ip6-loopback/', 'WEB_BLOCKED_URL'],
    ['https://intranet/', 'WEB_BLOCKED_URL'],
    ['http://127.0.0.1/', 'WEB_BLOCKED_URL'],
    ['http://10.1.2.3/', 'WEB_BLOCKED_URL'],
    ['http://172.16.0.1/', 'WEB_BLOCKED_URL'],
    ['http://192.168.1.1/', 'WEB_BLOCKED_URL'],
    ['http://169.254.169.254/latest/meta-data/', 'WEB_BLOCKED_URL'],
    ['http://100.64.0.1/', 'WEB_BLOCKED_URL'],
    ['http://0.0.0.0/', 'WEB_BLOCKED_URL'],
    ['http://[::1]/', 'WEB_BLOCKED_URL'],
    ['http://[fe80::1]/', 'WEB_BLOCKED_URL'],
    ['http://[fd00::1]/', 'WEB_BLOCKED_URL'],
  ] as const
  for (const [url, code] of blocked) {
    const verdict = fetchUrlGuard(url)
    assert.equal(verdict.ok, false, `${url} should be refused`)
    if (!verdict.ok) assert.equal(verdict.code, code, `${url} should be ${code}`)
  }
})

test('the URL guard accepts ordinary public targets', () => {
  for (const url of ['https://example.com/', 'https://docs.example.co.uk/a/b', 'http://8.8.8.8/', 'https://[2606:4700::1111]/']) {
    assert.equal(fetchUrlGuard(url).ok, true, `${url} should be allowed`)
  }
  assert.equal(fetchUrlGuard(''.trim()).ok, false)
  assert.equal(fetchUrlGuard(`https://example.com/${'a'.repeat(2_048)}`).ok, false)
})

test('a refused URL never reaches the network', async () => {
  const stub = makeFetch(() => asResponse(okBody('should not happen')))
  const { provider } = makeProvider({ fetchImpl: stub.fetchImpl })

  await assert.rejects(
    provider.fetch({ url: 'http://169.254.169.254/latest/meta-data/' }),
    (error: unknown) => (error as { code?: string }).code === 'WEB_BLOCKED_URL',
  )
  assert.equal(stub.calls, 0)
})

// ───────────────────────────────────────────────────────────────────────────
// Retry and cancellation
// ───────────────────────────────────────────────────────────────────────────

test('retries a fetch that got no response and resolves the key only once', async () => {
  let resolves = 0
  const stub = makeFetch((attempt) => {
    if (attempt < 3) throw new TypeError('fetch failed')
    return asResponse(okBody('recovered'))
  })
  const waits = instantWaits()
  const provider = new CommandCodeFetchProvider({
    resolveKey: async () => { resolves += 1; return 'k' },
    apiBase: () => 'https://api.commandcode.ai',
    fetchImpl: stub.fetchImpl,
    retryWait: waits.retryWait,
  })

  const result = await provider.fetch({ url: 'https://a.example/' })
  assert.equal(result.body.content, 'recovered')
  assert.equal(stub.calls, 3)
  assert.equal(resolves, 1)
  assert.equal(waits.waits.length, 2)
})

test('stops at the attempt budget and names the cause, target and attempt count', async () => {
  const stub = makeFetch(() => { throw new TypeError('fetch failed') })
  const waits = instantWaits()
  const { provider } = makeProvider({ fetchImpl: stub.fetchImpl, retryWait: waits.retryWait })

  await assert.rejects(
    provider.fetch({ url: 'https://a.example/' }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'WEB_PROVIDER_ERROR')
      const message = (error as Error).message
      assert.match(message, /web fetch request failed/)
      assert.match(message, /api\.commandcode\.ai/)
      assert.match(message, /已尝试 3 次/)
      return true
    },
  )
  assert.equal(stub.calls, 3)
})

test('does not retry once an HTTP status arrived: a 403 is an answer, not a blip', async () => {
  const stub = makeFetch(() => asResponse({ status: 403, body: { error: 'forbidden' } }))
  const { provider } = makeProvider({ fetchImpl: stub.fetchImpl })

  await assert.rejects(provider.fetch({ url: 'https://a.example/' }))
  assert.equal(stub.calls, 1)
})

test('throws WEB_ABORTED when the caller aborts mid-flight', async () => {
  const controller = new AbortController()
  const stub = makeFetch(() => { throw new DOMException('aborted', 'AbortError') })
  const { provider } = makeProvider({ fetchImpl: stub.fetchImpl })

  controller.abort(new Error('user cancelled'))
  await assert.rejects(
    provider.fetch({ url: 'https://a.example/' }, controller.signal),
    (error: unknown) => (error as { code?: string }).code === 'WEB_ABORTED',
  )
  assert.equal(stub.calls, 0)
})

test('an abort during the retry wait stops there instead of making another request', async () => {
  const controller = new AbortController()
  const stub = makeFetch(() => { throw new TypeError('fetch failed') })
  const provider = new CommandCodeFetchProvider({
    resolveKey: async () => 'k',
    apiBase: () => 'https://api.commandcode.ai',
    fetchImpl: stub.fetchImpl,
    retryWait: async () => { controller.abort(new Error('stop')) },
  })

  await assert.rejects(
    provider.fetch({ url: 'https://a.example/' }, controller.signal),
    (error: unknown) => (error as { code?: string }).code === 'WEB_ABORTED',
  )
  assert.equal(stub.calls, 1)
})

test('the fetch uses the gateway captured at call time, not one re-read after a wait', async () => {
  let base = 'https://fetch-scope-a.invalid'
  let scoped = ''
  let sent = ''
  const provider = new CommandCodeFetchProvider({
    apiBase: () => base,
    resolveKey: async (captured) => {
      scoped = captured ?? ''
      base = 'https://fetch-scope-b.invalid'
      return 'synthetic-key'
    },
    fetchImpl: (async (input: RequestInfo | URL) => {
      sent = String(input)
      return asResponse(okBody('ok'))
    }) as typeof fetch,
  })

  await provider.fetch({ url: 'https://a.example/' })
  assert.equal(scoped, 'https://fetch-scope-a.invalid')
  assert.equal(sent, 'https://fetch-scope-a.invalid/alpha/web-fetch')
})

// ───────────────────────────────────────────────────────────────────────────
// Selection on the real engine: the fetch field, and ONLY the fetch field
// ───────────────────────────────────────────────────────────────────────────

/** Recorded log lines; the "someone else pinned it" fact must be assertable. */
function logSink(): { info: string[]; warn: string[]; logger: { info(m: string): void; warn(m: string): void } } {
  const info: string[] = []
  const warn: string[] = []
  return { info, warn, logger: { info: (m) => { info.push(m) }, warn: (m) => { warn.push(m) } } }
}

/** The running runtime's two volatile selection fields. */
function runtimeConfig(web: WebRuntime): { searchProvider: { get(): unknown }; fetchProvider: { get(): unknown } } {
  return (web as unknown as { config: { searchProvider: { get(): unknown }; fetchProvider: { get(): unknown } } }).config
}

function runtimeValue(web: WebRuntime, field: 'searchProvider' | 'fetchProvider'): string | undefined {
  const value: unknown = runtimeConfig(web)[field].get()
  return typeof value === 'string' ? value : undefined
}

interface Sandbox {
  ctx: Context
  web: WebRuntime
  admin: WebSelectionSettings
  patch(): Promise<string>
  dispose(): Promise<void>
}

/** YAML for one `- insert:` row whose config values are scalars. */
function insertRow(id: string, name: string, config: Record<string, unknown>): string {
  const lines = ['- insert:', `    - id: ${id}`, `      name: "${name}"`, '      config:']
  for (const [key, value] of Object.entries(config)) lines.push(`        ${key}: ${String(value)}`)
  return `${lines.join('\n')}\n`
}

/** YAML for one profile user-layer override. */
function userPatch(id: string, name: string, config: Record<string, unknown>): string {
  const lines = [`- id: ${id}`, `  name: "${name}"`, '  config:']
  for (const [key, value] of Object.entries(config)) lines.push(`    ${key}: ${String(value)}`)
  return `${lines.join('\n')}\n`
}

/**
 * A real rc.2+ sandbox: real `boot()` + Loader + config editor + settings + a
 * real `WebRuntime`, over a throwaway profile.
 *
 * @param options - `base` is the `web` entry's composed config (defaults to the
 *   shipped pair); `user` pre-seeds the profile user layer.
 */
async function sandbox(options: { base?: Record<string, unknown>; user?: Record<string, unknown> } = {}): Promise<Sandbox> {
  const base = options.base ?? { searchProvider: 'deepseek-official', fetchProvider: 'http' }
  const root = fileURLToPath(new URL('..', import.meta.url))
  const { boot, readProfilePatches } = await import('@deepseek-ai/dsh-app-boot')
  const ConfigEditor = (await import('@deepseek-ai/dsh-config-editor')).default
  const SettingsForms = (await import('@deepseek-ai/dsh-settings')).default
  const { WebRuntime } = await import('@deepseek-ai/dsh-web')

  const home = await mkdtemp(join(tmpdir(), 'dsh-commandcode-fetch-'))
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
  ctx.provide('llm', { registerConfigurableProviders: () => {}, registerAdapter: () => {} } as never)
  await ctx.plugin(ConfigEditor)
  await ctx.plugin(SettingsForms)
  await new Promise((resolve) => setImmediate(resolve))

  return {
    ctx,
    web: ctx.get('web') as WebRuntime,
    admin: ctx.get('settings') as unknown as WebSelectionSettings,
    patch: () => readFile(patchPath, 'utf8'),
    dispose: async () => {
      await ctx.fiber.dispose()
      await rm(home, { recursive: true, force: true })
    },
  }
}

test('fetch selection takes the field, persists it, and leaves searchProvider untouched', async () => {
  const s = await sandbox()
  try {
    const handle = createCommandCodeFetchSelection({ web: s.web, settings: () => s.admin, logger: logSink().logger })
    assert.equal(runtimeValue(s.web, 'fetchProvider'), 'http')
    assert.equal(WEB_FETCH_SELECTION_FIELD, 'fetchProvider')

    handle.apply(true)
    await handle.settled()

    assert.equal(runtimeValue(s.web, 'fetchProvider'), 'commandcode')
    assert.equal(runtimeValue(s.web, 'searchProvider'), 'deepseek-official')
    const patchText = await s.patch()
    assert.match(patchText, /fetchProvider: commandcode/)
    // The user layer does record the composed search value too — this seam never
    // THREW that selection, because only the fetch field was touched. What must
    // not happen is the search field being taken over by the fetch toggle.
    assert.match(patchText, /searchProvider: deepseek-official/)
    assert.deepEqual(handle.state, { owner: true, preexisting: false, foreign: undefined, displaced: 'http' })

    handle.apply(false)
    await handle.settled()
    assert.equal(runtimeValue(s.web, 'fetchProvider'), 'http')
    assert.equal(runtimeValue(s.web, 'searchProvider'), 'deepseek-official')
    assert.equal(await s.patch(), '[]\n')
    assert.equal(handle.state.owner, false)
  } finally {
    await s.dispose()
  }
})

test('a foreign fetch pin is never displaced', async () => {
  const s = await sandbox()
  const sink = logSink()
  try {
    // The shipped settings page writes exactly this pair.
    await s.admin.update('web', { searchProvider: 'deepseek-search-api', fetchProvider: 'deepseek-fetch-api' })
    const handle = createCommandCodeFetchSelection({ web: s.web, settings: () => s.admin, logger: sink.logger })

    handle.apply(true)
    await handle.settled()

    assert.equal(runtimeValue(s.web, 'fetchProvider'), 'deepseek-fetch-api')
    assert.equal(handle.state.owner, false)
    assert.equal(handle.state.foreign, 'deepseek-fetch-api')
    assert.equal(sink.warn.length, 0)
    assert.equal(sink.info.length, 1)
    assert.match(sink.info[0]!, /web fetch/)
    assert.match(sink.info[0]!, /deepseek-fetch-api/)
  } finally {
    await s.dispose()
  }
})

test('a composed default already set to commandcode is preexisting: disabling writes nothing', async () => {
  const s = await sandbox({ base: { searchProvider: 'deepseek-official', fetchProvider: 'commandcode' } })
  try {
    const handle = createCommandCodeFetchSelection({ web: s.web, settings: () => s.admin, logger: logSink().logger })
    handle.apply(true)
    await handle.settled()
    assert.equal(handle.state.owner, false)
    assert.equal(handle.state.preexisting, true)

    handle.apply(false)
    await handle.settled()
    assert.equal(runtimeValue(s.web, 'fetchProvider'), 'commandcode')
    assert.equal(await s.patch(), '[]\n')
  } finally {
    await s.dispose()
  }
})
