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
 * packages/client/tsdown.client.ts). The client half imports React (`react`,
 * `react/jsx-runtime`) and the UI primitives the Web frontend already seeds,
 * so those stay external and resolve from the loader's module table at runtime.
 */
const lib = defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'lib',
  clean: true,
  sourcemap: true,
  dts: true,
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  deps: {
    neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/schemastery',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-credentials',
      '@deepseek-ai/dsh-launch-environment',
      '@deepseek-ai/dsh-settings',
      '@deepseek-ai/dsh-typert-protocol',
      '@deepseek-ai/dsh-web',
    ],
  },
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
  // Only platform/seed modules are resolvable from the loader's module table
  // at runtime, so exactly those stay external. Every other import must be a
  // type-only import (erased here) or a bundled local module: a runtime value
  // import of a non-seeded package fails the client `require()` audit in
  // scripts/verify-engine-load.mjs.
  deps: {
    neverBundle: [
      '@deepseek-ai/cordis',
      'react',
      'react/jsx-runtime',
      '@deepseek-ai/dsh-client-ui-primitives',
    ],
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify('@mars-sea/dsh-commandcode-provider')}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})

export default [lib, client]
