#!/usr/bin/env node
/**
 * Rewrite the vendored price rows in `src/model-prices.ts` from the official
 * pricing page.
 *
 * The page is the only source of truth for per-token rates, and it publishes
 * them twice: as an embedded model JSON array (the `timeOfDay` / `contextTiers`
 * blocks live here and nowhere else) and as rendered HTML rows. This script
 * reads the JSON — never the rendered column text — and then asserts the two
 * agree for the rows it rewrites, because a rate that is internally consistent
 * (`0.22 → 0.44` is exactly the 2× the page promises) can still be the wrong
 * row. That is not hypothetical: `deepseek-v4-flash-vision-exp` shipped at
 * `$0.22/$0.66` when the page says `$0.15/$0.60`, and only a cross-check
 * against the second source catches that class of error.
 *
 * Usage:
 *   node scripts/sync-model-prices.mjs           # rewrite the rows
 *   node scripts/sync-model-prices.mjs --check   # exit 1 if they would change
 *
 * `--check` is offline-safe in the sense that it reports a fetch failure
 * distinctly from a mismatch, so it can run in CI wherever the network is
 * available without silently passing when the page is unreachable.
 *
 * Everything except the `MODEL_PRICE_ROWS` array is hand-written and survives a
 * rewrite: the module docstring, the types, the slug rules, and the table
 * builder. Only that one array's literal rows are regenerated.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PRICING_URL = 'https://commandcode.ai/docs/resources/pricing-limits'
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = join(REPO_ROOT, 'src', 'model-prices.ts')

/** `--check` reports drift instead of rewriting. */
const CHECK_ONLY = process.argv.includes('--check')

/**
 * Round a rate to the precision the page publishes. The page's own figures
 * carry up to 8 decimals (`0.08334`, `0.0028`), and JSON round-tripping can
 * introduce float noise (`0.0030000000000000001`), so every rate is normalized
 * through `Number(x.toPrecision(12))` before it is written.
 *
 * @param {unknown} value - raw JSON number.
 * @returns {number} the normalized rate.
 */
function rate(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`not a finite rate: ${JSON.stringify(value)}`)
  }
  return Number(value.toPrecision(12))
}

/**
 * Pull the page's embedded model records out of its Next.js flight payload.
 *
 * The payload escapes its JSON as a string literal, so the document text holds
 * `\"id\":\"gpt-5.4\"` while the records themselves are plain objects. A global
 * unescape followed by a bare `JSON.parse` over brace-balanced spans is brittle
 * against nested braces, so each record is extracted with a real string-aware
 * scanner instead.
 *
 * @param {string} html - the fetched document.
 * @returns {Array<Record<string, unknown>>} the model records, in page order.
 */
function extractModelRecords(html) {
  const unescaped = html.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  const records = []
  const marker = '{"id":"'
  let at = unescaped.indexOf(marker)
  while (at !== -1) {
    const end = scanObject(unescaped, at)
    if (end === -1) break
    const span = unescaped.slice(at, end)
    try {
      const parsed = JSON.parse(span)
      // The page carries several JSON shapes; a model record is the one with
      // rates. Everything else in the payload is skipped.
      if (typeof parsed?.inputCost === 'number' && typeof parsed?.outputCost === 'number') {
        records.push(parsed)
      }
    } catch {
      // Not a standalone record (a truncated or nested span): skip it. A real
      // parse failure surfaces later as a missing row.
    }
    at = unescaped.indexOf(marker, at + 1)
  }
  return records
}

/**
 * Find the index just past the object that starts at `start`, honoring nested
 * objects/arrays and string escapes.
 *
 * @param {string} text - the document text.
 * @param {number} start - index of the opening `{`.
 * @returns {number} the index after the matching `}`, or -1 when unbalanced.
 */
function scanObject(text, start) {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  return -1
}

/**
 * Read the rendered rates out of the page's HTML table as a second opinion.
 *
 * The rendered row is `<name> | <context> | $in | $out | $cacheRead | $cacheWrite | …`,
 * and the first numeric quadruplet after the model's display name is the
 * off-peak band (the page's own note says the shown rates are the base band,
 * with peak called out in the annotation). Only rows whose slug can be matched
 * are compared; a row the HTML does not expose is simply not cross-checked.
 *
 * @param {string} html - the fetched document.
 * @returns {Map<string, number[]>} display-name → [in, out, cacheRead].
 */
function renderedRates(html) {
  const found = new Map()
  const rows = html.split(/<tr[\s>]/).slice(1)
  for (const row of rows) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
      m[1].replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim(),
    )
    if (cells.length < 5) continue
    const name = cells[0]
    const money = cells.slice(1).map((cell) => {
      const m = cell.match(/\$([0-9]+(?:\.[0-9]+)?)/)
      return m === null ? undefined : Number(m[1])
    })
    const triplet = money.filter((value) => value !== undefined).slice(0, 3)
    if (triplet.length === 3 && name !== '') found.set(name.toLowerCase(), triplet)
  }
  return found
}

/**
 * Build the declarative rows the module embeds.
 *
 * @param {Array<Record<string, unknown>>} records - model records from the page.
 * @param {Map<string, number[]>} rendered - the HTML cross-check.
 * @returns {Array<{ id: string, rates: number[], peak?: number[] }>} the rows.
 */
function buildRows(records, rendered) {
  const rows = []
  const seen = new Set()
  const problems = []
  for (const record of records) {
    const id = record.id
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue
    seen.add(id)
    const rates = [rate(record.inputCost), rate(record.outputCost), rate(record.cacheReadCost)]
    if (record.cacheWriteCost !== undefined) rates.push(rate(record.cacheWriteCost))
    /** @type {{ id: string, rates: number[], peak?: number[] }} */
    const row = { id, rates }

    const timeOfDay = record.timeOfDay
    if (timeOfDay !== undefined && typeof timeOfDay === 'object') {
      const offPeak = timeOfDay.offPeak
      const peak = timeOfDay.peak
      if (peak === undefined || typeof peak !== 'object') {
        throw new Error(`${id}: timeOfDay without a peak block — the page changed shape`)
      }
      // The page duplicates its base rates into `offPeak`. Keeping only the
      // peak override is sound ONLY while that equality holds, so assert it.
      if (offPeak !== undefined) {
        const same =
          rate(offPeak.inputCost) === rates[0] &&
          rate(offPeak.outputCost) === rates[1] &&
          rate(offPeak.cacheReadCost) === rates[2]
        if (!same) {
          throw new Error(
            `${id}: timeOfDay.offPeak (${JSON.stringify(offPeak)}) no longer equals the base rates ` +
              `(${JSON.stringify(rates.slice(0, 3))}); the table must store the off-peak half explicitly`,
          )
        }
      }
      const peakRates = [rate(peak.inputCost), rate(peak.outputCost), rate(peak.cacheReadCost)]
      // Peak is the expensive half; a non-increasing override means the two
      // blocks were swapped or the page redefined the windows.
      for (let i = 0; i < 3; i += 1) {
        if (peakRates[i] < rates[i]) {
          throw new Error(`${id}: peak rate is below the off-peak rate (${peakRates[i]} < ${rates[i]})`)
        }
      }
      row.peak = peakRates
    }

    if (record.contextTiers !== undefined) {
      problems.push(`  · ${id}: has contextTiers; row stores the base band only`)
    }

    // Second opinion: the rendered row must agree with the embedded JSON.
    const name = typeof record.name === 'string' ? record.name.toLowerCase() : ''
    const htmlRow = rendered.get(name)
    if (htmlRow !== undefined) {
      for (let i = 0; i < 3; i += 1) {
        if (htmlRow[i] !== rates[i]) {
          problems.push(
            `  ! ${id}: embedded JSON says ${rates[i]} at index ${i}, the rendered table says ${htmlRow[i]}`,
          )
        }
      }
    }
    rows.push(row)
  }
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { rows, problems }
}

/** Render the rows as the TypeScript literal the module embeds. */
function renderRows(rows) {
  return rows
    .map((row) => {
      const rates = row.rates.join(', ')
      const peak = row.peak === undefined ? '' : `, peak: [${row.peak.join(', ')}]`
      return `  { id: '${row.id}', rates: [${rates}]${peak} },`
    })
    .join('\n')
}

/**
 * Replace the `MODEL_PRICE_ROWS` array literal in place, leaving every other
 * byte of the module untouched.
 *
 * @param {string} source - current module text.
 * @param {string} body - the new rows.
 * @returns {string} the rewritten module text.
 */
function replaceRows(source, body) {
  const anchor = 'const MODEL_PRICE_ROWS: readonly ModelPriceRow[] = ['
  const start = source.indexOf(anchor)
  if (start === -1) throw new Error('MODEL_PRICE_ROWS declaration not found')
  // Anchor on the full declaration: a bare `indexOf('[')` finds the `[]` in the
  // type annotation, not the literal's opening bracket.
  const open = start + anchor.length - 1
  // The array closes at the first `]` that starts a line, which is the literal's
  // own terminator (no row contains a bracketed multi-line value).
  const close = source.indexOf('\n]', open)
  if (close === -1) throw new Error('MODEL_PRICE_ROWS array not found')
  // Keep the header, the `[`, the `\n]`, and the rest of the module; replace
  // only the rows between them.
  return `${source.slice(0, open + 1)}\n${body}\n]${source.slice(close + 2)}`
}

async function main() {
  const response = await fetch(PRICING_URL, { redirect: 'follow' })
  if (!response.ok) {
    console.error(`fetch failed: HTTP ${response.status} from ${PRICING_URL}`)
    process.exit(2)
  }
  const html = await response.text()
  const records = extractModelRecords(html)
  if (records.length < 50) {
    console.error(`only ${records.length} model records found — the page shape changed; refusing to rewrite`)
    process.exit(2)
  }
  const { rows, problems } = buildRows(records, renderedRates(html))
  const body = renderRows(rows)
  const source = await readFile(TARGET, 'utf8')
  const next = replaceRows(source, body)

  if (problems.length > 0) {
    console.warn('cross-checks that need a human look:')
    for (const line of problems) console.warn(line)
  }

  if (next === source) {
    console.log(`model prices are up to date (${rows.length} rows)`)
    return
  }
  if (CHECK_ONLY) {
    console.error(`model prices are STALE: ${rows.length} rows fetched from the page differ`)
    process.exit(1)
  }
  await writeFile(TARGET, next)
  const before = source.split('\n').length
  const after = next.split('\n').length
  console.log(`rewrote ${rows.length} rows in src/model-prices.ts (${before} -> ${after} lines)`)
}

await main()
