/**
 * `npm pack --json` output parsing that survives a chatty `prepare` script.
 *
 * Two facts about `npm pack` make a plain `JSON.parse(stdout)` unsafe:
 *
 * 1. `prepare` runs for a `pack` of the local checkout on npm 10 (the version
 *    GitHub's ubuntu-latest `actions/setup-node@v4` pins), even with
 *    `--ignore-scripts`. CI therefore saw this project's own `prepare` —
 *    `tsdown` — print its banners to STDOUT before the JSON, so the stream
 *    began with `ℹ tsdown v0.22.14 …` and `JSON.parse` threw
 *    `Unexpected token ''` (run 36803404336). npm 11 does not run it, which is
 *    why the same script passed locally and the failure only showed up in CI.
 * 2. The array shape is not contractual either: `logTar` keys the entry by
 *    index and the CLI merges numeric keys back into an array, so a change to
 *    either could hand back a keyed object instead.
 *
 * So: skip anything before the first parsable JSON value, and accept both
 * shapes. A stream with no JSON at all must fail loudly rather than be coerced
 * into something.
 */

/** How many leading non-JSON lines to tolerate before calling the stream broken. */
const MAX_LEADING_NOISE_LINES = 200

/** Characters that can begin a JSON value: containers, strings, numbers, literals. */
const JSON_VALUE_STARTS = /[[{"\d-]|[tfn]/

/**
 * Extract the first complete JSON value from `text`, ignoring any prefix noise.
 *
 * Each position that can START a JSON value is tried in turn: `JSON.parse`
 * reports only the first problem it hits, so slicing from a banner that happens
 * to contain a bracket fails on the trailing text rather than on the value
 * itself — and the real JSON further along would be missed. Noise lines (the
 * empty remainder after a newline) are counted so a runaway script cannot
 * silently swallow a genuine failure.
 *
 * @param {string} text
 * @returns {unknown} the parsed value
 * @throws {Error} when nothing parses within the noise budget
 */
export function parseJsonPrefix(text) {
  let noiseLines = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\n') {
      noiseLines += 1
      if (noiseLines > MAX_LEADING_NOISE_LINES) break
      continue
    }
    if (!JSON_VALUE_STARTS.test(char)) continue
    try {
      return JSON.parse(text.slice(index))
    } catch {
      // Not the start of the value; keep scanning.
    }
  }
  throw new Error(
    `npm pack --json 的输出里没有找到 JSON（噪声 ${noiseLines} 行，上限 ${MAX_LEADING_NOISE_LINES} 行）`,
  )
}

/**
 * The single packed entry from a `npm pack --json` stdout, array or keyed.
 *
 * @param {string} stdout
 * @returns {Record<string, unknown>}
 */
export function packedEntry(stdout) {
  const packed = parseJsonPrefix(stdout)
  const entry = Array.isArray(packed) ? packed[0] : Object.values(packed ?? {})[0]
  if (entry === null || typeof entry !== 'object') {
    throw new Error('npm pack --json 没有报告打包条目')
  }
  return /** @type {Record<string, unknown>} */ (entry)
}
