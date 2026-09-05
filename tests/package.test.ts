/** Package-metadata compatibility contract. */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

interface PackageManifest {
  dsh?: { client?: { platform?: string } }
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PackageManifest

test('every Harness peer and direct development package starts at 0.1.2-rc.1', () => {
  const peers = pkg.peerDependencies ?? {}
  const dev = pkg.devDependencies ?? {}
  const harnessPeers = Object.keys(peers).filter((name) => name.startsWith('@deepseek-ai/dsh-'))

  assert.ok(harnessPeers.length > 0)
  for (const name of harnessPeers) {
    assert.equal(peers[name], '^0.1.2-rc.1', `${name} peer range`)
    assert.equal(dev[name], '^0.1.2-rc.1', `${name} development range`)
  }
})

test('the rc.1 Web client remains enabled without dsh-client-runtime', () => {
  assert.equal(pkg.dsh?.client?.platform, 'web')
  assert.equal(pkg.peerDependencies?.['@deepseek-ai/dsh-client-runtime'], undefined)
  assert.equal(pkg.devDependencies?.['@deepseek-ai/dsh-client-runtime'], undefined)
})
