/** Isolated pnpm installation regression for marketplace-style generations. */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packedEntry } from './npm-pack-json.mjs'

const PNPM_VERSION = '10.34.5'
const repositoryDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const npmCache = join(repositoryDir, '.npm-cache')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
/** This checkout's own manifest: the peer assertion below is read from it, never hardcoded. */
const manifest = JSON.parse(readFileSync(join(repositoryDir, 'package.json'), 'utf8'))

/**
 * 需要逐版本验证的 Harness 包：peer 声明里所有**必需**的 `@deepseek-ai/dsh-*`。
 *
 * 可选 peer（客户端预置的 `react`、`dsh-client-ui-primitives`、`dsh-client-ui-slots`）
 * 不参与：npm 与 pnpm 都不会为可选 peer 自动安装，宿主 Web 前端自带这些模块，
 * 把它们写进隔离安装的依赖只会引入无关的解析失败。
 */
const requiredHarnessPeers = Object.keys(manifest.peerDependencies ?? {})
  .filter((name) => name.startsWith('@deepseek-ai/dsh-')
    && manifest.peerDependenciesMeta?.[name]?.optional !== true)

/**
 * 已验证引擎版本集合：取自 `@deepseek-ai/dsh-*` peer 范围的每个裸版本分支。
 *
 * 断言锚点选 `@deepseek-ai/dsh-llm`：它是适配器的宿主底座，任何 fresh generation 都必须
 * 解析到它。`dsh-invariants` 曾承担这个角色，但上游在 0.2.1-alpha.1 删除了整个包
 * （npm 上从未发布该版本），因此插件不再声明它。
 * 声明与兼容记录的一致性由 `tests/package.test.ts` 守；这里额外断言两者逐条对应，
 * 避免插件清单改了一处、隔离安装却在验证另一处。
 */
const declaredPeerRange = manifest.peerDependencies['@deepseek-ai/dsh-llm']
if (typeof declaredPeerRange !== 'string') throw new Error('manifest declares no @deepseek-ai/dsh-llm peer')
const declaredVersions = declaredPeerRange.split('||').map((part) => part.trim())
const recordedVersions = Object.keys(manifest.dsh?.compatibility?.dshReleases ?? {})
if ([...declaredVersions].sort().join() !== [...recordedVersions].sort().join()) {
  throw new Error(
    'the @deepseek-ai/dsh-llm peer range and dsh.compatibility.dshReleases disagree '
    + `(declared ${declaredVersions.join(' | ')}; recorded ${recordedVersions.join(' | ') || 'none'})`,
  )
}

/** Run a child command and return its captured streams or throw with diagnostics. */
function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, npm_config_cache: npmCache },
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status}\n${output}`)
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/**
 * Pack this checkout ONCE and install the tarball into a fresh pnpm generation per declared
 * engine version.
 *
 * 为什么每个版本各装一次：pnpm 只会为 peer 范围解析出**一个**满足条件的版本（通常是范围里
 * 最新的那个分支），所以单次 `pnpm add` 全绿只证明那一个引擎能装。这里把该版本的必需 Harness
 * 同伴依赖一起钉死，逐版本重装，再断言锁文件解析出的 `@deepseek-ai/dsh-llm` 恰好是目标版本。
 */
function packOnce() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-commandcode-install-'))
  const packDir = join(root, 'pack')
  mkdirSync(packDir)
  try {
    const packOutput = run(npm, [
      'pack',
      '--ignore-scripts',
      '--json',
      '--pack-destination',
      packDir,
    ], repositoryDir).stdout
    // npm 10 runs this project's `prepare` (tsdown) even with
    // --ignore-scripts, and its banners land on STDOUT ahead of the JSON —
    // `packedEntry` skips them. See ./npm-pack-json.mjs.
    const entry = packedEntry(packOutput)
    const filename = entry?.filename
    if (typeof filename !== 'string') throw new Error('npm pack did not report a tarball filename')
    return { root, tarball: join(packDir, filename) }
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

/** Install the tarball with every required Harness peer pinned to one exact engine version. */
function verifyIsolatedInstall(tarball, version) {
  const consumerDir = mkdtempSync(join(tmpdir(), `dsh-commandcode-install-${version}-`))
  try {
    writeFileSync(join(consumerDir, 'package.json'), `${JSON.stringify({
      name: 'dsh-commandcode-install-smoke',
      private: true,
      version: '0.0.0',
    }, null, 2)}\n`)
    writeFileSync(join(consumerDir, '.npmrc'), 'node-linker=hoisted\nside-effects-cache=false\n')

    const installResult = run(npx, [
      '--yes',
      `pnpm@${PNPM_VERSION}`,
      'add',
      tarball,
      ...requiredHarnessPeers.map((name) => `${name}@${version}`),
    ], consumerDir)
    const lock = readFileSync(join(consumerDir, 'pnpm-lock.yaml'), 'utf8')
    // 断言锁文件解析出的 @deepseek-ai/dsh-llm 恰好是本次目标版本：安装成功但解析到别的分支，
    // 说明钉版本没有生效，这一轮不能算这个引擎通过。
    const resolvedVersions = [...new Set(
      [...lock.matchAll(/@deepseek-ai\/dsh-llm@([^'"\s:()]+)/g)].map((match) => match[1]),
    )]
    if (resolvedVersions.length !== 1 || resolvedVersions[0] !== version) {
      throw new Error(
        `isolated install for dsh ${version} resolved ${resolvedVersions.join(', ') || 'no'} `
        + '@deepseek-ai/dsh-llm instead of the pinned version\n'
        + installResult.stdout
        + installResult.stderr,
      )
    }
    process.stdout.write(`isolated install passed with pnpm ${PNPM_VERSION} (dsh ${version})\n`)
  } finally {
    rmSync(consumerDir, { recursive: true, force: true })
  }
}

const packed = packOnce()
try {
  for (const version of declaredVersions) verifyIsolatedInstall(packed.tarball, version)
  process.stdout.write(`engine matrix verified: ${declaredVersions.join(', ')}\n`)
} finally {
  rmSync(packed.root, { recursive: true, force: true })
}
