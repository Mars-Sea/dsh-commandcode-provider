import { defineConfig } from 'tsdown'

/**
 * Self-contained build for the published bundle: transpile src/ to ESM under
 * lib/ without project references or type checking (the reference pattern for
 * out-of-tree dsh bundles). Peer packages stay external.
 *
 * The second config emits the browser client bundle (lib/client.js) from
 * src/client/index.ts. The host's client-modules scanner loads any bundle
 * that declares `dsh.client` + `exports["./client"]`; the artifact must call
 * `window.__ModuleLoader__.load({ id, factory })` — the same handoff shape the
 * harness's own client packages emit (see clientBundle() in the harness
 * packages/client/tsdown.client.ts). The client half only imports
 * `@deepseek-ai/cordis` (a platform module resolved from the loader's module
 * table at runtime), so it stays external here too.
 */
const lib = defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'lib',
  clean: true,
  sourcemap: true,
  dts: true,
  outExtension: () => ({ js: '.js', dts: '.d.ts' }),
  external: [
    '@deepseek-ai/cordis',
    '@deepseek-ai/schemastery',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-credentials',
    '@deepseek-ai/dsh-launch-environment',
    '@deepseek-ai/dsh-settings',
  ],
})

const client = defineConfig({
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  dts: false,
  clean: false,
  external: ['@deepseek-ai/cordis'],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify('@mars-sea/dsh-commandcode-provider')}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})

export default [lib, client]
