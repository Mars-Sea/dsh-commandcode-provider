/** 隔离验证 dsh「插件更新」资格链路（发布前回归）。
 *
 * 为什么必须隔离：插件更新资格取决于 profile 里保存的依赖 spec。开发用的 `web` profile
 * 以 `link:` 指向工作区，宿主 `updateRefusal()` 明确把它排除在更新之外，所以在它上面
 * 永远看不到「版本」区块；直接改它还会碰到 `bundle-in-use`（用户层仍有引用该组合包的行）。
 * 本脚本用 `DSH_HOME` 指向一个独立目录，从官方 web 模板建干净 profile，再从 npm 注册表
 * 安装一个较旧的已发布版本，复现真实用户的安装形态，全程不触碰 `~/.dsh` 与运行中的 GUI。
 *
 * 验证边界（不夸大）：
 *  - 脚本**不**调用运行中 Host 的 `pluginManager.listVersions()` / `updateBundle()`：
 *    那需要挂载完整 Loader 树与 HMR，成本高且脆弱。它复现 `updateRefusal()` 的资格判定，
 *    并跑与 `listVersions()` / `updateBundle()` 的 check **完全相同的 `pnpm view` 查询**；
 *    引擎兼容性判定直接复用宿主的 `evaluatePluginCompatibility()`。
 *  - 真正的宿主调用由隔离 Web GUI 完成：打开插件页看「版本」区块与「可更新」，点「更新」
 *    即宿主真机执行 check → remove → install（失败时 restore）。之后用 `--verify-result`
 *    断言 profile 已精确更新到目标版本，形成闭环。
 *
 * 用法：
 *   node scripts/verify-plugin-update.mjs                     # 自动临时 home，跑完删除
 *   node scripts/verify-plugin-update.mjs --home /tmp/iso    # 指定目录并保留（供 GUI 复用）
 *   node scripts/verify-plugin-update.mjs --home /tmp/iso --verify-result
 *   node scripts/verify-plugin-update.mjs --installed 0.17.1 --target 0.17.2
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDshRuntimeVersion, evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot'

const repositoryDir = resolve(fileURLToPath(new URL('..', import.meta.url)))
const manifest = JSON.parse(readFileSync(join(repositoryDir, 'package.json'), 'utf8'))
const PKG = manifest.name
const PROFILE = 'verify-update'

/** 只处理稳定版三段号：预发布版本带 `-`，由调用方过滤，不参与这里的大小比较。 */
function compareStable(a, b) {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}

/** 子进程执行：失败时把 stdout/stderr 一起带出，避免只报退出码看不到 pnpm 的诊断。 */
function run(command, args, env, cwd = repositoryDir) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status}\n${result.stdout ?? ''}${result.stderr ?? ''}`)
  }
  return result.stdout ?? ''
}

/** 解析命令行开关；`--verify-result` 与主流程互斥，其余都是可选覆盖。 */
function parseArgs(argv) {
  const options = { home: undefined, installed: undefined, target: undefined, verifyResult: false }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--verify-result') options.verifyResult = true
    else if (flag === '--home' || flag === '--installed' || flag === '--target') {
      const value = argv[++index]
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`)
      options[flag.slice(2)] = value
    } else throw new Error(`unknown argument ${flag}`)
  }
  return options
}

/** 宿主 `dependencySpec()` + `parseInstallSpec()` 的形态判定，只保留本脚本需要的分类。
 *  依据：dsh-plugin-manager 的 `updateRefusal()` 第四条——安装来源必须是「以自身包名保存的
 *  注册表 spec」，且不能是 `npm:` 别名；`link:`/`file:`/git/tarball 一律不可更新。
 */
function specKind(recorded) {
  if (/^(?:file|link):/.test(recorded)) return 'path'
  if (/^(?:npm|jsr|workspace|catalog):/.test(recorded)) return 'alias'
  if (/^(?:git\+|git@|[a-z]+:)/i.test(recorded) && !/^https?:\/\//i.test(recorded)) return 'git'
  if (/^https?:\/\//i.test(recorded)) return /\.(?:tgz|tar\.gz)(?:#.*)?$/i.test(recorded) ? 'tarball' : 'git'
  return 'registry'
}

/** 读 profile 保存的依赖值；宿主按 `name@<recorded>` 还原成可安装的 spec。 */
function profileDependency(home) {
  const file = join(home, 'profiles', PROFILE, 'package.json')
  if (!existsSync(file)) throw new Error(`isolated profile missing: ${file}`)
  const profile = JSON.parse(readFileSync(file, 'utf8'))
  const recorded = profile.dependencies?.[PKG]
  if (typeof recorded !== 'string') throw new Error(`profile does not declare ${PKG} as a dependency`)
  const installedFile = join(home, 'profiles', PROFILE, 'node_modules', PKG, 'package.json')
  const installedVersion = existsSync(installedFile)
    ? JSON.parse(readFileSync(installedFile, 'utf8')).version
    : undefined
  return { profile, recorded, installedVersion, selected: profile.dsh?.profile?.bundles?.includes(PKG) === true }
}

/** 与宿主 `listVersions()` 同源的注册表查询：全部版本 + 发布时间 + dist-tags。 */
function versionListing(env, profileDir) {
  const output = run('pnpm', ['view', PKG, 'versions', 'time', 'dist-tags', '--json'], env, profileDir)
  const parsed = JSON.parse(output)
  const versions = Array.isArray(parsed.versions) ? parsed.versions : [parsed.versions]
  return { versions: versions.filter((v) => typeof v === 'string'), tags: parsed['dist-tags'] ?? {} }
}

/** 与宿主 `updateBundle()` 的 check 同源：单版本清单字段。 */
function versionFacts(version, env, profileDir) {
  const output = run(
    'pnpm',
    ['view', `${PKG}@${version}`, 'name', 'version', 'engines', 'peerDependencies', 'deprecated', 'dsh', '--json'],
    env,
    profileDir,
  )
  return JSON.parse(output)
}

/** 从注册表挑「装旧版 / 更新到最新版」：只取稳定版，避免预发布被 UI 默认隐藏。 */
function pickVersions(options, env, profileDir) {
  const { versions, tags } = versionListing(env, profileDir)
  const stable = versions.filter((v) => /^\d+\.\d+\.\d+$/.test(v)).sort(compareStable).reverse()
  const target = options.target ?? tags.latest ?? stable[0]
  if (typeof target !== 'string' || !stable.includes(target)) {
    throw new Error(`target version ${JSON.stringify(target)} is not a published stable version`)
  }
  const installed = options.installed ?? stable.find((v) => compareStable(v, target) < 0)
  if (typeof installed !== 'string' || compareStable(installed, target) >= 0) {
    throw new Error(`cannot pick an older installed version before ${target}`)
  }
  return { installed, target, stable }
}

/** 复现 `updateRefusal()` 对已安装组合包的资格判定，逐条给出可读的失败原因。 */
function assertUpdatable(home, recorded, installedVersion, selected) {
  const checks = [
    [selected === true, `${PKG} is not selected in the profile's dsh.profile.bundles`],
    [PKG.startsWith('@deepseek-ai/') === false, `${PKG} is an installation-provided bundle, not a third-party dependency`],
    [PKG !== '@deepseek-ai/dsh-plugin-manager', `${PKG} carries plugin management and cannot be removed`],
    [typeof installedVersion === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(installedVersion),
      `${PKG} declares no semver version (read ${String(installedVersion)})`],
    [specKind(recorded) === 'registry', `${PKG} is not installed from a registry (saved spec: ${recorded})`],
    [recorded.includes(':') === false, `${PKG} is saved under an alias spec (${recorded})`],
  ]
  for (const [ok, reason] of checks) if (!ok) throw new Error(`not-updatable: ${reason}`)
  return `${PKG}@${installedVersion} saved as "${recorded}" (registry spec under its own name)`
}

/** 复现 `updateBundle()` 的 check：目标存在、声明组合包、引擎接纳、非弃用、非预发布。 */
function assertTarget(target, env, profileDir) {
  const facts = versionFacts(target, env, profileDir)
  const check = evaluatePluginCompatibility(
    {
      name: typeof facts.name === 'string' ? facts.name : PKG,
      version: typeof facts.version === 'string' ? facts.version : target,
      ...(facts.engines === undefined ? {} : { engines: facts.engines }),
      ...(facts.peerDependencies === undefined ? {} : { peerDependencies: facts.peerDependencies }),
    },
    {},
  )
  const problems = []
  if (facts.dsh?.bundle === undefined) problems.push('declares no dsh.bundle')
  if (check !== undefined && check.exempted !== true) {
    problems.push(`engines.dsh rejects the running dsh ${getDshRuntimeVersion()}`)
  }
  if (typeof facts.deprecated === 'string' && facts.deprecated !== '') problems.push('is deprecated')
  if (/^\d+\.\d+\.\d+-/.test(target)) problems.push('is a prerelease (hidden by default in the UI)')
  if (problems.length > 0) throw new Error(`update target ${target} would be refused at step "check": ${problems.join('; ')}`)
  return `dsh.bundle=${JSON.stringify(facts.dsh.bundle)}, engines.dsh=${JSON.stringify(facts.engines?.dsh)}`
}

/** `--verify-result`：用户在隔离 GUI 点完「更新」后，断言 profile 已 saveExact 到目标版本。 */
function verifyResult(home, target) {
  const { recorded, installedVersion } = profileDependency(home)
  if (recorded !== target) {
    throw new Error(`profile dependency is "${recorded}", expected exact "${target}" after updateBundle(saveExact)`)
  }
  if (installedVersion !== target) {
    throw new Error(`installed copy is ${String(installedVersion)}, expected ${target}`)
  }
  process.stdout.write(`PASS: profile dependency saved exactly as "${recorded}" and installed copy is ${installedVersion}\n`)
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const ownedHome = options.home === undefined
  const home = options.home ?? mkdtempSync(join(tmpdir(), 'dsh-plugin-update-'))
  const env = { DSH_HOME: home, npm_config_cache: join(home, 'npm-cache') }

  if (options.verifyResult) {
    if (ownedHome) throw new Error('--verify-result needs --home <dir> pointing at the prepared isolated home')
    const { tags } = versionListing(env, join(home, 'profiles', PROFILE))
    verifyResult(home, options.target ?? tags.latest)
    return
  }

  if (!ownedHome && existsSync(join(home, 'profiles', PROFILE))) {
    throw new Error(`${home}/profiles/${PROFILE} already exists; use a fresh --home to avoid overwriting user data`)
  }

  try {
    process.stdout.write(`[1/6] isolated DSH_HOME = ${home}\n`)

    // `--dump-config` 只组合配置并退出，但会按官方 web 模板创建 profile 目录与清单。
    run('dsh', ['--profile', PROFILE, '--from-default-profile', 'web', '--dump-config'], env)
    process.stdout.write('[2/6] fresh profile created from the shipped web template (dsh-base + dsh-web-app)\n')

    const profileDir = join(home, 'profiles', PROFILE)
    const { installed, target } = pickVersions(options, env, profileDir)
    process.stdout.write(`[3/6] registry plan: install ${PKG}@${installed}, expect update to ${target}\n`)

    run('dsh', ['plugin', '--profile', PROFILE, 'add', `${PKG}@${installed}`], env)
    const { recorded, installedVersion, selected } = profileDependency(home)
    if (installedVersion !== installed) {
      throw new Error(`pnpm installed ${String(installedVersion)}, expected ${installed}`)
    }

    process.stdout.write(`[4/6] ${assertUpdatable(home, recorded, installedVersion, selected)}\n`)

    const listing = versionListing(env, profileDir)
    const newer = listing.versions.filter((v) => /^\d+\.\d+\.\d+$/.test(v) && compareStable(v, installed) > 0)
    if (!newer.includes(target)) throw new Error(`listVersions would not list ${target} as newer than ${installed}`)
    if (listing.tags.latest !== target) {
      process.stdout.write(`      note: dist-tags.latest is ${listing.tags.latest}, target ${target} comes from the version list\n`)
    }
    process.stdout.write(`[5/6] listVersions would offer ${newer.length} newer stable version(s), including ${target}\n`)

    process.stdout.write(`[6/6] ${assertTarget(target, env, profileDir)}\n`)

    process.stdout.write(`\nPASS: ${PKG} is updatable from ${installed} to ${target} in an isolated registry install.\n`)
    if (ownedHome) {
      process.stdout.write('      (temporary home removed; use --home <dir> to keep it for the Web GUI check)\n')
    } else {
      process.stdout.write(`\nNext, start the isolated GUI (independent port, does not touch the running 3080):\n`)
      process.stdout.write(`  DSH_HOME=${home} dsh --profile ${PROFILE} --no-open --port 8099\n`)
      process.stdout.write(`Then open the printed URL, go to Plugins → ${PKG} → Versions, and click Update.\n`)
      process.stdout.write(`Afterwards: node scripts/verify-plugin-update.mjs --home ${home} --verify-result\n`)
    }
  } finally {
    if (ownedHome) rmSync(home, { recursive: true, force: true })
  }
}

main()
