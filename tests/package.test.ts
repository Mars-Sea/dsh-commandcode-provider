/** Package-metadata compatibility contract. */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

interface PackageManifest {
  dsh?: {
    client?: { platform?: string; inject?: string[] }
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

/**
 * 一个「裸」语义化版本号：不带任何范围操作符。
 * 支持范围必须由若干裸版本号用 `||` 析取而成，`^`／`~`／`>=` 这类会静默放行
 * 相邻预发布版与稳定补丁版的写法一律不可接受（issue #43 的教训）。
 */
const BARE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

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
  // 支持范围是「已验证引擎版本」的析取：每个分支都必须是裸版本号，
  // 于是一个分支对应且只对应一个经过引擎验证的宿主。
  const admitted = range.split('||').map((part) => part.trim())
  for (const part of admitted) {
    assert.match(
      part,
      BARE_VERSION,
      `peer range branch ${JSON.stringify(part)} must be a bare verified version`,
    )
  }
  // 范围与 dshReleases 必须逐条对应：既不允许放行没有验证记录的引擎，
  // 也不允许某个已验证引擎被范围漏掉。
  const declared = Object.keys(pkg.dsh?.compatibility?.dshReleases ?? {})
  assert.deepEqual(
    [...admitted].sort(),
    [...declared].sort(),
    'the peer range must be exactly the disjunction of the declared-compatible releases',
  )
})

test('per-release DSH compatibility lists only verified releases', () => {
  // DSH STORE only restores a listing from exact per-release records under
  // dsh.compatibility.dshReleases, and a release with no record reads as
  // `unknown`. DSH itself refuses to load a plugin whose declared engine range
  // does not admit the running engine, so every record here must name a bare
  // version the honest peer range also admits — never a range, and never an
  // engine that no `test:engine` run covers.
  const releases = pkg.dsh?.compatibility?.dshReleases ?? {}
  const declared = Object.keys(releases)
  assert.ok(declared.length > 0, 'at least one declared-compatible release')
  for (const version of declared) {
    assert.match(version, BARE_VERSION, `${version} must be a bare version`)
    assert.equal(releases[version], 'compatible')
  }
})

test('DSH compatibility keeps the verified release candidates and one alpha release', () => {
  // 向下兼容策略：RC 通道保留「最新已验证 + 上一稳定」两条，alpha 通道保留一条；
  // 每条都必须有一个真实的 `test:engine` 验证记录（由 dshReleases 与 peer 范围逐条对应保证）。
  // 同通道升级不再删掉上一稳定 RC（0.2.0-rc.2 是官方 npm `latest` 的宿主），
  // 但也不无限累加历史分支：新增分支前必须先在真实引擎上跑完整矩阵。
  // 离线测试只约束通道构成，最新版本由升级审计核对官方发布事实。
  const declared = Object.keys(pkg.dsh?.compatibility?.dshReleases ?? {})
  assert.ok(declared.length >= 2, 'at least one RC and one alpha release')
  assert.ok(
    declared.filter((version) => /^\d+\.\d+\.\d+-rc\.\d+$/.test(version)).length >= 1,
    'at least one release candidate',
  )
  assert.equal(
    declared.filter((version) => /^\d+\.\d+\.\d+-alpha\.\d+$/.test(version)).length,
    1,
    'exactly one alpha release',
  )
  assert.equal(new Set(declared).size, declared.length, 'no duplicate declarations')
})

test('the manifest declares the same engine range it supports', () => {
  // 三处必须逐字相同。**`engines.dsh` 不是装饰**：自 dsh `0.2.1-alpha.4`（含 `0.2.1-rc.2`）起，
  // 宿主 `evaluatePluginCompatibility` 在包自带 `engines.dsh` 时**只**看它，
  // 完全忽略 `@deepseek-ai/dsh*` peer（`app-boot/src/plugin-compatibility.ts`）；
  // 判定不通过时插件行被禁用、bundle 层被静默跳过、安装被拒绝。
  // `compatibility.dsh` 仍是我们自己的声明面（宿主不读它），由外部目录消费；
  // 三者分开维护必然漂移，故在此钉死相等。
  const supported = pkg.peerDependencies?.['@deepseek-ai/dsh-llm']
  assert.equal(pkg.dsh?.compatibility?.dsh, supported)
  assert.equal(pkg.engines?.dsh, supported)
  assert.equal(pkg.engines?.node, '>=22')
})

test('the Web client remains enabled without dsh-client-runtime', () => {
  assert.equal(pkg.dsh?.client?.platform, 'web')
  assert.equal(pkg.peerDependencies?.['@deepseek-ai/dsh-client-runtime'], undefined)
  assert.equal(pkg.devDependencies?.['@deepseek-ai/dsh-client-runtime'], undefined)
})

test('the client manifest contains only live client graph edges', () => {
  assert.deepEqual(pkg.dsh?.client?.inject, [
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-settings',
    '@deepseek-ai/dsh-api-remotes',
  ])
  assert.equal(pkg.dsh?.client?.inject?.includes('@deepseek-ai/dsh-client-connection'), false)
  assert.equal(pkg.peerDependencies?.['@deepseek-ai/dsh-client-connection'], undefined)
  assert.equal(pkg.devDependencies?.['@deepseek-ai/dsh-client-connection'], undefined)
})

test('only the client-seeded UI peers are optional, and each stays a development package', () => {
  // The Web frontend hands every client bundle a `staticModules` seed table, and
  // lib/client.js requires exactly three of it: react, react/jsx-runtime (both
  // from the `react` package) and @deepseek-ai/dsh-client-ui-primitives. No
  // installed copy is needed at runtime, while a Desktop release — which
  // validates the whole peer closure of every active plugin and ships host
  // packages only — refuses to start unless those three are optional
  // (`desktop profile: … requires missing …`).
  //
  // The set is load-bearing in BOTH directions:
  //   - an optional peer is NEVER installed (npm and pnpm auto-install only
  //     missing non-optional peers), so every name here must also be a
  //     devDependency or the authortime tree silently loses it. `react` is the
  //     live case: tests/client-boot.test.ts imports the React component tree at
  //     runtime and nothing else would pull `react` in.
  //   - a host-required peer marked optional here would stop being installed in a
  //     fresh marketplace generation, and no other check can see that.
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
