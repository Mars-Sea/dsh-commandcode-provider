import { defineConfig } from 'tsdown'

/**
 * Self-contained build for the published bundle: transpile src/ to ESM under
 * lib/ without project references or type checking (the reference pattern for
 * out-of-tree dsh bundles). Peer packages stay external.
 */
export default defineConfig({
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
