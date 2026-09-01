/**
 * Node loader hook backing `tests/client-boot.test.ts`.
 *
 * The plugin's client bundle imports `@deepseek-ai/dsh-client-ui-primitives`,
 * whose ES-module entry does `import css from "./*.module.css"`. Node cannot
 * parse CSS modules, but the boot test must run the *real* `apply()` from
 * source: tsx transpiles the TS/TSX while leaving the `.css` imports untouched.
 * This hook presents every `.css` resolution as a trivial empty module so the
 * React component values stay importable without a bundler.
 *
 * It is registered by the test file (via `node:module.register`) before the
 * dynamic import of `../src/client/index.ts`, which is what pulls the React
 * component tree in. It has no effect on any other test.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('.css')) {
    return { url: 'data:text/javascript,export default {}', shortCircuit: true }
  }
  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('data:text/javascript,export default {}')) {
    return { format: 'module', source: 'export default {}', shortCircuit: true }
  }
  return nextLoad(url, context)
}
