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
 * declares exactly ONE supported engine, so this is also where a peer bump is
 * proven to link before it ships.
 *
 * What it does, in order:
 *   1. Resolves the engine — `--engine <dir>`, `$DSH_ENGINE`, or the highest
 *      release `package.json` declares `compatible`, freshly installed.
 *   2. Copies this checkout's PUBLISHED surface into a scratch tree whose
 *      `node_modules` are the engine's, then imports the plugin there — the
 *      link check, and the assertion that `name`/`apply`/`Config` survive.
 *   3. Audits every static named import in `lib/index.js` against the engine's
 *      own exports, reporting the missing symbol by name instead of a raw
 *      SyntaxError.
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
 *   node scripts/verify-engine-load.mjs                     # install + check
 *   node scripts/verify-engine-load.mjs --engine /path/to/dsh-install
 *   node scripts/verify-engine-load.mjs --engine ~/.dsh/profiles/web
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

/** Print the report and exit with the aggregate verdict. */
function report(engine) {
  for (const message of warnings) process.stdout.write(`  warn  ${message}\n`)
  if (failures.length === 0) {
    process.stdout.write(`engine-load smoke passed against dsh ${engine}\n`)
    process.exit(0)
  }
  for (const message of failures) process.stderr.write(`  FAIL  ${message}\n`)
  process.stderr.write(`engine-load smoke FAILED against dsh ${engine} (${failures.length})\n`)
  process.exit(1)
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

/** The newest release `package.json` claims to support. */
function declaredEngineVersion() {
  const pkg = JSON.parse(readFileSync(join(repositoryDir, 'package.json'), 'utf8'))
  const releases = Object.keys(pkg.dsh?.compatibility?.dshReleases ?? {})
  if (releases.length === 0) abort('package.json declares no dsh.compatibility.dshReleases')
  return releases.sort(compareVersions).at(-1)
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
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(TypertGatewayService, {})
    await ctx.plugin({ inject: plugin.inject, apply(c) { plugin.apply(c, config) } })
    const gateway = ctx.get('typertGateway')
    const control = new AbortController()
    const stream = await gateway.stream({ namespace: 'commandcode', method: 'enrollmentWatch', args: { input: { pageId } }, signal: control.signal })
    const iterator = stream[Symbol.asyncIterator]()
    assert.equal((await iterator.next()).value, true)
    const state = await gateway.invoke({ namespace: 'commandcode', method: 'enrollmentBegin', args: { input: { id, pageId, mode: 'manual', label: '合成账号', automaticName: false, key: 'synthetic-key' } } })
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
          assert.equal(assembly.finish.failure.code, scenario === 'empty-limit' ? 'OUTPUT_TOKEN_LIMIT' : scenario === 'tool-cut' ? 'STREAM_CLOSED' : 'PROVIDER_STREAM_ERROR')
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
        if (rejectExtraForReport && url.startsWith(b) && key === 'Bearer synthetic-extra') {
          rejectExtraForReport = false
          return new Response('rate limited', { status: 429 })
        }
        if (rejectRotation && url.startsWith(d) && key === 'Bearer synthetic-extra') {
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
    assert.equal(calls.slice(beforeReport).every(call => call.url.startsWith(b)), true, '旧报告不得读取丙网关的用量')
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

/** Run every check against one resolved engine. */
async function verify(argv) {
  const options = parseArgs(argv)
  const version = options.version ?? (options.engine === undefined ? declaredEngineVersion() : undefined)
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
    checkClientRequires(engine.modules)
    await checkImagePricing(staged)
    await checkVolatileConfig(staged)
    await checkToolHistory(staged, engine.modules)
    await checkEnrollmentStream(staged, engine.modules)
    await checkStreamSettlement(staged, engine.modules)
    await checkGatewayRequestFacts(staged, engine.modules)
    const policy = await checkImagePolicy(engine.modules)
    process.stdout.write(`request-image offload contract on this engine: ${policy}\n`)
    if (version !== undefined && engine.version !== version) {
      warn(`engine reports ${engine.version}, expected ${version}`)
    }
    report(engine.version)
  } finally {
    if (scratch !== undefined && !options.keep) rmSync(scratch, { recursive: true, force: true })
    if (installed !== undefined && !options.keep) rmSync(installed, { recursive: true, force: true })
  }
}

await verify(process.argv.slice(2))
