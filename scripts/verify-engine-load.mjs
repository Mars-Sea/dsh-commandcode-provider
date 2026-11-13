/**
 * Engine-load smoke test: prove this bundle LINKS and EVALUATES against a real
 * dsh engine before it ships.
 *
 * Why this exists (issue #43): dsh-llm 0.1.6 removed
 * `offloadRequestImagesWithPolicy`, which the adapter imported by name. The
 * built bundle carried a static ESM named import of a symbol that no longer
 * existed, so on that engine the host half never instantiated — no
 * `commandcode` route, no settings page, no panel — while every check that ran
 * against this checkout's own `node_modules` stayed green, because a
 * `link:`-installed profile resolves the plugin's peers from the checkout
 * rather than from the engine. A named import of an absent export is a
 * link-time failure, so no amount of runtime testing short of importing the
 * bundle from a tree whose peers ARE the engine can see it. The plugin now
 * declares a fixed set of supported engines, so this is also where a peer bump
 * is proven to link before it ships.
 *
 * What it does, in order:
 *   1. Resolves the engine — `--engine <dir>`, `$DSH_ENGINE`, or EVERY release
 *      `package.json` declares `compatible`, freshly installed and checked in
 *      turn. A peer range that admits several engines is only honest while all
 *      of them pass here.
 *   2. Copies this checkout's PUBLISHED surface into a scratch tree whose
 *      `node_modules` are the engine's, then imports the plugin there — the
 *      link check, and the assertion that `name`/`apply`/`Config` survive.
 *   3. Audits every static named import in `lib/index.js` against the engine's
 *      own exports, reporting the missing symbol by name instead of a raw
 *      SyntaxError.
 *   3b. Calls this engine's OWN `evaluatePluginCompatibility` on the published
 *      manifest. Every other check stages the bundle into the engine's peer
 *      tree, so none of them can see the host's ADMISSION verdict — and since
 *      dsh 0.2.1-alpha.4 that verdict reads `engines.dsh` alone and ignores the
 *      dsh peers entirely. "Everything green here, yet the install is refused"
 *      is exactly how the alpha.4 upgrade would otherwise have shipped broken.
 *   4. Audits `lib/client.js`'s `require()` calls against the engine's platform
 *      seed table and its mounted `dsh.client` rows.
 *   5. Asserts the engine exports the whole durable-offload contract the
 *      adapter imports by name, and that `LlmError` carries
 *      `failure.offloadImages` — the payload the adapter's offload request is
 *      read from.
 *   6. Asserts the Config schema really drives this engine's settings forms:
 *      every field except the composition-only `apiKey` carries
 *      `meta.volatile`, and parsing a config through the schema yields a LIVE
 *      reference (`{ get() }`) the loader can commit a write into. A field with
 *      no mark is invisible to and unwritable from the settings page.
 *   7. Builds tool history with this engine's message constructors and captures
 *      both transports' next request. Calls AND results must survive; merely
 *      loading the bundle cannot detect message-envelope drift.
 *   8. Opens the published enrollment watch through the real registry and
 *      Gateway, then proves cancellation waits for a synthetic key write and
 *      compensates. This uses in-memory settings and credentials, no account.
 *   9. 通过真实模型运行时与块装配器检查三协议的成功、截断、取消、空响应、
 *      工具断流和尾部错误；只使用合成响应，不访问提供商。
 *
 * Usage:
 *   node scripts/verify-engine-load.mjs                     # matrix: install + check every declared release
 *   node scripts/verify-engine-load.mjs --engine /path/to/dsh-install
 *   node scripts/verify-engine-load.mjs --engine ~/.dsh/profiles/web
 *   node scripts/verify-engine-load.mjs --version 0.2.1-rc.2
 *
 * Exit codes: 0 the bundle loads on the engine; 1 a check failed; 2 the engine
 * could not be resolved or installed, so "could not run" never reads as
 * "passed" (the same convention as scripts/sync-model-prices.mjs).
 */

import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repositoryDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
/** Every package this bundle may require at runtime follows this scope. */
const SCOPE = '@deepseek-ai'
/** The published surface, i.e. what `npm pack` would put in the tarball. */
const PUBLISHED = ['lib', 'package.json', 'cordis.patch.yml']

const failures = []
const warnings = []

/** Record a failed check and keep going, so one run reports every problem. */
function fail(message) {
  failures.push(message)
}

/** Record a non-fatal observation. */
function warn(message) {
  warnings.push(message)
}

/** Print one engine's report and return whether it passed; the matrix in main owns the exit code. */
function report(engine) {
  for (const message of warnings) process.stdout.write(`  warn  ${message}\n`)
  if (failures.length === 0) {
    process.stdout.write(`engine-load smoke passed against dsh ${engine}\n`)
    return true
  }
  for (const message of failures) process.stderr.write(`  FAIL  ${message}\n`)
  process.stderr.write(`engine-load smoke FAILED against dsh ${engine} (${failures.length})\n`)
  return false
}

/** Leave the process with the "could not run" verdict. */
function abort(message) {
  process.stderr.write(`verify-engine-load: ${message}\n`)
  process.exit(2)
}

/** Run a child command, or throw with its output. */
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: process.env })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status}\n${result.stdout ?? ''}${result.stderr ?? ''}`)
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

/** Parse the launcher's own flags. */
function parseArgs(argv) {
  const options = { engine: process.env.DSH_ENGINE, version: undefined, keep: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--engine') options.engine = argv[++index]
    else if (arg === '--version') options.version = argv[++index]
    else if (arg === '--keep') options.keep = true
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0] + '*/\n')
      process.exit(0)
    } else abort(`unknown argument ${arg}`)
  }
  return options
}

/** Compare two semver strings, prerelease-aware. Enough for dsh's own versions. */
function compareVersions(a, b) {
  const split = (value) => {
    const [core, prerelease = ''] = String(value).split('-', 2)
    return { numbers: core.split('.').map(Number), prerelease: prerelease === '' ? [] : prerelease.split('.') }
  }
  const left = split(a)
  const right = split(b)
  for (let index = 0; index < 3; index += 1) {
    const difference = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0)
    if (difference !== 0) return difference
  }
  // A release outranks its own prereleases; identifiers compare per semver.
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return right.prerelease.length - left.prerelease.length
  }
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    const one = left.prerelease[index]
    const two = right.prerelease[index]
    if (one === undefined) return -1
    if (two === undefined) return 1
    if (one === two) continue
    const numeric = /^\d+$/.test(one) && /^\d+$/.test(two)
    if (numeric) return Number(one) - Number(two)
    return one < two ? -1 : 1
  }
  return 0
}

/**
 * Every release `package.json` claims to support, oldest first.
 *
 * 这里返回的是本插件对用户作出的全部兼容承诺，因此每一个都要跑完整套检查：
 * 只验证其中一个，等于把另一个「已声明兼容」的引擎放行给用户却无人验证，
 * 正是 issue #43 那种绿着发出去的坏配对。
 */
function declaredEngineVersions() {
  const pkg = JSON.parse(readFileSync(join(repositoryDir, 'package.json'), 'utf8'))
  const releases = Object.keys(pkg.dsh?.compatibility?.dshReleases ?? {})
  if (releases.length === 0) abort('package.json declares no dsh.compatibility.dshReleases')
  return releases.sort(compareVersions)
}

/**
 * The engine's module directory (the one holding the package scope) plus its
 * dsh-llm version. Accepts either an install root or a `node_modules` path.
 */
function resolveEngine(dir) {
  for (const modules of [join(dir, 'node_modules'), dir]) {
    const manifest = join(modules, SCOPE, 'dsh-llm', 'package.json')
    if (existsSync(manifest)) {
      return { modules, root: dirname(modules), version: JSON.parse(readFileSync(manifest, 'utf8')).version }
    }
  }
  abort(`${dir} is not an engine: no ${SCOPE}/dsh-llm under it or its node_modules.\n`
    + '  Point --engine at an installed dsh (the npx cache entry) or at a profile.\n'
    + '  Note that a profile usually LINKS the plugin, so its own node_modules is not\n'
    + '  the engine — use the install directory `dsh` itself resolved from.')
}

/** Install one engine release into a scratch root and return it. */
function installEngine(version) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-engine-load-'))
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name: 'dsh-engine-load', private: true, version: '0.0.0' }, null, 2)}\n`)
  // A self-contained cache: the check must not depend on (or disturb) the
  // user's npm cache, and repeat runs then reuse the download.
  const cache = join(tmpdir(), 'dsh-engine-load-npm-cache')
  mkdirSync(cache, { recursive: true })
  process.stdout.write(`installing ${SCOPE}/dsh@${version} (first run downloads the engine)\n`)
  run(npm, ['install', '--no-audit', '--no-fund', '--cache', cache, `${SCOPE}/dsh@${version}`], root)
  return root
}

/** Every static named import in one built file, by module specifier. */
function namedImports(source) {
  const imports = new Map()
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    const names = match[1]
      .split(',')
      .map((entry) => entry.trim().split(/\s+as\s+/)[0].trim())
      .filter((name) => name !== '' && !name.startsWith('type '))
    if (names.length === 0) continue
    const existing = imports.get(match[2]) ?? new Set()
    for (const name of names) existing.add(name)
    imports.set(match[2], existing)
  }
  return imports
}

/** Every `require("…")` specifier in one built client bundle. */
function requiredModules(source) {
  return new Set([...source.matchAll(/require\(["']([^"']+)["']\)/g)].map((match) => match[1]))
}

/** Resolve one specifier from the engine root and read its runtime exports. */
async function engineExports(engineRoot, specifier) {
  const require = createRequire(join(engineRoot, 'probe.cjs'))
  let resolved
  try {
    resolved = require.resolve(specifier)
  } catch (error) {
    return { resolved: false, names: new Set(), error: error.message }
  }
  try {
    const module = await import(pathToFileURL(resolved).href)
    return { resolved: true, names: new Set(Object.keys(module)), error: undefined }
  } catch (error) {
    return { resolved: true, names: new Set(), error: error.message }
  }
}

/** The platform seed words the Web shell hands to every client bundle. */
function platformSeeds(modules) {
  const dist = join(modules, SCOPE, 'dsh-web-frontend', 'dist', 'assets')
  if (!existsSync(dist)) return undefined
  const asset = readdirSync(dist).find((name) => name.startsWith('index-') && name.endsWith('.js'))
  if (asset === undefined) return undefined
  const source = readFileSync(join(dist, asset), 'utf8')
  // The seed factory is the one object literal listing the platform modules;
  // asking per specifier keeps this independent of minifier naming. Both key
  // forms appear there: a bare identifier (`react`) and a quoted one
  // (`react/jsx-runtime`, `react-dom`).
  return (specifier) => {
    const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(?:"${escaped}"|\\b${escaped})\\s*:`).test(source)
  }
}

/** Copy the published surface into a tree whose peers are the engine's. */
function stageBundle(engineModules, scratch) {
  const modules = join(scratch, 'node_modules')
  mkdirSync(modules, { recursive: true })
  for (const entry of readdirSync(engineModules)) {
    if (entry.startsWith('.')) continue
    symlinkSync(join(engineModules, entry), join(modules, entry), 'dir')
  }
  const target = join(modules, '@mars-sea', 'dsh-commandcode-provider')
  mkdirSync(dirname(target), { recursive: true })
  // COPIED, never linked: Node resolves a symlinked package's imports from its
  // realpath, which is exactly the resolution that hid the bug.
  for (const entry of PUBLISHED) {
    cpSync(join(repositoryDir, entry), join(target, entry), { recursive: true })
  }
  return target
}

/** Check 1: the bundle links and evaluates with the engine's own peers. */
async function checkLink(engineModules, scratch) {
  const staged = stageBundle(engineModules, scratch)
  const probe = join(scratch, 'probe.mjs')
  writeFileSync(probe, [
    `const mod = await import('@mars-sea/dsh-commandcode-provider')`,
    `process.stdout.write(JSON.stringify({`,
    `  name: mod.name,`,
    `  inject: mod.inject,`,
    `  apply: typeof mod.apply,`,
    `  config: typeof mod.Config,`,
    `}))`,
    '',
  ].join('\n'))
  let output
  try {
    output = run(process.execPath, [probe], scratch)
  } catch (error) {
    // A link failure is the whole point of this check, so it is a RESULT, not
    // an exception: keep the module loader's own sentence, which names the
    // symbol, and let the remaining checks still run.
    const lines = String(error.message).split('\n')
    const detail = lines.find((line) => line.includes('SyntaxError'))
      ?? lines.find((line) => line.includes('Cannot find'))?.trim()
      ?? 'the bundle could not be imported'
    fail(`the built bundle does not load on this engine: ${detail.trim()}`)
    return undefined
  }
  let plugin
  try {
    plugin = JSON.parse(output.trim().split('\n').at(-1))
  } catch {
    fail(`the bundle loaded but the probe printed no plugin shape: ${output.trim()}`)
    return undefined
  }
  if (plugin.name !== 'llm-commandcode') fail(`plugin name is ${String(plugin.name)}, expected llm-commandcode`)
  if (plugin.apply !== 'function') fail('the plugin entry exports no apply()')
  if (plugin.config !== 'function') fail('the plugin entry exports no Config schema')
  return staged
}

/** Check 2: every static named import exists on the engine. */
async function checkNamedImports(engineRoot) {
  const source = readFileSync(join(repositoryDir, 'lib', 'index.js'), 'utf8')
  for (const [specifier, names] of namedImports(source)) {
    if (specifier.startsWith('node:') || !specifier.startsWith(SCOPE)) continue
    const exported = await engineExports(engineRoot, specifier)
    if (!exported.resolved) {
      fail(`${specifier} does not resolve on this engine: ${exported.error}`)
      continue
    }
    const missing = [...names].filter((name) => !exported.names.has(name))
    if (missing.length > 0) {
      fail(`${specifier} exports no ${missing.join(', ')} — a static import of it fails at ESM link time`)
    }
  }
}

/**
 * Check 2b: the engine's own compatibility preflight admits this plugin.
 *
 * 其余检查都走「把发布面装进引擎的 peer 树再加载」，唯独看不见宿主**准入判定**
 * 本身。自 dsh `0.2.1-alpha.4` 起 `evaluatePluginCompatibility`
 * （`@deepseek-ai/dsh-app-boot`）在包自带 `engines.dsh` 时**只**读它、完全忽略
 * `@deepseek-ai/dsh*` peer；判定不通过时插件行被禁用、bundle 层被静默跳过、
 * `dsh plugin add` 在 pnpm 之前就拒绝——三条路径都不在上面的检查里，所以
 * alpha.3 → alpha.4 那轮升级里本脚本全绿、真实安装却被拒绝。这里对真实引擎的
 * 判定函数做一次真实调用补上这个缺口；旧引擎上该函数读 peer 规则，因此两种
 * 判据都被覆盖。函数或包缺失时只记警告，不把「引擎没提供」读成「插件不兼容」。
 * @param engineRoot - the engine's node_modules directory.
 * @param version - the engine's own version, passed explicitly so the verdict names it.
 */
async function checkEngineAdmission(engineRoot, version) {
  const require = createRequire(join(engineRoot, 'probe.cjs'))
  let entry
  try {
    entry = require.resolve(`${SCOPE}/dsh-app-boot`)
  } catch (error) {
    warn(`dsh ${version} ships no ${SCOPE}/dsh-app-boot: the host compatibility preflight was not exercised (${error.message})`)
    return
  }
  let evaluate
  try {
    evaluate = (await import(pathToFileURL(entry).href)).evaluatePluginCompatibility
  } catch (error) {
    fail(`${SCOPE}/dsh-app-boot cannot be loaded on this engine: ${error.message}`)
    return
  }
  if (typeof evaluate !== 'function') {
    warn(`dsh ${version} exports no evaluatePluginCompatibility: the host compatibility preflight was not exercised`)
    return
  }
  const manifest = JSON.parse(readFileSync(join(repositoryDir, 'package.json'), 'utf8'))
  let issue
  try {
    issue = evaluate(manifest, undefined, version)
  } catch (error) {
    // 清单读不出来宿主会直接拒绝该包，所以这是失败而不是警告。
    fail(`the host compatibility preflight cannot read this plugin's manifest on dsh ${version}: ${error.message}`)
    return
  }
  if (issue === undefined || issue.exempted === true) {
    process.stdout.write(`host compatibility preflight admits this plugin on dsh ${version}\n`)
    return
  }
  // `requirements` 是 alpha.4 起的字段名，旧引擎叫 `peers`。
  const unmet = issue.requirements ?? issue.peers ?? {}
  fail(`the host compatibility preflight REJECTS this plugin on dsh ${version}: ${JSON.stringify(unmet)} `
    + '— the plugin would be disabled, its bundle skipped, and installation refused')
}

/** Check 3: the client bundle requires only seeds or mounted client rows. */
function checkClientRequires(engineModules) {
  const source = readFileSync(join(repositoryDir, 'lib', 'client.js'), 'utf8')
  const seeded = platformSeeds(engineModules)
  if (seeded === undefined) {
    warn('no dsh-web-frontend dist in this engine, skipped the client require audit')
    return
  }
  for (const specifier of requiredModules(source)) {
    if (specifier.startsWith('node:')) continue
    if (seeded(specifier)) continue
    const manifest = join(engineModules, ...specifier.split('/'), 'package.json')
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).dsh?.client !== undefined) continue
    fail(`lib/client.js requires "${specifier}", which is neither a platform seed nor a mounted dsh.client row`)
  }
}

/**
 * Check 5: the staged bundle prices request images against THIS engine.
 *
 * More than the unit tests can cover: that this engine's `LlmAdapter` base
 * accepts the adapter's `imageRequestPricing` override, that the symbols the
 * pricing path imports still resolve on it, and that the payload shape it hands
 * over is priced — the token meter throws unless exactly one price comes back
 * per occurrence, so an unhandled shape is a broken meter rather than a wrong
 * number.
 */
async function checkImagePricing(staged) {
  if (staged === undefined) return
  // Imported in-process from the STAGED tree, so its bare imports are the
  // engine's: the child probe above proves the link, this holds the real class.
  const plugin = await import(pathToFileURL(join(staged, 'lib', 'index.js')).href)
  if (typeof plugin.CommandCodeAdapter !== 'function') {
    fail('the bundle exports no CommandCodeAdapter, so its image pricing cannot be checked')
    return
  }
  const adapter = new plugin.CommandCodeAdapter({
    options: () => ({}),
    resolveApiKey: async () => 'engine-load-probe',
  })
  const pricing = adapter.imageRequestPricing('commandcode', 'claude-sonnet-5')
  if (pricing === undefined || typeof pricing.priceImages !== 'function') {
    fail('imageRequestPricing() declared nothing for a Vision-capable model')
    return
  }
  // A 3600x2400 source projects onto the documented 1568-px long edge: 1568x1045.
  const ref = {
    attachmentId: 'sha256:engine-load-probe',
    mediaType: 'image/png',
    bytes: 4096,
    width: 3600,
    height: 2400,
  }
  const asBlock = pricing.priceImages([{ type: 'image', attachment: ref }])
  if (asBlock.length !== 1) {
    fail(`priceImages() must answer one price per occurrence, got ${asBlock.length}`)
    return
  }
  // Anthropic's published rule (one token per 750 px) at the request target.
  const expected = Math.ceil((1568 * 1045) / 750)
  if (asBlock[0].visualTokens !== expected) {
    fail(`a retained image priced ${asBlock[0].visualTokens} tokens, expected ${expected} at the request target`)
  }
  if (asBlock[0].text !== '') fail('a retained image on this route carries no model-visible text')
  const [offloaded] = pricing.priceImages([{ type: 'image', attachment: ref, offloaded: true }])
  if (offloaded.visualTokens !== 0) fail('an offloaded occurrence must cost no vision tokens')
  const textOnly = adapter.imageRequestPricing('commandcode', 'deepseek/deepseek-v4-pro')
  const [priced] = textOnly.priceImages([{ type: 'image', attachment: ref }])
  if (priced.visualTokens !== 0 || priced.text === '') {
    fail('a text-only route must price every occurrence as placeholder text')
  }
}

/**
 * Check 6: the Config schema really drives this engine's settings forms.
 *
 * The mark is worthless if the engine's schemastery ignores it, so this asserts
 * both halves: every field except the composition-only `apiKey` carries
 * `meta.volatile`, and parsing a config through the schema produces a LIVE
 * reference (`{ get() }`) the loader can commit a settings write into. A field
 * with no mark is invisible to AND unwritable from the settings page, and a
 * parse that yields plain values means an in-place write cannot reach the
 * running fiber — either way the plugin's settings page goes dead, which no
 * amount of local unit testing can see.
 */
async function checkVolatileConfig(staged) {
  if (staged === undefined) return
  const plugin = await import(pathToFileURL(join(staged, 'lib', 'index.js')).href)
  const fields = plugin.Config?.dict
  if (fields === undefined || fields.apiBase === undefined) {
    fail('the staged Config schema carries no dict, so its settings-form surface cannot be checked')
    return
  }
  if (typeof fields.apiBase.volatile !== 'function') {
    fail('this engine\'s schemastery has no .volatile(); the settings page would render no editable field')
    return
  }
  for (const [name, field] of Object.entries(fields)) {
    const marked = field?.meta?.volatile === true
    if (name === 'apiKey') {
      if (marked) fail('Config.apiKey must stay unmarked: it is the composition-only secret literal')
      continue
    }
    if (!marked) fail(`Config.${name} is not volatile — settings forms cannot see or write it`)
  }
  let parsed
  try {
    parsed = plugin.Config({ apiKeyEnv: 'engine-load-probe' })
  } catch (error) {
    fail(`Config rejected the engine-load probe config: ${error.message}`)
    return
  }
  const ref = parsed?.apiKeyEnv
  if (ref === null || typeof ref !== 'object' || typeof ref.get !== 'function') {
    fail('Config parses to plain values on this engine, so volatile writes cannot commit in place')
  } else if (ref.get() !== 'engine-load-probe') {
    fail(`the parsed reference answered ${String(ref.get())}, expected the probe value`)
  }
}

/** Provider-owned codes must remain real engine errors with durable retry and request facts. */
async function checkProviderFailures(staged, engineModules) {
  if (staged === undefined) return
  const plugin = await import(pathToFileURL(join(staged, 'lib', 'index.js')).href)
  const require = createRequire(join(dirname(engineModules), 'provider-failure-probe.cjs'))
  const llm = await import(pathToFileURL(require.resolve(`${SCOPE}/dsh-llm`)).href)
  let verified = true
  for (const protocol of ['cli', 'openai', 'messages']) {
    for (const [status, code] of [[400, 'PROVIDER_HTTP_ERROR'], [429, 'THROTTLED'], [200, 'PROVIDER_PROTOCOL_ERROR']]) {
      try {
        const adapter = new plugin.CommandCodeAdapter({
          options: () => ({
            apiBase: 'https://engine-failure.invalid', workingDir: '/tmp/engine-probe', modelsCachePath: '',
            protocol: protocol === 'messages' ? 'auto' : protocol,
            requestTimeoutMs: 1000, streamIdleTimeoutMs: 1000,
          }),
          resolveApiKey: async () => 'synthetic-error-key',
          fetchImpl: async () => new Response(status === 200 ? null : 'synthetic refusal', {
            status, headers: { 'x-request-id': 'synthetic-engine-failure', 'retry-after': '7' },
          }),
        })
        await assert.rejects(async () => {
          for await (const _ of adapter.stream({
            provider: 'commandcode', model: protocol === 'messages' ? 'claude-haiku-5-5' : 'synthetic-error-model',
            messages: [llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] })],
          })) { /* Consume the published adapter against this engine's actual error class. */ }
        }, error => {
          assert.ok(error instanceof llm.LlmError)
          assert.equal(error.code, code)
          assert.equal(error.failure.code, code)
          assert.equal(error.failure.requestId, 'synthetic-engine-failure')
          assert.equal(error.failure.status, status === 200 ? undefined : status)
          assert.equal(error.failure.providerRetryAfterMs, status === 200 ? undefined : 7000)
          assert.ok(Object.isFrozen(error.failure))
          return true
        })
      } catch (error) {
        verified = false
        fail(`${protocol} provider failure ${code}: ${error.message}`)
      }
    }
  }
  if (verified) process.stdout.write('Provider failure contract passed: 3 protocols × HTTP refusal, throttle and missing body (real engine errors)\n')
}

/** Check 4: the engine exports the whole durable-offload contract the adapter speaks. */
async function checkImagePolicy(engineModules) {
  const specifier = `${SCOPE}/dsh-llm`
  const require = createRequire(join(dirname(engineModules), 'probe.cjs'))
  const module = await import(pathToFileURL(require.resolve(specifier)).href)
  // Every one of these is a STATIC import of lib/index.js, so a missing export
  // is a link-time failure the child probe above already reports; naming them
  // here is what turns "the bundle did not load" into "this symbol is gone".
  const missing = ['requiredImageOffload', 'projectOffloadedImages', 'IMAGE_OFFLOAD_REQUIRED_CODE']
    .filter((name) => module[name] === undefined)
  if (missing.length > 0) {
    fail(`${specifier} is missing ${missing.join(', ')}; the adapter cannot budget images`)
    return 'none'
  }
  // The adapter throws this code with `offloadImages`; dsh-compaction-image-offload
  // reads it back off `failure`, so a dropped field would silently break offload.
  const error = new module.LlmError('engine-load probe', module.IMAGE_OFFLOAD_REQUIRED_CODE, { offloadImages: 3 })
  if (error.code !== 'IMAGE_OFFLOAD_REQUIRED') fail(`LlmError code round-trip returned ${String(error.code)}`)
  if (error.failure?.offloadImages !== 3) {
    fail('LlmError does not carry failure.offloadImages, so the harness cannot read the offload count')
  }
  return 'durable'
}

/** Check 7: real engine messages survive both request serializers (no network). */
async function checkToolHistory(staged, engineModules) {
  if (staged === undefined) return
  const plugin = await import(pathToFileURL(join(staged, 'lib', 'index.js')).href)
  const require = createRequire(join(dirname(engineModules), 'probe.cjs'))
  const llm = await import(pathToFileURL(require.resolve(`${SCOPE}/dsh-llm`)).href)
  const callId = llm.ToolCallId('engine-tool-history-probe')
  const messages = [
    llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'inspect the repository' }] }),
    llm.createAssistantMessage({
      source: { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' },
      content: [
        { type: 'text', text: 'Let me inspect the changes.' },
        { type: 'tool-call', id: callId, name: 'bash', arguments: '{"command":"git status"}' },
      ],
    }),
    llm.createToolResultMessage({ callId, content: [{ type: 'text', text: 'working tree clean' }], isError: false }),
  ]
  for (const protocol of ['cli', 'openai']) {
    try {
      let body
      const adapter = new plugin.CommandCodeAdapter({
        options: () => ({
          apiBase: 'https://engine-probe.invalid', workingDir: '/tmp/engine-probe',
          modelsCachePath: '/tmp/engine-probe-unused.json',
          protocol, requestTimeoutMs: 1000, streamIdleTimeoutMs: 1000,
        }),
        resolveApiKey: async () => 'engine-load-probe',
        fetchImpl: async (_url, init) => {
          body = JSON.parse(init.body)
          return new Response(protocol === 'cli'
            ? 'data: {"type":"text-delta","text":"ok"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\n'
            : 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
          { headers: { 'content-type': 'text/event-stream' } })
        },
      })
      for await (const chunk of adapter.stream({ provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash', messages })) {
        if (chunk.type === 'finish') assert.equal(chunk.reason.kind, 'stop')
      }
      const wire = protocol === 'cli' ? body.params.messages : body.messages
      assert.deepEqual(wire.map((m) => m.role), ['user', 'assistant', 'tool'])
      if (protocol === 'cli') {
        const call = wire[1].content.find((b) => b.type === 'tool-call')
        assert.equal(call.toolCallId, callId)
        assert.equal(wire[2].content[0].toolCallId, callId)
        assert.equal(wire[2].content[0].toolName, 'bash')
        assert.deepEqual(wire[2].content[0].output, { type: 'text', value: 'working tree clean' })
      } else {
        assert.equal(wire[1].tool_calls[0].id, callId)
        assert.equal(wire[2].tool_call_id, callId)
        assert.equal(wire[2].content, 'working tree clean')
      }
    } catch (error) {
      fail(`${protocol} lost or rejected this engine's tool history: ${error.message}`)
    }
  }
  // rc.2 dynamic tool projection: a newly enabled tool must survive the
  // harness projection and reach both Command Code transports in the same
  // conversation. The provider has no native tool-update event, so the
  // adapter's addition-only contract intentionally sends the complete active
  // declaration list and drops the developer marker from the wire.
  const dynamicTool = {
    name: 'engine-dynamic-tool',
    description: 'A tool enabled after the conversation started.',
    parameters: { type: 'object', properties: {} },
  }
  const dynamicMessage = llm.createDeveloperMessage({
    source: { kind: 'tool-registry' },
    content: [{ type: 'tool-addition', toolName: dynamicTool.name }],
  })
  const dynamicProjection = llm.projectToolUpdates(
    [dynamicMessage, llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'use it' }] })],
    [dynamicTool],
    'addition-only',
    { tools: [], updates: [{ messageId: dynamicMessage.id, additions: [dynamicTool] }] },
  )
  if (dynamicProjection.tools?.[0]?.name !== dynamicTool.name) {
    fail('rc.2 projectToolUpdates() dropped the newly enabled tool')
  }
  for (const protocol of ['cli', 'openai']) {
    try {
      let body
      const adapter = new plugin.CommandCodeAdapter({
        options: () => ({
          apiBase: 'https://engine-probe.invalid', workingDir: '/tmp/engine-probe',
          modelsCachePath: '/tmp/engine-probe-unused.json', protocol,
          requestTimeoutMs: 1000, streamIdleTimeoutMs: 1000,
        }),
        resolveApiKey: async () => 'engine-load-probe',
        fetchImpl: async (_url, init) => {
          body = JSON.parse(init.body)
          return new Response(protocol === 'cli'
            ? 'data: {"type":"text-delta","text":"ok"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\n'
            : 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
          { headers: { 'content-type': 'text/event-stream' } })
        },
      })
      const options = {
        provider: 'commandcode', model: 'engine-dynamic-tool-probe',
        messages: [...dynamicProjection.messages], tools: dynamicProjection.tools,
        maxTokens: 100, temperature: 0, stream: true,
      }
      for await (const chunk of adapter.stream(options)) {
        if (chunk.type === 'finish') assert.equal(chunk.reason.kind, 'stop')
      }
      const wireTools = protocol === 'cli' ? body.params.tools : body.tools
      const wireName = protocol === 'cli' ? wireTools[0].name : wireTools[0].function.name
      if (wireName !== dynamicTool.name) fail(`${protocol} dropped the rc.2 dynamic tool declaration`)
      const wireMessages = protocol === 'cli' ? body.params.messages : body.messages
      if (wireMessages.some((message) => message.role === 'developer')) {
        fail(`${protocol} sent a developer tool-update marker instead of the active declaration`)
      }
    } catch (error) {
      fail(`${protocol} lost the rc.2 dynamic tool update: ${error.message}`)
    }
  }
  process.stdout.write(`tool history checked with engine result role: ${messages[2].role}\n`)
}

/**
 * alpha.3 起 Gateway 的 `InvokeRemoteRequest.peer` 由可选变必需：每个载体与进程内
 * 调用方都要显式指名自己代表谁，无法再缺省为「按 operator 处理」。
 *
 * alpha.2 的 `dsh-client-connection` 只有 `OperatorPeer`、没有 `Peer`，因此这里按引擎
 * 能力探测：新款返回一个 owner Peer，旧款返回 `undefined`，调用处据此决定要不要带
 * `peer` 参数。这样同一套探针能在两个已声明引擎上跑，不必按版本分叉。
 * @param ctx - 本检查自建的 Context，Peer 挂在它的 root 下。
 * @param load - 从被检引擎目录解析模块的加载器。
 * @returns 该引擎可用的 owner Peer；旧款引擎返回 undefined。
 */
async function engineOwnerPeer(ctx, load) {
  try {
    const { Peer } = await load(`${SCOPE}/dsh-client-connection`)
    return typeof Peer === 'function' ? new Peer(ctx.root, { principal: { kind: 'owner' } }) : undefined
  } catch { return undefined }
}

/**
 * alpha.3 起 `TypertGatewayService` 的 `static inject` 多出 `remoteAccess`：缺这个服务
 * 时 cordis 会让网关插件停在 INACTIVE，`ctx.get('typertGateway')` 直接是 undefined，
 * 探针会以一句无关的 TypeError 失败。
 *
 * `@deepseek-ai/dsh-api-remote-access` 是 alpha.3 新引入的包，alpha.2 上不存在；先探测
 * 包能不能解析，存在才注册。旧引擎没有这个包也没有这项依赖，跳过即可。
 * @param ctx - 本检查自建的 Context。
 * @param load - 从被检引擎目录解析模块的加载器。
 */
async function pluginEngineRemoteAccess(ctx, load) {
  let mod
  try { mod = await load(`${SCOPE}/dsh-api-remote-access`) } catch { return }
  await ctx.plugin(mod.default, {})
}

/** 用真实宿主注册表与网关验证发布包的单页观察流；仅使用内存设置和合成凭据。 */
async function checkEnrollmentStream(staged, engineModules) {
  if (staged === undefined) return
  const require = createRequire(join(dirname(engineModules), 'enrollment-probe.cjs'))
  const load = async (name) => import(pathToFileURL(require.resolve(name)).href)
  const [{ Context, Service }, { TypertRegistry }, { TypertGatewayService }, plugin] = await Promise.all([
    load(`${SCOPE}/cordis`), load(`${SCOPE}/dsh-typert-registry`), load(`${SCOPE}/dsh-api-gateway`),
    import(pathToFileURL(join(staged, 'lib', 'index.js')).href),
  ])
  const ctx = new Context()
  const peer = await engineOwnerPeer(ctx, load)
  const config = { apiKeyEnv: 'ENROLLMENT_PROBE' }
  let revision = 1
  let releaseWrite
  const writing = new Promise((resolve) => { releaseWrite = resolve })
  const keys = new Map()
  let started = false
  const pageId = '00000000-0000-4000-8000-000000000001'
  const id = '00000000-0000-4000-8000-000000000002'
  class ProbeLlm extends Service {
    constructor(c) { super(c, 'llm') }
    registerConfigurableProviders() {}
    registerAdapter() {}
  }
  class ProbeSettings extends Service {
    constructor(c) { super(c, 'settings') }
    get writable() { return true }
    configure() { return () => {} }
    describe() { return [{ ns: 'llm-commandcode', value: structuredClone(config), revision }] }
    async mutate(_ns, ops, expected) {
      assert.equal(expected, revision)
      for (const op of ops) config[op.path[0]] = structuredClone(op.value)
      revision++
    }
  }
  class ProbeCredentials extends Service {
    constructor(c) { super(c, 'credentials') }
    async describe(ref) { return { configured: keys.has(ref), writable: true } }
    async set(ref, key) { started = true; await writing; keys.set(ref, key) }
    async unset(ref) { keys.delete(ref) }
  }
  try {
    new ProbeLlm(ctx)
    new ProbeSettings(ctx)
    new ProbeCredentials(ctx)
    await pluginEngineRemoteAccess(ctx, load)
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(TypertGatewayService, {})
    await ctx.plugin({ inject: plugin.inject, apply(c) { plugin.apply(c, config) } })
    const gateway = ctx.get('typertGateway')
    const control = new AbortController()
    const stream = await gateway.stream({ namespace: 'commandcode', method: 'enrollmentWatch', args: { input: { pageId } }, ...peer === undefined ? {} : { peer }, signal: control.signal })
    const iterator = stream[Symbol.asyncIterator]()
    assert.equal((await iterator.next()).value, true)
    const state = await gateway.invoke({ namespace: 'commandcode', method: 'enrollmentBegin', args: { input: { id, pageId, mode: 'manual', label: '合成账号', automaticName: false, key: 'synthetic-key' } }, ...peer === undefined ? {} : { peer } })
    assert.equal(state.id, id)
    for (let n = 0; n < 100 && !started; n++) await new Promise((resolve) => setTimeout(resolve, 2))
    assert.equal(started, true)
    assert.equal(config.accountEnrollmentTasks[0].phase, 'pending')
    const ended = iterator.next().catch(() => undefined)
    control.abort()
    await ended
    releaseWrite()
    for (let n = 0; n < 100 && config.accountEnrollmentTasks.length; n++) await new Promise((resolve) => setTimeout(resolve, 2))
    assert.deepEqual(config.accountEnrollmentTasks, [])
    assert.deepEqual(config.accounts, [])
    assert.equal(keys.size, 0)
    process.stdout.write('enrollment stream cancellation checked through the real engine Gateway\n')
  } catch (error) { fail(`account enrollment stream contract: ${error.message}`) }
  finally { releaseWrite(); await ctx.fiber.dispose() }
}

/**
 * 把一个 prepare 过的会话放进引擎的 SessionStore 并完成创建通知，返回 detach 释放函数。
 * dsh 0.2.2-alpha.2 在 `session/created` 通知完成前把 store 持有的会话保持只读，`enter()` 之后
 * 立刻 `append()` 会抛 "cannot append before session/created completes"。`announce()` 在插件支持的
 * 每个引擎（rc.2 起）都存在、旧引擎上只是发出 `session/created`，也是真实创建者的调用方式，
 * 所以探针一律通知，不按引擎分支。
 */
function enterAndAnnounce(ctx, session) {
  const release = ctx.sessions.enter(session)
  ctx.sessions.announce(session)
  return release
}

/** 真实历史服务读取关闭会话和分支，真实 Gateway 校验查询及纯数字响应。 */
async function checkAnalyticsHistory(staged, engineModules) {
  if (staged === undefined) return
  const require = createRequire(join(dirname(engineModules), 'analytics-probe.cjs'))
  const load = async name => import(pathToFileURL(require.resolve(name)).href)
  const [{ Context, Service }, { default: SessionStore }, { default: SessionQuery }, { TypertRegistry }, { TypertGatewayService }, plugin] = await Promise.all([
    load(`${SCOPE}/cordis`), load(`${SCOPE}/dsh-session`), load(`${SCOPE}/dsh-session-query`), load(`${SCOPE}/dsh-typert-registry`), load(`${SCOPE}/dsh-api-gateway`),
    import(pathToFileURL(join(staged, 'lib', 'index.js')).href),
  ])
  const ctx = new Context(), savedFetch = globalThis.fetch, stored = new Map()
  const peer = await engineOwnerPeer(ctx, load)
  globalThis.fetch = async () => { throw new Error('合成统计检查不访问网络') }
  class ProbeLlm extends Service {
    constructor(c) { super(c, 'llm') }
    registerConfigurableProviders() {}
    registerAdapter() {}
  }
  class ReadStorage extends Service {
    identity = Symbol('analytics-storage')
    constructor(c) { super(c, 'sessionPersistence') }
    async list() { return [...stored.values()].map(s => ({ header: s.session, revision: 'fixed' })) }
    async stat(id) { const s = stored.get(id); return s ? { header: s.session, revision: 'fixed' } : undefined }
    async open(id, access) {
      assert.equal(access, 'read')
      const s = stored.get(id)
      assert.ok(s)
      return { id, access, header: s.session, inheritedEventCount: s.inheritedEventCount,
        async read(offset = 0, length = s.events.length) { return { eventState: 'detached', events: structuredClone(s.events.slice(offset, offset + length)) } },
        async close() {},
      }
    }
  }
  try {
    new ProbeLlm(ctx)
    new ReadStorage(ctx)
    await pluginEngineRemoteAccess(ctx, load)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionQuery)
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(TypertGatewayService, {})
    await ctx.plugin({ inject: plugin.inject, apply(c) { plugin.apply(c, { apiKeyEnv: 'ANALYTICS_PROBE' }) } })
    const query = ctx.get('sessionQuery'), gateway = ctx.get('typertGateway')
    const appendAttempt = (s, turn, tokens) => {
      s.append('turn/start', { turn })
      s.append('step/start', { turn, step: 1 })
      s.append('request/header', { header: { config: { provider: 'commandcode', model: 'gpt-5.6-luna' } }, reason: turn === 1 ? 'initial' : 'resume' })
      s.append('assistant/attempt', { turn, step: 1, stream: [{ type: 'chunk', time: Date.now(), chunk: { type: 'usage', usage: { inputTokens: tokens, outputTokens: 0 } } }] })
      s.append('step/end', { turn, step: 1 })
      s.append('turn/end', { turn, reason: { kind: 'error', error: { code: 'UNKNOWN', message: '合成错误' } } })
    }
    const enterAnnounced = session => enterAndAnnounce(ctx, session)
    const parent = ctx.sessions.prepare('analytics-parent'), detach = enterAnnounced(parent)
    appendAttempt(parent, 1, 100)
    const original = await query.readSession(parent.id)
    stored.set(parent.id, original)
    detach()
    const child = ctx.sessions.prepare('analytics-child', { seed: original.events, inheritedEventCount: original.events.length, meta: { isSeeded: true, parentSession: parent.id } })
    const detachChild = enterAnnounced(child)
    appendAttempt(child, 2, 200)
    stored.set(child.id, await query.readSession(child.id))
    detachChild()
    const result = await gateway.invoke({ namespace: 'commandcode', method: 'analytics', args: { query: { mode: 'recent', limit: 20 } }, ...peer === undefined ? {} : { peer } })
    assert.equal(result.status, 'ready')
    assert.equal(result.scannedSessions, 2)
    assert.equal(result.unreadableSessions, 0)
    assert.equal(result.totals.sessions, 2)
    assert.equal(result.totals.requests, 2)
    assert.equal(result.totals.failed, 2)
    assert.equal(result.totals.tokens.uncachedInputTokens, 300)
    assert.ok(Array.isArray(result.scenarios))
    assert.equal(JSON.stringify(result).includes('analytics-parent'), false)
    await assert.rejects(gateway.invoke({ namespace: 'commandcode', method: 'analytics', args: { query: { mode: 'recent', limit: 101 } }, ...peer === undefined ? {} : { peer } }))
    process.stdout.write('真实历史服务与 Gateway 已验证关闭会话、分支去重、计价和严格查询，无账号网络请求\n')
  } catch (error) { fail(`模型分析历史契约：${error.message}`) }
  finally { globalThis.fetch = savedFetch; await ctx.fiber.dispose() }
}

/**
 * 真实会话投影注册表上的费用投影。插件用 `ctx.effect(() => registry.register(...))` 的同步写法
 * 注册 `commandCodeCost`；dsh 0.2.2-alpha.2 把 `register()` 的运行时返回值改成「可调用的 thenable」，
 * 并在其 README 明确保留这种写法的清理所有权、注册本身不警告。此前没有任何检查在真实注册表上
 * 跑过它，所以这里真的注册、驱动一个会话，再用 rc.2 起就有的 `snapshot()` 读折叠结果：注册失败、
 * 折叠失败或视图形状漂移会在这里暴露，而不是在用户的会话费用读数里。
 * 只用合成事件，不访问网络、不需要账号。
 */
async function checkCostProjection(staged, engineModules) {
  if (staged === undefined) return
  const require = createRequire(join(dirname(engineModules), 'cost-projection-probe.cjs'))
  const load = async name => import(pathToFileURL(require.resolve(name)).href)
  const [{ Context, Service }, { default: SessionStore }, { default: SessionQuery }, { TypertRegistry }, { TypertGatewayService }, { default: SessionProjectionRegistry }, plugin] = await Promise.all([
    load(`${SCOPE}/cordis`), load(`${SCOPE}/dsh-session`), load(`${SCOPE}/dsh-session-query`), load(`${SCOPE}/dsh-typert-registry`), load(`${SCOPE}/dsh-api-gateway`), load(`${SCOPE}/dsh-session-projection`),
    import(pathToFileURL(join(staged, 'lib', 'index.js')).href),
  ])
  const ctx = new Context(), savedFetch = globalThis.fetch
  await engineOwnerPeer(ctx, load)
  globalThis.fetch = async () => { throw new Error('合成费用投影检查不访问网络') }
  class ProbeLlm extends Service {
    constructor(c) { super(c, 'llm') }
    registerConfigurableProviders() {}
    registerAdapter() {}
  }
  // 插件组合需要一个 sessionPersistence 才能装起历史查询；本探针不读历史，给空存储即可。
  class EmptyStorage extends Service {
    identity = Symbol('cost-storage')
    constructor(c) { super(c, 'sessionPersistence') }
    async list() { return [] }
    async stat() { return undefined }
  }
  try {
    new ProbeLlm(ctx)
    new EmptyStorage(ctx)
    await pluginEngineRemoteAccess(ctx, load)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionQuery)
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(TypertGatewayService, {})
    // 注册表必须先于会话创建：它在 `session/created` 时才为已注册单元建 cell。
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin({ inject: plugin.inject, apply(c) { plugin.apply(c, { apiKeyEnv: 'COST_PROBE' }) } })
    const registry = ctx.get('sessionProjections')
    assert.ok(registry, '宿主没有提供 sessionProjections 服务')
    const session = ctx.sessions.prepare('cost-probe'), release = enterAndAnnounce(ctx, session)
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('request/header', { header: { config: { provider: 'commandcode', model: 'gpt-5.6-luna' } }, reason: 'initial' })
    session.append('assistant/attempt', { turn: 1, step: 1, stream: [{ type: 'chunk', time: Date.now(), chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 7, cacheReadTokens: 40 } } }] })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'UNKNOWN', message: '合成错误' } } })
    const facts = registry.snapshot(session, ['commandCodeCost']).values.commandCodeCost
    assert.ok(facts, '快照里没有 commandCodeCost：费用投影没有在真实注册表上注册成功')
    assert.equal(facts.groups.length, 1, `期望折叠出 1 个计费分组，实际 ${facts.groups.length}`)
    const [group] = facts.groups
    assert.equal(group.provider, 'commandcode')
    assert.equal(group.model, 'gpt-5.6-luna')
    assert.equal(group.tokens.uncachedInputTokens, 100)
    assert.equal(group.tokens.outputTokens, 7)
    assert.equal(group.tokens.cacheReadTokens, 40)
    release()
    process.stdout.write('费用投影已在真实会话投影注册表上注册，并折叠出预期的计费分组（无账号网络请求）\n')
  } catch (error) { fail(`费用投影契约：${error.message}`) }
  finally { globalThis.fetch = savedFetch; await ctx.fiber.dispose() }
}

/** 通过真实模型运行时传递标题用途，验证发布产物在小预算下发送关闭思考档位。 */
async function checkSessionTitle(staged, engineModules) {
  if (staged === undefined) return
  const require = createRequire(join(dirname(engineModules), 'session-title-probe.cjs'))
  const load = async name => import(pathToFileURL(require.resolve(name)).href)
  const [{ Context }, llm, plugin] = await Promise.all([
    load(`${SCOPE}/cordis`), load(`${SCOPE}/dsh-llm`), import(pathToFileURL(join(staged, 'lib', 'index.js')).href),
  ])
  let verified = true
  for (const protocol of ['cli', 'openai']) {
    const ctx = new Context()
    try {
      const model = 'deepseek/deepseek-v4.1-flash'
      const runtime = new llm.LlmRuntime(ctx)
      const sent = []
      const adapter = new plugin.CommandCodeAdapter({
        options: () => ({ apiBase: 'https://engine-title.invalid', workingDir: '/tmp', modelsCachePath: '', protocol, requestTimeoutMs: 1000, streamIdleTimeoutMs: 1000 }),
        resolveApiKey: async () => 'synthetic-title-key',
        fetchImpl: async (url, init) => {
          if (String(url).endsWith('/provider/v1/models')) return new Response(JSON.stringify({ data: [
            { id: model, name: 'DeepSeek', context_length: 262144, supported_endpoints: ['/chat/completions'] },
          ] }))
          const body = JSON.parse(init.body)
          sent.push(protocol === 'cli' ? body.params : body)
          const events = protocol === 'cli'
            ? [{ type: 'text-delta', text: '会话标题提取' }, { type: 'finish', finishReason: 'stop' }]
            : [{ choices: [{ delta: { content: '会话标题提取' }, finish_reason: 'stop' }] }]
          return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
        },
      })
      runtime.registerAdapter(['commandcode'], adapter)
      const chunks = []
      for await (const chunk of runtime.stream({ provider: 'commandcode', model, maxTokens: 64, purpose: 'session-title',
        messages: [llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '生成会话标题' }] })] })) chunks.push(chunk)
      assert.equal(sent.length, 1)
      assert.equal(sent[0].reasoning_effort, 'off')
      assert.equal(sent[0].max_tokens, 64)
      assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), '会话标题提取')
      assert.deepEqual(chunks.filter(chunk => chunk.type === 'finish').map(chunk => chunk.reason.kind), ['stop'])
    } catch (error) { verified = false; fail(`${protocol} 标题调用验证失败：${error.message}`) }
    finally { await ctx.fiber.dispose() }
  }
  if (verified) process.stdout.write('真实模型运行时已验证两种聊天协议的标题用途、关闭思考和 64 词元预算（合成响应）\n')
}

/** 真实宿主负责把适配器异常转为唯一的失败结束；不是在测试里自行模拟这层转换。 */
async function checkStreamSettlement(staged, engineModules) {
  if (staged === undefined) return
  const require = createRequire(join(dirname(engineModules), 'stream-settlement-probe.cjs'))
  const load = async name => import(pathToFileURL(require.resolve(name)).href)
  const [{ Context }, llm, plugin] = await Promise.all([
    load(`${SCOPE}/cordis`), load(`${SCOPE}/dsh-llm`), import(pathToFileURL(join(staged, 'lib', 'index.js')).href),
  ])
  const sse = event => `data: ${JSON.stringify(event)}\n\n`
  let verified = true
  for (const protocol of ['cli', 'openai', 'messages']) {
    const scenarios = ['success', 'limited', 'empty-limit', 'tool-cut', 'cancel', 'cancel-tool', 'trailing']
    if (protocol === 'openai') scenarios.push('tail-error')
    for (const scenario of scenarios) {
      const model = protocol === 'messages' ? 'claude-engine-settlement' : 'engine-settlement'
      const control = new AbortController()
      const tool = { id: 'settlement-tool', name: 'read', arguments: '{"path":"synthetic"}' }
      const toolScenario = scenario === 'tool-cut' || scenario === 'cancel-tool'
      const reason = scenario === 'limited' || scenario === 'empty-limit' ? 'length' : 'stop'
      let events
      if (protocol === 'cli') {
        events = [toolScenario ? { type: 'tool-call', toolCallId: tool.id, toolName: tool.name, input: { path: 'synthetic' } }
          : scenario === 'empty-limit' ? { type: 'reasoning-delta', text: 'thinking' } : { type: 'text-delta', text: 'first' }]
        if (scenario !== 'tool-cut') events.push({ type: 'finish', finishReason: reason, totalUsage: { outputTokens: 3 } })
      } else if (protocol === 'openai') {
        events = [{ choices: [], usage: { prompt_tokens: 10, completion_tokens: 1 } }, { choices: [{ delta: toolScenario
          ? { tool_calls: [{ index: 0, id: tool.id, function: { name: tool.name, arguments: tool.arguments } }] }
          : scenario === 'empty-limit' ? { reasoning_content: 'thinking' } : { content: 'first' } }] }]
        if (scenario !== 'tool-cut') events.push({ choices: [{ delta: {}, finish_reason: toolScenario ? 'tool_calls' : reason }] },
          { choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } })
      } else {
        const type = toolScenario ? 'tool_use' : scenario === 'empty-limit' ? 'thinking' : 'text'
        events = [{ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
          { type: 'content_block_start', index: 0, content_block: type === 'tool_use'
            ? { type, id: tool.id, name: tool.name, input: {} } : { type, text: '', thinking: '' } },
          { type: 'content_block_delta', index: 0, delta: type === 'tool_use'
            ? { type: 'input_json_delta', partial_json: tool.arguments }
            : type === 'thinking' ? { type: 'thinking_delta', thinking: 'thinking' } : { type: 'text_delta', text: 'first' } },
          { type: 'content_block_stop', index: 0 }]
        if (scenario !== 'tool-cut') events.push({ type: 'message_delta', delta: { stop_reason: reason === 'length' ? 'max_tokens' : 'end_turn' }, usage: { output_tokens: 3 } },
          { type: 'message_stop' })
      }
      if (scenario === 'tail-error') events.push({ error: { message: 'synthetic tail failure', isRetryable: false } })
      let body = events.map(sse).join('') + (protocol === 'openai' && scenario !== 'tool-cut' && scenario !== 'tail-error' ? 'data: [DONE]\n\n' : '')
      if (scenario === 'trailing') body += sse(protocol === 'cli' ? { type: 'text-delta', text: 'extra' }
        : protocol === 'openai' ? { choices: [{ delta: { content: 'extra' } }] }
          : { type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'extra' } })
      const ctx = new Context()
      try {
        const runtime = new llm.LlmRuntime(ctx)
        const adapter = new plugin.CommandCodeAdapter({
          options: () => ({ apiBase: 'https://engine-settlement.invalid', workingDir: '/tmp', modelsCachePath: '', protocol, requestTimeoutMs: 1000, streamIdleTimeoutMs: 1000 }),
          resolveApiKey: async () => 'synthetic-settlement-key',
          fetchImpl: async url => String(url).endsWith('/provider/v1/models')
            ? new Response(JSON.stringify({ data: [{ id: model, name: 'Synthetic', context_length: 262144, supported_endpoints: [protocol === 'messages' ? '/messages' : '/chat/completions'] }] }))
            : new Response(body, { headers: { 'x-request-id': 'settlement-request' } }),
        })
        runtime.registerAdapter(['commandcode'], adapter)
        const assembly = new llm.BlockAssembler()
        const chunks = []
        for await (const chunk of runtime.stream({ provider: 'commandcode', model, maxTokens: 100,
          messages: [llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'synthetic' }] })], signal: control.signal })) {
          chunks.push(chunk)
          assembly.push(chunk)
          if ((scenario === 'cancel' && chunk.type === 'text-delta')
            || (scenario === 'cancel-tool' && chunk.type === 'block-start' && chunk.blockType === 'tool-call')) control.abort(new Error('合成取消'))
        }
        const finishes = chunks.filter(chunk => chunk.type === 'finish')
        assert.equal(finishes.length, 1, '真实宿主只能产生一个最终结果')
        const expected = scenario.startsWith('cancel') ? 'aborted' : ['empty-limit', 'tool-cut', 'tail-error'].includes(scenario) ? 'error' : scenario === 'limited' ? 'max-tokens' : 'stop'
        assert.equal(assembly.finish.kind, expected)
        assert.equal(chunks.filter(chunk => chunk.type === 'usage').length <= 1, true)
        if (['empty-limit', 'tool-cut', 'tail-error'].includes(scenario)) {
          // `empty-limit` sends maxTokens: 100 and the upstream reports 3 output
          // tokens, so the budget was NOT exhausted: since 0.18.0 that is
          // REASONING_LIMIT (upstream stopped on its own, usually a reasoning
          // loop), not OUTPUT_TOKEN_LIMIT. The at-budget boundary stays
          // OUTPUT_TOKEN_LIMIT and is covered by tests/adapter.test.ts.
          assert.equal(assembly.finish.failure.code, scenario === 'empty-limit' ? 'REASONING_LIMIT' : scenario === 'tool-cut' ? 'STREAM_CLOSED' : 'PROVIDER_STREAM_ERROR')
          assert.equal(assembly.finish.failure.requestId, 'settlement-request')
        }
        if (scenario.startsWith('cancel') || scenario === 'tool-cut') {
          assert.equal(assembly.interruptedBlocks().some(block => block.type === 'tool-call'), false,
            '宿主中断快照不保留可以执行的工具调用；失败终态走请求错误分支')
        }
        if (scenario === 'trailing') assert.equal(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'extra'), false)
        if (['success', 'limited', 'trailing', 'tail-error'].includes(scenario)) assert.equal(assembly.usage.outputTokens, 3)
      } catch (error) { verified = false; fail(`${protocol} ${scenario} 流收束验证失败：${error.message}`) }
      finally { await ctx.fiber.dispose() }
    }
  }
  if (verified) process.stdout.write('真实宿主已验证三协议唯一终态、截断、取消、尾部失败、失败工具快照与用量（22 个场景）\n')
}

/** 经真实宿主验证整数窗口及其默认预算，避免只有适配器元数据断言通过。 */
async function checkContextWindowBudget(staged, engineModules) {
  if (staged === undefined) return
  const require = createRequire(join(dirname(engineModules), 'context-window-probe.cjs'))
  const load = async name => import(pathToFileURL(require.resolve(name)).href)
  const [{ Context }, llm, plugin] = await Promise.all([
    load(`${SCOPE}/cordis`), load(`${SCOPE}/dsh-llm`), import(pathToFileURL(join(staged, 'lib', 'index.js')).href),
  ])
  let verified = true
  try {
    assert.throws(() => plugin.Config({ contextWindow: 32768.5 }))
    assert.throws(() => plugin.Config({ contextWindowOverrides: { model: 32768.5 } }))
  } catch (error) { verified = false; fail(`上下文整数配置校验：${error.message}`) }
  for (const protocol of ['cli', 'openai', 'messages']) {
    const scenarios = [
      { catalog: 8192, custom: 131072, expected: 131072 },
      { catalog: 1000000, custom: 32768, expected: 32768 },
      { catalog: 8192, custom: 131072, published: 16384, expected: 16384 },
      // 绕过配置校验的程序化小数也不能形成宿主拒绝的模型元数据。
      { catalog: 8192, custom: 32768.5, expected: 8192 },
    ]
    for (const [index, scenario] of scenarios.entries()) {
      const ctx = new Context(), sent = []
      try {
        const model = 'deepseek/deepseek-v4-flash'
        const runtime = new llm.LlmRuntime(ctx)
        const sse = event => `data: ${JSON.stringify(event)}\n\n`
        const response = protocol === 'cli'
          ? sse({ type: 'text-delta', text: 'ok' }) + sse({ type: 'finish', finishReason: 'stop' })
          : protocol === 'openai'
            ? sse({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n'
            : sse({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } })
              + sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
              + sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } })
              + sse({ type: 'content_block_stop', index: 0 })
              + sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })
              + sse({ type: 'message_stop' })
        const adapter = new plugin.CommandCodeAdapter({
          options: () => ({ apiBase: `https://engine-context-${protocol}-${index}.invalid`, workingDir: '/tmp', modelsCachePath: '',
            protocol, requestTimeoutMs: 1000, streamIdleTimeoutMs: 1000, contextWindow: scenario.custom }),
          resolveApiKey: async () => 'synthetic-context-key',
          fetchImpl: async (url, init) => {
            if (String(url).endsWith('/provider/v1/models')) return Response.json({ object: 'list', data: [{
              id: model, name: '合成上下文模型', context_length: scenario.catalog,
              supported_endpoints: [protocol === 'messages' ? '/messages' : '/chat/completions'],
              ...scenario.published === undefined ? {} : { max_output_tokens: scenario.published },
            }] })
            const body = JSON.parse(String(init?.body))
            sent.push(protocol === 'cli' ? body.params.max_tokens : body.max_tokens)
            return new Response(response)
          },
        })
        runtime.registerAdapter(['commandcode'], adapter)
        const info = await runtime.resolveModelInfo('commandcode', model)
        assert.equal(info.context.contextWindow, Number.isInteger(scenario.custom) ? scenario.custom : scenario.catalog)
        assert.equal(info.defaultMaxTokens, scenario.expected)
        for (const maxTokens of [undefined, 65536]) {
          const assembly = new llm.BlockAssembler()
          for await (const chunk of runtime.stream({ provider: 'commandcode', model,
            messages: [llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '合成请求' }] })],
            ...maxTokens === undefined ? {} : { maxTokens },
          })) assembly.push(chunk)
          assert.equal(assembly.finish.kind, 'stop')
        }
        assert.deepEqual(sent, [scenario.expected, Math.min(65536, scenario.expected)])
      } catch (error) { verified = false; fail(`${protocol} 上下文预算场景 ${index + 1}：${error.stack ?? error.message}`) }
      finally { await ctx.fiber.dispose() }
    }
  }
  if (verified) process.stdout.write('真实宿主已验证整数窗口、调大调小、公布上限及三协议默认/显式预算（12 个场景）\n')
}

/** 使用真实插件入口、易变引用与账号池验证接线，网络及凭据仍为合成依赖。 */
async function checkGatewayRequestFacts(staged, engineModules) {
  if (staged === undefined) return
  const require = createRequire(join(dirname(engineModules), 'gateway-facts-probe.cjs'))
  const load = async name => import(pathToFileURL(require.resolve(name)).href)
  const [{ Context, Service }, { updateVolatile }, { TypertRegistry }, plugin] = await Promise.all([
    load(`${SCOPE}/cordis`), load(`${SCOPE}/cosmokit`), load(`${SCOPE}/dsh-typert-registry`),
    import(pathToFileURL(join(staged, 'lib', 'index.js')).href),
  ])
  const a = 'https://engine-facts-a.invalid', b = 'https://engine-facts-b.invalid', c = 'https://engine-facts-c.invalid'
  const d = 'https://engine-facts-d.invalid', e = 'https://engine-facts-e.invalid'
  const ctx = new Context(), savedFetch = globalThis.fetch
  const calls = [], keys = new Map([['GATEWAY_FACTS_PROBE', 'synthetic-default'], ['GATEWAY_FACTS_EXTRA', 'synthetic-extra']])
  let adapter, armed, rejected = false, rejectExtraForReport = false, rejectRotation = false
  let values = { apiBase: a, apiKeyEnv: 'GATEWAY_FACTS_PROBE', modelsCachePath: '', filterModelsByPlan: false, activeAccount: 'default' }
  const config = plugin.Config(values)
  const change = patch => {
    values = { ...values, ...patch }
    const candidate = plugin.Config(values)
    for (const name of Object.keys(patch)) updateVolatile(config[name], candidate[name])
  }
  const gate = () => {
    let enter, release
    const entered = new Promise(resolve => { enter = resolve })
    const waiting = new Promise(resolve => { release = resolve })
    return { enter, release, entered, waiting }
  }
  class ProbeLlm extends Service {
    constructor(context) { super(context, 'llm') }
    registerConfigurableProviders() {}
    registerAdapter(_providers, value) { adapter = value }
  }
  class ProbeCredentials extends Service {
    constructor(context) { super(context, 'credentials') }
    async resolve(ref) {
      const value = keys.get(ref)
      if (armed !== undefined) {
        const pending = armed
        armed = undefined
        pending.enter()
        await pending.waiting
      }
      return value === undefined ? undefined : { value }
    }
  }
  const request = { provider: 'commandcode', model: 'synthetic/engine-facts', messages: [{ id: 'synthetic-message', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }] }
  const generate = async () => { for await (const _ of adapter.stream(request)) { /* 检查真实收束。 */ } }
  let pending
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input), key = new Headers(init?.headers).get('authorization')
      calls.push({ url, key })
      if (url.endsWith('/provider/v1/chat/completions')) {
        if (!rejected) { rejected = true; return new Response('rate limited', { status: 429 }) }
        if (rejectExtraForReport && new URL(url).origin === b && key === 'Bearer synthetic-extra') {
          rejectExtraForReport = false
          return new Response('rate limited', { status: 429 })
        }
        if (rejectRotation && new URL(url).origin === d && key === 'Bearer synthetic-extra') {
          rejectRotation = false
          armed = pending
          return new Response('invalid credential', { status: 401 })
        }
        return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      }
      return new Response(JSON.stringify({ windowLimits: { fiveHour: { exceeded: false } } }))
    }
    new ProbeLlm(ctx)
    new ProbeCredentials(ctx)
    await ctx.plugin(TypertRegistry)
    await ctx.plugin({ inject: plugin.inject, apply(context) { plugin.apply(context, config) } })
    assert.ok(adapter, '真实宿主必须注册适配器')
    await assert.rejects(generate(), error => error.code === 'THROTTLED')
    pending = gate()
    armed = pending
    const old = generate()
    await pending.entered
    change({ apiBase: b, accounts: [{ apiKeyEnv: 'GATEWAY_FACTS_EXTRA', label: '合成额外账号' }], activeAccount: 'GATEWAY_FACTS_EXTRA' })
    pending.release()
    await old
    assert.deepEqual(calls.map(call => call.url), [
      `${a}/provider/v1/chat/completions`, `${a}/alpha/billing/credits`, `${a}/provider/v1/chat/completions`,
    ])
    assert.equal(calls[2].key, 'Bearer synthetic-default', '旧调用固定账号定义')
    await generate()
    assert.equal(calls.at(-1).url, `${b}/provider/v1/chat/completions`)
    assert.equal(calls.at(-1).key, 'Bearer synthetic-extra', '新调用使用新账号配置且不继承甲的限流')

    rejectExtraForReport = true
    await generate()

    // 实际远端接收者读取账号时切第三个网关，整个报告仍属于乙。
    pending = gate()
    armed = pending
    const beforeReport = calls.length
    const reporting = ctx.get('commandcodeUsage').report()
    await pending.entered
    change({ apiBase: c, accounts: [], activeAccount: 'default' })
    pending.release()
    const report = await reporting
    assert.equal(report.accounts.length, 2, '旧用量报告仍保留乙的账号定义')
    assert.equal(report.accounts.find(account => account.id === 'GATEWAY_FACTS_EXTRA').active, true)
    assert.equal(report.accounts.find(account => account.id === 'GATEWAY_FACTS_EXTRA').mark, '', '用量报告使用共享恢复后的标记')
    assert.equal(calls.length > beforeReport, true)
    assert.equal(calls.slice(beforeReport).every(call => new URL(call.url).origin === b), true, '旧报告不得读取丙网关的用量')
    change({ apiBase: d, accounts: [{ apiKeyEnv: 'GATEWAY_FACTS_EXTRA', label: '合成额外账号' }], activeAccount: 'GATEWAY_FACTS_EXTRA' })
    const beforeRotation = calls.length
    pending = gate()
    rejectRotation = true
    const rotating = generate()
    await pending.entered
    change({ apiBase: e, accounts: [], activeAccount: 'default' })
    pending.release()
    await rotating
    assert.deepEqual(calls.slice(beforeRotation), [
      { url: `${d}/provider/v1/chat/completions`, key: 'Bearer synthetic-extra' },
      { url: `${d}/provider/v1/chat/completions`, key: 'Bearer synthetic-default' },
    ], '真实轮换回调必须沿用原连接及账号定义')
    await generate()
    assert.equal(calls.at(-1).url, `${e}/provider/v1/chat/completions`)
    process.stdout.write('网关事实真实宿主检查通过：初次解析、轮换、探测与用量固定原来源，新调用读取新配置\n')
  } catch (error) { fail(`网关事实真实宿主检查：${error.stack ?? error.message}`) }
  finally {
    pending?.release()
    armed?.release()
    globalThis.fetch = savedFetch
    await ctx.fiber.dispose()
  }
}

/** Run every check against one already-resolved engine. Returns whether that engine passed. */
async function verify(options) {
  const version = options.version ?? (options.engine === undefined ? declaredEngineVersions().at(-1) : undefined)
  let engineRoot = options.engine
  let scratch
  let installed
  try {
    if (engineRoot === undefined) {
      installed = installEngine(version)
      engineRoot = installed
    }
    const engine = resolveEngine(engineRoot)
    process.stdout.write(`engine: dsh ${engine.version} at ${engine.root}\n`)
    scratch = mkdtempSync(join(tmpdir(), 'dsh-engine-load-tree-'))
    const staged = await checkLink(engine.modules, scratch)
    await checkNamedImports(engine.modules)
    await checkEngineAdmission(engine.modules, engine.version)
    checkClientRequires(engine.modules)
    await checkImagePricing(staged)
    await checkVolatileConfig(staged)
    await checkProviderFailures(staged, engine.modules)
    await checkToolHistory(staged, engine.modules)
    await checkEnrollmentStream(staged, engine.modules)
    await checkAnalyticsHistory(staged, engine.modules)
    await checkCostProjection(staged, engine.modules)
    await checkSessionTitle(staged, engine.modules)
    await checkStreamSettlement(staged, engine.modules)
    await checkContextWindowBudget(staged, engine.modules)
    await checkGatewayRequestFacts(staged, engine.modules)
    const policy = await checkImagePolicy(engine.modules)
    process.stdout.write(`request-image offload contract on this engine: ${policy}\n`)
    if (version !== undefined && engine.version !== version) {
      warn(`engine reports ${engine.version}, expected ${version}`)
    }
    return report(engine.version)
  } finally {
    if (scratch !== undefined && !options.keep) rmSync(scratch, { recursive: true, force: true })
    if (installed !== undefined && !options.keep) rmSync(installed, { recursive: true, force: true })
  }
}

/**
 * 默认对 package.json 声明兼容的**每一个**引擎各跑一遍完整检查（矩阵）；
 * `--engine` / `--version` 仍可把范围收窄到单个引擎。
 */
async function main(argv) {
  const options = parseArgs(argv)
  if (options.engine !== undefined || options.version !== undefined) {
    process.exit((await verify(options)) ? 0 : 1)
  }
  const versions = declaredEngineVersions()
  let passed = true
  for (const [index, version] of versions.entries()) {
    if (index > 0) process.stdout.write('\n')
    process.stdout.write(`===== 引擎矩阵 ${index + 1}/${versions.length}: dsh ${version} =====\n`)
    // 每个引擎独立结算：上一个引擎的失败不得污染下一个的判定。
    failures.length = 0
    warnings.length = 0
    passed = (await verify({ ...options, version })) && passed
  }
  if (versions.length > 1) {
    process.stdout.write(
      passed
        ? `engine-load smoke passed on all ${versions.length} declared-compatible engines (${versions.join(', ')})\n`
        : `engine-load smoke FAILED on at least one of ${versions.length} declared-compatible engines (${versions.join(', ')})\n`,
    )
  }
  process.exit(passed ? 0 : 1)
}

await main(process.argv.slice(2))
