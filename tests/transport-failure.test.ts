/**
 * Transport failure diagnostics (node:test, zero deps). Run with `npm test`.
 *
 * The two helpers exist to make "all requests failed" actionable: the reason
 * must come from the nested `cause` fetch hides, the raw message (which may
 * embed internal paths) must never leak back, and the origin must stay
 * `scheme://host:port` so a proxy prefix or a query never rides along.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { httpOrigin, transportFailureReason } from '../src/transport-failure.ts'

/** Build the TypeError('fetch failed') shape undici produces, with a code nested in `cause`. */
function fetchFailed(code: string): TypeError {
  const cause = Object.assign(new Error(`connect ${code} 127.0.0.1:18797`), { code })
  return new TypeError('fetch failed', { cause })
}

test('transportFailureReason reads a code nested in the fetch cause', () => {
  assert.equal(transportFailureReason(fetchFailed('ECONNREFUSED')), '连接被拒绝（ECONNREFUSED）')
  assert.equal(transportFailureReason(fetchFailed('ENOTFOUND')), '域名解析失败（ENOTFOUND）')
  assert.equal(transportFailureReason(fetchFailed('UND_ERR_CONNECT_TIMEOUT')), '连接超时（UND_ERR_CONNECT_TIMEOUT）')
})

test('transportFailureReason quotes an unmapped code instead of guessing', () => {
  assert.equal(transportFailureReason(fetchFailed('EACCES')), '网络错误（EACCES）')
})

test('transportFailureReason reads an AggregateError listing per-address causes', () => {
  const error = new AggregateError([fetchFailed('EHOSTUNREACH')], 'all connections failed')
  assert.equal(transportFailureReason(error), '主机不可达（EHOSTUNREACH）')
})

test('transportFailureReason stays silent when no code is present', () => {
  assert.equal(transportFailureReason(new TypeError('fetch failed')), undefined)
  assert.equal(transportFailureReason('ECONNREFUSED'), undefined)
  assert.equal(transportFailureReason(null), undefined)
})

test('httpOrigin keeps scheme and host:port and drops path and query', () => {
  assert.equal(httpOrigin('https://api.commandcode.ai/provider/v1?x=1'), 'https://api.commandcode.ai')
  assert.equal(httpOrigin('http://127.0.0.1:18797/bili/https://api.commandcode.ai'), 'http://127.0.0.1:18797')
  assert.equal(httpOrigin('not a url'), undefined)
})
