/** 校验真正的发布文件列表，不能用工作区存在的源码冒充已打包的入口。 */
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { packedEntry } from './npm-pack-json.mjs'

/** 条件入口递归展开；通配目标必须至少对应一个发布文件。 */
export function verifyPackedExports(manifest, files) {
  const problems = []
  const targets = [manifest.main, manifest.types]
  const walk = (value) => {
    if (typeof value === 'string') targets.push(value)
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(walk)
  }
  walk(manifest.exports)
  for (const target of new Set(targets.filter((value) => typeof value === 'string'))) {
    const relative = target.replace(/^\.\//, '')
    const pattern = new RegExp(`^${relative.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
    if (!files.some((file) => pattern.test(file))) problems.push(`发布入口没有对应文件：${target}`)
  }
  return problems
}

function main() {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const packed = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root, encoding: 'utf8',
  })
  if (packed.error !== undefined) throw packed.error
  if (packed.status !== 0) throw new Error(packed.stderr || `打包检查退出 ${packed.status}`)
  // npm 10 runs this project's `prepare` (tsdown) even with --ignore-scripts,
  // and its banners land on STDOUT ahead of the JSON — `packedEntry` skips
  // them. See ./npm-pack-json.mjs.
  const entry = packedEntry(packed.stdout)
  if (!Array.isArray(entry?.files) || entry.files.length === 0) throw new Error('打包没有提供发布文件列表')
  const problems = verifyPackedExports(manifest, entry.files.map((file) => file.path))
  if (problems.length > 0) throw new Error(problems.join('\n'))
  console.log(`发布入口检查通过：${entry.files.length} 个文件，版本 ${manifest.version}`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main() } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
