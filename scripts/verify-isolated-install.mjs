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

/** Pack this checkout and install the tarball into a fresh pnpm generation. */
function verifyIsolatedInstall() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-commandcode-install-'))
  const packDir = join(root, 'pack')
  const consumerDir = join(root, 'consumer')
  mkdirSync(packDir)
  mkdirSync(consumerDir)
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
      join(packDir, filename),
    ], consumerDir)
    const lock = readFileSync(join(consumerDir, 'pnpm-lock.yaml'), 'utf8')
    // 断言一个仍然存在、且本插件确实声明为 peer 的核心宿主包。dsh-invariants
    // 曾承担这个角色，但上游在 0.2.1-alpha.1 删除了整个包（npm 上从未发布该版本），
    // 因此改用 dsh-llm —— 适配器的宿主底座，任何 fresh generation 都必须解析到它。
    // 声明的 peer 是「已验证引擎版本」的析取（护栏见 tests/package.test.ts），
    // 所以这里要在锁文件里找到其中至少一个确切版本，而不是整串范围文本。
    const declaredPeerRange = manifest.peerDependencies['@deepseek-ai/dsh-llm']
    const declaredPeerVersions = declaredPeerRange.split('||').map((part) => part.trim())
    const resolvedVersions = [...new Set(
      [...lock.matchAll(/@deepseek-ai\/dsh-llm@([^'"\s:()]+)/g)].map((match) => match[1]),
    )]
    const resolvedPeer = declaredPeerVersions.find((version) => resolvedVersions.includes(version))
    if (resolvedPeer === undefined) {
      throw new Error(
        'isolated install resolved no declared peer version of @deepseek-ai/dsh-llm '
        + `(declared ${declaredPeerVersions.join(' | ')}; resolved ${resolvedVersions.join(', ') || 'none'})\n`
        + installResult.stdout
        + installResult.stderr,
      )
    }
    process.stdout.write(`isolated install passed with pnpm ${PNPM_VERSION} (dsh-llm ${resolvedPeer})\n`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

verifyIsolatedInstall()
