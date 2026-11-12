import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LlmError, ProviderRequestId, type LlmFailure } from '@deepseek-ai/dsh-llm'
import { providerError } from '../src/llm-error.ts'
import { bilingual, generateHttpError, streamErrorToLlmError } from '../src/provider-errors.ts'
import { failureWithRequestId } from '../src/stream-response.ts'

for (const factoryAvailable of [false, true]) {
  test(`provider errors preserve custom codes and facts with ${factoryAvailable ? 'rc.2 factory' : 'legacy constructor'}`, t => {
    const original = Object.getOwnPropertyDescriptor(LlmError, 'fromFailure')
    t.after(() => {
      if (original) Object.defineProperty(LlmError, 'fromFailure', original)
      else Reflect.deleteProperty(LlmError, 'fromFailure')
    })
    const factoryCalls: LlmFailure[] = []
    Object.defineProperty(LlmError, 'fromFailure', {
      configurable: true,
      value: factoryAvailable ? (failure: LlmFailure, options?: ErrorOptions): LlmError => {
        factoryCalls.push(failure)
        // Emulate the official factory with the real engine's error constructor.
        return Reflect.construct(LlmError, [failure.message, failure.code, { ...failure, ...options }]) as LlmError
      } : undefined,
    })
    for (const code of ['THROTTLED', 'PROVIDER_HTTP_ERROR', 'PROVIDER_STREAM_ERROR', 'PROVIDER_PROTOCOL_ERROR', 'OUTPUT_TOKEN_LIMIT']) {
      const cause = new Error('synthetic cause')
      const options = Object.freeze({ status: 429, providerRetryAfterMs: 7000, requestId: ProviderRequestId('synthetic-original'), cause })
      const error = providerError('synthetic failure', code, options)
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, code)
      assert.equal(error.cause, cause)
      assert.deepEqual(error.failure, { message: 'synthetic failure', code, status: 429, providerRetryAfterMs: 7000, requestId: 'synthetic-original' })
      assert.ok(Object.isFrozen(error.failure))
      assert.equal(failureWithRequestId(error, { protocol: 'openai', headers: { 'x-request-id': 'synthetic-new' } }), error)

      const withoutId = providerError('synthetic failure', code, { status: 429, providerRetryAfterMs: 7000, cause })
      const tagged = failureWithRequestId(withoutId, { protocol: 'openai', headers: { 'x-request-id': 'synthetic-new' } })
      assert.ok(tagged instanceof LlmError)
      assert.notEqual(tagged, withoutId)
      assert.equal(tagged.code, code)
      assert.equal(tagged.cause, cause)
      assert.deepEqual(tagged.failure, { ...withoutId.failure, requestId: 'synthetic-new' })
      assert.equal(withoutId.failure.requestId, undefined)
    }
    const offload = providerError('offload images', 'IMAGE_OFFLOAD_REQUIRED', { offloadImages: 3 })
    assert.equal(offload.failure.offloadImages, 3)
    assert.equal(providerError('no facts', 'PROVIDER_PROTOCOL_ERROR').cause, undefined)
    assert.throws(() => providerError('', 'PROVIDER_PROTOCOL_ERROR'), /message/)
    assert.throws(() => providerError('failure', ''), /code/)
    assert.throws(() => providerError('failure', 'PROVIDER_HTTP_ERROR', { status: 99 }), /status/)
    if (factoryAvailable) {
      assert.ok(factoryCalls.length > 0)
      assert.ok(factoryCalls.every(failure => !Object.hasOwn(failure, 'cause')))
    } else assert.equal(factoryCalls.length, 0)
  })
}

test('provider classifications keep custom retry and permanent codes', () => {
  assert.equal(bilingual('OUTPUT_TOKEN_LIMIT', 'limited', '截断').code, 'OUTPUT_TOKEN_LIMIT')
  assert.equal(generateHttpError(400, 'bad field').code, 'PROVIDER_HTTP_ERROR')
  const throttled = generateHttpError(429, 'rate limited', 7000)
  assert.equal(throttled.code, 'THROTTLED')
  assert.equal(throttled.failure.providerRetryAfterMs, 7000)
  assert.equal(streamErrorToLlmError({ message: 'synthetic rejection', isRetryable: false }).code, 'PROVIDER_STREAM_ERROR')
})
