/**
 * Minimal stand-in for `@deepseek-ai/dsh-client-ui-primitives`, served by
 * `tests/_css-module-loader.mjs` to the tests that import the plugin's React
 * tree. See that file for why the real barrel cannot be loaded outside a
 * bundler; `tsc` still typechecks every call site against the package's `.d.ts`.
 */
import { createElement, forwardRef } from 'react'

/** Render just enough of a button (including its leading icon) for a rendered tree to be addressable. */
export const Button = forwardRef(function Button(
  { children, icon, onClick, disabled, type, variant: _variant, size: _size, ...rest },
  ref,
) {
  return createElement(
    'button',
    { ...rest, ref, type: type ?? 'button', disabled: disabled === true, onClick },
    icon ?? null,
    children,
  )
})

/** Render the menu's item labels, plus whatever the caller anchors inside it. */
export function Menu({ items = [], footer = [], anchor, children }) {
  const labels = [...items, ...footer].map((item, index) =>
    createElement(
      'span',
      { key: item?.id ?? String(index), 'data-cc-menu-item': true },
      item?.text ?? item?.label ?? '',
    ))
  return createElement('span', { 'data-cc-menu': true }, anchor ?? null, labels, children)
}

/** Render the semantic state so a rendered tree can assert the dot it got. */
export function StateDot({ state, size, className }) {
  return createElement('span', {
    'data-cc-state-dot': state,
    className,
    'aria-hidden': 'true',
    ...(size === undefined ? {} : { 'data-cc-size': String(size) }),
  })
}

/** Render the switch's button contract: role, state and accessible name. */
export function Switch({ checked, onChange, label, disabled, title, className }) {
  return createElement('button', {
    type: 'button',
    role: 'switch',
    'aria-checked': checked,
    'aria-label': label,
    title,
    disabled: disabled === true,
    className,
    onClick: () => onChange(!checked),
  })
}

/** Render a read-only semantic capsule tag. */
export function Tag({ tone = 'outline', className, children }) {
  return createElement('span', { 'data-tone': tone, className }, children)
}

/** Render a controlled segmented tablist. */
export function SegmentedControl({ id, value, options, onChange, label, disabled = false, className }) {
  return createElement(
    'div',
    { role: 'tablist', 'aria-label': label, className },
    options.map((opt) =>
      createElement(
        'button',
        {
          key: opt.value,
          id: `${id}-${opt.value}`,
          type: 'button',
          role: 'tab',
          'aria-selected': opt.value === value,
          disabled: disabled || opt.disabled === true,
          title: opt.title,
          onClick: () => {
            if (opt.value !== value) onChange(opt.value)
          },
        },
        opt.label,
      )),
  )
}

/** Render a single-line text input with optional leading icon. */
export const Input = forwardRef(function Input({ icon, className, ...rest }, ref) {
  return createElement(
    'span',
    { className },
    icon ?? null,
    createElement('input', { ...rest, ref }),
  )
})

/** Render the shared staged value field contract (`fields.tsx`). */
export function SettingsValueField(props) {
  return createElement(
    'div',
    { 'data-cc-settings-field': props.id },
    createElement('label', { htmlFor: props.id }, props.label),
    props.help !== undefined
      ? createElement('button', { type: 'button', 'aria-label': props.help.label })
      : null,
    props.overridden
      ? createElement(
          'span',
          null,
          createElement(Tag, { tone: 'neutral' }, props.overriddenLabel),
          createElement('button', { type: 'button', disabled: props.disabled, onClick: props.onReset }, props.resetLabel),
        )
      : null,
    createElement('input', {
      id: props.id,
      type: 'text',
      ...(props.numeric ? { inputMode: 'numeric' } : {}),
      ...(props.invalid ? { 'aria-invalid': true } : {}),
      value: props.text,
      placeholder: props.placeholder ?? '',
      disabled: props.disabled,
      onChange: (event) => props.onEdit(event.target.value),
    }),
    props.invalid || props.hint
      ? createElement('p', null, props.invalid ? props.invalidLabel : props.hint)
      : null,
  )
}

/** Render a minimal dialog when open. */
export function Modal({ open, onClose, title, closeLabel, description, children, footer, className }) {
  if (!open) return null
  return createElement(
    'div',
    { role: 'dialog', 'aria-label': title, className },
    createElement('button', { type: 'button', 'aria-label': closeLabel, onClick: onClose }),
    description ? createElement('p', null, description) : null,
    children ?? null,
    footer ?? null,
  )
}

function makeIcon(name) {
  return function StubIcon({ size = 16, className }) {
    return createElement('svg', {
      'data-cc-icon': name,
      width: size,
      height: size,
      className,
      'aria-hidden': 'true',
    })
  }
}

export const IconChevronDownOutlineRegular = makeIcon('chevron-down')
export const IconRefreshOutlineRegular = makeIcon('refresh')
export const IconPlusOutlineMedium = makeIcon('plus-md')
export const IconPlusOutlineRegular = makeIcon('plus')
export const IconEllipsisOutlineRegular = makeIcon('ellipsis')
export const IconTrashOutlineRegular = makeIcon('trash')
export const IconRightUpOutlineRegular = makeIcon('right-up')
export const IconGaugeOutlineRegular = makeIcon('gauge')
export const IconSearchOutlineRegular = makeIcon('search')
export const IconInfoOutlineRegular = makeIcon('info')
export const IconCheckCircleOutlineRegular = makeIcon('check-circle')
export const IconWarningTriangleOutlineRegular = makeIcon('warning-triangle')
export const IconWarningOutlineRegular = makeIcon('warning')
export const IconSlidersTwoOutlineRegular = makeIcon('sliders')
export const IconShieldOutlineRegular = makeIcon('shield')
