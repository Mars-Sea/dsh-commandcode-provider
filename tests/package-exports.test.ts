import { test } from 'node:test'
import assert from 'node:assert/strict'

const { verifyPackedExports } = await import(new URL('../scripts/verify-package-exports.mjs', import.meta.url).href)

test('打包入口校验展开条件和通配项，发现工作区有但未发布的源码', () => {
  const manifest = {
    main: './lib/index.js', types: './lib/index.d.ts',
    exports: { '.': { types: './lib/index.d.ts', default: './lib/index.js' }, './src/*': './src/*', './locale/*.json': './locale/*.json' },
  }
  const files = ['lib/index.js', 'lib/index.d.ts', 'locale/zh-CN.json']
  assert.deepEqual(verifyPackedExports(manifest, files), ['发布入口没有对应文件：./src/*'])
  delete (manifest.exports as Record<string, unknown>)['./src/*']
  assert.deepEqual(verifyPackedExports(manifest, files), [])
  assert.deepEqual(verifyPackedExports(manifest, ['lib/index.js']), [
    '发布入口没有对应文件：./lib/index.d.ts', '发布入口没有对应文件：./locale/*.json',
  ])
})

test('发布入口中的点和其他正则字符按字面匹配', () => {
  assert.deepEqual(verifyPackedExports({ exports: { './client': './lib/client.js' } }, ['lib/clientXjs']), [
    '发布入口没有对应文件：./lib/client.js',
  ])
})
