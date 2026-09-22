/**
 * Engine-load smoke test: prove this bundle LINKS and EVALUATES against a real
 * dsh engine before it ships.
 *
 * Why this exists (issue #43): dsh-llm 0.1.6 removed
 * `offloadRequestImagesWithPolicy`, which the adapter imported by name. The
 * built bundle carried a static ESM named import of a symbol that no longer
 * existed, so on that engine the host half never instantiated — no
 * `commandcode` route, no settings page, no panel — while every check that ran
 * against this checkout's own `node_modules` stayed green, because those peers
 * are pinned at 0.1.2-rc.1 and a `link:`-installed profile resolves them from
 * there instead of from the engine. A named import of an absent export is a
 * link-time failure, so no amount of runtime testing short of importing the
 * bundle from a tree whose peers ARE the engine can see it.
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
 *   5. Asserts the engine exposes ONE complete request-image policy generation
 *      and, on the durable (>=0.1.6) one, that `LlmError` carries
 *      `failure.offloadImages` — the payload the adapter's offload request is
 *      read from.
 *   6. Asserts the Config schema SPLIT holds on this engine: `Config` marks
 *      every settings-form field volatile (except the composition-only
 *      `apiKey`) and parses to live references, while `LegacySettingsSchema`
 *      carries no mark and parses to a plain, `structuredClone`-able object —
 *      the shape ≤0.1.6's settings registration requires even though
 *      schemastery ≥3.18.3 creates references during parse on every
 *      generation. Skipped with a warning on engines whose schemastery
 *      predates `.volatile()`.
 *   7. Builds tool history with this engine's message constructors and captures
 *      both transports' next request. Calls AND results must survive; merely
 *      loading the bundle cannot detect message-envelope drift.
 *
 * Usage:
 *   node scripts/verify-engine-load.mjs                     # install + check
 *   node scripts/verify-engine-load.mjs --version 0.1.5-rc.2
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
 * pricing path imports still resolve on it, and that BOTH payload generations
 * the harness has shipped are priced — the token meter throws unless exactly one
 * price comes back per occurrence, so an unhandled shape is a broken meter
 * rather than a wrong number.
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
  const asReference = pricing.priceImages([ref])
  if (asBlock.length !== 1 || asReference.length !== 1) {
    fail(`priceImages() must answer one price per occurrence, got ${asBlock.length} and ${asReference.length}`)
    return
  }
  // Anthropic's published rule (one token per 750 px) at the request target.
  const expected = Math.ceil((1568 * 1045) / 750)
  if (asBlock[0].visualTokens !== expected) {
    fail(`a retained image priced ${asBlock[0].visualTokens} tokens, expected ${expected} at the request target`)
  }
  if (asReference[0].visualTokens !== expected) {
    fail('the bare-reference payload (<=0.1.5) priced differently from the block payload')
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
 * Check 6: the Config schema split is right for BOTH settings generations.
 *
 * Two facts must hold on the engine the bundle will run on:
 *
 *   1. `Config` (the 0.1.7 generation) marks every field volatile except the
 *      composition-only `apiKey`, AND parsing a config through it really does
 *      produce a live reference (`{ get() }`) — the mark is worthless if the
 *      engine's schemastery ignores it.
 *   2. `LegacySettingsSchema` (the ≤0.1.6 registration) carries NO mark and
 *      parses to a plain, `structuredClone`-able object. This is not
 *      bookkeeping: schemastery ≥3.18.3 creates references during PARSE on
 *      EVERY generation (`dsh-settings` through 0.1.6 declares
 *      `schemastery: ^3.18.2`, so a freshly installed old engine resolves
 *      3.18.3), and that generation re-validates the base it is handed and
 *      `structuredClone`s it for the directory — so a marked schema there is a
 *      boot-time `ValidationError`. Check 1 cannot see that: the plugin still
 *      links and evaluates; only a MARKED-schema-on-old-engine parse does.
 *
 * The mark can only exist where the engine's schemastery ships `.volatile()`,
 * so an older engine reports SKIPPED instead of failing a generation that
 * never needed the split.
 */
async function checkVolatileConfig(staged) {
  if (staged === undefined) return
  const plugin = await import(pathToFileURL(join(staged, 'lib', 'index.js')).href)
  const fields = plugin.Config?.dict
  const legacyFields = plugin.LegacySettingsSchema?.dict
  if (fields === undefined || fields.apiBase === undefined) {
    fail('the staged Config schema carries no dict, so its settings-form surface cannot be checked')
    return
  }
  if (legacyFields === undefined || legacyFields.apiBase === undefined) {
    fail('the staged bundle exports no LegacySettingsSchema — ≤0.1.6 registration cannot be checked')
    return
  }
  if (typeof fields.apiBase.volatile !== 'function') {
    warn('engine schemastery predates .volatile(); skipped the settings-form field audit')
    return
  }
  for (const [name, field] of Object.entries(fields)) {
    const marked = field?.meta?.volatile === true
    if (name === 'apiKey') {
      if (marked) fail('Config.apiKey must stay unmarked: it is the composition-only secret literal')
      continue
    }
    if (!marked) fail(`Config.${name} is not volatile — 0.1.7 settings forms cannot see or write it`)
  }
  for (const [name, field] of Object.entries(legacyFields)) {
    if (field?.meta?.volatile === true) {
      fail(`LegacySettingsSchema.${name} carries a volatile mark — ≤0.1.6 settings would throw at boot`)
    }
  }
  // Parse through both schemas. `Config` must yield references; the legacy one
  // must stay plain AND survive the clone the old service performs on it.
  let marked
  try {
    marked = plugin.Config({ apiKeyEnv: 'engine-load-probe' })
  } catch (error) {
    fail(`Config rejected the engine-load probe config: ${error.message}`)
    return
  }
  const ref = marked?.apiKeyEnv
  if (ref === null || typeof ref !== 'object' || typeof ref.get !== 'function') {
    fail('Config parses to plain values on this engine, so volatile writes cannot commit in place')
  }
  let legacy
  try {
    legacy = plugin.LegacySettingsSchema({ apiKeyEnv: 'engine-load-probe' })
  } catch (error) {
    fail(`LegacySettingsSchema rejected the engine-load probe config: ${error.message}`)
    return
  }
  if (legacy?.apiKeyEnv !== 'engine-load-probe') {
    fail(`LegacySettingsSchema parsed apiKeyEnv as ${String(legacy?.apiKeyEnv)}, expected the plain string`)
  }
  try {
    structuredClone(legacy)
  } catch (error) {
    fail(`LegacySettingsSchema parses to a non-cloneable object (${error.name}) — ≤0.1.6 describe would throw`)
  }
}

/** Check 4: the engine has one complete request-image policy, payload included. */
async function checkImagePolicy(engineModules) {
  const specifier = `${SCOPE}/dsh-llm`
  const require = createRequire(join(dirname(engineModules), 'probe.cjs'))
  const module = await import(pathToFileURL(require.resolve(specifier)).href)
  const durable = typeof module.requiredImageOffload === 'function' && typeof module.projectOffloadedImages === 'function'
  const transient = typeof module.offloadRequestImagesWithPolicy === 'function'
  if (!durable && !transient) {
    fail(`${specifier} exposes neither request-image policy generation; the adapter cannot budget images`)
    return 'none'
  }
  if (durable && transient) {
    warn(`${specifier} exposes both policy generations; the adapter speaks the durable one`)
  }
  if (durable) {
    // The adapter throws this code with `offloadImages`; dsh-compaction-image-offload
    // reads it back off `failure`, so a dropped field would silently break offload.
    const error = new module.LlmError('engine-load probe', module.IMAGE_OFFLOAD_REQUIRED_CODE, { offloadImages: 3 })
    if (error.code !== 'IMAGE_OFFLOAD_REQUIRED') fail(`LlmError code round-trip returned ${String(error.code)}`)
    if (error.failure?.offloadImages !== 3) {
      fail('LlmError does not carry failure.offloadImages, so the harness cannot read the offload count')
    }
  }
  return durable ? 'durable' : 'transient'
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
  process.stdout.write(`tool history checked with engine result role: ${messages[2].role}\n`)
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
    const policy = await checkImagePolicy(engine.modules)
    process.stdout.write(`request-image policy on this engine: ${policy}\n`)
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
