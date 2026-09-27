/**
 * Node loader hook backing the tests that import the plugin's React tree
 * (`tests/client-boot.test.ts`): it must run the REAL `apply()` from source,
 * which tsx transpiles while leaving two imports node cannot resolve.
 *
 * 1. **CSS modules.** `@deepseek-ai/dsh-client-ui-primitives` does
 *    `import css from "./*.module.css"`; every `.css` is served as an empty
 *    module so the component values stay importable without a bundler.
 * 2. **The UI barrel itself** — a SEED module whose npm entry ships without
 *    the dependency list its own source imports (`clsx`, `katex`, shiki/mdast),
 *    so importing it from node_modules can only work through a bundler. It is
 *    replaced by `./_primitives-stub.mjs`; `tsc` still typechecks every call
 *    site against the package's own `.d.ts`.
 *
 * Registered via `node:module.register` before the dynamic import of
 * `../src/client/index.ts`. No effect on any other test.
 */

const EMPTY_MODULE = 'data:text/javascript,export default {}'
const PRIMITIVES = '@deepseek-ai/dsh-client-ui-primitives'
const PRIMITIVES_STUB = new URL('./_primitives-stub.mjs', import.meta.url).href

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('.css')) {
    return { url: EMPTY_MODULE, shortCircuit: true }
  }
  if (specifier === PRIMITIVES) {
    return { url: PRIMITIVES_STUB, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (url === EMPTY_MODULE) {
    return { format: 'module', source: 'export default {}', shortCircuit: true }
  }
  return nextLoad(url, context)
}
