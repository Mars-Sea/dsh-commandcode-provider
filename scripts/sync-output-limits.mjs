#!/usr/bin/env node
/**
 * Rewrite `MODEL_OUTPUT_TOKEN_LIMITS` in `src/capabilities.ts` from the public
 * models.dev catalog.
 *
 * Command Code's own `/provider/v1/models` publishes `context_length` and
 * `supported_endpoints` but NO output cap, so this adapter had been deriving
 * one from the context window and sending 131072 to models whose real ceiling
 * is 128000. The Messages endpoint refuses that by name
 * (`max_tokens: 131072 > 128000, which is the maximum allowed number of output
 * tokens for claude-sonnet-5-5`, issue #71), and because the rejection text
 * contains the word `max_tokens` it was ALSO being classified as a context
 * overflow — so the harness compacted a session that was not oversized and
 * resent the identical request.
 *
 * The catalog is a cross-provider aggregation, and that shapes the whole
 * script. The same model id appears under 2–26 providers, and for open-weight
 * models those providers disagree wildly (`moonshotai/Kimi-K3` has nine
 * different `output` values from 8000 to 1048576, because each host configures
 * its own deployment). A gateway's ceiling is neither the vendor's nor any one
 * host's.
 *
 * Command Code sells these models through their VENDOR'S OWN API, so the
 * vendor's number is the one worth writing: it is the ceiling the model was
 * built to, and every reseller sits at or below it. Resolution order:
 *
 *   1. the vendor's own row in the catalog, matched by name (see
 *      `OFFICIAL_PROVIDERS`; ids are namespaced by Command Code and bare under
 *      the vendor, so the match is on the normalized tail);
 *   2. that same row after dropping an OpenRouter-style `:free` suffix, which
 *      is a billing variant rather than a different deployment;
 *   3. unanimity across every provider carrying the id — only reached for
 *      models with no vendor row here (Stealth's own, and the handful of hosts
 *      that file no first-party entry);
 *   4. nothing. A model that reaches this point is left for the runtime to
 *      learn from the endpoint's own rejection (see `noteOutputCeilingRefusal`).
 *
 * Step 4 is not a gap. When the gateway is stricter than the vendor — and a
 * reseller is free to be — the request is refused, `streamRequest()` reads the
 * ceiling out of the refusal and retries once, and the tighter value is what
 * every later request uses. A vendor figure that is too high costs one round
 * trip; a guessed one that is too low silently halves every answer, forever.
 *
 * Usage:
 *   node scripts/sync-output-limits.mjs           # rewrite the table
 *   node scripts/sync-output-limits.mjs --check   # exit 1 if it would change
 *
 * `--check` reports an unreachable catalog distinctly from a mismatch, so CI
 * can run it wherever the network exists without passing on a fetch failure.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const CATALOG_URL = 'https://models.dev/api.json'
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = join(REPO_ROOT, 'src', 'capabilities.ts')

/** `--check` reports drift instead of rewriting. */
const CHECK_ONLY = process.argv.includes('--check')

/**
 * Command Code catalog id namespace → the vendor's own models.dev entry.
 *
 * Command Code names a model by its vendor (`Qwen/Qwen3.8-Max`,
 * `zai-org/GLM-5.2`, `z-ai/glm-5.3-flashx`), and the vendor files it unprefixed
 * under its own key (`qwen3.8-max`, `glm-5.2`), so the mapping is not a lookup
 * but a naming convention. `gpt-*` and `claude-*` arrive bare and are matched by
 * their family prefix. A namespace absent here (`stealth`, and hosts that file
 * no first-party row) falls through to rule 3.
 */
const OFFICIAL_PROVIDERS = {
  Qwen: 'alibaba',
  gpt: 'openai',
  claude: 'anthropic',
  deepseek: 'deepseek',
  moonshotai: 'moonshotai',
  MiniMaxAI: 'minimax',
  nvidia: 'nvidia',
  poolside: 'poolside',
  stepfun: 'stepfun',
  thinkingmachines: 'thinkingmachines',
  xai: 'xai',
  xiaomi: 'xiaomi',
  'z-ai': 'zai',
  'zai-org': 'zai',
  google: 'google',
  sakana: 'sakana',
  meta: 'meta',
  tencent: 'tencent',
  meituan: 'meituan',
  inclusionai: 'inclusionai',
}

/** Compare ids with punctuation and case out: `Qwen3.8-Max` ≡ `qwen3.8-max`. */
const normalizeId = (id) => id.toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * Ceilings the catalog cannot supply, recorded by hand with the reason.
 *
 * These are NOT guesses to fill a hole — each one is a documented inference a
 * rewrite must not silently drop, and this map is how the row survives the very
 * script that would otherwise omit it (rule 4). Every entry carries the evidence
 * it rests on, and every entry is visited by the runtime anyway: a wrong value
 * costs one refused request, then `streamRequest()` remembers the real ceiling.
 *
 * - `inclusionai/ling-3.1-flash:free` (command-code@1.70.0): models.dev has no
 *   `ling-3.1` row at all as of 2026-09-30 — the Ling family's newest entry is
 *   `ling-3.0-flash`, which every provider that carries it files at exactly
 *   32768 output (`openrouter`, `kilo`, `nano-gpt`, `deepinfra`, `novita-ai`).
 *   32768 is therefore the family's established ceiling and the 3.1 inherits it
 *   rather than starting at DEFAULT_MESSAGES_MAX_TOKENS. Recorded deliberately:
 *   it is one uniform family-wide figure, not a split vote.
 */
const MANUAL_CEILINGS = {
  'inclusionai/ling-3.1-flash:free': { value: 32768, via: 'manual: no models.dev row; Ling family ceiling 32768, see MANUAL_CEILINGS' },
}

/** The vendor namespace of a catalog id, or its family for a bare one. */
function namespaceOf(id) {
  const slash = id.indexOf('/')
  return slash < 0 ? id.split('-')[0] : id.slice(0, slash)
}

/**
 * The ceiling from the vendor's own row, or undefined when the catalog files
 * no such model there. A free variant is a billing tier on the same
 * deployment, so it is tried without before giving up. Both spellings occur in
 * the catalog and neither is uniform: `inclusionai/ling-3.0-flash-sante:free`
 * uses a colon, `poolside/laguna-s-2.1-free` a hyphen. The suffix comes off the
 * FULL id, not the tail — the vendor files that model under its namespaced
 * name, so stripping after the split would still miss it.
 */
function officialCeiling(catalog, id) {
  const providerId = OFFICIAL_PROVIDERS[namespaceOf(id)]
  const models = providerId === undefined ? undefined : catalog[providerId]?.models
  if (models === undefined) return undefined
  const tail = id.slice(id.indexOf('/') + 1)
  const paid = id.replace(/(?::|-)free$/, '')
  for (const candidate of [id, tail, paid, paid.slice(paid.indexOf('/') + 1)]) {
    const wanted = normalizeId(candidate)
    for (const [key, model] of Object.entries(models)) {
      const output = model?.limit?.output
      if (output > 0 && normalizeId(key) === wanted) return { value: output, via: providerId }
    }
  }
  return undefined
}

/**
 * Read the Command Code model ids out of the snapshot. `KNOWN_PLANS` is the
 * only complete list in the module (it enumerates every catalog row by plan),
 * so it is the set this table is generated for; parsing the literal keeps the
 * script free of a build step and of a second copy of the id list.
 */
async function readCatalogIds() {
  const source = await readFile(TARGET, 'utf8')
  const start = source.indexOf('export const KNOWN_PLANS')
  const end = source.indexOf('export const KNOWN_SUBSCRIPTION_PLANS')
  if (start < 0 || end < 0) throw new Error('cannot locate KNOWN_PLANS in src/capabilities.ts')
  return [...source.slice(start, end).matchAll(/^ {2}'([^']+)':/gm)].map((m) => m[1])
}

async function fetchCatalog() {
  const response = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`${CATALOG_URL} returned HTTP ${response.status}`)
  return response.json()
}

/**
 * Every provider's `limit.output` for one model id, keyed by provider.
 *
 * The id is looked up twice per provider. Vendors that also resell other
 * vendors' weights file their own rows under the bare id (`gemini-3.7-flash`
 * under `google`), while the aggregators that Command Code's catalog was built
 * from file it namespaced (`google/gemini-3.7-flash`); both spellings have to
 * resolve or the first-party row is invisible to the very rule meant to find it.
 */
function collectOutputs(catalog, id) {
  const found = new Map()
  for (const [providerId, provider] of Object.entries(catalog)) {
    const model = provider.models?.[id]
      ?? provider.models?.[id.slice(id.indexOf('/') + 1)]
    const output = model?.limit?.output
    if (typeof output === 'number' && output > 0) found.set(providerId, output)
  }
  return found
}

/**
 * The ceiling to record for `id`, or undefined when neither the vendor's row
 * nor an unanimous consensus supports one.
 */
function resolveCeiling(catalog, id) {
  const manual = MANUAL_CEILINGS[id]
  if (manual !== undefined) return manual
  const official = officialCeiling(catalog, id)
  if (official !== undefined) return official
  const outputs = collectOutputs(catalog, id)
  if (outputs.size === 0) return undefined
  const distinct = new Set(outputs.values())
  if (distinct.size === 1) {
    return { value: distinct.values().next().value, via: `${outputs.size} provider(s), unanimous` }
  }
  return undefined
}

/** The table literal, with each row naming why it is trusted. */
function renderTable(rows) {
  const body = [...rows]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([id, entry]) => `  // ${entry.via}\n  ['${id}', ${entry.value}],`)
    .join('\n')
  return `export const MODEL_OUTPUT_TOKEN_LIMITS: ReadonlyMap<string, number> = new Map([\n${body}\n])`
}

async function main() {
  const [catalog, ids] = await Promise.all([fetchCatalog(), readCatalogIds()])

  const rows = []
  const skipped = []
  for (const id of ids) {
    const ceiling = resolveCeiling(catalog, id)
    if (ceiling === undefined) {
      const distinct = new Set(collectOutputs(catalog, id).values()).size
      skipped.push(`${id}${distinct > 1 ? ` (${distinct} conflicting provider values)` : ' (not in catalog)'}`)
      continue
    }
    rows.push([id, ceiling])
  }

  const current = await readFile(TARGET, 'utf8')
  const match = /export const MODEL_OUTPUT_TOKEN_LIMITS: ReadonlyMap<string, number> = new Map\(\[[\s\S]*?\]\)/.exec(current)
  if (match === null) throw new Error('cannot locate MODEL_OUTPUT_TOKEN_LIMITS in src/capabilities.ts')
  const next = current.replace(match[0], renderTable(rows))

  console.log(`catalog: ${ids.length} model id(s); wrote ${rows.length} ceiling(s); left ${skipped.length} to runtime learning`)
  if (skipped.length > 0) {
    console.log('left out (no vendor row, and providers disagree or are absent):')
    for (const line of skipped) console.log(`  ${line}`)
  }

  if (next === current) {
    console.log('table already up to date')
    return
  }
  if (CHECK_ONLY) {
    console.error('MODEL_OUTPUT_TOKEN_LIMITS is out of date; run: node scripts/sync-output-limits.mjs')
    process.exitCode = 1
    return
  }
  await writeFile(TARGET, next)
  console.log(`updated ${TARGET}`)
}

main().catch((error) => {
  console.error(`sync-output-limits failed: ${error.message}`)
  process.exitCode = 1
})
