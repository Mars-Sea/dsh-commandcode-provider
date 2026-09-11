/**
 * dsh-TUI settings-section tests (node:test, zero deps). Run with `npm test`.
 *
 * The section is the only surface a TUI-only user has for entering the Command
 * Code API key (issue #28), and dsh-TUI renders a FIXED declaration — it never
 * re-reads the plugin's config — so these tests pin the parts that would fail
 * silently in a terminal:
 *
 * - the API-key field is a `secret` field whose ref is the plugin's own
 *   credential reference and not one dsh-TUI reserves for the host (a reserved
 *   ref is dropped by the host's guard, leaving a settings page with no key
 *   field at all);
 * - the option-bearing fields express "unset" (a `select` cannot, so they are
 *   `text` + `options` with an `auto` sentinel that parses back to a clear);
 * - the booleans render their EFFECTIVE default rather than the raw stored
 *   value, because the schema leaves them undefined on a fresh install;
 * - re-registration happens exactly when a fact frozen into the declaration
 *   moved, and never on an unrelated refresh.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Context } from '@deepseek-ai/cordis'
import type { Plugin } from '@deepseek-ai/cordis'

import {
  ACTIVE_ACCOUNT_AUTO,
  LANG_AUTO,
  applyCommandCodeTuiSettings,
  buildCommandCodeTuiSection,
  commandCodeTuiModelChoices,
} from '../src/tui-settings.ts'
import type {
  TuiModelChoice,
  TuiSettingsField,
  TuiSettingsSection,
  TuiSettingsSectionsService,
} from '../src/tui-settings.ts'
import { KNOWN_PLANS } from '../src/capabilities.ts'

/** Plan tiers in picker order, mirrored from the web dropdown's headings. */
const TIER_ORDER: readonly string[] = ['go', 'goat', 'pro', 'provider', 'max']

/** The plugin's default credential reference. */
const DEFAULT_REF = 'COMMANDCODE_API_KEY'

interface Deps {
  apiKeyRef: () => string
  accountSlots: () => readonly { id: string; label: string }[]
  visibleModels: () => readonly string[]
  modelVisibility: () => Readonly<Record<string, boolean>> | undefined
  modelChoices: () => readonly TuiModelChoice[]
}

/** A tiny catalog in the shape `commandCodeTuiModelChoices()` produces. */
const CATALOG: readonly TuiModelChoice[] = [
  { id: 'free/ling', tier: 'go', free: true, hint: 'Go · FREE' },
  { id: 'go/alpha', tier: 'go', free: false, hint: 'Go · 1M' },
  { id: 'goat/beta', tier: 'goat', free: false, hint: 'GOAT · Image' },
  { id: 'pro/gamma', tier: 'pro', free: false, hint: 'Pro · 256K' },
  { id: 'provider/delta', tier: 'provider', free: false, hint: 'Provider · 1M' },
]

/** Build the section over a mutable slot list and allowlist, like the entry does. */
/**
 * A stored allowlist as a hand-edited document really holds it. `storedIds()`
 * takes `unknown` for exactly this reason — the value comes from a settings
 * document nothing has validated — but `build()`'s `visible` option is declared
 * as the *validated* id list, so a case that deliberately stores junk crosses
 * that boundary here, once, named, and keeps the array literal itself checked.
 */
function storedJunk(ids: readonly unknown[]): readonly string[] {
  return ids as readonly string[]
}

function build(
  overrides: Partial<Deps> & { visible?: readonly string[]; flags?: Record<string, boolean> } = {},
): {
  section: TuiSettingsSection
  slots: { id: string; label: string }[]
  setVisible: (ids: readonly string[]) => void
  setFlags: (flags: Record<string, boolean>) => void
  deps: Deps
} {
  const { visible: initial = [], flags: initialFlags = {}, ...rest } = overrides
  const slots = [
    { id: 'default', label: 'Default' },
    { id: 'COMMANDCODE_API_KEY_2', label: 'Backup' },
  ]
  let visible = [...initial]
  let flags = { ...initialFlags }
  const deps: Deps = {
    apiKeyRef: () => DEFAULT_REF,
    accountSlots: () => slots,
    // Read through mutable cells: the fields must see the LIVE document on
    // every call, so a test can land a write between two parses.
    visibleModels: () => visible,
    modelVisibility: () => flags,
    modelChoices: () => CATALOG,
    ...rest,
  }
  return {
    section: buildCommandCodeTuiSection({ ns: 'llm-commandcode', ...deps }),
    slots,
    setVisible: (ids) => {
      visible = [...ids]
    },
    setFlags: (next) => {
      flags = { ...next }
    },
    deps,
  }
}

/** One field by its settings path. */
function field(section: TuiSettingsSection, path: string): TuiSettingsField {
  const hit = section.fields.find((candidate) => candidate.path.join('.') === path)
  assert.ok(hit !== undefined, `section declares a "${path}" field`)
  return hit
}

/** The checkbox for one model id. */
function checkbox(section: TuiSettingsSection, id: string): TuiSettingsField {
  const hit = section.fields.find(
    (candidate) => candidate.path.join('.') === `modelVisibility.${id}`,
  )
  assert.ok(hit !== undefined, `section offers a checkbox for "${id}"`)
  return hit
}

/** Apply a field's parse, asserting the draft was accepted. */
function parse(target: TuiSettingsField, text: string): { kind: string; value?: unknown } {
  assert.ok(target.parse !== undefined, 'field declares a parse')
  const write = target.parse(text)
  assert.ok(write !== undefined, `parse accepts ${JSON.stringify(text)}`)
  return write
}

test('the section targets the plugin namespace and groups every field', () => {
  const { section } = build()
  assert.equal(section.ns, 'llm-commandcode')
  assert.equal(section.title, 'Command Code')
  assert.deepEqual((section.groups ?? []).map((group) => group.id), [
    'connection',
    'models',
    'models-go',
    'models-goat',
    'models-pro',
    'models-provider',
    'advanced',
  ])
  const groups = new Set((section.groups ?? []).map((group) => group.id))
  for (const entry of section.fields) {
    assert.ok(entry.group !== undefined, `${entry.label} declares a group`)
    assert.equal(groups.has(entry.group), true, `${entry.label} names a declared group`)
  }
  // Every field addresses a settings key of its own — see the dedicated
  // uniqueness test below for why the checkboxes cannot share one.
  const paths = section.fields.map((entry) => entry.path.join('.'))
  assert.equal(new Set(paths).size, paths.length)
  assert.equal(
    section.fields.filter((entry) => entry.path[0] === 'modelVisibility').length,
    CATALOG.length,
  )
})

test('the API key is a secret field on the plugin credential reference', () => {
  const { section } = build()
  const key = field(section, 'apiKey')
  assert.equal(key.kind, 'text', 'the key control is a text field')
  assert.equal(key.secret?.ref, DEFAULT_REF)
  // dsh-TUI drops a plugin section field whose ref the host owns
  // (DEEPSEEK_API_KEY / DEEPSEEK_* / DSH_*). A ref drifting into that
  // namespace would silently remove the only key input a TUI user has.
  assert.equal(key.secret?.ref.startsWith('DEEPSEEK_'), false)
  assert.equal(key.secret?.ref.startsWith('DSH_'), false)
  // A secret field is write-only: it never seeds a draft from the settings
  // document, so a format/parse pair here would be dead code.
  assert.equal(key.format, undefined)
  assert.equal(key.parse, undefined)
  // It is the only credential control in the section.
  const secrets = section.fields.filter((entry) => entry.secret !== undefined)
  assert.deepEqual(secrets.map((entry) => entry.path.join('.')), ['apiKey'])
})

test('the API key field follows the effective credential reference', () => {
  const { section } = build({ apiKeyRef: () => 'COMMANDCODE_API_KEY_WORK' })
  assert.equal(field(section, 'apiKey').secret?.ref, 'COMMANDCODE_API_KEY_WORK')
  assert.match(field(section, 'apiKey').hint ?? '', /COMMANDCODE_API_KEY_WORK/)
})

test('the API base field clears on an empty draft and trims a value', () => {
  const base = field(build().section, 'apiBase')
  assert.equal(base.kind, 'text')
  assert.deepEqual(parse(base, ''), { kind: 'clear' })
  assert.deepEqual(parse(base, '   '), { kind: 'clear' })
  assert.deepEqual(parse(base, '  https://example.test  '), {
    kind: 'set',
    value: 'https://example.test',
  })
})

test('the plan filter renders its effective default, not the stored undefined', () => {
  const filter = field(build().section, 'filterModelsByPlan')
  assert.equal(filter.kind, 'boolean')
  // The schema carries no default; the adapter resolves unset to `true`. A raw
  // boolean format would render "(empty)" on a fresh install.
  assert.equal(filter.format?.(undefined), 'true')
  assert.equal(filter.format?.(false), 'false')
  assert.equal(filter.format?.(true), 'true')
  assert.deepEqual(parse(filter, 'false'), { kind: 'set', value: false })
  assert.deepEqual(parse(filter, 'true'), { kind: 'set', value: true })
})

test('every field owns a unique path, so no two drafts collide', () => {
  const { section } = build()
  // dsh-TUI keys a staged draft by the field's PATH and pushes one write op
  // per field carrying that key. Two fields sharing a path therefore share one
  // draft, every one of them parses it on save, and only the LAST op survives —
  // which is how a checkbox list once silently rewrote the allowlist from the
  // last catalog model instead of the row the user toggled. This invariant is
  // the whole reason each model gets `modelVisibility.<id>`.
  const paths = section.fields.map((entry) => entry.path.join('.'))
  assert.equal(new Set(paths).size, paths.length, 'no two fields share a path')
})

test('every catalog model is its own checkbox in its plan tier group', () => {
  const { section } = build()
  const boxes = section.fields.filter((entry) => entry.path[0] === 'modelVisibility')
  assert.deepEqual(boxes.map((entry) => entry.label), CATALOG.map((choice) => choice.id))
  assert.deepEqual(boxes.map((entry) => entry.group), [
    'models-go',
    'models-go',
    'models-goat',
    'models-pro',
    'models-provider',
  ])
  for (const box of boxes) {
    // `select` cannot express membership and the seam has no multi-select, so a
    // boolean per model is the only control that renders as a checkbox.
    assert.equal(box.kind, 'boolean')
    assert.equal(box.path.length, 2, 'each checkbox addresses its own key')
    assert.ok(box.parse !== undefined && box.format !== undefined, 'a checkbox formats and parses')
    assert.match(box.hint ?? '', /·/, 'the row hint carries the capability summary')
  }
})

test('an unset allowlist renders every model checked', () => {
  const { section } = build()
  for (const box of section.fields.filter((entry) => entry.path[0] === 'modelVisibility')) {
    // Empty means "show everything" to the adapter, so the checkboxes render
    // the EFFECTIVE visibility — an all-unchecked page would read as "nothing
    // is allowed" and invite a save that hides every model.
    assert.equal(box.format?.(undefined), 'true', `${box.label} is checked when unset`)
  }
})

test('a stored allowlist decides which boxes are checked', () => {
  const { section } = build({ visible: ['go/alpha', 'pro/gamma'] })
  const checked = section.fields
    .filter((entry) => entry.path[0] === 'modelVisibility')
    .filter((entry) => entry.format?.(undefined) === 'true')
    .map((entry) => entry.label)
  assert.deepEqual(checked, ['go/alpha', 'pro/gamma'])
  // A malformed document must not break the render, and must be judged the way
  // the adapter judges it: `resolveAdapterOptions` drops a non-array to
  // `undefined`, which means "show everything" — so every box reads checked
  // rather than the page claiming the user hid every model.
  const alpha = checkbox(section, 'go/alpha')
  assert.equal(alpha.format?.(undefined), 'true')
  // A hand-edited document holds what it holds: the number and the blank are
  // there on purpose, so this case crosses the fixture's validated `visible`
  // option through the one documented boundary below.
  const listed = build({ visible: storedJunk(['go/alpha', 3, '', 'pro/gamma']) }).section
  assert.equal(checkbox(listed, 'go/alpha').format?.(undefined), 'true')
  assert.equal(checkbox(listed, 'goat/beta').format?.(undefined), 'false')
})

test('a checkbox writes an override, and only when it disagrees with the array', () => {
  const { section } = build()
  // Unset means "all visible", so switching one off is a real override…
  assert.deepEqual(parse(checkbox(section, 'go/alpha'), 'false'), { kind: 'set', value: false })
  // …while switching an already-visible model on is not, and must leave no
  // residue: the clear re-inherits the composition layer and keeps the
  // document minimal.
  assert.deepEqual(parse(checkbox(section, 'go/alpha'), 'true'), { kind: 'clear' })
})

test('the array allowlist stays the baseline an override is judged against', () => {
  const { section, setVisible } = build({ visible: ['go/alpha', 'pro/gamma'] })
  const beta = checkbox(section, 'goat/beta')
  // beta is hidden by the array, so checking it is an override…
  assert.deepEqual(parse(beta, 'true'), { kind: 'set', value: true })
  // …and unchecking it again is not.
  assert.deepEqual(parse(beta, 'false'), { kind: 'clear' })
  // A write that landed after this declaration was built changes the baseline:
  // the inherited state must be read when the save runs, not when the section
  // was registered.
  setVisible([])
  assert.deepEqual(parse(beta, 'false'), { kind: 'set', value: false })
  assert.deepEqual(parse(beta, 'true'), { kind: 'clear' })
})

test('an override decides its own model, whatever the array says', () => {
  const { section } = build({ visible: ['go/alpha'], flags: { 'goat/beta': true, 'pro/gamma': false } })
  assert.equal(checkbox(section, 'go/alpha').format?.(undefined), 'true', 'follows the array')
  assert.equal(checkbox(section, 'goat/beta').format?.(true), 'true', 'override wins')
  assert.equal(checkbox(section, 'pro/gamma').format?.(false), 'false', 'override wins')
})

test('ids this build cannot place stay visible and switchable', () => {
  const { section } = build({
    visible: ['retired/model'],
    flags: { 'gone/too': false },
  })
  assert.ok((section.groups ?? []).some((group) => group.id === 'models-other'))
  // A model retired or renamed upstream must not vanish from the page — from
  // either the array or the override map — or it could never be switched from
  // the terminal again.
  assert.deepEqual(
    section.fields.filter((entry) => entry.group === 'models-other').map((entry) => entry.label),
    ['retired/model', 'gone/too'],
  )
  assert.equal(checkbox(section, 'retired/model').format?.(undefined), 'true')
  assert.equal(checkbox(section, 'gone/too').format?.(false), 'false')
  // Its checkbox writes its own key, like any other row.
  assert.deepEqual(parse(checkbox(section, 'gone/too'), 'true'), { kind: 'set', value: true })
})

test('the shipped catalog is the known model table, tier-ordered', () => {
  const choices = commandCodeTuiModelChoices()
  const ids = choices.map((choice) => choice.id)
  assert.equal(ids.length, Object.keys(KNOWN_PLANS).length)
  assert.equal(new Set(ids).size, ids.length, 'no model is offered twice')
  const ranks = choices.map((choice) => TIER_ORDER.indexOf(choice.tier))
  assert.equal(ranks.includes(-1), false, 'every shipped model sits in a known tier')
  for (let i = 1; i < ranks.length; i += 1) {
    assert.ok((ranks[i] as number) >= (ranks[i - 1] as number), 'tiers ascend (Go first)')
  }
  // Free models lead their own tier — they cost nothing and every account can
  // use them, so they are the best first candidates.
  const go = choices.filter((choice) => choice.tier === 'go')
  assert.equal(go[0]?.free, true)
})

test('the active-account field keeps "unset" reachable', () => {
  const { section } = build()
  const active = field(section, 'activeAccount')
  // `select` can only ever land on a declared option, so an unset value could
  // never be reached again after the first pin. Text + options is the host's
  // own preset-plus-custom shape and keeps the clear path.
  assert.equal(active.kind, 'text')
  assert.deepEqual(active.options?.map((option) => option.value), [
    ACTIVE_ACCOUNT_AUTO,
    'default',
    'COMMANDCODE_API_KEY_2',
  ])
  assert.equal(active.options?.[1]?.label, 'Default')
  assert.equal(active.format?.(undefined), ACTIVE_ACCOUNT_AUTO)
  assert.equal(active.format?.(''), ACTIVE_ACCOUNT_AUTO)
  assert.equal(active.format?.('  '), ACTIVE_ACCOUNT_AUTO)
  assert.equal(active.format?.('default'), 'default')
  assert.deepEqual(parse(active, ACTIVE_ACCOUNT_AUTO), { kind: 'clear' })
  assert.deepEqual(parse(active, '  '), { kind: 'clear' })
  assert.deepEqual(parse(active, ' COMMANDCODE_API_KEY_2 '), {
    kind: 'set',
    value: 'COMMANDCODE_API_KEY_2',
  })
})

test('the account selector reflects the slot list it was built from', () => {
  const { section } = build({ accountSlots: () => [{ id: 'account-2', label: 'Work' }] })
  assert.deepEqual(field(section, 'activeAccount').options?.map((option) => option.value), [
    ACTIVE_ACCOUNT_AUTO,
    'account-2',
  ])
  // An account list without the default slot still leaves the selector usable.
  assert.deepEqual(field(build({ accountSlots: () => [] }).section, 'activeAccount').options?.map(
    (option) => option.value,
  ), [ACTIVE_ACCOUNT_AUTO])
})

test('the language field maps unset to auto and stages a concrete locale', () => {
  const lang = field(build().section, 'lang')
  assert.equal(lang.kind, 'text')
  assert.deepEqual(lang.options?.map((option) => option.value), [LANG_AUTO, 'zh', 'en'])
  assert.equal(lang.format?.(undefined), LANG_AUTO)
  assert.equal(lang.format?.('fr'), LANG_AUTO)
  assert.equal(lang.format?.('en'), 'en')
  assert.deepEqual(parse(lang, LANG_AUTO), { kind: 'clear' })
  assert.deepEqual(parse(lang, ' en '), { kind: 'set', value: 'en' })
  // An unsupported locale stays a valid draft here and is rejected by the
  // schema at save time, which is what surfaces the error on the screen.
  assert.deepEqual(parse(lang, 'fr'), { kind: 'set', value: 'fr' })
})

// ---------------------------------------------------------------------------
// Registration lifecycle
// ---------------------------------------------------------------------------

/** A stubbed `tuiSettingsSections` seam that records what it was handed. */
interface Seam {
  service: TuiSettingsSectionsService
  sections: TuiSettingsSection[]
  disposals: number
  fail: { value: Error | undefined }
}

function makeService(): Seam {
  const state: Seam = {
    service: undefined!,
    sections: [],
    disposals: 0,
    fail: { value: undefined },
  }
  state.service = {
    register(section) {
      if (state.fail.value !== undefined) throw state.fail.value
      state.sections.push(section)
      return () => {
        state.disposals += 1
      }
    },
  }
  return state
}

/**
 * Capture the plugin's own warnings. `ctx.logger.warn` is a prototype method
 * on a shared logger, so the spy owns a per-context property and restores it.
 */
function spyWarn(ctx: Context): { messages: string[]; restore: () => void } {
  const messages: string[] = []
  const logger = ctx.logger as unknown as { warn: (message: string) => void }
  const original = logger.warn
  logger.warn = (message: string) => {
    messages.push(message)
  }
  return {
    messages,
    restore: () => {
      logger.warn = original
    },
  }
}

/** Mount the section on a real cordis context over a stubbed seam. */
async function mount(options: {
  slots?: { id: string; label: string }[]
  ref?: string
  withService?: boolean
} = {}): Promise<{
  ctx: Context
  fiber: { dispose: () => Promise<void> }
  refresh: () => void
  seam: Seam
  slots: { id: string; label: string }[]
  warnings: string[]
}> {
  const slots = options.slots ?? [{ id: 'default', label: 'Default' }]
  const seam = makeService()
  const ctx = new Context()
  if (options.withService !== false) ctx.provide('tuiSettingsSections', seam.service)
  const spy = spyWarn(ctx)
  let refresh: (() => void) | undefined
  const fiber = ctx.plugin<Plugin.Function>((pluginCtx: Context) => {
    refresh = applyCommandCodeTuiSettings(pluginCtx, {
      ns: 'llm-commandcode',
      apiKeyRef: () => options.ref ?? DEFAULT_REF,
      accountSlots: () => slots,
      visibleModels: () => [],
      modelChoices: () => CATALOG,
    })
  }, {})
  await fiber
  return {
    ctx,
    fiber: fiber as unknown as { dispose: () => Promise<void> },
    refresh: () => refresh?.(),
    seam,
    slots,
    warnings: spy.messages,
  }
}

test('registration declares the section once', async () => {
  const host = await mount()
  assert.equal(host.seam.sections.length, 1)
  assert.equal(host.seam.sections[0]?.ns, 'llm-commandcode')
  await host.fiber.dispose()
})

test('an unrelated refresh does not churn the section list', async () => {
  const host = await mount()
  host.refresh()
  host.refresh()
  assert.equal(host.seam.sections.length, 1, 'unchanged facts re-use the declaration')
  assert.equal(host.seam.disposals, 0)
  await host.fiber.dispose()
})

test('a changed account list re-registers, withdrawing the previous section first', async () => {
  const host = await mount()
  host.slots.push({ id: 'COMMANDCODE_API_KEY_2', label: 'Backup' })
  host.refresh()
  assert.equal(host.seam.disposals, 1, 'the stale declaration is withdrawn')
  assert.equal(host.seam.sections.length, 2)
  assert.deepEqual(
    host.seam.sections[1]?.fields
      .find((entry) => entry.path.join('.') === 'activeAccount')
      ?.options?.map((option) => option.value),
    [ACTIVE_ACCOUNT_AUTO, 'default', 'COMMANDCODE_API_KEY_2'],
  )
  await host.fiber.dispose()
  assert.equal(host.seam.disposals, 2, 'teardown withdraws the live declaration')
})

test('a changed credential reference re-registers the key field', async () => {
  const slots = [{ id: 'default', label: 'Default' }]
  const seam = makeService()
  const ctx = new Context()
  ctx.provide('tuiSettingsSections', seam.service)
  let ref = DEFAULT_REF
  let refresh: (() => void) | undefined
  const fiber = ctx.plugin<Plugin.Function>((pluginCtx: Context) => {
    refresh = applyCommandCodeTuiSettings(pluginCtx, {
      ns: 'llm-commandcode',
      apiKeyRef: () => ref,
      accountSlots: () => slots,
      visibleModels: () => [],
      modelChoices: () => CATALOG,
    })
  }, {})
  await fiber
  assert.equal(
    seam.sections[0]?.fields.find((entry) => entry.secret !== undefined)?.secret?.ref,
    DEFAULT_REF,
  )
  ref = 'COMMANDCODE_API_KEY_WORK'
  refresh?.()
  assert.equal(
    seam.sections[1]?.fields.find((entry) => entry.secret !== undefined)?.secret?.ref,
    'COMMANDCODE_API_KEY_WORK',
  )
  await (fiber as unknown as { dispose: () => Promise<void> }).dispose()
})

test('refresh is inert after teardown', async () => {
  const host = await mount()
  await host.fiber.dispose()
  const declared = host.seam.sections.length
  host.slots.push({ id: 'COMMANDCODE_API_KEY_2', label: 'Backup' })
  host.refresh()
  assert.equal(host.seam.sections.length, declared, 'a torn-down section is not resurrected')
})

test('a rejecting host is contained, not fatal', async () => {
  // A seam that throws on register: the plugin must keep running (the terminal
  // simply shows no Command Code page) and must say so.
  const seam = makeService()
  seam.fail.value = new Error('shadow policy denies mutate in replay-shadow mode')
  const ctx = new Context()
  ctx.provide('tuiSettingsSections', seam.service)
  const spy = spyWarn(ctx)
  let refresh: (() => void) | undefined
  const fiber = ctx.plugin<Plugin.Function>((pluginCtx: Context) => {
    refresh = applyCommandCodeTuiSettings(pluginCtx, {
      ns: 'llm-commandcode',
      apiKeyRef: () => DEFAULT_REF,
      accountSlots: () => [],
      visibleModels: () => [],
      modelChoices: () => CATALOG,
    })
  }, {})
  await fiber
  assert.equal(spy.messages.length, 1)
  assert.match(spy.messages[0] ?? '', /dsh-TUI settings section/)
  assert.match(spy.messages[0] ?? '', /shadow policy/)
  assert.equal(seam.sections.length, 0)
  // A failed declaration must stay retryable: the seam recovers, the next
  // refresh lands the section instead of the plugin staying half-declared.
  seam.fail.value = undefined
  refresh?.()
  assert.equal(seam.sections.length, 1)
  await (fiber as unknown as { dispose: () => Promise<void> }).dispose()
  spy.restore()
})

test('a host without the seam is left alone', async () => {
  const host = await mount({ withService: false })
  assert.equal(host.seam.sections.length, 0)
  assert.equal(host.refresh(), undefined, 'no refresh handle without a seam')
  await host.fiber.dispose()
})

test('a malformed seam is ignored rather than trusted', async () => {
  for (const value of [undefined, null, 42, {}, { register: 'nope' }]) {
    const ctx = new Context()
    ctx.provide('tuiSettingsSections', value)
    let refresh: (() => void) | undefined
    const fiber = ctx.plugin<Plugin.Function>((pluginCtx: Context) => {
      refresh = applyCommandCodeTuiSettings(pluginCtx, {
        ns: 'llm-commandcode',
        apiKeyRef: () => DEFAULT_REF,
        accountSlots: () => [],
        visibleModels: () => [],
      })
    }, {})
    await fiber
    assert.equal(refresh, undefined, `seam ${JSON.stringify(value)} is not usable`)
    await (fiber as unknown as { dispose: () => Promise<void> }).dispose()
  }
})
