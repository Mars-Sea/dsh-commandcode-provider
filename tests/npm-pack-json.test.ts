import { test } from 'node:test'
import assert from 'node:assert/strict'

const { parseJsonPrefix, packedEntry } = await import(
  new URL('../scripts/npm-pack-json.mjs', import.meta.url).href
)

/**
 * CI runs npm 10 (`actions/setup-node@v4` on ubuntu-latest), which runs this
 * project's `prepare` — `tsdown` — even under `npm pack --ignore-scripts`. Its
 * banners land on STDOUT AHEAD of the JSON, so `JSON.parse(stdout)` threw
 * `Unexpected token ''` and `npm run test:install` failed there while passing
 * locally on npm 11 (run 36803404336). These cases pin the skip-and-parse.
 */
test('跳过 prepare 脚本打在 JSON 之前的 stdout 噪声', () => {
  const noise = [
    '\u001b[34mℹ\u001b[39m \u001b[34mtsdown v0.22.14\u001b[39m powered by rolldown',
    '\u001b[34mℹ\u001b[39m config file: /home/runner/work/repo/tsdown.config.ts ',
    '\u001b[32m✔\u001b[39m Build complete in 726ms',
    '',
  ].join('\n')
  const payload = [{ filename: 'mars-sea-dsh-commandcode-provider-0.12.2.tgz', files: [] }]
  const stdout = `${noise}\n${JSON.stringify(payload, null, 2)}\n`
  assert.deepEqual(parseJsonPrefix(stdout), payload)
  assert.equal(packedEntry(stdout).filename, 'mars-sea-dsh-commandcode-provider-0.12.2.tgz')
})

test('噪声里的方括号和无括号文本都不会被误当成 JSON 起点', () => {
  // A banner containing `[ESM]` and a path containing `{` must not win: both
  // are tried and rejected, and the real array further along still parses.
  const noisy = '[ESM] lib/index.js\nconfig {tsdown.config.ts}\n[{"filename":"a.tgz"}]'
  assert.deepEqual(parseJsonPrefix(noisy), [{ filename: 'a.tgz' }])
})

test('没有 JSON 时明确报错，而不是返回空值让后续静默通过', () => {
  assert.throws(() => parseJsonPrefix('ℹ tsdown v0.22.14\n✔ Build complete\n'), /没有找到 JSON/)
  assert.throws(() => packedEntry(''), /没有找到 JSON/)
  // An empty array parses fine but carries no entry: reported as a missing
  // entry, not silently handed back as `undefined`.
  assert.throws(() => packedEntry('[]'), /没有报告打包条目/)
})

test('噪声行数超过上限就停止扫描并报错', () => {
  // A runaway `prepare` printing thousands of lines must fail loudly rather
  // than scan forever or latch onto something that merely looks like JSON.
  const runaway = `${'x\n'.repeat(500)}[{"filename":"late.tgz"}]`
  assert.throws(() => parseJsonPrefix(runaway), /没有找到 JSON/)
})

test('数组与键值对象两种 npm pack 形状都接受', () => {
  const entry = { filename: 'p.tgz', files: [{ path: 'lib/index.js' }] }
  assert.deepEqual(packedEntry(JSON.stringify([entry])), entry)
  assert.deepEqual(packedEntry(JSON.stringify({ 0: entry })), entry)
})

test('打包条目非对象时报错', () => {
  assert.throws(() => packedEntry('"a string"'), /没有报告打包条目/)
  assert.throws(() => packedEntry('null'), /没有报告打包条目/)
})
