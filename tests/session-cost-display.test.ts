import { withRequestFacts } from './cost-fixture.ts'
/**
 * DOM-injection tests for the composer's session-cost figure
 * (`src/client/session-cost-display.ts`). Run with `npm test`.
 *
 * This module is the highest-risk half of the readout: it reaches into the
 * harness's OWN token-usage markup — the pill's button and the usage dialog's
 * `dl` — appends nodes to them, hides rows, and restores everything on the way
 * out. None of that is covered by `tests/session-cost.test.ts`, which stops at
 * the pure projection, so these tests drive the real class through its two
 * injected seams (`doc` and `observe`) against a small fake DOM.
 *
 * What is pinned here is the safety contract, not the arithmetic:
 *   · nothing is injected unless the shipped shape confirms (positionally, by
 *     the token count each row must be showing);
 *   · a re-render that drops our nodes is self-healed, not assumed;
 *   · disposal removes every node we added and every style we set;
 *   · a missing anchor degrades to nothing instead of throwing.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SessionCostDisplay, type SessionCostObserverFactory } from '../src/client/session-cost-display.ts'
import {
  SESSION_COST_COPY,
  buildSessionCostView as buildCostView,
  type SessionCostInput,
} from '../src/client/session-cost.ts'
import type { CommandCodePriceTable } from '../src/usage-wire.ts'

const buildSessionCostView = (input: SessionCostInput) => buildCostView(withRequestFacts(input))

// ---------------------------------------------------------------------------
// A fake DOM: only what the display actually touches
// ---------------------------------------------------------------------------

class FakeNode {
  childNodes: FakeNode[] = []
  parentNode: FakeNode | null = null
  /**
   * Whether this node is part of the document tree. Computed by walking to the
   * root rather than stored as a flag: the display decides whether its cached
   * dialog is still live with `isConnected`, so a double that reported a
   * detached node as connected would test the wrong branch — and a real
   * `isConnected` is exactly this walk.
   */
  get isConnected(): boolean {
    let node: FakeNode = this
    while (node.parentNode !== null) node = node.parentNode
    return node instanceof FakeDocument
  }

  /** Simulate the harness replacing this node: detach it from its parent. */
  detach(): void {
    this.parentNode?.removeChild(this)
  }

  appendChild<T extends FakeNode>(child: T): T {
    child.parentNode?.removeChild(child)
    child.parentNode = this
    this.childNodes.push(child)
    return child
  }

  removeChild<T extends FakeNode>(child: T): T {
    const at = this.childNodes.indexOf(child)
    if (at !== -1) this.childNodes.splice(at, 1)
    child.parentNode = null
    return child
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
  style: Record<string, string> = {}

  constructor(tagName: string) {
    super()
    this.tagName = tagName.toUpperCase()
  }

  /**
   * The display assigns `a11y.id = A11Y_ID` directly (it is how the DOM API is
   * normally used), so the property must land in the same place `setAttribute`
   * writes — otherwise an `#id` lookup would not see it.
   */
  get id(): string {
    return this.attributes.get('id') ?? ''
  }

  set id(value: string) {
    this.attributes.set('id', value)
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

  /** Depth-first search by a single `[attr]`, `[attr="v"]`, `tag` or class-free selector. */
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

  closest(selector: string): FakeElement | null {
    let node: FakeNode | null = this
    while (node !== null) {
      if (node instanceof FakeElement && matches(node, selector)) return node
      node = node.parentNode
    }
    return null
  }
}

/**
 * Match the selector subset the display uses: a tag name, one or more
 * `[attr]` / `[attr="value"]` tests, or a compound of both
 * (`button[aria-haspopup="dialog"]`). A bare `[attr]` matches on PRESENCE, so
 * a valueless attribute (`""`) still matches — the display sets several
 * attributes to the empty string.
 */
function matches(element: FakeElement, selector: string): boolean {
  // `#id` — how the a11y description node is addressed.
  const byId = selector.match(/^#(.+)$/)
  if (byId !== null) {
    if (element.getAttribute('id') !== byId[1]) return false
    return true
  }
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
  head = new FakeElement('head')

  constructor() {
    super()
    this.appendChild(this.body)
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName)
  }

  querySelector(selector: string): FakeElement | null {
    return this.body.querySelector(selector)
  }

  /**
   * The document-level collection the ambiguity guard reads: a second composer
   * (0.1.6-alpha.2's embedded sidebar Conversation) can put a second usage
   * dialog in the page at the same time, and only the COUNT distinguishes that
   * case from the ordinary one.
   */
  querySelectorAll(selector: string): FakeElement[] {
    return this.body.querySelectorAll(selector)
  }
}

const doc = (): FakeDocument => new FakeDocument()
/** The shipped shape is `Element`; the fake is structurally compatible for our use. */
const asDocument = (fake: FakeDocument): Document => fake as unknown as Document

// ---------------------------------------------------------------------------
// The shipped markup the injection targets
// ---------------------------------------------------------------------------

/**
 * The shipped stats row as it really nests: the pills (`StatsPills`), of which
 * the LAST `aria-haspopup` child is the token pill, inside the row's root div.
 * The wrapper matters — the display scopes its lookup to it — and so does the
 * PRECEDING trigger: once a step carries timing the row starts with the time
 * pill, which is also a `button[aria-haspopup="dialog"]`, so a lookup that took
 * the first trigger instead of the last would decorate the clock. Both shapes
 * are modelled here for that reason.
 *
 * `marker: false` models dsh 0.1.6-alpha.2, which DELETED
 * `data-composer-stats` from this root while leaving every other part of the
 * markup identical. The row must still be found there — that deletion is what
 * took the readout dark, and a lookup that insists on the attribute is exactly
 * the bug.
 */
function shippedPill(parent: FakeElement, options: { marker?: boolean } = {}): {
  root: FakeElement
  button: FakeElement
  label: FakeElement
  timeButton: FakeElement
  timeLabel: FakeElement
} {
  const root = new FakeElement('div')
  if (options.marker !== false) root.setAttribute('data-composer-stats', '')
  const timeButton = new FakeElement('button')
  timeButton.setAttribute('aria-haspopup', 'dialog')
  const timeLabel = new FakeElement('span')
  timeLabel.textContent = '12.4s'
  timeButton.appendChild(timeLabel)
  root.appendChild(timeButton)
  const button = new FakeElement('button')
  button.setAttribute('aria-haspopup', 'dialog')
  const label = new FakeElement('span')
  label.textContent = '1.2M tokens'
  button.appendChild(label)
  root.appendChild(button)
  parent.appendChild(root)
  return { root, button, label, timeButton, timeLabel }
}

/**
 * The composer footer's context meter, as 0.1.6-alpha.2 introduces it: a ring
 * whose trigger is itself a `button[aria-haspopup="dialog"]`, rendered AFTER the
 * dock outlet as the outlet's SIBLING inside the composer's dock row.
 *
 * It is the reason the scope stops at the outlet. It is out of reach for an
 * outlet-scoped lookup, and it would be the WINNER of a parent-scoped "last
 * trigger wins" — which is how the session cost would end up hanging off the
 * context ring instead of the token pill.
 */
function contextMeter(parent: FakeElement): FakeElement {
  const root = new FakeElement('span')
  const button = new FakeElement('button')
  button.setAttribute('aria-haspopup', 'dialog')
  button.setAttribute('aria-label', '45% of context used')
  button.appendChild(new FakeElement('svg'))
  root.appendChild(button)
  parent.appendChild(root)
  return button
}

/**
 * The shipped usage dialog: a `dl` of `dt`/`dd` pairs, portaled onto `body`.
 * `values` are the value cells' text, in order.
 */
function shippedDialog(parent: FakeElement, values: (string | undefined)[]): FakeElement {
  const dl = new FakeElement('dl')
  dl.setAttribute('data-session-stats-usage', '')
  for (const value of values) {
    const dt = new FakeElement('dt')
    dt.textContent = 'label'
    const dd = new FakeElement('dd')
    if (value !== undefined) dd.textContent = value
    dl.appendChild(dt)
    dl.appendChild(dd)
  }
  parent.appendChild(dl)
  return dl
}

// ---------------------------------------------------------------------------
// The view under test
// ---------------------------------------------------------------------------

/** A flat table with every rate published, so every row can be priced. */
const FLAT: CommandCodePriceTable = {
  models: [
    {
      id: 'commandcode/test-flat',
      slug: 'test-flat',
      inputCost: 1,
      outputCost: 2,
      cacheReadCost: 0.1,
      cacheWriteCost: 1.25,
    },
  ],
  peakHours: [[1, 4], [6, 10]],
}

const SELECTION = {
  lastUsed: { provider: 'commandcode', model: 'commandcode/test-flat' },
  next: { provider: 'commandcode', model: 'commandcode/test-flat' },
}

function view(usage: SessionCostInput['usage']): NonNullable<ReturnType<typeof buildSessionCostView>> {
  const built = buildSessionCostView({
    usage,
    selection: SELECTION,
    table: FLAT,
    now: Date.UTC(2026, 8, 16, 5, 0, 0),
  })
  assert.ok(built, 'the fixture must be priceable')
  return built
}

/** A display wired to both seams, plus the observer's manual trigger. */
function makeDisplay(scopeRoot: FakeElement | null) {
  const fake = doc()
  // The composer lives in the page in real life, so attach it: the dialog is
  // resolved document-wide and the pill is resolved through the scope, and both
  // need the tree to be whole for the lookups to mean anything.
  if (scopeRoot !== null && scopeRoot.parentNode === null) fake.body.appendChild(scopeRoot)
  const trigger = { fire: (): void => {} }
  const observe: SessionCostObserverFactory = (_target, listener) => {
    trigger.fire = listener
    return () => {
      trigger.fire = (): void => {}
    }
  }
  const display = new SessionCostDisplay({
    doc: asDocument(fake),
    scope: () => scopeRoot as unknown as ParentNode | null,
    observe,
  })
  display.start()
  return { display, fake, trigger }
}

// ---------------------------------------------------------------------------
// The pill
// ---------------------------------------------------------------------------

test('the cost is appended to the shipped pill and removed on dispose', () => {
  const composer = new FakeElement('div')
  const { button } = shippedPill(composer)
  const { display, fake } = makeDisplay(composer)

  display.sync(view({ uncachedInputTokens: 1_000_000, outputTokens: 500_000 }))
  const injected = button.querySelector('[data-composer-session-cost]')
  assert.ok(injected, 'the cost run is appended to the shipped button')
  // Appended LAST, so the shipped label stays first in the text run.
  assert.equal(button.childNodes[button.childNodes.length - 1], injected)
  assert.equal(injected.textContent.includes('$2.00'), true, `the amount is in the run: ${injected.textContent}`)
  // The description is how the figure reaches assistive tech, because the
  // shipped button's own aria-label is computed by the harness and cannot be
  // extended.
  assert.equal(button.getAttribute('aria-describedby'), 'dsh-commandcode-session-cost')
  assert.ok(fake.body.querySelector('#dsh-commandcode-session-cost'), 'the description node is in the page')

  display.dispose()
  assert.equal(button.querySelector('[data-composer-session-cost]'), null, 'disposal removes the run')
  assert.equal(button.hasAttribute('aria-describedby'), false, 'and gives the attribute back')
})

test("a shipped aria-describedby is never overwritten or taken away", () => {
  const composer = new FakeElement('div')
  const { button } = shippedPill(composer)
  button.setAttribute('aria-describedby', 'harness-own-description')
  const { display } = makeDisplay(composer)

  display.sync(view({ uncachedInputTokens: 1_000_000 }))
  assert.equal(button.getAttribute('aria-describedby'), 'harness-own-description', 'the harness description wins')

  display.dispose()
  assert.equal(
    button.getAttribute('aria-describedby'),
    'harness-own-description',
    'and is still there after we leave',
  )
})

test("the figure lands on the token pill, never on the time pill beside it", () => {
  // Both pills announce a dialog, so `button[aria-haspopup="dialog"]` matches
  // two nodes once a step carries timing. The rule is "the LAST one", and this
  // is the only shape that can fail it: with a single trigger, first and last
  // are the same node and a wrong rule still passes.
  const composer = new FakeElement('div')
  const { button, timeButton } = shippedPill(composer)
  const { display } = makeDisplay(composer)

  display.sync(view({ uncachedInputTokens: 1_000_000, outputTokens: 500_000 }))

  assert.ok(button.querySelector('[data-composer-session-cost]'), 'the cost joins the token pill')
  assert.equal(button.getAttribute('aria-describedby'), 'dsh-commandcode-session-cost')
  assert.equal(
    timeButton.querySelector('[data-composer-session-cost]'),
    null,
    'the time pill keeps the shipped markup',
  )
  assert.equal(timeButton.hasAttribute('aria-describedby'), false)

  // Disposal is symmetric: it must clean the pill it decorated and leave the
  // other one exactly as it found it.
  display.dispose()
  assert.equal(button.hasAttribute('aria-describedby'), false)
  assert.equal(timeButton.querySelector('[data-composer-session-cost]'), null)
})

test('a re-rendered pill is re-decorated instead of losing the figure', () => {
  const composer = new FakeElement('div')
  const first = shippedPill(composer)
  const { display } = makeDisplay(composer)

  display.sync(view({ uncachedInputTokens: 1_000_000 }))
  assert.ok(first.button.querySelector('[data-composer-session-cost]'))

  // React remounts the row: the whole stats root is replaced, so our node goes
  // with the old tree. The next sync must notice and re-attach to the NEW row —
  // assuming the old one survived would leave the figure silently gone.
  first.button.detach()
  composer.removeChild(first.root)
  const fresh = shippedPill(composer)
  display.sync(view({ uncachedInputTokens: 1_000_000 }))
  assert.ok(fresh.button.querySelector('[data-composer-session-cost]'), 'the figure follows the shipped row')
})

test('a pill whose label text was rewritten keeps its figure', () => {
  const composer = new FakeElement('div')
  const { button } = shippedPill(composer)
  const { display } = makeDisplay(composer)

  display.sync(view({ uncachedInputTokens: 1_000_000 }))
  const before = button.querySelector('[data-composer-session-cost]')

  // React rewrites the LABEL's own text on every token update. Our run is a
  // sibling node, so it survives: this pins that an ordinary text update does
  // not detach the cost, which is the case the module's own comment describes.
  const label = button.childNodes[0] as FakeElement
  label.textContent = '1.3M tokens'
  display.sync(view({ uncachedInputTokens: 1_100_000 }))
  assert.equal(button.querySelector('[data-composer-session-cost]'), before, 'the same node stays put')
})

test('an unpriceable session removes the injected figure', () => {
  const composer = new FakeElement('div')
  const { button } = shippedPill(composer)
  const { display } = makeDisplay(composer)

  display.sync(view({ uncachedInputTokens: 1_000_000 }))
  assert.ok(button.querySelector('[data-composer-session-cost]'))

  // `undefined` is "nothing honest to show": the pill must go back to exactly
  // the shipped markup rather than showing a stale or zero figure.
  display.sync(undefined)
  assert.equal(button.querySelector('[data-composer-session-cost]'), null)
  assert.equal(button.hasAttribute('aria-describedby'), false)
})

// The next three tests are the regression fence for dsh 0.1.6-alpha.2, which
// deleted `data-composer-stats` AND moved the composer's context meter into a
// footer beside the dock outlet. The old suite built its own marked root and
// treated an unmarked row as an acceptable no-op, so the readout could go dark
// on a real engine with every check green.

test('an unmarked stats row (dsh 0.1.6-alpha.2) still gets the cost', () => {
  const outlet = new FakeElement('div')
  const { button, timeButton } = shippedPill(outlet, { marker: false })
  const { display } = makeDisplay(outlet)

  display.sync(view({ uncachedInputTokens: 1_000_000 }))

  const injected = button.querySelector('[data-composer-session-cost]')
  assert.ok(injected, 'the token pill is found without the attribute')
  assert.equal(timeButton.querySelector('[data-composer-session-cost]'), null, 'still never the clock')
  display.dispose()
})

test('the dock outlet scopes the lookup away from the footer context meter', () => {
  // The real 0.1.6-alpha.2 shape: `div.dock > [data-slot=…dock] + ContextMeter`.
  const footer = new FakeElement('div')
  const outlet = new FakeElement('div')
  outlet.setAttribute('data-slot', 'conversation.composer.dock')
  const { button } = shippedPill(outlet, { marker: false })
  footer.appendChild(outlet)
  const meter = contextMeter(footer)
  const page = doc()
  page.body.appendChild(footer)

  const trigger = { fire: (): void => {} }
  const display = new SessionCostDisplay({
    doc: asDocument(page),
    scope: () => outlet as unknown as ParentNode,
    observe: (_target, listener) => {
      trigger.fire = listener
      return () => {
        trigger.fire = (): void => {}
      }
    },
  })
  display.start()
  display.sync(view({ uncachedInputTokens: 1_000_000 }))

  assert.ok(button.querySelector('[data-composer-session-cost]'), 'the cost lands on the token pill')
  assert.equal(
    meter.querySelector('[data-composer-session-cost]'),
    null,
    'the context meter is a SIBLING of the outlet, so it is never the host',
  )
  display.dispose()
})

test('a composer with no shipped pill is a no-op that never throws', () => {
  const outlet = new FakeElement('div')
  const { display } = makeDisplay(outlet)
  // An empty outlet: no pills at all, so there is nothing to append to. This is
  // the "markup moved somewhere we cannot see" case, and it stays a no-op.
  assert.doesNotThrow(() => display.sync(view({ uncachedInputTokens: 1_000_000 })))
  assert.equal(outlet.querySelector('[data-composer-session-cost]'), null)
  display.dispose()
})

// ---------------------------------------------------------------------------
// The usage dialog
// ---------------------------------------------------------------------------

test('a confirming dialog gets a price per row and gives every node back', () => {
  const composer = new FakeElement('div')
  shippedPill(composer)
  const { display, fake } = makeDisplay(composer)

  // 1M uncached in, 500K out, 0 cache read/write: the shipped rows are
  // cacheHit (a percentage), uncachedInput, cacheRead, output — and the
  // predicted counts must match the cells for the shape to confirm.
  const dl = shippedDialog(fake.body, ['0%', '1,000,000 tok', '0 tok', '500,000 tok'])
  display.sync(view({ uncachedInputTokens: 1_000_000, outputTokens: 500_000 }))

  const prices = dl.querySelectorAll('[data-session-cost-price]')
  assert.equal(prices.length, 3, 'the three counted rows are priced; the percentage row is not')
  const dds = [...dl.childNodes].filter((node): node is FakeElement => node instanceof FakeElement && node.tagName === 'DD')
  assert.equal(dds[1]?.querySelector('[data-session-cost-price]')?.textContent, '$1.00')
  assert.equal(dds[3]?.querySelector('[data-session-cost-price]')?.textContent, '$1.00')
  assert.equal(dds[0]?.querySelector('[data-session-cost-price]'), null, 'the cache-hit row is never priced')

  display.dispose()
  assert.equal(dl.querySelectorAll('[data-session-cost-price]').length, 0, 'disposal removes every price')
})

test('a dialog whose counts do not confirm is left exactly as it shipped', () => {
  const composer = new FakeElement('div')
  shippedPill(composer)
  const { display, fake } = makeDisplay(composer)

  // The cells show different counts than the view predicts, so this is not the
  // dialog we think it is (another build, another session) and NOTHING may be
  // decorated — pricing the wrong row would be worse than showing no price.
  const dl = shippedDialog(fake.body, ['0%', '999 tok', '0 tok', '500,000 tok'])
  display.sync(view({ uncachedInputTokens: 1_000_000, outputTokens: 500_000 }))
  assert.equal(dl.querySelectorAll('[data-session-cost-price]').length, 0)
})

// Two live composers are reachable from dsh 0.1.6-alpha.2 (the sidebar mounts an
// embedded Conversation), and the dialog is portaled onto `body`, so a
// document-wide lookup can no longer tell whose dialog it is looking at. The
// count is the only honest discriminator: with two open, neither may be priced.

test('two open usage dialogs are both left alone rather than mispriced', () => {
  const composer = new FakeElement('div')
  shippedPill(composer)
  const { display, fake } = makeDisplay(composer)

  // The other session's composer and its dialog, with counts that WOULD confirm
  // against this entry's view — the coincidence the shape check cannot catch.
  const other = new FakeElement('div')
  shippedPill(other)
  fake.body.appendChild(other)
  const ours = shippedDialog(fake.body, ['0%', '1,000,000 tok', '0 tok', '500,000 tok'])
  const theirs = shippedDialog(fake.body, ['0%', '1,000,000 tok', '0 tok', '500,000 tok'])

  display.sync(view({ uncachedInputTokens: 1_000_000, outputTokens: 500_000 }))

  assert.equal(theirs.querySelectorAll('[data-session-cost-price]').length, 0, 'never the stranger')
  assert.equal(ours.querySelectorAll('[data-session-cost-price]').length, 0, 'and not a guess at ours either')
})

test('the ambiguity clears once only one dialog remains', () => {
  const composer = new FakeElement('div')
  shippedPill(composer)
  const { display, fake, trigger } = makeDisplay(composer)

  const survivor = shippedDialog(fake.body, ['0%', '1,000,000 tok', '0 tok', '500,000 tok'])
  const departing = shippedDialog(fake.body, ['0%', '1,000,000 tok', '0 tok', '500,000 tok'])
  display.sync(view({ uncachedInputTokens: 1_000_000, outputTokens: 500_000 }))
  assert.equal(survivor.querySelectorAll('[data-session-cost-price]').length, 0)

  // The other composer closes its dialog (its portal unmounts) and the observer
  // re-runs the sync: the remaining dialog is unambiguous again and is priced.
  departing.parentNode?.removeChild(departing)
  trigger.fire()
  display.sync(view({ uncachedInputTokens: 1_000_000, outputTokens: 500_000 }))
  assert.ok(survivor.querySelectorAll('[data-session-cost-price]').length > 0, 'priced once it is alone')
  display.dispose()
})

test('a dialog that opens later is decorated when the observer fires', () => {
  const composer = new FakeElement('div')
  shippedPill(composer)
  const { display, fake, trigger } = makeDisplay(composer)

  // The dialog is portaled on open, so it does not exist when the view lands.
  display.sync(view({ uncachedInputTokens: 1_000_000, outputTokens: 500_000 }))
  const dl = shippedDialog(fake.body, ['0%', '1,000,000 tok', '0 tok', '500,000 tok'])
  assert.equal(dl.querySelectorAll('[data-session-cost-price]').length, 0, 'nothing is injected before it opens')

  trigger.fire()
  assert.equal(dl.querySelectorAll('[data-session-cost-price]').length, 3, 'the observer decorates the opened dialog')
})

test('a closed dialog gives its hidden rows and styles back', () => {
  const composer = new FakeElement('div')
  shippedPill(composer)
  const { display, fake, trigger } = makeDisplay(composer)

  // A session with real priced spend AND cache-write tokens whose rate the page
  // does not publish — a mixed session, which is what makes the cache-write row
  // hidden. (A cache-write-ONLY session on such a model is the case the view
  // refuses to render at all, so it could not reach the dialog.)
  const noCacheWrite: CommandCodePriceTable = {
    models: [{ id: 'commandcode/test-flat', slug: 'test-flat', inputCost: 1, outputCost: 2, cacheReadCost: 0.1 }],
    peakHours: [[1, 4], [6, 10]],
  }
  const mixed = buildSessionCostView({
    usage: { uncachedInputTokens: 1_000_000, cacheWriteTokens: 7 },
    selection: SELECTION,
    table: noCacheWrite,
    now: Date.UTC(2026, 8, 16, 5, 0, 0),
  })
  assert.ok(mixed)
  assert.equal(mixed.unpricedCacheWriteTokens, 7)

  const dl = shippedDialog(fake.body, ['0%', '1,000,000 tok', '0 tok', '7 tok', '0 tok'])
  display.sync(mixed)
  const dds = [...dl.childNodes].filter((node): node is FakeElement => node instanceof FakeElement && node.tagName === 'DD')
  assert.equal(dds[3]?.style.display, 'none', 'the unpriced row is hidden')

  // The dialog closes: the harness takes its nodes back, and the style we set on
  // a detached node must not linger on a recycled one.
  fake.body.removeChild(dl)
  trigger.fire()
  // `delete` leaves no own property at all, so the honest observable is
  // presence/absence of the inline style rather than a particular falsy value.
  // `''` is the DOM's canonical "no inline style", which is what the display
  // writes back — the row returns to the sheet's own styling rather than
  // staying hidden.
  assert.equal(dds[3]?.style.display, '', 'the hidden style is given back on close')
})

test('disposal stops observing and detaches the injected nodes', () => {
  const composer = new FakeElement('div')
  shippedPill(composer)
  const { display, fake, trigger } = makeDisplay(composer)

  display.sync(view({ uncachedInputTokens: 1_000_000, outputTokens: 500_000 }))
  const dl = shippedDialog(fake.body, ['0%', '1,000,000 tok', '0 tok', '500,000 tok'])
  trigger.fire()
  assert.equal(dl.querySelectorAll('[data-session-cost-price]').length, 3)

  display.dispose()
  // The observer is detached, so a later dialog open cannot re-inject.
  const later = shippedDialog(fake.body, ['0%', '1,000,000 tok', '0 tok', '500,000 tok'])
  trigger.fire()
  assert.equal(later.querySelectorAll('[data-session-cost-price]').length, 0)
  // And disposal is safe to call again.
  assert.doesNotThrow(() => display.dispose())
})

test('the copy the injection renders is the copy the projection owns', () => {
  // Guards against the display layer growing its own strings: the title it puts
  // on the pill must start with the shared label.
  const composer = new FakeElement('div')
  const { button } = shippedPill(composer)
  const { display } = makeDisplay(composer)
  display.sync(view({ uncachedInputTokens: 1_000_000 }))
  const injected = button.querySelector('[data-composer-session-cost]') as FakeElement
  assert.ok(injected, 'the run is injected')
  // `title` is a DOM PROPERTY, not an attribute: asserting on
  // `getAttribute('title')` would have looked correct while checking nothing.
  assert.equal(
    (injected as unknown as { title: string }).title.startsWith(SESSION_COST_COPY.panelTitle),
    true,
    'the tooltip starts with the shared label',
  )
  // And the tooltip must not carry the separators of clauses that were empty.
  assert.equal((injected as unknown as { title: string }).title.includes('·  ·'), false)
})
