/**
 * Settings-nav glyph injection tests (node:test, zero deps). Run with `npm test`.
 *
 * `src/client/settings-nav-icon.ts` reaches into the settings shell's OWN nav
 * markup: it finds the row by label, hides the shell's gear and inserts one
 * inline SVG, then gives everything back on disposal. The real class is driven
 * through its injected seams (`doc`, `observe`, `createIcon`) against a small
 * fake DOM.
 *
 * What is pinned is the safety contract, not the artwork: only the row that
 * confirms by label is touched, a re-render that drops our glyph is self-healed,
 * a replaced row is re-decorated, disposal restores the shell's glyph exactly,
 * and a missing dialog degrades to nothing instead of throwing.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { create } from 'react-test-renderer'

import {
  SETTINGS_NAV_GLYPH,
  SETTINGS_NAV_ICON_ATTR,
  SettingsNavIcon,
  createSettingsNavGlyph,
  type SettingsNavIconObserverFactory,
} from '../src/client/settings-nav-icon.ts'
import { CommandCodeNavGlyph } from '../src/client/settings-nav-glyph.tsx'

// A fake DOM: only what the decorator actually touches

class FakeNode {
  childNodes: FakeNode[] = []
  parentNode: FakeNode | null = null

  appendChild<T extends FakeNode>(child: T): T {
    child.parentNode?.removeChild(child)
    child.parentNode = this
    this.childNodes.push(child)
    return child
  }

  insertBefore<T extends FakeNode>(child: T, reference: FakeNode | null): T {
    child.parentNode?.removeChild(child)
    child.parentNode = this
    const at = reference === null ? this.childNodes.length : this.childNodes.indexOf(reference)
    this.childNodes.splice(at < 0 ? this.childNodes.length : at, 0, child)
    return child
  }

  removeChild<T extends FakeNode>(child: T): T {
    const at = this.childNodes.indexOf(child)
    if (at !== -1) this.childNodes.splice(at, 1)
    child.parentNode = null
    return child
  }

  /** Simulate the shell re-rendering this node out of the tree. */
  detach(): void {
    this.parentNode?.removeChild(this)
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join('')
  }

  set textContent(value: string) {
    for (const child of this.childNodes) child.parentNode = null
    this.childNodes = []
    if (value !== '') this.appendChild(new FakeText(value))
  }
}

class FakeText extends FakeNode {
  constructor(private readonly data: string) {
    super()
  }

  override get textContent(): string {
    return this.data
  }
}

class FakeElement extends FakeNode {
  readonly tagName: string
  attributes = new Map<string, string>()
  /**
   * The real `style.display` reads `''` when unset, so the double must too:
   * the decorator records the pre-decoration value and writes it back on
   * disposal, and `undefined` would not distinguish "never set" from "restored".
   */
  style: Record<string, string> = { display: '' }

  constructor(tagName: string) {
    super()
    this.tagName = tagName.toUpperCase()
  }

  get firstElementChild(): FakeElement | null {
    return this.childNodes.find((child): child is FakeElement => child instanceof FakeElement) ?? null
  }

  get lastElementChild(): FakeElement | null {
    const elements = this.childNodes.filter((child): child is FakeElement => child instanceof FakeElement)
    return elements[elements.length - 1] ?? null
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name)
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null
  }

  querySelectorAll(selector: string): FakeElement[] {
    const found: FakeElement[] = []
    const visit = (node: FakeNode): void => {
      for (const child of node.childNodes) {
        if (child instanceof FakeElement) {
          if (matches(child, selector)) found.push(child)
          visit(child)
        }
      }
    }
    visit(this)
    return found
  }
}

/** Match the selector subset the decorator uses: a tag, `[attr]`, `[attr="v"]`. */
function matches(element: FakeElement, selector: string): boolean {
  const compound = selector.match(/^([a-zA-Z]*)((?:\[[a-zA-Z-]+(?:="[^"]*")?\])+)$/)
  if (compound === null) return element.tagName === selector.toUpperCase()
  const tag = compound[1] ?? ''
  const attrs = compound[2] ?? ''
  if (tag !== '' && element.tagName !== tag.toUpperCase()) return false
  for (const test of attrs.matchAll(/\[([a-zA-Z-]+)(?:="([^"]*)")?\]/g)) {
    const name = test[1]!
    if (!element.attributes.has(name)) return false
    if (test[2] !== undefined && element.getAttribute(name) !== test[2]) return false
  }
  return true
}

class FakeDocument extends FakeNode {
  body = new FakeElement('body')

  constructor() {
    super()
    this.appendChild(this.body)
  }

  createElementNS(_namespace: string, tagName: string): FakeElement {
    return new FakeElement(tagName)
  }

  querySelector(selector: string): FakeElement | null {
    return this.body.querySelector(selector)
  }
}

const asDocument = (fake: FakeDocument): Document => fake as unknown as Document

/** The observer seam: capture the listener so a test can announce a change. */
function recordingObserver(): {
  observe: SettingsNavIconObserverFactory
  wake: () => void
  detached: () => boolean
  targets: Node[]
} {
  const state = { listener: undefined as (() => void) | undefined, gone: false, targets: [] as Node[] }
  return {
    observe: (target, listener) => {
      state.listener = listener
      state.targets.push(target)
      return () => {
        state.gone = true
      }
    },
    wake: () => state.listener?.(),
    detached: () => state.gone,
    get targets() {
      return state.targets
    },
  }
}

// The shipped markup the injection targets

/**
 * A settings modal with a nav rail. The other rows model the shell's own
 * sections, including one that ALSO falls back to the gear (an unknown id), so
 * a decoration that ignored the label would decorate the wrong row.
 */
function settingsNav(doc: FakeDocument, labels: readonly string[] = ['通用设置', 'Command Code', '反向代理']): {
  dialog: FakeElement
  nav: FakeElement
  row: (label: string) => FakeElement
  icon: (label: string) => FakeElement
  label: (label: string) => FakeElement
} {
  const dialog = new FakeElement('div')
  dialog.setAttribute('data-shortcut-modal', 'settings')
  const nav = new FakeElement('nav')
  dialog.appendChild(nav)
  const byLabel = new Map<string, FakeElement>()
  for (const text of labels) {
    const button = new FakeElement('button')
    const icon = new FakeElement('svg')
    const span = new FakeElement('span')
    span.textContent = text
    button.appendChild(icon)
    button.appendChild(span)
    nav.appendChild(button)
    byLabel.set(text, button)
  }
  doc.body.appendChild(dialog)
  const pick = (label: string): FakeElement => {
    const row = byLabel.get(label)
    assert.ok(row !== undefined, `fixture row ${label}`)
    return row
  }
  return {
    dialog,
    nav,
    row: pick,
    icon: (label: string) => pick(label).firstElementChild!,
    label: (label: string) => pick(label).lastElementChild!,
  }
}

/** A fresh decorator with the glyph factory doubled. */
function build(doc: FakeDocument, options: { label?: () => string; createIcon?: () => FakeElement } = {}): {
  decorator: SettingsNavIcon
  created: FakeElement[]
  observer: ReturnType<typeof recordingObserver>
} {
  const observer = recordingObserver()
  const created: FakeElement[] = []
  const decorator = new SettingsNavIcon({
    doc: asDocument(doc),
    label: options.label ?? (() => 'Command Code'),
    observe: observer.observe,
    createIcon: () => {
      const glyph = options.createIcon?.() ?? new FakeElement('svg')
      created.push(glyph)
      return glyph as unknown as Element
    },
  })
  return { decorator, created, observer }
}

// --- Tests

test('decorates only the row whose label matches, hiding its shell glyph', () => {
  const doc = new FakeDocument()
  const nav = settingsNav(doc)
  const { decorator, created, observer } = build(doc)

  decorator.start()

  const row = nav.row('Command Code')
  const icon = nav.icon('Command Code')
  const label = nav.label('Command Code')
  assert.equal(icon.style.display, 'none', 'shell gear is hidden')
  assert.equal(created.length, 1, 'one glyph injected')
  assert.equal(row.childNodes.length, 3, 'glyph inserted between icon and label')
  assert.equal(row.childNodes[1], created[0], 'glyph sits before the label')
  assert.equal(row.childNodes[2], label, 'label still last (that is what matching reads)')
  assert.equal(label.textContent, 'Command Code')
  // The unknown-id row that ALSO gets the gear is left exactly as shipped.
  const other = nav.row('反向代理')
  assert.equal((other.firstElementChild as FakeElement).style.display, '')
  assert.equal(other.childNodes.length, 2)
  assert.equal(observer.targets.length, 1, 'observes the body once')
  decorator.dispose()
})

test('does nothing when the dialog is not open, and decorates when it opens', () => {
  const doc = new FakeDocument()
  const { decorator, created, observer } = build(doc)
  decorator.start()
  assert.equal(created.length, 0, 'no dialog, no glyph')
  assert.equal(observer.targets.length, 1, 'still watching for the portal')

  const nav = settingsNav(doc)
  observer.wake()
  assert.equal(created.length, 1, 'opening the dialog decorates')
  assert.equal((nav.icon('Command Code') as FakeElement).style.display, 'none')
  decorator.dispose()
})

test('restores nothing when the row label does not confirm', () => {
  const doc = new FakeDocument()
  const nav = settingsNav(doc, ['通用设置', '反向代理'])
  const { decorator, created } = build(doc)
  decorator.start()
  assert.equal(created.length, 0, 'no row reads "Command Code"')
  assert.equal((nav.icon('反向代理') as FakeElement).style.display, '')
  decorator.dispose()
})

test('an empty label is not a match, so an unregistered namespace cannot decorate', () => {
  const doc = new FakeDocument()
  settingsNav(doc)
  const { decorator, created } = build(doc, { label: () => '   ' })
  decorator.start()
  assert.equal(created.length, 0)
  decorator.dispose()
})

test('a row labelled outside the settings modal is never touched', () => {
  const doc = new FakeDocument()
  settingsNav(doc)
  // Same label, same shape, but NOT inside the portaled settings dialog.
  const stray = new FakeElement('div')
  const strayNav = new FakeElement('nav')
  const button = new FakeElement('button')
  button.appendChild(new FakeElement('svg'))
  const span = new FakeElement('span')
  span.textContent = 'Command Code'
  button.appendChild(span)
  strayNav.appendChild(button)
  stray.appendChild(strayNav)
  doc.body.appendChild(stray)

  const { decorator, created } = build(doc)
  decorator.start()
  assert.equal(created.length, 1, 'the dialog row wins the lookup')
  assert.equal(button.childNodes.length, 2, 'the stray row is left alone')
  assert.equal((button.firstElementChild as FakeElement).style.display, '')
  decorator.dispose()
})

test('re-inserts the glyph when a re-render drops it', () => {
  const doc = new FakeDocument()
  const nav = settingsNav(doc)
  const { decorator, created, observer } = build(doc)
  decorator.start()
  const row = nav.row('Command Code')
  created[0]!.detach()
  assert.equal(row.childNodes.length, 2, 'glyph gone')

  observer.wake()
  assert.equal(created.length, 2, 'a second glyph is created')
  assert.equal(row.childNodes[1], created[1], 'and re-inserted before the label')
  decorator.dispose()
})

test('follows a re-rendered row node and lets go of the replaced one', () => {
  const doc = new FakeDocument()
  const nav = settingsNav(doc)
  const { decorator, created, observer } = build(doc)
  decorator.start()

  const old = nav.row('Command Code')
  const icon = nav.icon('Command Code')
  const updated = new FakeElement('button')
  updated.appendChild(new FakeElement('svg'))
  const span = new FakeElement('span')
  span.textContent = 'Command Code'
  updated.appendChild(span)
  // Replace the row the way a keyed re-render would: a brand new node.
  const parent = old.parentNode!
  parent.insertBefore(updated, old)
  old.detach()

  observer.wake()
  assert.equal(created.length, 2, 'the new row gets its own glyph')
  assert.equal(updated.childNodes[1], created[1], 'inserted before its label')
  assert.equal((updated.firstElementChild as FakeElement).style.display, 'none')
  assert.equal(icon.style.display, '', 'the replaced row is restored as we found it')
  decorator.dispose()
})

test('dispose removes our glyph and gives the shell glyph back exactly', () => {
  const doc = new FakeDocument()
  const nav = settingsNav(doc)
  const { decorator, created } = build(doc)
  const icon = nav.icon('Command Code')
  const before = icon.style.display
  decorator.start()
  decorator.dispose()

  assert.equal(icon.style.display, before, 'shell glyph restored')
  assert.equal(created[0]!.parentNode, null, 'our glyph removed')
  assert.equal(nav.row('Command Code').childNodes.length, 2, 'row back to the shipped shape')
  decorator.dispose() // idempotent
})

test('start is idempotent and dispose detaches the observer', () => {
  const doc = new FakeDocument()
  settingsNav(doc)
  const { decorator, created, observer } = build(doc)
  decorator.start()
  decorator.start()
  assert.equal(observer.targets.length, 1, 'one observer, not two')
  assert.equal(created.length, 1)
  decorator.dispose()
  assert.equal(observer.detached(), true)
})

test('the default glyph follows the shell icon artwork conventions', () => {
  const doc = new FakeDocument()
  const glyph = createSettingsNavGlyph(asDocument(doc)) as unknown as FakeElement
  assert.equal(glyph.tagName, 'SVG')
  assert.equal(glyph.getAttribute('width'), '16')
  assert.equal(glyph.getAttribute('height'), '16')
  assert.equal(glyph.getAttribute('viewBox'), '0 0 16 16')
  assert.equal(glyph.getAttribute('fill'), 'none')
  assert.equal(glyph.getAttribute('aria-hidden'), 'true')
  assert.equal(glyph.hasAttribute(SETTINGS_NAV_ICON_ATTR), true)
  assert.equal(glyph.style.flex, 'none')
  const path = glyph.firstElementChild as FakeElement
  assert.equal(path.tagName, 'PATH')
  assert.equal(path.getAttribute('d'), SETTINGS_NAV_GLYPH)
  assert.equal(path.getAttribute('stroke'), 'currentColor')
  assert.equal(path.getAttribute('stroke-width'), '1.3')
})

test('the official slot glyph draws the same mark at the requested size', () => {
  const tree = create(createElement(CommandCodeNavGlyph, { size: 16 })).toJSON()
  assert.ok(tree !== null && !Array.isArray(tree))
  assert.equal(tree.type, 'svg')
  assert.equal(tree.props.width, 16)
  assert.equal(tree.props.height, 16)
  assert.equal(tree.props.viewBox, '0 0 16 16')
  assert.equal(tree.props['aria-hidden'], 'true')
  const path = (tree.children ?? [])[0]
  assert.ok(path !== undefined && typeof path !== 'string')
  assert.equal(path.type, 'path')
  assert.equal(path.props.d, SETTINGS_NAV_GLYPH)
  assert.equal(path.props.stroke, 'currentColor')
  assert.equal(path.props.strokeWidth, 1.3)
})

test('handles the alpha.3 row shape: the icon is a wrapper span, not a bare svg', () => {
  // 0.2.2-alpha.3 wraps the nav glyph in `<span class="navIcon" aria-hidden>`
  // and renders the slot's fallback inside it. The decorator must hide the
  // WRAPPER (hiding only the inner svg would leave an empty flex item and
  // double the button's 8px gap) and still read the label as the last child.
  const doc = new FakeDocument()
  const dialog = new FakeElement('div')
  dialog.setAttribute('data-shortcut-modal', 'settings')
  const nav = new FakeElement('nav')
  const button = new FakeElement('button')
  const wrapper = new FakeElement('span')
  wrapper.appendChild(new FakeElement('svg'))
  const label = new FakeElement('span')
  label.textContent = 'Command Code'
  button.appendChild(wrapper)
  button.appendChild(label)
  nav.appendChild(button)
  dialog.appendChild(nav)
  doc.body.appendChild(dialog)

  const { decorator, created } = build(doc)
  decorator.start()

  assert.equal(wrapper.style.display, 'none', 'the wrapper is hidden, not its child')
  assert.equal(created.length, 1)
  assert.equal(button.childNodes[1], created[0])
  assert.equal(button.childNodes[2], label)

  decorator.dispose()
  assert.equal(wrapper.style.display, '')
  assert.equal(button.childNodes.length, 2)
})
