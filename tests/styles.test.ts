/**
 * Injected-stylesheet containment tests (node:test, zero deps). Run with
 * `npm test`.
 *
 * The plugin ships two stylesheets into the harness page — the settings page's
 * (`PAGE_CSS`) and the plans & quota panel's (`PANEL_CSS`) — and both are plain
 * GLOBAL CSS: every rule they carry is able to match markup this plugin did not
 * render. One did (issue #48). `[class*="_footerActions"]` was written for the
 * sidebar's footer-action container, but that is not a stem the sidebar owns
 * alone: `@deepseek-ai/dsh-client-ui-user-questions` renders the
 * ask-user-question dialog's button row as `Mbwy4a_footerActions`, so the rule's
 * `flex-direction:column` reached it too and stacked the dialog's side-by-side
 * buttons. Nothing in the plugin's own tests could see that: the stylesheets
 * were only ever asserted through their effects on our own markup.
 *
 * So this file pins containment directly, in two layers:
 *
 *   1. a STRUCTURAL audit — every compound of every selector must be qualified
 *      by one of our own `cc-`/`ccp-` classes, or be one of the two documented
 *      sidebar region anchors, and the shared `footerActions` stem may only
 *      appear alongside the `footArea` anchor that scopes it;
 *   2. a SIMULATION — a miniature selector matcher run against the real foreign
 *      class stems, proving the dialog's button row is not matched and the
 *      sidebar's row still is.
 *
 * Layer 2 is what keeps layer 1 from being decoration: the fixture list includes
 * markup our matcher WOULD match with the old selector, and that is asserted
 * first. Without the audit, a future rule could reintroduce the leak through a
 * shape the fixtures do not enumerate; without the simulation, the audit's
 * allowlist could be widened to nothing without anyone noticing.
 *
 * Both stylesheets are imported from their modules — never re-typed here — so
 * these tests cannot drift from what is actually injected.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { PAGE_CSS, PAGE_CSS_ID } from '../src/client/page-styles.ts'
import { PANEL_CSS, PANEL_CSS_ID } from '../src/client/panel-styles.ts'

// ---------------------------------------------------------------------------
// Selector parsing (the constrained subset these stylesheets use)
// ---------------------------------------------------------------------------

/** One declaration block, with the at-rule prelude it sits under. */
interface Rule {
  /** The comma-separated selector list, verbatim. */
  selector: string
  /** The declarations between the braces. */
  body: string
  /** Enclosing at-rule prelude (`@media …`), or null at the top level. */
  media: string | null
}

/** Drop `/* … *\/` comments. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/**
 * Walk a stylesheet into flat rules. At-rules recurse instead of being treated
 * as rules, so a `@media` wrapper cannot hide a selector from the audit. Braces
 * inside declaration values would break this — the stylesheets have none (their
 * only URL is a percent-encoded SVG data URI).
 */
function parseRules(css: string): Rule[] {
  const out: Rule[] = []
  const walk = (text: string, media: string | null): void => {
    let i = 0
    while (i < text.length) {
      const open = text.indexOf('{', i)
      if (open < 0) break
      const prelude = text.slice(i, open).trim()
      let depth = 1
      let j = open + 1
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth += 1
        else if (text[j] === '}') depth -= 1
        j += 1
      }
      const body = text.slice(open + 1, j - 1)
      if (prelude.startsWith('@')) walk(body, prelude)
      else if (prelude !== '') out.push({ selector: prelude, body, media })
      i = j
    }
  }
  walk(stripComments(css), null)
  return out
}

/** One compound of a selector, with the combinator that precedes it. */
interface Part {
  compound: string
  /** `null` for the first compound, else `>` / `+` / `~` / ` ` (descendant). */
  combinator: string | null
}

/** Split a selector on its top-level combinators (brackets/parens/quotes aware). */
function splitParts(selector: string): Part[] {
  const parts: Part[] = []
  let buf = ''
  let depth = 0
  let quote = ''
  let pending: string | null = null
  const flush = (): void => {
    const compound = buf.trim()
    if (compound !== '') parts.push({ compound, combinator: pending })
    pending = null
    buf = ''
  }
  for (const ch of selector.trim()) {
    if (quote !== '') {
      buf += ch
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      buf += ch
      continue
    }
    if (ch === '[' || ch === '(') depth += 1
    if (ch === ']' || ch === ')') depth -= 1
    if (depth === 0 && (ch === '>' || ch === '+' || ch === '~')) {
      flush()
      pending = ch
      continue
    }
    if (depth === 0 && /\s/.test(ch)) {
      const hadBuf = buf.trim() !== ''
      flush()
      if (hadBuf && pending === null) pending = ' '
      continue
    }
    buf += ch
  }
  flush()
  return parts
}

/** A compound's class-substring attribute values: `[class*="x"]` → `x`. */
function attrStems(compound: string): string[] {
  return [...compound.matchAll(/\[\s*class\s*\*=\s*"([^"]*)"\s*\]/g)].map((m) => m[1] ?? '')
}

/** A compound's own classes and type selector, ignoring attributes/pseudos. */
function compoundParts(compound: string): { classes: string[]; type: string } {
  // Strip attribute selectors, then pseudos — including their parens (`:has(…)`,
  // `:not(…)`). Nested parens would need real parsing; none are used here.
  const rest = compound
    .replace(/\[[^\]]*\]/g, '')
    .replace(/::?[A-Za-z-]+(\([^)]*\))?/g, '')
  const classes = [...rest.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1] ?? '')
  const type = rest.replace(/\.[A-Za-z0-9_-]+/g, '').trim()
  return { classes, type }
}

// ---------------------------------------------------------------------------
// Containment policy
// ---------------------------------------------------------------------------

/** Our own class namespaces: `cc-` (settings page) and `ccp-` (panel). */
const OWN_CLASS = /^(?:cc|ccp)-/

/**
 * The two sidebar class stems the plugin's stylesheet is allowed to reach into,
 * measured against every client bundle of the 0.1.6-alpha.1 engine.
 *
 * `_footArea` is the sidebar shell's own column, declared by
 * `dsh-client-ui-sidebar` ALONE — which is why it is the SCOPING anchor.
 * `_footerActions` is the action row inside that column, and it is NOT exclusive
 * to it: `dsh-client-ui-user-questions` renders the ask-user-question dialog's
 * button row with the same stem (`Mbwy4a_footerActions`, issue #48), so it may
 * only appear in a selector that also requires the region ancestor above it.
 */
const REGION_STEM = '_footArea'
const SHARED_STEM = '_footerActions'
const FOREIGN_STEMS = new Set([REGION_STEM, SHARED_STEM])

/** Every complete selector in one stylesheet, flattened. */
function selectorsOf(css: string): { selector: string; rule: Rule }[] {
  return parseRules(css).flatMap((rule) =>
    rule.selector.split(',').map((selector) => ({ selector: selector.trim(), rule })),
  )
}

const SHEETS = [
  { name: 'PAGE_CSS', id: PAGE_CSS_ID, css: PAGE_CSS },
  { name: 'PANEL_CSS', id: PANEL_CSS_ID, css: PANEL_CSS },
]

// ---------------------------------------------------------------------------
// Structural audit: every compound is ours, or a documented region anchor
// ---------------------------------------------------------------------------

for (const sheet of SHEETS) {
  test(`${sheet.name}: every selector compound is qualified by one of our own classes or a documented sidebar anchor`, () => {
    const offenders: string[] = []
    for (const { selector } of selectorsOf(sheet.css)) {
      // Once a compound is qualified by one of our own classes, every compound
      // after it can only ever match inside our own markup (`… .ccp-close span`),
      // so an element like `span` there is contained by the selector as a whole.
      let insideOwnSubtree = false
      for (const part of splitParts(selector)) {
        const { classes } = compoundParts(part.compound)
        const stems = attrStems(part.compound)
        const own = classes.some((name) => OWN_CLASS.test(name))
        // The documented region anchors: attribute-substring compounds naming
        // only sidebar stems this plugin is allowed to lay out.
        const anchored =
          stems.length > 0 && classes.length === 0 && stems.every((stem) => FOREIGN_STEMS.has(stem))
        if (!own && !anchored && !(insideOwnSubtree && classes.length === 0)) {
          offenders.push(`${selector}  →  ${part.compound}`)
        }
        if (own) insideOwnSubtree = true
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `${sheet.name} carries selector compounds that can match foreign markup — qualify them with a cc-/ccp- class, or anchor them to the sidebar region and document them here:\n${offenders.join('\n')}`,
    )
  })

  test(`${sheet.name}: the shared footerActions stem is always scoped by the sidebar region anchor`, () => {
    const offenders: string[] = []
    for (const { selector } of selectorsOf(sheet.css)) {
      const parts = splitParts(selector)
      parts.forEach((part, index) => {
        if (!attrStems(part.compound).includes(SHARED_STEM)) return
        const scoped = parts
          .slice(0, index)
          .some((earlier) => attrStems(earlier.compound).includes(REGION_STEM))
        if (!scoped) offenders.push(selector)
      })
    }
    assert.deepEqual(
      offenders,
      [],
      `"${SHARED_STEM}" is declared by the ask-user-question dialog as well as the sidebar (issue #48), so a selector using it must also constrain an ancestor with "${REGION_STEM}":\n${offenders.join('\n')}`,
    )
  })
}

test('the two stylesheets carry distinct ids under the plugin package prefix', () => {
  assert.notEqual(PAGE_CSS_ID, PANEL_CSS_ID)
  for (const id of [PAGE_CSS_ID, PANEL_CSS_ID]) {
    assert.match(id, /^@mars-sea\/dsh-commandcode-provider\//)
  }
})

// ---------------------------------------------------------------------------
// Simulation: the real foreign class stems
// ---------------------------------------------------------------------------

/** A fixture element, with `ancestors[0]` as its parent. */
interface Element {
  tag: string
  classes: string[]
  ancestors: Element[]
}

function el(tag: string, classes: string[], ancestors: Element[] = []): Element {
  return { tag, classes, ancestors }
}

/**
 * The ask-user-question dialog's card, as `dsh-client-ui-user-questions` renders
 * it (measured on 0.1.6-alpha.1): `div.frame > section.card > footer.footer`,
 * whose `div.footerActions` holds the next/submit buttons beside
 * `div.pager` — a `display:flex` row (`align-items:center;gap:12px`) that
 * declares NO `flex-direction`, i.e. side by side, which is what the plugin's
 * rule overrode. The hash prefixes are a measurement too; the STEMS are what the
 * rule keys on, so a re-hash does not invalidate the fixture.
 */
const ASK_DIALOG_FRAME = el('div', ['Mbwy4a_frame'])
const ASK_DIALOG_CARD = el('section', ['Mbwy4a_card'], [ASK_DIALOG_FRAME])
const ASK_DIALOG_FOOTER = el('footer', ['Mbwy4a_footer'], [ASK_DIALOG_CARD])
const ASK_DIALOG_ROW = el('div', ['Mbwy4a_footerActions'], [ASK_DIALOG_FOOTER])

/** The sidebar shell's foot area and the action row inside it (`footArea` is its direct parent). */
const SIDEBAR_FOOT_AREA = el('div', ['hHd-Xa_footArea'])
const SIDEBAR_ROW = el('div', ['hHd-Xa_footerActions'], [SIDEBAR_FOOT_AREA])

/** Match one compound: attributes, own classes, and the type selector. */
function matchCompound(element: Element, compound: string): boolean {
  const stems = attrStems(compound)
  if (!stems.every((stem) => element.classes.some((name) => name.includes(stem)))) return false
  const { classes, type } = compoundParts(compound)
  if (!classes.every((name) => element.classes.includes(name))) return false
  if (type !== '' && type !== element.tag) return false
  // State pseudos (`:hover`, `:checked`, `:has(…)`) are treated as satisfied:
  // they refine WHEN a rule applies, not WHICH elements it can reach, and this
  // matcher is only ever asked whether a selector can reach foreign markup.
  return true
}

/** Can `selector` match `element`? Right-to-left, with real ancestor walks. */
function matches(element: Element, selector: string): boolean {
  const parts = splitParts(selector)
  const at = (current: Element | undefined, index: number): boolean => {
    if (index < 0) return true
    if (current === undefined) return false
    if (!matchCompound(current, parts[index]!.compound)) return false
    if (index === 0) return true
    const combinator = parts[index]!.combinator
    if (combinator === '>') return at(current.ancestors[0], index - 1)
    if (combinator === '+') return false // no adjacent-sibling selectors are shipped
    return current.ancestors.some((ancestor) => at(ancestor, index - 1))
  }
  return at(element, parts.length - 1)
}

test('the fixture reproduces issue #48: the unanchored selector did match the dialog row', () => {
  // The bug in one line. If this ever stops being true the fixture — not the
  // fix — has gone stale, and the assertions below would pass vacuously.
  assert.equal(matches(ASK_DIALOG_ROW, '[class*="_footerActions"]'), true)
  assert.equal(matches(SIDEBAR_ROW, '[class*="_footerActions"]'), true)
})

for (const sheet of SHEETS) {
  test(`${sheet.name}: no selector matches the ask-user-question dialog's button row`, () => {
    const matching = selectorsOf(sheet.css)
      .map(({ selector }) => selector)
      .filter((selector) => matches(ASK_DIALOG_ROW, selector))
    assert.deepEqual(
      matching,
      [],
      `${sheet.name} styles the ask-user-question dialog's footer row, which is official component markup (issue #48):\n${matching.join('\n')}`,
    )
  })
}

test('the sidebar action row is still forced into a column', () => {
  const matching = parseRules(PANEL_CSS).filter((entry) =>
    entry.selector.split(',').some((selector) => matches(SIDEBAR_ROW, selector.trim())),
  )
  assert.ok(
    matching.length > 0,
    'no rule matches the sidebar footer-action row — the wide card would overflow the column',
  )
  assert.ok(
    matching.some((rule) => /flex-direction:\s*column/.test(rule.body)),
    'the rule that reaches the sidebar action row no longer forces it into a column',
  )
  // ...and none of them may also reach the dialog row: that is the entire point
  // of anchoring the rule to the sidebar's foot area.
  for (const rule of matching) {
    assert.equal(matches(ASK_DIALOG_ROW, rule.selector), false, rule.selector)
  }
})
