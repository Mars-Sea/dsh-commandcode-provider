/**
 * Minimal stand-in for `@deepseek-ai/dsh-client-ui-primitives`, served by
 * `tests/_css-module-loader.mjs` to the tests that import the plugin's React
 * tree. See that file for why the real barrel cannot be loaded outside a
 * bundler; `tsc` still typechecks every call site against the package's `.d.ts`.
 */
import { createElement } from 'react'

/** Render just enough of a button for a rendered tree to be addressable. */
export function Button({ children, onClick, disabled, type, ...rest }) {
  return createElement(
    'button',
    { ...rest, type: type ?? 'button', disabled: disabled === true, onClick },
    children,
  )
}

/** Render the menu's item labels, plus whatever the caller anchors inside it. */
export function Menu({ items = [], footer = [], children }) {
  const labels = [...items, ...footer].map((item, index) =>
    createElement(
      'span',
      { key: item?.id ?? String(index), 'data-cc-menu-item': true },
      item?.text ?? item?.label ?? '',
    ))
  return createElement('span', { 'data-cc-menu': true }, labels, children)
}
