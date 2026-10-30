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

/** 一个「裸」语义化版本号：不带任何范围操作符（`dshReleases` 的键必须是它）。 */
const BARE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/**
 * 支持范围是「同通道区间」而不是裸版本析取（用户 2026-10-24 拍板）：每个分支锁定一条
 * major.minor.patch 版本线，下界是该线上已验证的最新预发布，上界写成**同一 major.minor 的
 * 下一个 patch** 的 `-0` 预发布号。自 2026-10-28 起有两个并列分支（用户拍板「放开整个
 * 0.2.2 通道」）：`0.2.1` 的 `-rc.N` 线与 `0.2.2` 的 `-alpha.N` 线。两条线的预发布序列
 * 不相交，一个区间写不出来，所以用 ` || ` 并列而不是把上界推到 0.3.0-0。
 *
 * 为什么上界必须是 `<X.Y.(Z+1)-0`：按 semver 优先级 `0.2.2-rc.1 < 0.2.2`，所以写成
 * `<0.2.2` 会把下一条线的 RC 放进来；`~0.2.1-rc.2` 更糟（等价于 `>=0.2.1-rc.2 <0.3.0`，
 * 连 0.2.2 与 0.2.3 整段都放行）。`-0` 是唯一能精确排除「下一条线的任何预发布」的写法
 * （node semver 实测，见 docs/agent-reference/engine-compatibility.md）。
 */
const CHANNEL_BRANCH = /^>=(\d+)\.(\d+)\.(\d+)-([0-9A-Za-z.-]+) <(\d+)\.(\d+)\.(\d+)-0$/

/** 预发布类型的 semver 优先级：alpha < beta < rc。 */
const PRERELEASE_ORDER: Record<string, number> = { alpha: 0, beta: 1, rc: 2 }

/**
 * 一条记录在某个通道内的「等级」，用于和该通道下界比较；不属于该通道时返回 undefined。
 * 同通道指 major.minor.patch 完全相同（`0.2.1` 与 `0.2.1-rc.2` 同通道）。
 * 无预发布的正式版高于任何预发布，用 MAX_SAFE_INTEGER 表示。
 */
function releaseRank(version: string, channel: string): number | undefined {
  const dash = version.indexOf('-')
  const bare = dash === -1 ? version : version.slice(0, dash)
  const prerelease = dash === -1 ? undefined : version.slice(dash + 1)
  if (bare !== channel) return undefined
  if (prerelease === undefined) return Number.MAX_SAFE_INTEGER
  const [kind, serial] = prerelease.split('.')
  const order = PRERELEASE_ORDER[kind ?? '']
  assert.ok(order !== undefined, `${version} uses an unsupported prerelease kind ${String(kind)}`)
  return order * 1000 + Number(serial)
}

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

  // 每个分支都必须是「>=<该线已验证的预发布> <<同一 major.minor 的下一个 patch>-0」。
  const branches = range.split(' || ').map((branch) => {
    const admitted = CHANNEL_BRANCH.exec(branch)
    assert.ok(
      admitted,
      `peer range branch ${JSON.stringify(branch)} must be ">=<verified prerelease> <next patch>-0"`,
    )
    const [, major, minor, patch, prerelease, upperMajor, upperMinor, upperPatch] = admitted
    // 上界是「同一个 major.minor 的下一个 patch 的 `-0`」，也就是给这一条版本线封口：
    // 下界 0.2.1-rc.2 → 上界 0.2.2-0（0.2.1 的预发布与正式版全准入，0.2.2 及以后全排除），
    // 下界 0.2.2-alpha.2 → 上界 0.2.3-0。写成 0.3.0-0 会把 0.2.2 之后整段 0.2.x 也放进来，
    // 写成 0.2.1-0 又会把下界自己排除在外。
    assert.equal(upperMajor, major, `branch ${JSON.stringify(branch)} upper bound must keep the lower bound's major`)
    assert.equal(upperMinor, minor, `branch ${JSON.stringify(branch)} upper bound must keep the lower bound's minor`)
    assert.equal(
      Number(upperPatch),
      Number(patch) + 1,
      `branch ${JSON.stringify(branch)} upper bound must be the next patch line's "-0"`,
    )
    const channel = `${major}.${minor}.${patch}`
    const lowerRank = releaseRank(`${channel}-${prerelease}`, channel)
    assert.ok(lowerRank !== undefined, `branch ${JSON.stringify(branch)} lower bound must be a prerelease`)
    return { channel, lowerRank }
  })
  assert.ok(
    branches.length >= 1 && branches.length <= 2,
    'declare at most the current minor and the one whose prereleases are verified',
  )

  // 记录是「实测过哪些版本」，区间是「放行哪些版本」：方向相反但必须相容——
  // 每条记录都要落在某个分支的通道内，且不得早于该分支已验证的下界
  // （`0.2.1-rc.1` 及更早、`0.2.2-alpha.1` 从未验证过）。
  const declared = Object.keys(pkg.dsh?.compatibility?.dshReleases ?? {})
  for (const version of declared) {
    assert.match(version, BARE_VERSION, `${version} must be a bare version`)
    const owners = branches
      .map((branch) => ({ branch, rank: releaseRank(version, branch.channel) }))
      .filter((entry): entry is { branch: { channel: string; lowerRank: number }; rank: number } => entry.rank !== undefined)
    assert.ok(owners.length > 0, `${version} is not in any declared channel of ${JSON.stringify(range)}`)
    assert.ok(
      owners.some(({ branch, rank }) => rank >= branch.lowerRank),
      `${version} is older than the verified lower bound of its channel, so the range cannot admit it`,
    )
  }
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

test('DSH compatibility records every verified release of the admitted channel range', () => {
  // 用户 2026-10-24 拍板：准入由 `engines.dsh` 的区间负责（同通道已验证下界及以上自动放行），
  // 本记录只列**实际跑过完整引擎矩阵**的版本 —— 0.2.1 通道的 rc.2、rc.3、rc.4、
  // rc.5（2026-10-30 补入，npm `latest`／`next`），以及 2026-10-28 用户拍板放开
  // 0.2.2 通道后补入的 alpha.2（npm `alpha`，`test:engine` 与 `test:install` 均跑过）。
  // 未来同通道新版本无需改声明即可准入，但只有补上记录才算已验证；
  // 这份记录同时是 `test:engine` 与 `test:install` 的矩阵来源，加记录就必须先跑通它们。
  const declared = Object.keys(pkg.dsh?.compatibility?.dshReleases ?? {})
  assert.equal(declared.length, 5, 'keep exactly the verified engine releases')
  assert.deepEqual(
    [...declared].sort(),
    ['0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.4', '0.2.1-rc.5', '0.2.2-alpha.2'],
    'one record per channel: the 0.2.1 RC line plus the 0.2.2 alpha line',
  )
})

test('the manifest declares the same engine range it supports', () => {
  // 三处必须逐字相同。**`engines.dsh` 不是装饰**：自 dsh `0.2.1-alpha.4` 起，
  // 宿主 `evaluatePluginCompatibility` 在包自带 `engines.dsh` 时**只**看它，
  // 完全忽略 `@deepseek-ai/dsh*` peer（`app-boot/src/plugin-compatibility.ts`）；
  // 判定不通过时插件行被禁用、bundle 层被静默跳过、安装被拒绝。
  // `compatibility.dsh` 仍是我们自己的声明面（宿主不读它），由外部目录消费；
  // 三者分开维护必然漂移，故在此钉死相等。
  const supported = pkg.peerDependencies?.['@deepseek-ai/dsh-llm']
  assert.equal(pkg.dsh?.compatibility?.dsh, supported)
  assert.equal(pkg.engines?.dsh, supported)
  // Node 下界随 0.2.2 通道升到 24.9：`@deepseek-ai/dsh@0.2.2-alpha.2` 自己声明
  // `engines.node >=24.9.0`，而本插件同时准入它，所以整个包的 Node 门槛必须跟着抬到
  // 同一水位 —— 否则会出现「插件声称支持某引擎，但那个引擎在这台机器的 Node 上起不来」。
  // 代价是 Node 22/23 用户失去支持，升级说明写在两份 README 与 CHANGELOG。
  assert.equal(pkg.engines?.node, '>=24.9')
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
