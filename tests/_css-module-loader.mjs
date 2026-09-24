/**
 * Node loader hook backing the tests that import the plugin's React tree
 * (`tests/client-boot.test.ts`).
 *
 * Two presentations are needed, and neither changes what those tests assert —
 * they exercise the real `apply()`, its registrations, its inject faces and its
 * wire traffic, never a rendered primitive:
 *
 * 1. **CSS modules.** The plugin's client bundle imports
 *    `@deepseek-ai/dsh-client-ui-primitives`, whose ES-module entry does
 *    `import css from "./*.module.css"`. Node cannot parse CSS modules, but the
 *    boot test must run the *real* `apply()` from source: tsx transpiles the
 *    TS/TSX while leaving the `.css` imports untouched. Every `.css` resolution
 *    is presented as a trivial empty module so the React component values stay
 *    importable without a bundler.
 *
 * 2. **The platform UI barrel.** `@deepseek-ai/dsh-client-ui-primitives` is a
 *    SEED module: in the browser the host hands the client bundle a
 *    pre-bundled copy, and the package's npm entry point therefore ships
 *    without the dependency list its own source imports (`clsx`, `katex`, the
 *    shiki/mdast stack — none of which the ENGINE's tree installs either).
 *    Importing it straight from node_modules can only work through a bundler.
 *    This hook serves `./_primitives-stub.mjs` instead: the two components the
 *    plugin imports, in the shape the host supplies. The real contract is still
 *    enforced — `tsc` typechecks every primitive call site against the
 *    package's own `.d.ts`, so a renamed or removed export is a compile error
 *    here rather than a silent gap.
 *
 * Registered by the test file (via `node:module.register`) before the dynamic
 * import of `../src/client/index.ts`, which is what pulls the React component
 * tree in. It has no effect on any other test.
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
