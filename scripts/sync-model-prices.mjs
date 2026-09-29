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
 * The rendered table is read back as a second opinion. It is a `<div>` GRID, not
 * a `<table>`: it was a real table until some point before 2026-09-29, when the
 * `<tr>`-based parser was found to be matching only the six plan cards and
 * therefore checking none of the 88 model rows. `renderedRates()` now anchors on
 * each row's name cell and harvests all 88, `main()` refuses to write when that
 * harvest collapses, and a discounted row's struck-through figures are compared
 * against the `listRates` taken from the table JSON — so the pre-discount copy
 * is verified by an independent rendering of it, not by itself.
 *
 * The page also carries a SECOND array (the pricing table's own records), which
 * is where a row's `deal` and its pre-discount `listRates` live. Rows with a
 * deal are written with both price sets so the runtime can revert when the
 * promotion lapses; see `buildRows()` for why the table's `discountPercent` is
 * deliberately NOT used as the revert factor.
 *
 * Each row also carries the page's per-model monthly allowance
 * (`planAllowanceUsd`, identical to `planBudgetUsd` on all 82 rows), which is
 * what the settings page shows next to a model so the user can see how far
 * their plan's credits stretch on it. It exists ONLY for GOAT and Pro; the
 * script asserts that key set rather than trusting it.
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
 * Pull the pricing TABLE's records — the ones carrying `deal` and `tiers`.
 *
 * The page embeds two arrays whose records open with the same `{"id":"` marker:
 * the estimator's (flat `inputCost`/`outputCost`/`cacheReadCost`, which the rows
 * are built from) and the pricing table's (per-tier `rates`/`listRates` plus the
 * `deal` block). Only the latter carries `deal`, so that is the discriminator.
 * Both are needed: the estimator array publishes the DISCOUNTED rates, and the
 * table is the only place a pre-discount `listRates` exists.
 *
 * @param {string} html - the fetched document.
 * @returns {Map<string, Record<string, unknown>>} page slug → pricing-table record.
 */
function extractDealRecords(html) {
  const unescaped = html.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  const records = new Map()
  const marker = '{"id":"'
  let at = unescaped.indexOf(marker)
  while (at !== -1) {
    const end = scanObject(unescaped, at)
    if (end === -1) break
    try {
      const parsed = JSON.parse(unescaped.slice(at, end))
      if (typeof parsed?.id === 'string' && parsed?.deal !== undefined && Array.isArray(parsed?.tiers)) {
        records.set(parsed.id, parsed)
      }
    } catch {
      // Not a standalone record; a missing deal surfaces as an absent listRates.
    }
    at = unescaped.indexOf(marker, at + 1)
  }
  return records
}

/**
 * The pricing table's own pre-discount triplet for a row, when it publishes a
 * literal one.
 *
 * `listRates` is sometimes a flight REFERENCE rather than an object — the
 * Long-context tier of a discounted row holds
 * `"$30:props:rows:81:tiers:0:listRates"`, pointing at another tier's value —
 * so anything that is not a plain object with the three numeric keys is
 * reported as "not published" instead of being coerced into a rate.
 *
 * @param {Record<string, unknown> | undefined} record - the pricing-table record.
 * @returns {number[] | undefined} `[input, output, cacheRead]`, or undefined.
 */
function tableListRates(record) {
  const list = Array.isArray(record?.tiers) ? record.tiers[0]?.listRates : undefined
  if (list === null || typeof list !== 'object' || Array.isArray(list)) return undefined
  const keys = ['input', 'output', 'cacheRead']
  if (keys.some((key) => typeof list[key] !== 'number')) return undefined
  return keys.map((key) => rate(list[key]))
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
 * The model table's row markers, as the page renders them today.
 *
 * The table is a CSS grid, NOT a `<table>`: a row opens with
 * `<div class="grid grid-cols-[…]">` and its first cell is the name cell
 * (`flex min-w-0 items-center gap-2 px-4 py-3`), which holds the display name in
 * an `<a>`/`<span>` carrying `text-[13px] font-medium` — a deal badge next to it
 * uses `text-[10px]`, so the two never collide. Splitting the document on the
 * NAME CELL's opening tag therefore yields one segment per model, and each
 * segment contains exactly that model's rate cells before the next row begins.
 *
 * The previous parser split on `<tr>`/`<td>`; when the page moved to this
 * layout it kept returning the six plan cards and silently cross-checked
 * nothing for 88 models (measured 2026-09-29), which is why this now anchors on
 * the name cell and why `main()` refuses a suspiciously small harvest.
 */
const NAME_CELL_OPEN = '<div class="flex min-w-0 items-center gap-2 px-4 py-3">'
const MODEL_NAME = /<(?:a|span)[^>]*class="[^"]*text-\[13px\] font-medium[^"]*"[^>]*>([\s\S]*?)<\/(?:a|span)>/
const RATE_CELL = /<div class="(?:px-2 py-3 text-right|flex flex-col items-end px-2 py-3)[^"]*">([\s\S]*?)<\/div>/g
/**
 * A struck-through figure. The trailing `(?:\s[^>]*)?` matters: a looser
 * `<s[^>]*>` also matches `<span …>`, which would read a live price as if the
 * page had struck it through — an error this caught on the DeepSeek rows, whose
 * only markup is a tooltip `<span>`.
 */
const STRUCK_RATE = /<s(?:\s[^>]*)?>[^0-9]*\$([0-9]+(?:\.[0-9]+)?)/

/**
 * Read the model table out of the page's rendered HTML as a second opinion.
 *
 * Each row is `<name> | <context> | $in | $out | $cacheRead | $cacheWrite |
 * <capabilities>`, and this returns both price sets the row can show:
 *
 * - `rates` — the figure actually charged. On a discounted row the cell renders
 *   `<s>list</s><span>promotional</span>`, so the LAST `$` in the cell is the
 *   current price.
 * - `listRates` — the struck-through pre-discount triplet, present only when ALL
 *   three rate cells carry one. This is a genuinely independent copy of the
 *   table JSON's `listRates`, which is what makes it worth checking against.
 *
 * Rows whose cells show a word instead of a figure (`Free`) or the em-dash of an
 * unpublished rate are left out: there is nothing to compare, and a row that
 * cannot be parsed must never be reported as agreement.
 *
 * @param {string} html - the fetched document.
 * @returns {Map<string, { rates: number[], listRates?: number[] }>} lower-cased display name → parsed row.
 */
function renderedRates(html) {
  const found = new Map()
  const segments = html.split(NAME_CELL_OPEN).slice(1)
  for (const segment of segments) {
    const nameMatch = segment.match(MODEL_NAME)
    if (nameMatch === null) continue
    const name = nameMatch[1]
      .replace(/<[^>]*>/g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .trim()
      .toLowerCase()
    if (name === '' || found.has(name)) continue
    const current = []
    const struck = []
    for (const cell of segment.matchAll(RATE_CELL)) {
      const inner = cell[1]
      const money = [...inner.matchAll(/\$([0-9]+(?:\.[0-9]+)?)/g)]
      if (money.length === 0) continue
      current.push(rate(Number(money[money.length - 1][1])))
      const was = inner.match(STRUCK_RATE)
      struck.push(was === null ? undefined : rate(Number(was[1])))
    }
    if (current.length < 3) continue
    const listTriplet = struck.slice(0, 3)
    found.set(name, {
      rates: current.slice(0, 3),
      ...(listTriplet.length === 3 && listTriplet.every((value) => value !== undefined)
        ? { listRates: listTriplet }
        : {}),
    })
  }
  return found
}

/**
 * Build the declarative rows the module embeds.
 *
 * Rows for a model carrying a `deal` keep BOTH price sets: `rates` is what the
 * page charges while the promotion runs, `listRates` what it reverts to once
 * `deal.expires` passes. The runtime picks between them with the same clock
 * `dealLabel()` uses, so a lapsed discount stops pricing a session at the
 * promotional rate without waiting for the next sync.
 *
 * @param {Array<Record<string, unknown>>} records - model records from the page.
 * @param {Map<string, number[]>} rendered - the HTML cross-check.
 * @param {Map<string, Record<string, unknown>>} [dealRecords] - the pricing table's records.
 * @returns {Array<{ id: string, rates: number[], listRates?: number[], peak?: number[], allowance?: { goat: number, pro: number }, contextTiers?: unknown[] }>} the rows.
 */
function buildRows(records, rendered, dealRecords = new Map()) {
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

    // Per-model monthly allowance, in USD. The page publishes it ONLY for GOAT
    // and Pro — its own words are "the boost is a per-model allowance, so it
    // lives on the plans that have them" — so the key set is asserted rather
    // than trusted: a third tier means the product changed shape and a human
    // has to decide how the settings page should show it.
    const allowance = record.planAllowanceUsd
    if (allowance !== undefined && allowance !== null) {
      if (typeof allowance !== 'object' || Array.isArray(allowance)) {
        problems.push(`  ! ${id}: planAllowanceUsd is not an object (${JSON.stringify(allowance)})`)
      } else {
        const keys = Object.keys(allowance).sort()
        const expected = ['goat', 'pro']
        if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
          problems.push(`  ! ${id}: per-model allowance tiers are [${keys.join(', ')}], expected exactly [goat, pro]`)
        } else if (keys.some((key) => typeof allowance[key] !== 'number')) {
          problems.push(`  ! ${id}: per-model allowance is not numeric (${JSON.stringify(allowance)})`)
        } else {
          row.allowance = { goat: rate(allowance.goat), pro: rate(allowance.pro) }
        }
      }
    }

    if (record.contextTiers !== undefined) {
      if (!Array.isArray(record.contextTiers) || record.contextTiers.length === 0) throw new Error(`${id}: invalid contextTiers`)
      let previous = 0
      row.contextTiers = record.contextTiers.map((tier, index, tiers) => {
        const rates = [rate(tier.inputCost), rate(tier.outputCost), rate(tier.cacheReadCost)]
        if (tier.cacheWriteCost !== undefined) rates.push(rate(tier.cacheWriteCost))
        if (tier.maxContext === undefined) {
          if (index !== tiers.length - 1) throw new Error(`${id}: only the last context tier can be unbounded`)
          return { rates }
        }
        const maxContext = tier.maxContext
        if (!Number.isSafeInteger(maxContext) || maxContext <= previous || index === tiers.length - 1) throw new Error(`${id}: invalid context tier boundary`)
        previous = maxContext
        return { maxContext, rates }
      })
    }

    // A discounted row publishes the promotional rates here; the page's table
    // also publishes what the row reverts to. Keep both so the runtime can fall
    // back the moment the deal lapses.
    //
    // The table's own `listRates` is the ONLY usable pre-discount figure: its
    // `discountPercent` is a marketing number that does not divide out. MiMo
    // V2.5 (98% off) prices 0.14/0.28/0.0028 against a published list of
    // 0.8/4/0.16 — ratios of 5.7×, 14.3× and 57×, not one percentage. So the
    // page's literal listRates is copied verbatim, and context tiers are scaled
    // by that row's own per-bucket ratios when those agree.
    //
    // A deal with no literal listRates needs no fallback data: the page is
    // saying the UNIT PRICE does not change (Qwen 3.7 Max's `2x-usage` doubles
    // the allowance, it does not discount a token), so there is nothing to
    // revert to and the row is left alone. Same for a list that equals the
    // promotional rates.
    const deal = dealRecords.get(id)?.deal
    if (deal !== undefined && typeof deal === 'object') {
      const fromPage = tableListRates(dealRecords.get(id))
      const unchanged =
        fromPage !== undefined &&
        fromPage.length === rates.length &&
        fromPage.every((value, index) => value === rates[index])
      if (row.peak !== undefined && fromPage !== undefined && !unchanged) {
        // Pre-discount PEAK rates are published nowhere, and inventing a
        // multiplier for them is exactly the class of error this script exists
        // to catch. Leave the row discounted and flag it for a human.
        problems.push(`  ! ${id}: has both a deal and time-of-day pricing — its pre-discount peak rates need a human`)
      } else if (fromPage !== undefined && rates.length === 3 && !unchanged) {
        const factors = fromPage.map((value, index) => value / rates[index])
        row.listRates = fromPage
        if (row.contextTiers !== undefined) {
          if (Math.max(...factors) - Math.min(...factors) > 0.01) {
            problems.push(
              `  ! ${id}: its deal does not scale all three buckets alike (${factors.map((f) => f.toFixed(3)).join(', ')}),` +
                ` so its context tiers keep the promotional rates`,
            )
          } else {
            row.contextTiers = row.contextTiers.map((tier) =>
              tier.rates.length === 3
                ? { ...tier, listRates: tier.rates.map((value, index) => rate(value * factors[index])) }
                : tier,
            )
          }
        }
      }
    }

    // Second opinion: the rendered row must agree with the embedded JSON.
    const name = typeof record.name === 'string' ? record.name.toLowerCase() : ''
    const htmlRow = rendered.get(name)
    if (htmlRow !== undefined) {
      for (let i = 0; i < 3; i += 1) {
        if (htmlRow.rates[i] !== rates[i]) {
          problems.push(
            `  ! ${id}: embedded JSON says ${rates[i]} at index ${i}, the rendered table says ${htmlRow.rates[i]}`,
          )
        }
      }
      // The struck-through figures are the page's OWN pre-discount copy, so they
      // check the `listRates` taken from the table JSON rather than restating it.
      if (htmlRow.listRates !== undefined && row.listRates !== undefined) {
        for (let i = 0; i < 3; i += 1) {
          if (htmlRow.listRates[i] !== row.listRates[i]) {
            problems.push(
              `  ! ${id}: listRates[${i}] is ${row.listRates[i]} in the table JSON, but the rendered row strikes through ${htmlRow.listRates[i]}`,
            )
          }
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
      const listRates = row.listRates === undefined ? '' : `, listRates: [${row.listRates.join(', ')}]`
      const peak = row.peak === undefined ? '' : `, peak: [${row.peak.join(', ')}]`
      const allowance = row.allowance === undefined
        ? ''
        : `, allowance: { goat: ${row.allowance.goat}, pro: ${row.allowance.pro} }`
      const tiers = row.contextTiers === undefined ? '' : `, contextTiers: ${JSON.stringify(row.contextTiers)}`
      return `  { id: '${row.id}', rates: [${rates}]${listRates}${peak}${allowance}${tiers} },`
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
  // A blind cross-check is worse than no cross-check, because the run looks
  // clean either way. That is exactly what happened between the page's move to a
  // div grid and 2026-09-29: the old `<tr>` parser matched six plan cards and
  // silently compared nothing for 88 models. Refuse to write when the harvest
  // collapses like that, so the next layout change fails loudly instead.
  const rendered = renderedRates(html)
  if (rendered.size < records.length / 2) {
    console.error(
      `only ${rendered.size} model rows parsed out of the rendered table for ${records.length} records — ` +
        `the second opinion went blind; refusing to rewrite`,
    )
    process.exit(2)
  }
  const { rows, problems } = buildRows(records, rendered, extractDealRecords(html))
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
