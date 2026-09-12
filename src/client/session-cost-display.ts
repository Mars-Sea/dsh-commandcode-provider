/**
 * The DOM half of the composer's session-cost figure (browser only).
 *
 * The cost is not a surface of its own any more: it is injected INTO the two
 * surfaces the harness already draws under the composer — the token-usage pill
 * (`1.2M tokens · Cache hit 87%`) and the usage dialog that pill opens. This
 * module owns that injection; `./session-cost.ts` owns every number and every
 * string, and `./session-cost-view.tsx` owns the two seats the figures come
 * from.
 *
 * Why inject rather than take the pill's cell over (registering a `stats` entry
 * REPLACES the shipped readout, it does not extend it): the shipped row is one
 * component owning its tokens / cache-hit / duration figures through the `chat`
 * locale namespace, and its cache-hit percentage obeys an exact-integer rule
 * this plugin must not re-derive. Owning that cell would mean reproducing all of
 * it in English, and every upstream change to it would stop reaching users. So
 * the shipped markup stays the harness's, and this module adds exactly two
 * things to it.
 *
 * Four properties make that safe, all verified against the shipped build:
 *
 * 1. **The dialog's rows are styled by ELEMENT.** `dsh-client-ui-chat`'s
 *    `stat-dialog` module styles its `dl` as a two-column grid and then
 *    `.details dt` / `.details dd` — not by class. A price node appended INSIDE a
 *    shipped value cell therefore inherits that cell's tabular numerals and right
 *    alignment for free, and this plugin ships no CSS at all.
 * 2. **The dialog's rows are matched by POSITION and confirmed by value.** Their
 *    labels are the `chat` locale's own strings (`Uncached input` in English,
 *    `未缓存输入` in Chinese), so no label is ever read. Instead the shape is
 *    predicted from the session's buckets — the cache-hit row exists while there
 *    is billed prompt input, the cache-write row while those tokens are non-zero
 *    — and each value cell must then carry exactly the token count predicted for
 *    it. A dialog that does not confirm is left alone.
 * 3. **The pill keeps the cost visible when space runs out.** The button is an
 *    inline flex row with `gap`, and its label carries `min-width:0` plus
 *    ellipsis; our appended span keeps the default `min-width:auto`, so the
 *    LABEL is what truncates. The cost also inherits the button's `font:inherit`
 *    and `tabular-nums` typography and its hover/expanded tint.
 * 4. **React owns those value cells' text, so a price is re-attached, never
 *    assumed.** The shipped component renders each count as a single string, and
 *    React rewrites such a cell through `textContent` when the count changes —
 *    which drops every child with it, our price included. Every sync therefore
 *    re-checks that the node is still where it was put; the cost of that is a
 *    read, and the alternative is a price that silently disappears mid-session.
 *
 * A `MutationObserver` on `document.body` with `childList` (deliberately NOT
 * `subtree`, so streaming text never wakes it) is the only way to learn that the
 * dialog — which is portaled straight onto `body`, with no slot of ours inside
 * it — has opened or closed. That observer is also what decorates a newly opened
 * dialog from the last view this module was handed.
 *
 * @module dsh-commandcode-provider/client/session-cost-display
 */

import type { SessionCostPillRun, SessionCostRowDecoration, SessionCostShippedRow, SessionCostView } from './session-cost.ts'
import {
  SESSION_COST_COPY,
  sessionCostPillRun,
  sessionCostRowDecorations,
} from './session-cost.ts'

/** The shipped composer stats row (dsh-client-ui-chat `StatsPills`). */
const STATS_ROOT = '[data-composer-stats]'

/**
 * The shipped token-usage dialog's `<dl>`. Unique in the whole of
 * `dsh-client-ui-chat`: the per-message turn-usage panel has its own dialog with
 * different markup, so the composer's is unambiguous.
 */
const USAGE_DIALOG = '[data-session-stats-usage]'

/**
 * The usage dialog's trigger. Both pills announce a dialog, but the token one is
 * rendered LAST — and when no step carries timing the time pill is not a button
 * at all, so "last" still selects the token pill in both cases.
 */
const DIALOG_TRIGGER = 'button[aria-haspopup="dialog"]'

/**
 * Stable id for the hidden node the appended cost is described by. The pill's
 * own `aria-label` is computed by the harness on every render and cannot be
 * extended, so a description is how the cost reaches assistive technology.
 */
const A11Y_ID = 'dsh-commandcode-session-cost'

/** How many consecutive misses before the missing anchor is worth a console line. */
const MISSES_BEFORE_WARNING = 3

/**
 * How the display learns that the shipped usage dialog opened or closed.
 *
 * `target` is `document.body`, and the returned function detaches. The default
 * is a `MutationObserver`; the seam exists so tests can announce the dialog
 * without a global observer (the repository's usual injected-seam shape).
 */
export type SessionCostObserverFactory = (target: Node, listener: () => void) => (() => void) | undefined

/**
 * The default observer: `childList` on `body`, and deliberately NOT `subtree`, so
 * streaming text inside the page never wakes it while the panel the harness
 * portals straight onto `body` does.
 */
const observeBodyChildren: SessionCostObserverFactory = (target, listener) => {
  if (typeof MutationObserver === 'undefined') return undefined
  const observer = new MutationObserver(listener)
  observer.observe(target, { childList: true })
  return () => observer.disconnect()
}

/** What the display layer reads: the injected document and where to look in it. */
export interface SessionCostDisplayOptions {
  /** The document to inject into (injected so node tests can drive a double). */
  doc: Document
  /**
   * The composer that owns this entry — our own outlet wrapper's parent, so a
   * session-scoped composer looks in its OWN card rather than at whichever
   * `[data-composer-stats]` happens to come first in the document.
   */
  scope: () => ParentNode | null
  /** Observer seam; defaults to a `childList` `MutationObserver` on `body`. */
  observe?: SessionCostObserverFactory
}

/**
 * Owns the nodes injected into the shipped token-usage UI.
 *
 * One instance per mounted entry. `sync()` is cheap and idempotent: it re-reads
 * both targets on every call, which is what lets it self-heal when React
 * remounts the row or replaces the dialog, and it rewrites a node only when its
 * text actually changed.
 */
export class SessionCostDisplay {
  private readonly doc: Document
  private readonly scope: () => ParentNode | null
  private readonly observe: SessionCostObserverFactory
  private view: SessionCostView | undefined = undefined
  /** Detaches the observer installed by `start()`. */
  private detach: (() => void) | undefined = undefined
  /** The button we appended into, while it is still connected. */
  private pillHost: Element | undefined = undefined
  /** Our appended root, and the two nodes whose text changes. */
  private pillRoot: HTMLElement | undefined = undefined
  private pillValue: HTMLElement | undefined = undefined
  private pillA11y: HTMLElement | undefined = undefined
  /** Whether WE set `aria-describedby` on the button (so only we take it back). */
  private described = false
  /** The dialog we decorated, the price nodes we own, and the cells we hid. */
  private dialogHost: Element | undefined = undefined
  private dialogPrices = new Map<HTMLElement, HTMLElement>()
  private dialogHidden = new Set<HTMLElement>()
  private pillMisses = 0

  constructor(options: SessionCostDisplayOptions) {
    this.doc = options.doc
    this.scope = options.scope
    this.observe = options.observe ?? observeBodyChildren
  }

  /** Begin watching for the shipped usage dialog opening and closing. */
  start(): void {
    if (this.detach !== undefined) return
    const body = this.doc.body
    if (body === null || body === undefined) return
    this.detach = this.observe(body, () => this.apply())
  }

  /**
   * Hand the display the current figure.
   *
   * Undefined — nothing priceable about this session — removes everything this
   * module injected, leaving both shipped surfaces exactly as they ship.
   */
  sync(view: SessionCostView | undefined): void {
    this.view = view
    this.apply()
  }

  /** Remove every injected node and stop observing. Safe to call twice. */
  dispose(): void {
    this.detach?.()
    this.detach = undefined
    this.removePill()
    this.clearDialog()
    this.view = undefined
  }

  /** Re-apply the last known view to whatever both targets are right now. */
  private apply(): void {
    this.applyPill()
    this.applyDialog()
  }

  // -------------------------------------------------------------------------
  // The pill: the cost as the last item of the shipped token pill's text run
  // -------------------------------------------------------------------------

  private applyPill(): void {
    const view = this.view
    if (view === undefined) {
      this.removePill()
      return
    }
    if (this.pillHost?.isConnected !== true) {
      const button = this.resolvePillButton()
      if (button === null) {
        this.pillMisses += 1
        if (this.pillMisses === MISSES_BEFORE_WARNING) {
          console.warn(
            `[dsh-commandcode-provider] no ${STATS_ROOT} row to append the session cost to; the figure stays in the usage dialog only`,
          )
        }
        return
      }
      this.pillMisses = 0
      this.removePill()
      this.buildPill(button, sessionCostPillRun(view))
    }
    if (this.pillValue !== undefined) {
      const amount = sessionCostPillRun(view).value
      if (this.pillValue.textContent !== amount) this.pillValue.textContent = amount
    }
    if (this.pillRoot !== undefined) {
      if (this.pillRoot.title !== view.title) this.pillRoot.title = view.title
      const approximate = view.approximate ? 'true' : null
      if (this.pillRoot.getAttribute('data-approximate') !== approximate) {
        if (approximate === null) this.pillRoot.removeAttribute('data-approximate')
        else this.pillRoot.setAttribute('data-approximate', approximate)
      }
    }
    if (this.pillA11y !== undefined) {
      const described = `${SESSION_COST_COPY.panelTitle} ${view.value}`
      if (this.pillA11y.textContent !== described) this.pillA11y.textContent = described
    }
  }

  /** The shipped token pill, scoped to this entry's own composer. */
  private resolvePillButton(): Element | null {
    const scope = this.scope() ?? this.doc
    const root = scope.querySelector(STATS_ROOT)
    if (root === null) return null
    const triggers = root.querySelectorAll(DIALOG_TRIGGER)
    return triggers.length === 0 ? null : (triggers[triggers.length - 1] ?? null)
  }

  /**
   * Create and append the cost run. The button's child list is static
   * (`[svg, label]`), so appending once is enough for it to stay last.
   */
  private buildPill(button: Element, run: SessionCostPillRun): void {
    const doc = this.doc
    const root = doc.createElement('span')
    root.setAttribute('data-composer-session-cost', '')
    // The separator is its own node so it can carry the shipped pill's separator
    // colour. Its LEFT spacing comes from the button's flex gap; the right margin
    // reproduces the shipped separator's `margin:0 6px` rhythm, so the run reads
    // `tokens · Cache hit 87% · $0.0123` at one consistent rhythm.
    const separator = doc.createElement('span')
    separator.textContent = run.separator
    separator.setAttribute('aria-hidden', 'true')
    separator.style.color = 'var(--dsw-alias-separator-primary)'
    separator.style.margin = '0 6px 0 0'
    const value = doc.createElement('span')
    value.textContent = run.value
    value.style.fontWeight = '500'
    // Referenced by the button's `aria-describedby`: a hidden node named by id is
    // still read out, which is how the cost survives the aria-label override.
    const a11y = doc.createElement('span')
    a11y.id = A11Y_ID
    a11y.style.display = 'none'
    root.appendChild(separator)
    root.appendChild(value)
    root.appendChild(a11y)
    button.appendChild(root)
    // Only ever claim the attribute when the button has none of its own: a
    // shipped `aria-describedby` is the harness's, and overwriting it would
    // delete a description we cannot restore.
    if (!button.hasAttribute('aria-describedby')) {
      button.setAttribute('aria-describedby', A11Y_ID)
      this.described = true
    }
    this.pillHost = button
    this.pillRoot = root
    this.pillValue = value
    this.pillA11y = a11y
  }

  private removePill(): void {
    if (this.pillRoot !== undefined && this.pillRoot.parentNode !== null) {
      this.pillRoot.parentNode.removeChild(this.pillRoot)
    }
    if (this.described) {
      this.pillHost?.removeAttribute('aria-describedby')
      this.described = false
    }
    this.pillHost = undefined
    this.pillRoot = undefined
    this.pillValue = undefined
    this.pillA11y = undefined
  }

  // -------------------------------------------------------------------------
  // The dialog: a price on the right of each token row the harness already draws
  // -------------------------------------------------------------------------

  private applyDialog(): void {
    const view = this.view
    const host = view === undefined ? null : this.resolveDialog()
    if (host === null || view === undefined) {
      this.clearDialog()
      return
    }
    this.pruneDialog(host)
    const plan = sessionCostRowDecorations(view)
    const pairs = dialogPairs(host)
    if (!dialogShapeMatches(pairs, plan, this.dialogPrices)) {
      // The dialog is not the shape this session's buckets predict — a different
      // build, or a projection carrying values the counts cannot explain. Leave
      // it exactly as the harness drew it rather than pricing the wrong row.
      this.clearDialog()
      return
    }
    const hidden = new Set<HTMLElement>()
    for (const [index, row] of plan.entries()) {
      const pair = pairs[index]
      if (pair === undefined) continue
      const span = this.dialogPrices.get(pair.dd)
      if (row.hidden) {
        // The row is dropped: both cells, or the grid leaves an empty label
        // behind. An inline `display` survives the harness's own re-renders
        // (React pins no style on these nodes) and is given back on disposal.
        if (pair.dt.style.display !== 'none') pair.dt.style.display = 'none'
        if (pair.dd.style.display !== 'none') pair.dd.style.display = 'none'
        hidden.add(pair.dt)
        hidden.add(pair.dd)
        this.removeDialogPrice(pair.dd, span)
        continue
      }
      if (pair.dt.style.display === 'none') pair.dt.style.display = ''
      if (pair.dd.style.display === 'none') pair.dd.style.display = ''
      if (row.amount === undefined) {
        this.removeDialogPrice(pair.dd, span)
        continue
      }
      const price = span ?? this.createDialogPrice(pair.dd, row.row)
      // React owns this cell's text and rewrites it through `textContent` when
      // the count changes, which drops every child with it — so the price is
      // re-attached on a miss rather than assumed to still be there.
      if (price.parentNode !== pair.dd) pair.dd.appendChild(price)
      if (price.textContent !== row.amount) price.textContent = row.amount
    }
    // Cells hidden by an earlier shape (a cache-write row React then rewrote) go
    // back to the harness.
    for (const cell of [...this.dialogHidden]) {
      if (hidden.has(cell)) continue
      if (cell.style.display === 'none') cell.style.display = ''
      this.dialogHidden.delete(cell)
    }
    for (const cell of hidden) this.dialogHidden.add(cell)
    this.dialogHost = host
  }

  /** Forget the cells and prices a re-rendered dialog took with it. */
  private pruneDialog(host: Element): void {
    for (const [dd, price] of [...this.dialogPrices]) {
      if (dd.parentNode === host) continue
      if (price.parentNode !== null) price.parentNode.removeChild(price)
      this.dialogPrices.delete(dd)
    }
    for (const cell of [...this.dialogHidden]) {
      if (cell.parentNode === host) continue
      this.dialogHidden.delete(cell)
    }
  }

  /** The price node for one shipped value cell, appended as its last child. */
  private createDialogPrice(dd: HTMLElement, row: SessionCostShippedRow): HTMLElement {
    const price = this.doc.createElement('span')
    price.setAttribute('data-session-cost-price', row)
    // The cell is right-aligned over tabular numerals, so a fixed-width
    // inline-block lines the prices up as a column of their own to the right of
    // the counts instead of trailing each count raggedly.
    price.style.marginLeft = '6px'
    price.style.display = 'inline-block'
    price.style.minWidth = '56px'
    price.style.textAlign = 'right'
    price.style.fontWeight = '500'
    dd.appendChild(price)
    this.dialogPrices.set(dd, price)
    return price
  }

  private removeDialogPrice(dd: HTMLElement, price: HTMLElement | undefined): void {
    if (price === undefined) return
    if (price.parentNode !== null) price.parentNode.removeChild(price)
    this.dialogPrices.delete(dd)
  }

  /**
   * The shipped usage dialog, or null while it is closed.
   *
   * The dialog is portaled onto `body`, so unlike the pill it cannot be scoped
   * from this entry; DSH renders one composer, and the attribute is unique in
   * the chat client, so a document-level lookup is exact. Should a future build
   * mount two composers at once, both dialogs would describe whichever session
   * this entry belongs to — noted rather than defended against.
   */
  private resolveDialog(): Element | null {
    if (this.dialogHost?.isConnected === true) return this.dialogHost
    // The dialog we injected into is gone: our nodes went with it, so only the
    // bookkeeping is left to drop.
    this.clearDialog()
    return this.doc.querySelector(USAGE_DIALOG)
  }

  /** Give the dialog back: every price removed, every hidden row restored. */
  private clearDialog(): void {
    for (const price of this.dialogPrices.values()) {
      if (price.parentNode !== null) price.parentNode.removeChild(price)
    }
    this.dialogPrices.clear()
    for (const cell of this.dialogHidden) {
      if (cell.style.display === 'none') cell.style.display = ''
    }
    this.dialogHidden.clear()
    this.dialogHost = undefined
  }
}

/** The shipped dialog's `dt`/`dd` pairs, in document order. */
function dialogPairs(host: Element): Array<{ dt: HTMLElement; dd: HTMLElement }> {
  const pairs: Array<{ dt: HTMLElement; dd: HTMLElement }> = []
  let label: HTMLElement | null = null
  for (const node of Array.from(host.childNodes)) {
    const tag = tagNameOf(node)
    if (tag === 'DT') label = node as HTMLElement
    else if (tag === 'DD' && label !== null) {
      pairs.push({ dt: label, dd: node as HTMLElement })
      label = null
    }
  }
  return pairs
}

/** `tagName` upper-cased, or an empty string for a non-element node. */
function tagNameOf(node: Node): string {
  const tag = (node as Element).tagName
  return typeof tag === 'string' ? tag.toUpperCase() : ''
}

/**
 * Whether the dialog really holds the rows this session's buckets predict.
 *
 * The shipped labels belong to the `chat` locale — they are `Uncached input` in
 * English and something else entirely in Chinese — so rows are matched by
 * POSITION, and this is what makes that safe: the row count must agree, the
 * cache-hit row must be the percentage it is, and every other value must carry
 * exactly the token count of the bucket predicted for it. A mismatch means the
 * dialog is not what this view describes, and nothing is decorated.
 */
function dialogShapeMatches(
  pairs: ReadonlyArray<{ dt: HTMLElement; dd: HTMLElement }>,
  plan: readonly SessionCostRowDecoration[],
  prices: ReadonlyMap<HTMLElement, HTMLElement>,
): boolean {
  if (pairs.length !== plan.length) return false
  return plan.every((row, index) => {
    const pair = pairs[index]
    if (pair === undefined) return false
    const text = hostValueText(pair.dd, prices.get(pair.dd))
    if (row.tokens === undefined) return text.includes('%')
    return digitsOf(text) === String(row.tokens)
  })
}

/**
 * A value cell's own text, without the price this module appended to it — the
 * digits of `3,206,544 tok` are the host's, the digits of `$0.07` are ours.
 */
function hostValueText(dd: HTMLElement, price: HTMLElement | undefined): string {
  let text = ''
  for (const node of Array.from(dd.childNodes)) {
    if (node === price) continue
    text += node.textContent ?? ''
  }
  return text
}

/** Every digit of a display string, so locale grouping cannot break the match. */
function digitsOf(text: string): string {
  return text.replace(/\D/g, '')
}
