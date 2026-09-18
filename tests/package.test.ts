/** Package-metadata compatibility contract. */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

interface PackageManifest {
  dsh?: {
    client?: { platform?: string }
    compatibility?: { dshReleases?: Record<string, string>; dsh?: string }
  }
  engines?: { node?: string; dsh?: string }
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean } | undefined>
  devDependencies?: Record<string, string>
}

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PackageManifest

test('every Harness peer and development package shares one supported release range', () => {
  const peers = pkg.peerDependencies ?? {}
  const dev = pkg.devDependencies ?? {}
  const harnessPeers = Object.keys(peers).filter((name) => name.startsWith('@deepseek-ai/dsh-'))

  assert.ok(harnessPeers.length > 0)
  const ranges = new Set(harnessPeers.map((name) => peers[name]))
  assert.equal(ranges.size, 1, 'one range for every Harness package, never a per-package drift')
  const range = [...ranges][0]!
  for (const name of harnessPeers) {
    assert.equal(dev[name], range, `${name} development range`)
  }
  // Why an exact-version disjunction rather than a caret: semver only admits a
  // prerelease inside the SAME major.minor.patch tuple as the comparator, so
  // `^0.1.2-rc.1` resolves to 0.1.2-rc.1 alone — it never admits 0.1.3-alpha.1,
  // 0.1.5-rc.2 or 0.1.6-alpha.1, which is how a broken engine pairing stayed
  // invisible (issue #43).
  assert.ok(!range.includes('x') && !range.includes('>='), 'no compact comparator form can express this')
  for (const version of Object.keys(pkg.dsh?.compatibility?.dshReleases ?? {})) {
    assert.ok(
      range.split(' || ').includes(`^${version}`),
      `peer range must admit declared-compatible ${version}`,
    )
  }
})

test('per-release DSH compatibility is declared for every supported release', () => {
  // DSH STORE only restores a listing from exact per-release records under
  // dsh.compatibility.dshReleases; a peer range alone is not evidence, and a
  // release with no record reads as `unknown`. Records are additive: each
  // release keeps its own entry, so the catalog can still list the plugin for a
  // user who has not moved to the newest engine.
  const releases = pkg.dsh?.compatibility?.dshReleases ?? {}
  for (const version of [
    '0.1.2-rc.1',
    '0.1.3-alpha.1',
    '0.1.3-alpha.2',
    '0.1.5-alpha.1',
    '0.1.5-rc.1',
    '0.1.5-rc.2',
    '0.1.6-alpha.1',
    '0.1.6-alpha.2',
  ]) {
    assert.equal(releases[version], 'compatible', `dshReleases[${version}]`)
  }
})

test('the manifest declares the same engine range it supports', () => {
  // `compatibility.dsh` and `engines.dsh` are declarative: dsh itself reads
  // neither, but a catalog that finds no explicit engine range falls back to a
  // peer range, so leaving them out lets the two drift apart silently.
  const supported = pkg.peerDependencies?.['@deepseek-ai/dsh-llm']
  assert.equal(pkg.dsh?.compatibility?.dsh, supported)
  assert.equal(pkg.engines?.dsh, supported)
  assert.equal(pkg.engines?.node, '>=22')
})

test('the rc.1 Web client remains enabled without dsh-client-runtime', () => {
  assert.equal(pkg.dsh?.client?.platform, 'web')
  assert.equal(pkg.peerDependencies?.['@deepseek-ai/dsh-client-runtime'], undefined)
  assert.equal(pkg.devDependencies?.['@deepseek-ai/dsh-client-runtime'], undefined)
})

test('only the client-seeded UI peers are optional, and each stays a development package', () => {
  // The Web frontend hands every client bundle a `staticModules` seed table —
  // react, react/jsx-runtime, react-dom, react-dom/client,
  // @deepseek-ai/cordis, @deepseek-ai/dsh-client-store,
  // @deepseek-ai/dsh-client-ui-slots, @deepseek-ai/dsh-client-ui-primitives,
  // read out of the 0.1.2-rc.1, 0.1.5-rc.2 and 0.1.6-alpha.2 engines alike — and
  // lib/client.js requires exactly three of them: react, react/jsx-runtime (both
  // from the `react` package) and @deepseek-ai/dsh-client-ui-primitives. No
  // installed copy is therefore needed at runtime, while an older Desktop
  // release — which validates the whole peer closure of every active plugin and
  // ships host packages only — refuses to start unless those three are optional
  // (`desktop profile: … requires missing …`).
  //
  // The set is load-bearing in BOTH directions, which is why it is pinned as an
  // exact list rather than merely checked for well-formedness:
  //   - an optional peer is NEVER installed (npm and pnpm both auto-install only
  //     missing non-optional peers), so every name here must also be a
  //     devDependency or the authortime tree silently loses it. `react` is the
  //     live case: tests/client-boot.test.ts imports the React component tree at
  //     runtime, and the committed lock still carries react only because
  //     @deepseek-ai/dsh-client-ui-primitives@0.1.2-rc.1 depends on it — the
  //     0.1.6-alpha.2 line declares no dependencies at all, so the next
  //     package-lock.json refresh would drop it.
  //   - a host-required peer marked optional here would stop being installed in a
  //     fresh marketplace generation, and no other check can see that:
  //     test:engine stages the ENGINE's own peers, and test:install only asserts
  //     that @deepseek-ai/dsh-invariants resolves.
  const optional = Object.entries(pkg.peerDependenciesMeta ?? {})
    .filter(([, meta]) => meta?.optional === true)
    .map(([name]) => name)
    .sort()

  assert.deepEqual(optional, [
    '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/dsh-client-ui-slots',
    'react',
  ])
  for (const name of optional) {
    assert.ok(
      pkg.peerDependencies?.[name] !== undefined,
      `${name} is marked optional but declares no peer range, which makes that entry inert`,
    )
    assert.ok(
      pkg.devDependencies?.[name] !== undefined,
      `${name} is an optional peer, so no package manager installs it: keep it in devDependencies`,
    )
  }
})
