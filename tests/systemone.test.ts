/**
 * System One decision-client tests (node:test, zero deps). Run with `npm test`.
 *
 * These pin the wire contract this plugin reads from
 * `POST {apiBase}/provider/v1/systemone` (command-code@1.64.0), which is the
 * whole reason the guard can exist:
 *
 * - the request body `{ model, state, questions }` with the typed-question
 *   vocabulary, on the plugin's own credential chain and version header;
 * - the answer shapes by question type, parsed STRICTLY — an absent or
 *   out-of-range probability is a malformed body, never a default, because the
 *   guard reads that number as "safe to run without asking";
 * - the failure taxonomy the guard fails closed on (HTTP, network, timeout,
 *   caller abort, unreadable body, unbuildable request).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  SYSTEMONE_MODEL,
  SYSTEMONE_ROUTE,
  SystemOneError,
  parseSystemOneResponse,
  runSystemOne,
  type SystemOneDeps,
  type SystemOneRequest,
} from '../src/systemone.ts'
import { COMMAND_CODE_CLI_VERSION } from '../src/adapter.ts'

/** A fetch stub that records the last request and answers with a scripted response. */
interface Stub {
  deps: SystemOneDeps
  url: string | undefined
  init: RequestInit | undefined
  body: Record<string, unknown> | undefined
  calls: number
}

function makeFetch(impl: (url: string, init: RequestInit | undefined) => Response | Promise<Response>): Stub {
  const stub: Stub = {
    deps: undefined!,
    url: undefined,
    init: undefined,
    body: undefined,
    calls: 0,
  }
  stub.deps = {
    apiBase: () => 'https://api.commandcode.ai',
    resolveApiKey: async () => 'test-key',
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      stub.calls += 1
      stub.url = String(input)
      stub.init = init
      stub.body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
      return await impl(String(input), init)
    }) as typeof fetch,
  }
  return stub
}

/**
 * A transport that never answers on its own and settles only when its signal
 * aborts — the shape a stalled connection has. An already-aborted signal
 * rejects immediately, like a real fetch does.
 */
function neverSettles(_url: string, init: RequestInit | undefined): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal
    if (signal === undefined || signal === null) return
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

/** A minimal valid decision body for one `noul` answer. */
function noulBody(probability: number): Response {
  return Response.json({ model: SYSTEMONE_MODEL, answers: { safe: { type: 'noul', noul: probability } }, usage: { input_tokens: 84, output_tokens: 3 } })
}

/** The guard's own single-question request, as the real caller builds it. */
function safeRequest(overrides: Partial<SystemOneRequest> = {}): SystemOneRequest {
  return {
    state: 'Tool: bash\nCommand:\nls -la',
    questions: {
      safe: {
        type: 'noul',
        instructions: 'Is it safe?',
        criteria: { true: 'read-only', false: 'anything else' },
      },
    },
    ...overrides,
  }
}

test('a decision posts the typed-question body to /provider/v1/systemone with the plugin headers', async () => {
  const stub = makeFetch(() => noulBody(0.97))
  const response = await runSystemOne(stub.deps, safeRequest())

  assert.equal(stub.calls, 1)
  assert.equal(stub.url, `https://api.commandcode.ai${SYSTEMONE_ROUTE}`)
  assert.equal(stub.url, 'https://api.commandcode.ai/provider/v1/systemone')
  assert.equal(stub.init?.method, 'POST')
  const headers = stub.init?.headers as Record<string, string>
  assert.equal(headers.Authorization, 'Bearer test-key')
  assert.equal(headers['x-command-code-version'], COMMAND_CODE_CLI_VERSION)
  assert.equal(headers['Content-Type'], 'application/json')
  // The ZDR header is never sent: this model has no ZDR upstream, so asking
  // with it would turn every decision into a 422.
  assert.equal(headers['x-cmd-zdr'], undefined)

  assert.deepEqual(stub.body, {
    model: SYSTEMONE_MODEL,
    state: 'Tool: bash\nCommand:\nls -la',
    questions: safeRequest().questions,
  })
  assert.equal(response.answers.safe?.type, 'noul')
  assert.equal(response.answers.safe?.type === 'noul' ? response.answers.safe.noul : undefined, 0.97)
  assert.deepEqual(response.usage, { inputTokens: 84, outputTokens: 3 })
})

test('an apiBase trailing slash does not double the separator', async () => {
  const stub = makeFetch(() => noulBody(0.9))
  await runSystemOne({ ...stub.deps, apiBase: () => 'https://api.commandcode.ai/' }, safeRequest())
  assert.equal(stub.url, 'https://api.commandcode.ai/provider/v1/systemone')
})

test('an explicit model override reaches the body (the endpoint takes a model id)', async () => {
  const stub = makeFetch(() => noulBody(0.9))
  await runSystemOne(stub.deps, safeRequest({ model: 'typesafe/other' }))
  assert.equal(stub.body?.model, 'typesafe/other')
})

test('a request with no questions or too many is refused before any network call', async () => {
  const stub = makeFetch(() => noulBody(0.9))
  await assert.rejects(
    () => runSystemOne(stub.deps, { state: 'x', questions: {} }),
    (error: unknown) => error instanceof SystemOneError && error.kind === 'invalid-request',
  )
  const many: Record<string, { type: 'noul'; instructions: string }> = {}
  for (let i = 0; i < 21; i += 1) many[`q${i}`] = { type: 'noul', instructions: 'x' }
  await assert.rejects(
    () => runSystemOne(stub.deps, { state: 'x', questions: many }),
    (error: unknown) => error instanceof SystemOneError && error.kind === 'invalid-request',
  )
  assert.equal(stub.calls, 0)
})

test('an unparseable apiBase is refused before any network call', async () => {
  const stub = makeFetch(() => noulBody(0.9))
  await assert.rejects(
    () => runSystemOne({ ...stub.deps, apiBase: () => 'not a url' }, safeRequest()),
    (error: unknown) => error instanceof SystemOneError && error.kind === 'invalid-request',
  )
  assert.equal(stub.calls, 0)
})

test('a credential failure is its own kind and never reaches fetch', async () => {
  const stub = makeFetch(() => noulBody(0.9))
  const deps: SystemOneDeps = {
    ...stub.deps,
    resolveApiKey: async () => {
      throw new Error('llm-commandcode: no API key')
    },
  }
  await assert.rejects(
    () => runSystemOne(deps, safeRequest()),
    (error: unknown) => error instanceof SystemOneError && error.kind === 'credential'
      && error.message.includes('no API key'),
  )
  assert.equal(stub.calls, 0)
})

test('the decision budget ends a stalled credential lookup before fetch', async () => {
  const stub = makeFetch(() => noulBody(0.9))
  await assert.rejects(
    () => runSystemOne({
      ...stub.deps,
      resolveApiKey: () => new Promise<string>(() => {}),
    }, safeRequest(), { timeoutMs: 20 }),
    (error: unknown) => error instanceof SystemOneError && error.kind === 'timeout',
  )
  assert.equal(stub.calls, 0)
})

test('a caller abort ends a stalled credential lookup', async () => {
  const stub = makeFetch(() => noulBody(0.9))
  const controller = new AbortController()
  const pending = runSystemOne({
    ...stub.deps,
    resolveApiKey: () => new Promise<string>(() => {}),
  }, safeRequest(), { signal: controller.signal, timeoutMs: 5000 })
  controller.abort()
  await assert.rejects(
    () => pending,
    (error: unknown) => error instanceof SystemOneError && error.kind === 'aborted',
  )
  assert.equal(stub.calls, 0)
})

test('a non-2xx answer carries the status and a body excerpt', async () => {
  const stub = makeFetch(() => new Response('{"error":{"code":"cmd_zdr_no_providers"}}', { status: 422 }))
  await assert.rejects(
    () => runSystemOne(stub.deps, safeRequest()),
    (error: unknown) => error instanceof SystemOneError && error.kind === 'http' && error.status === 422
      && error.message.includes('cmd_zdr_no_providers'),
  )
})

test('a connection failure is a network failure', async () => {
  const stub = makeFetch(() => {
    throw new TypeError('fetch failed')
  })
  await assert.rejects(
    () => runSystemOne(stub.deps, safeRequest()),
    (error: unknown) => error instanceof SystemOneError && error.kind === 'network',
  )
})

test('a decision that outlives its budget is a timeout, not a network error', async () => {
  const stub = makeFetch(neverSettles)
  await assert.rejects(
    () => runSystemOne(stub.deps, safeRequest(), { timeoutMs: 20 }),
    (error: unknown) => error instanceof SystemOneError && error.kind === 'timeout'
      && error.message.includes('timed out'),
  )
})

test('an already-aborted caller signal is an abort, not a timeout', async () => {
  const stub = makeFetch(() => noulBody(0.9))
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => runSystemOne(stub.deps, safeRequest(), { signal: controller.signal }),
    (error: unknown) => error instanceof SystemOneError && error.kind === 'aborted',
  )
  assert.equal(stub.calls, 0)
})

test('a caller abort mid-flight is an abort, not a timeout', async () => {
  const controller = new AbortController()
  const stub = makeFetch(neverSettles)
  const pending = runSystemOne(stub.deps, safeRequest(), { signal: controller.signal, timeoutMs: 5000 })
  controller.abort()
  await assert.rejects(
    () => pending,
    (error: unknown) => error instanceof SystemOneError && error.kind === 'aborted',
  )
})

test('an unparseable body is an invalid response', async () => {
  const stub = makeFetch(() => new Response('not json', { status: 200 }))
  await assert.rejects(
    () => runSystemOne(stub.deps, safeRequest()),
    (error: unknown) => error instanceof SystemOneError && error.kind === 'invalid-response',
  )
})

test('answer parsing: each question type is read strictly by its own type', () => {
  const parsed = parseSystemOneResponse({
    model: SYSTEMONE_MODEL,
    answers: {
      yes: { type: 'noul', noul: 0.96 },
      pick: { type: 'choice', choice: 'billing', confidence: 0.89, probabilities: { billing: 0.91, shipping: 0.09 } },
      rate: { type: 'score', score: 1.41, confidence: 0.5, legend: { 0: 'Calm' }, probabilities: { 0: 0.02, 1: 0.98 } },
    },
  })
  assert.deepEqual(parsed, {
    model: SYSTEMONE_MODEL,
    answers: {
      yes: { type: 'noul', noul: 0.96 },
      pick: { type: 'choice', choice: 'billing', confidence: 0.89, probabilities: { billing: 0.91, shipping: 0.09 } },
      rate: { type: 'score', score: 1.41, confidence: 0.5, probabilities: { 0: 0.02, 1: 0.98 } },
    },
  })
})

test('answer parsing rejects every shape the guard must not read as a verdict', () => {
  const cases: unknown[] = [
    undefined,
    null,
    'safe',
    [],
    {},
    { answers: {} },
    { answers: { safe: {} } },
    { answers: { safe: { type: 'noul' } } },
    { answers: { safe: { type: 'noul', noul: 'high' } } },
    { answers: { safe: { type: 'noul', noul: 1.5 } } },
    { answers: { safe: { type: 'noul', noul: -0.1 } } },
    { answers: { safe: { type: 'noul', noul: Number.NaN } } },
    { answers: { safe: { type: 'choice' } } },
    { answers: { safe: { type: 'choice', choice: '', confidence: 0.5 } } },
    { answers: { safe: { type: 'choice', choice: 'a', confidence: 2 } } },
    { answers: { safe: { type: 'choice', choice: 'a', probabilities: { a: 'x' } } } },
    { answers: { safe: { type: 'score', score: 'high' } } },
    { answers: { safe: { type: 'unknown', value: 1 } } },
    // One malformed entry fails the whole body: a partially understood
    // decision is not a decision.
    { answers: { safe: { type: 'noul', noul: 0.9 }, other: { type: 'choice' } } },
    { answers: { safe: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 'many' } },
    { answers: { safe: { type: 'noul', noul: 0.9 } }, usage: [] },
  ]
  for (const value of cases) {
    assert.equal(parseSystemOneResponse(value), undefined, `expected rejection for ${JSON.stringify(value)}`)
  }
})

test('a body without usage still parses (usage is optional)', () => {
  assert.deepEqual(parseSystemOneResponse({ answers: { safe: { type: 'noul', noul: 1 } } }), {
    answers: { safe: { type: 'noul', noul: 1 } },
  })
})
