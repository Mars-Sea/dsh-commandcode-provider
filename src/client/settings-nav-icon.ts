/**
 * The glyph shown beside this plugin's settings page in the settings nav
 * (browser only).
 *
 * The settings shell used to pick a nav glyph by SECTION ID alone:
 * `ui-settings-general`'s `navIcon(id)` knows `account` / `models` /
 * `agent-presets` / `plugins` / `archived-sessions` and hands every other id
 * `IconSettingsOutlineMedium` (the gear), so on those hosts the `commandcode`
 * row shares the gear with every other unrecognised section (the bundled
 * 反向代理 row included). `settings.section` registrations carry no icon field
 * there. dsh 0.2.2-alpha.3 added the `settings.section.icon` slot, which is the
 * sanctioned seat and what `./settings-nav-glyph.tsx` registers whenever the
 * host declares it; THIS module is the fallback for the engines that predate
 * the slot (the plugin still supports `0.2.1-rc.2` and `0.2.2-alpha.2`). Once
 * the engine floor reaches `0.2.2-alpha.3`, delete this module and keep only
 * the slot registration.
 *
 * What it does is deliberately small: inside the settings modal's nav it finds
 * the one row whose label is this plugin's nav label, hides the shell's glyph
 * (`display:none`, recorded and given back on disposal) and inserts one inline
 * SVG — the Command Code mark (a command glyph, matching `icon.svg`) — before
 * the label. The artwork constant is shared with the slot-rendered glyph, so
 * the two engines draw exactly the same mark.
 *
 * Three properties keep it safe:
 *
 * 1. **Scoped and identified by LABEL, not by position.** The modal is found by
 *    the shell's own `data-shortcut-modal="settings"` attribute and the row by
 *    the localized nav label, so reordering, other plugins' sections, and the
 *    shell's unknown-id fallback do not matter. Only the row that reads
 *    "Command Code" is touched.
 * 2. **React owns the row, so the decoration is IDEMPOTENT and self-healing.**
 *    `sync()` re-reads the row every time; if a re-render dropped our glyph it
 *    is inserted again, and a row that no longer confirms is restored exactly
 *    as the shell drew it. Attributes and nodes we add never overwrite anything
 *    the shell set.
 * 3. **A missing dialog is not an error.** The dialog is portaled onto `body`
 *    only while open; no dialog, no nav, or no matching row simply means
 *    nothing to do. Neither a throw nor a console line — unlike a data surface,
 *    a decorative glyph disappearing is not worth reporting.
 *
 * A `MutationObserver` on `document.body` with `childList` (deliberately NOT
 * `subtree`, so streaming chat text never wakes it) is how the portaled dialog's
 * mount is noticed; the same shape as `./session-cost-display.ts`.
 *
 * @module dsh-commandcode-provider/client/settings-nav-icon
 */

/** The settings shell's modal, portaled straight onto `body` while open. */
const SETTINGS_DIALOG = '[data-shortcut-modal="settings"]'

/** The section nav rail inside that modal (an element, not a class stem). */
const SETTINGS_NAV = 'nav'

/** The SVG namespace for the injected glyph. */
const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * Marks OUR node, so a re-sync can tell our glyph from the shell's (and so a
 * test can assert the injected artwork without knowing the private shape).
 */
export const SETTINGS_NAV_ICON_ATTR = 'data-cc-settings-nav-icon'

/**
 * The Command Code mark as a 16px line glyph: the command symbol (four loops
 * joined by a square), stroke-only so it inherits `currentColor` from the nav
 * cell exactly like the shell's own `Icon*OutlineMedium` artwork.
 *
 * Authored here rather than imported: the slot this replaces does not exist on
 * the host we inject into, and `icon.svg` is a filled badge whose interior mark
 * loses its counter at 16px. The geometry is the brand mark's, simplified to
 * one path.
 */
export const SETTINGS_NAV_GLYPH =
  'M10 4v8a2 2 0 1 0 2-2H4a2 2 0 1 0 2 2V4a2 2 0 1 0-2 2h8a2 2 0 1 0-2-2'

/**
 * How the decorator learns that the portaled dialog opened or closed.
 *
 * `target` is `document.body`, and the returned function detaches. The default
 * is a `MutationObserver`; the seam exists so tests can announce the dialog
 * without a global observer (the repository's usual injected-seam shape).
 */
export type SettingsNavIconObserverFactory = (target: Node, listener: () => void) => (() => void) | undefined

/** The default observer: `childList` on `body`, deliberately not `subtree`. */
const observeBodyChildren: SettingsNavIconObserverFactory = (target, listener) => {
  if (typeof MutationObserver === 'undefined') return undefined
  const observer = new MutationObserver(listener)
  observer.observe(target, { childList: true })
  return () => observer.disconnect()
}

/** Our glyph factory: a fresh SVG node, injected so tests can double it. */
export type SettingsNavIconFactory = (doc: Document) => Element

/**
 * Build the injected glyph.
 *
 * The attribute set mirrors the shell's own icon artwork (`fill="none"`,
 * `viewBox="0 0 16 16"`, `aria-hidden`, `stroke="currentColor"` on the path) so
 * the row reads and paints like every other nav cell; `flex:none` matches the
 * shell's icon wrapper and keeps the button's 8px gap from stretching it.
 */
export function createSettingsNavGlyph(doc: Document): Element {
  const svg = doc.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('xmlns', SVG_NS)
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute(SETTINGS_NAV_ICON_ATTR, '')
  svg.style.flex = 'none'
  const path = doc.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', SETTINGS_NAV_GLYPH)
  path.setAttribute('stroke', 'currentColor')
  path.setAttribute('stroke-width', '1.3')
  path.setAttribute('stroke-linecap', 'round')
  path.setAttribute('stroke-linejoin', 'round')
  svg.appendChild(path)
  return svg
}

/** What the decorator reads: the document, the current label, and the seams. */
export interface SettingsNavIconOptions {
  /** The document to decorate (injected so node tests can drive a double). */
  doc: Document
  /**
   * This plugin's nav label, resolved on every sync so the row keeps matching
   * after a language switch. The row itself is identified by this text.
   */
  label: () => string
  /** Observer seam; defaults to a `childList` `MutationObserver` on `body`. */
  observe?: SettingsNavIconObserverFactory
  /** Glyph factory seam; defaults to {@link createSettingsNavGlyph}. */
  createIcon?: SettingsNavIconFactory
}

/**
 * Element with a `style` object: both shapes the shell renders for the icon
 * (an HTML `span` wrapper on 0.2.2-alpha.3, a bare `svg` before that) carry one.
 */
type StyledElement = Element & { style: CSSStyleDeclaration }

/**
 * Owns the injected glyph in the settings nav.
 *
 * One instance per client plugin. `sync()` is cheap and idempotent: it re-reads
 * the row on every call, rewrites nothing when the decoration is already in
 * place, and restores the shell's glyph when the row stops confirming.
 */
export class SettingsNavIcon {
  private readonly doc: Document
  private readonly label: () => string
  private readonly observe: SettingsNavIconObserverFactory
  private readonly createIcon: SettingsNavIconFactory
  /** Detaches the observer installed by `start()`. */
  private detach: (() => void) | undefined = undefined
  /** The nav row we decorated, while it is still the row we found. */
  private row: Element | undefined = undefined
  /** Our glyph, and the shell glyph we hid (with its original inline display). */
  private glyph: Element | undefined = undefined
  private hiddenIcon: StyledElement | undefined = undefined
  private hiddenDisplay: string | undefined = undefined

  constructor(options: SettingsNavIconOptions) {
    this.doc = options.doc
    this.label = options.label
    this.observe = options.observe ?? observeBodyChildren
    this.createIcon = options.createIcon ?? createSettingsNavGlyph
  }

  /** Begin watching for the settings dialog opening and closing. */
  start(): void {
    if (this.detach !== undefined) return
    const body = this.doc.body
    if (body === null || body === undefined) return
    this.detach = this.observe(body, () => this.sync())
    // The dialog can already be open when this runs (a client plugin reload
    // while the modal is up), so decorate once immediately.
    this.sync()
  }

  /** Decorate the row as it is right now, or restore it when it is gone. */
  sync(): void {
    const row = this.resolveRow()
    if (row === null) {
      this.clear()
      return
    }
    if (row === this.row && this.glyph !== undefined && this.glyph.parentNode === row) return
    this.clear()
    this.decorate(row)
  }

  /** Remove the injected glyph, give back the shell's, and stop observing. */
  dispose(): void {
    this.detach?.()
    this.detach = undefined
    this.clear()
  }

  /**
   * The nav row whose label is ours.
   *
   * The label is the LAST element child on both host shapes (`[icon, label]`,
   * and the 0.2.2-alpha.3 `[wrapper, label]`), which is also what keeps the
   * match from depending on the icon wrapper's markup.
   */
  private resolveRow(): Element | null {
    const dialog = this.doc.querySelector(SETTINGS_DIALOG)
    if (dialog === null) return null
    const nav = dialog.querySelector(SETTINGS_NAV)
    if (nav === null) return null
    const label = this.label().trim()
    if (label === '') return null
    for (const button of Array.from(nav.querySelectorAll('button'))) {
      const text = button.lastElementChild?.textContent?.trim()
      if (text === label) return button
    }
    return null
  }

  /**
   * Hide the shell's glyph and insert ours before the label.
   *
   * A row with no icon child at all (only the label) is decorated too: there is
   * nothing to hide, and inserting our glyph still gives it the same leading
   * 16px glyph every other row has.
   */
  private decorate(row: Element): void {
    const label = row.lastElementChild
    if (label === null) return
    const icon = row.firstElementChild
    if (icon !== null && icon !== label) {
      this.hiddenIcon = icon as StyledElement
      this.hiddenDisplay = this.hiddenIcon.style.display
      this.hiddenIcon.style.display = 'none'
    }
    const glyph = this.createIcon(this.doc)
    row.insertBefore(glyph, label)
    this.row = row
    this.glyph = glyph
  }

  /** Undo {@link decorate}, idempotently. */
  private clear(): void {
    if (this.glyph !== undefined && this.glyph.parentNode !== null) {
      this.glyph.parentNode.removeChild(this.glyph)
    }
    if (this.hiddenIcon !== undefined && this.hiddenDisplay !== undefined) {
      // Only restore a node we actually hid; a re-rendered row keeps no claim.
      this.hiddenIcon.style.display = this.hiddenDisplay
    }
    this.row = undefined
    this.glyph = undefined
    this.hiddenIcon = undefined
    this.hiddenDisplay = undefined
  }
}
