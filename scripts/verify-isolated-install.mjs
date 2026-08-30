/** Isolated pnpm installation regression for marketplace-style generations. */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PNPM_VERSION = '10.34.5'
const repositoryDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'

/** Run a child command and return its captured streams or throw with diagnostics. */
function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: process.env,
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
    const packed = JSON.parse(packOutput)
    const filename = packed[0]?.filename
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
    if (!lock.includes('@deepseek-ai/dsh-invariants@')) {
      throw new Error(
        'isolated install did not resolve the invariants peer\n'
        + installResult.stdout
        + installResult.stderr,
      )
    }
    process.stdout.write(`isolated install passed with pnpm ${PNPM_VERSION}\n`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

verifyIsolatedInstall()
