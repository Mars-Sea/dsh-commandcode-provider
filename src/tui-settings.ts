/**
 * dsh-TUI settings section (`tuiSettingsSections`).
 *
 * The terminal front door (dsh-TUI) owns its settings screen and asks plugins
 * only to DECLARE what is editable: a section over the plugin's own settings
 * namespace, which the screen renders and writes through the dsh settings
 * service. Without such a declaration a TUI-only user cannot enter the Command
 * Code API key at all — the web Models page is the only surface that writes
 * it, and dsh-TUI's own `/provider` wizard manages its `llm-pi-ai` routes
 * exclusively (issue #28).
 *
 * The seam is third-party, so this module carries LOCAL structural types
 * instead of importing `@deepseek-harness-tui/dsh-tui`: the plugin keeps zero
 * dependency on a terminal front door it may never meet, and an unmeet seam
 * degrades to "no section" rather than to a failed import. Registration rides
 * `ctx.inject(['tuiSettingsSections'], …)` in the plugin entry, so a profile
 * without dsh-TUI never activates the fiber — the same optional-service shape
 * `commands`, `web` and `typert` already use.
 *
 * The API-key field is a **secret** field: dsh-TUI keeps the literal out of
 * the settings document and writes the draft through the credentials seam
 * under the declared reference — the same guarantee the web card provides.
 * The reference must not collide with a host-owned one; dsh-TUI rejects
 * `DEEPSEEK_*`/`DSH_*` refs from plugin sections, and this plugin's default
 * (`COMMANDCODE_API_KEY`) is its own namespace.
 *
 * The model allowlist is a **checkbox per catalog model**, grouped by plan
 * tier — the terminal counterpart of the web page's searchable dropdown, and
 * the reason this page does not ask anyone to type 60+ model ids from memory.
 * dsh-TUI's seam has no multi-select kind (only `text | number | boolean |
 * select`) and no array element path a checkbox could own, so each model is
 * its own `boolean` field that WRITES THE WHOLE ARRAY through its `parse`:
 * the seam lets a field's write carry any value, which is what makes a
 * per-model checkbox express set membership. Two rules keep that honest.
 * (1) `parse` reads the allowlist LIVE through its thunk instead of the value
 * the field was built with, and rebuilds the array from THAT: the screen
 * stages several toggles into one save, so a captured base would let two
 * quick toggles resurrect each other's stale list. (2) An empty allowlist
 * means "show every model" to the adapter, so the checkboxes render the
 * EFFECTIVE set — unset shows everything checked, and checking a box only
 * records an explicit list once something is excluded.
 *
 * @module dsh-commandcode-provider/tui-settings
 */

import type { Context } from '@deepseek-ai/cordis'

import {
  KNOWN_PLANS,
  capabilityDescription,
  isFreeModel,
} from './capabilities.ts'

/** Provider-owned translations for one title, label, or hint. */
export interface TuiLocalizedText {
  readonly zh?: string
  readonly en?: string
}

/** Control kinds the dsh-TUI settings screen knows how to render. */
export type TuiSettingsFieldKind = 'text' | 'number' | 'boolean' | 'select'

/** One choice of an options-bearing field. */
export interface TuiSettingsFieldOption {
  /** Stored value. */
  readonly value: string
  /** Display label (English; also the fallback). */
  readonly label: string
  /** Provider-owned translations for the label. */
  readonly descriptions?: TuiLocalizedText
}

/** The write one field's draft stages when the section is saved. */
export type TuiSettingsFieldWrite =
  | { readonly kind: 'set'; readonly value: unknown }
  | { readonly kind: 'clear' }

/** One editable field inside a section. */
export interface TuiSettingsField {
  /** Key path from the section root, in the settings service's `mutate` vocabulary. */
  readonly path: readonly string[]
  /** Short field label (English; also the fallback). */
  readonly label: string
  /** Provider-owned translations for the label. */
  readonly descriptions?: TuiLocalizedText
  /** Optional one-line help rendered under the field. */
  readonly hint?: string
  /** Provider-owned translations for the hint. */
  readonly hintDescriptions?: TuiLocalizedText
  /** Optional group id; grouped fields render on that group's subpage. */
  readonly group?: string
  readonly kind: TuiSettingsFieldKind
  /**
   * Choices for an options-bearing field. A `text` field that carries options
   * is the TUI's own "preset plus custom value" shape: `←`/`→` cycle the
   * presets while Enter opens the text editor.
   */
  readonly options?: readonly TuiSettingsFieldOption[]
  /** Input placeholder for `kind: 'text' | 'number'`. */
  readonly placeholder?: string
  /**
   * Credential control: the literal never rides the settings document — the
   * draft starts blank on every open, a blank draft writes nothing, and a
   * typed draft writes through the credentials seam under `ref`.
   */
  readonly secret?: { readonly ref: string }
  /** Render a stored value as draft text. */
  readonly format?: (value: unknown) => string
  /** The write a draft text stages; `undefined` marks the draft invalid. */
  readonly parse?: (text: string) => TuiSettingsFieldWrite | undefined
}

/** Optional navigation group inside one section. */
export interface TuiSettingsGroup {
  /** Stable identifier, unique inside the section. */
  readonly id: string
  /** Group title (English; also the fallback). */
  readonly title: string
  /** Provider-owned translations for the title. */
  readonly descriptions?: TuiLocalizedText
}

/** One plugin's section inside the dsh-TUI settings screen. */
export interface TuiSettingsSection {
  /** Settings namespace this section edits. */
  readonly ns: string
  /** Section title (English; also the fallback). */
  readonly title: string
  /** Provider-owned translations for the title. */
  readonly descriptions?: TuiLocalizedText
  /** Optional navigation groups, in display order. */
  readonly groups?: readonly TuiSettingsGroup[]
  /** Editable fields, in display order. */
  readonly fields: readonly TuiSettingsField[]
}

/** The slice of the `tuiSettingsSections` service this module uses. */
export interface TuiSettingsSectionsService {
  /** Declare a section; the returned disposer withdraws it. */
  register(section: TuiSettingsSection): () => void
}

/** The selector value meaning "no pinned account — follow rotation order". */
export const ACTIVE_ACCOUNT_AUTO = 'auto'


/** Tier display names, mirroring the web dropdown's headings (`model-select.ts`). */
const TIER_TITLES: Readonly<Record<string, string>> = {
  go: 'Go',
  goat: 'GOAT',
  pro: 'Pro',
  provider: 'Provider',
  max: 'Max',
}

/** Tiers in picker order; a model outside this set joins the "Other" group. */
const TIER_ORDER: readonly string[] = ['go', 'goat', 'pro', 'provider', 'max']

/** The group holding models this build's catalog does not know. */
const OTHER_GROUP_ID = 'models-other'

/** One catalog model offered as a checkbox. */
export interface TuiModelChoice {
  /** Catalog model id, e.g. `deepseek/deepseek-v4-pro`. */
  readonly id: string
  /** Minimum plan tier key from `KNOWN_PLANS`. */
  readonly tier: string
  /** Whether the model is currently free, so it leads its group. */
  readonly free: boolean
  /** Footer hint for the focused row: plan tier · deal · peak · `Image`. */
  readonly hint: string
}

/**
 * Every model this build knows, in checkbox order: plan tier (Go first), then
 * free before paid inside a tier, then by id.
 *
 * The list is the static capability snapshot rather than a live catalog read
 * on purpose — a settings page must draw synchronously, and the snapshot is
 * synced from the same upstream table the picker's tier headings come from.
 * A model added upstream after this build still reaches the user: an empty
 * allowlist shows everything, and a model named in the allowlist but absent
 * here is rendered by the "Other" group instead of disappearing.
 */
export function commandCodeTuiModelChoices(): readonly TuiModelChoice[] {
  return Object.keys(KNOWN_PLANS)
    .map((id) => ({
      id,
      tier: KNOWN_PLANS[id] ?? '',
      free: isFreeModel(id),
      hint: capabilityDescription(id),
    }))
    .sort((a, b) => {
      const tierDelta = tierRank(a.tier) - tierRank(b.tier)
      if (tierDelta !== 0) return tierDelta
      if (a.free !== b.free) return a.free ? -1 : 1
      return a.id.localeCompare(b.id)
    })
}

/** Sort rank of a tier key; unknown tiers trail every known one. */
function tierRank(tier: string): number {
  const rank = TIER_ORDER.indexOf(tier)
  return rank === -1 ? TIER_ORDER.length : rank
}

/** The stored allowlist as a clean id list (non-strings and blanks dropped). */
function storedIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === 'string' && id !== '')
    : []
}

/** Everything the section needs from the plugin entry. */
export interface CommandCodeTuiSettingsDeps {
  /** The plugin's settings namespace (`llm-commandcode`). */
  ns: string
  /** Section title; defaults to `Command Code`. */
  title?: string
  /**
   * The credential reference the API-key field writes through, read per
   * registration so a `Config.apiKeyEnv` change re-targets the field instead
   * of silently writing to the old reference.
   */
  apiKeyRef: () => string
  /**
   * Account slots for the active-account selector, in rotation order, read
   * per registration. A changed list re-registers the section (see
   * {@link applyCommandCodeTuiSettings}).
   */
  accountSlots: () => readonly { id: string; label: string }[]
  /**
   * The stored model allowlist, read LIVE at save time. A checkbox judges its
   * inherited state against this, so it must be read when the write runs, not
   * captured when the section was registered. An empty list means "every model
   * is visible" (the adapter's rule).
   */
  visibleModels: () => readonly string[]
  /**
   * The per-model override map the checkboxes write, read per registration so
   * ids this build's catalog does not know still get a row of their own. Same
   * live-read rule as {@link visibleModels}.
   */
  modelVisibility?: () => Readonly<Record<string, boolean>> | undefined
  /** The models to offer as checkboxes; defaults to the static snapshot. */
  modelChoices?: () => readonly TuiModelChoice[]
}

/**
 * Build the section descriptor. Pure, so tests can pin the exact fields
 * without a dsh-TUI host.
 *
 * Field choices worth keeping: the option-bearing field (`activeAccount`) is
 * `text` + `options` rather than `select`, because a `select`
 * cannot express "unset" — cycling only ever lands on a declared option, so a
 * `select` would strand the user on a pinned value with no way back to
 * automatic. The `auto` sentinel plus a `parse` that clears the path keeps the
 * unset state reachable. `filterModelsByPlan` formats its EFFECTIVE default
 * (unset means true at the adapter), so a fresh install reads true instead of
 * the screen's "(empty)".
 */
export function buildCommandCodeTuiSection(
  deps: CommandCodeTuiSettingsDeps,
): TuiSettingsSection {
  const ref = deps.apiKeyRef()
  const slots = deps.accountSlots()
  const choices = (deps.modelChoices ?? commandCodeTuiModelChoices)()
  const catalogIds = choices.map((choice) => choice.id)
  const known = new Set(catalogIds)
  // An empty allowlist means "show every model" at the adapter, so an
  // unchecked-for-no-reason model reads as visible. The stored facts are read
  // live by each field, never captured here.
  const stored = storedIds(deps.visibleModels())
  const overrides = deps.modelVisibility?.() ?? {}
  // Models this build's catalog cannot place (retired or renamed upstream, or
  // added after this snapshot) plus stored-but-unknown ids. They get their own
  // group so they stay visible and switchable instead of silently sticking.
  const extras = [...new Set([...stored, ...Object.keys(overrides)])].filter((id) => !known.has(id))

  const tierGroups = TIER_ORDER
    .filter((tier) => choices.some((choice) => choice.tier === tier))
    .map((tier) => ({
      id: `models-${tier}`,
      title: `${TIER_TITLES[tier] ?? tier} models`,
    }))
  // Models this snapshot cannot place (a tier added upstream) share the group
  // with the stored-but-unknown allowlist entries.
  const unranked = choices.filter((choice) => tierRank(choice.tier) === TIER_ORDER.length)
  const otherGroup = unranked.length > 0 || extras.length > 0
    ? [{ id: OTHER_GROUP_ID, title: 'Other models' }]
    : []

  /**
   * One checkbox: a boolean at a path of its OWN (`modelVisibility.<id>`).
   *
   * The path must be unique per model. dsh-TUI keys a staged draft by the
   * field's path (`fieldKey`), so N checkboxes sharing `visibleModels` share
   * ONE draft: every one of them then parses that same draft on save, all N
   * write ops address the same path, and only the LAST field's op survives —
   * which silently rewrote the allowlist from the last catalog model instead
   * of the one that was toggled. A per-model key is what makes a checkbox
   * express one model's state.
   *
   * An override equal to what the array already says is written as a CLEAR, so
   * toggling a model back to its inherited state leaves no residue and the
   * document stays minimal.
   */
  const modelField = (id: string, hint: string, group: string): TuiSettingsField => ({
    path: ['modelVisibility', id],
    group,
    kind: 'boolean',
    label: id,
    ...(hint === '' ? {} : { hint }),
    format: (value) => {
      if (typeof value === 'boolean') return String(value)
      // No override: the model follows the array allowlist, where empty or
      // unset means "everything is visible".
      const listed = storedIds(deps.visibleModels())
      return String(listed.length === 0 || listed.includes(id))
    },
    parse: (text) => {
      const on = text.trim() === 'true'
      // Read the array LIVE, not at registration time: the screen stages a
      // toggle and saves it later, and the inherited state must be judged
      // against what the document holds when the write runs.
      const listed = storedIds(deps.visibleModels())
      const inherited = listed.length === 0 || listed.includes(id)
      return on === inherited ? { kind: 'clear' } : { kind: 'set', value: on }
    },
  })

  return {
    ns: deps.ns,
    title: deps.title ?? 'Command Code',
    groups: [
      { id: 'connection', title: 'Connection' },
      { id: 'models', title: 'Models' },
      ...tierGroups,
      ...otherGroup,
      { id: 'advanced', title: 'Advanced' },
    ],
    fields: [
      {
        path: ['apiKey'],
        group: 'connection',
        kind: 'text',
        label: 'API key',
        secret: { ref },
        hint: `Stored in the credential store as ${ref}, never in settings.yaml.`,
      },
      {
        path: ['apiBase'],
        group: 'connection',
        kind: 'text',
        label: 'API base',
        placeholder: 'https://api.commandcode.ai',
        hint: 'Leave empty for the public Command Code Provider API.',
        parse: (text) => {
          const trimmed = text.trim()
          return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: trimmed }
        },
      },
      {
        path: ['filterModelsByPlan'],
        group: 'models',
        kind: 'boolean',
        label: 'Hide out-of-plan models',
        hint: 'Keeps models above your subscription tier out of the picker. Fails open.',
        // Unset means "filter" at the adapter, so render the effective default
        // rather than letting the raw boolean format report an empty value.
        format: (value) => (value === false ? 'false' : 'true'),
        parse: (text) => ({ kind: 'set', value: text.trim() === 'true' }),
      },
      ...choices
        .filter((choice) => tierRank(choice.tier) !== TIER_ORDER.length)
        .map((choice) => modelField(choice.id, choice.hint, `models-${choice.tier}`)),
      ...unranked.map((choice) => modelField(choice.id, choice.hint, OTHER_GROUP_ID)),
      ...extras.map((id) => modelField(id, capabilityDescription(id), OTHER_GROUP_ID)),
      {
        path: ['activeAccount'],
        group: 'advanced',
        kind: 'text',
        label: 'Active account',
        hint: 'A pinned account id, or auto to follow the rotation order.',
        options: [
          {
            value: ACTIVE_ACCOUNT_AUTO,
            label: 'Automatic (rotation order)',
          },
          ...slots.map((slot) => ({
            value: slot.id,
            label: slot.label,
          })),
        ],
        format: (value) => (typeof value === 'string' && value.trim() !== '' ? value : ACTIVE_ACCOUNT_AUTO),
        parse: (text) => {
          const trimmed = text.trim()
          return trimmed === '' || trimmed === ACTIVE_ACCOUNT_AUTO
            ? { kind: 'clear' }
            : { kind: 'set', value: trimmed }
        },
      },
    ],
  }
}

/**
 * The `tuiSettingsSections` service, read defensively.
 *
 * The service name is declared by dsh-TUI's own module augmentation, which
 * this package deliberately does not import, so the typed `Context` has no
 * such property. The read goes through the REFLECTIVE `ctx.get` rather than a
 * bare property access: cordis refuses a property read for a service the fiber
 * never declared in `inject` (`cannot get property … without inject`), and an
 * unmeet seam must degrade to "no section" instead of throwing out of the
 * plugin's boot.
 */
function tuiSettingsService(ctx: Context): TuiSettingsSectionsService | undefined {
  let candidate: unknown
  try {
    candidate = ctx.get('tuiSettingsSections')
  } catch {
    return undefined
  }
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const register = (candidate as { register?: unknown }).register
  if (typeof register !== 'function') return undefined
  return {
    register: (register as (section: TuiSettingsSection) => () => void)
      .bind(candidate) as TuiSettingsSectionsService['register'],
  }
}

/**
 * Identity of everything in the section that can change at runtime: the
 * credential reference behind the API-key field, the account slots behind the
 * active-account selector, and the stored-but-unknown allowlist entries that
 * get a checkbox of their own. Re-registration is skipped while this matches,
 * so ordinary settings writes never churn the screen's section list — the
 * checkboxes themselves read their state live and need no re-declaration.
 */
function sectionSignature(section: TuiSettingsSection): string {
  const active = section.fields.find((field) => field.path.join('.') === 'activeAccount')
  return JSON.stringify({
    secret: section.fields.find((field) => field.secret !== undefined)?.secret?.ref ?? '',
    options: active?.options?.map((option) => option.value) ?? [],
    // Only this group's membership can change the field LIST: every catalog
    // checkbox reads its own state live, so an ordinary toggle needs no
    // re-declaration.
    other: section.fields
      .filter((field) => field.group === OTHER_GROUP_ID)
      .map((field) => field.label),
  })
}

/**
 * Register the Command Code section on a dsh-TUI host.
 *
 * @param ctx - the context of an activated `tuiSettingsSections` injection.
 * @param deps - plugin-owned facts the section reads.
 * @returns a refresh function that re-registers the section when a fact it
 *   renders changed (the plugin entry calls it from its settings `onChange`
 *   hook), or `undefined` when the seam is unusable. The returned function is
 *   inert after the fiber is torn down.
 */
export function applyCommandCodeTuiSettings(
  ctx: Context,
  deps: CommandCodeTuiSettingsDeps,
): (() => void) | undefined {
  const service = tuiSettingsService(ctx)
  if (service === undefined) return undefined
  let disposed = false
  let current: { signature: string; dispose: () => void } | undefined
  const refresh = (): void => {
    if (disposed) return
    const section = buildCommandCodeTuiSection(deps)
    const signature = sectionSignature(section)
    if (current?.signature === signature) return
    // Withdraw before re-declaring: dsh-TUI keeps one section per namespace,
    // so a second register would otherwise be refused (or shadow the first,
    // depending on the host build) instead of replacing it.
    current?.dispose()
    current = undefined
    try {
      current = { signature, dispose: service.register(section) }
    } catch (error: unknown) {
      // A host that rejects the declaration (a shadow-mode capability policy,
      // a future contract change) must not take the plugin down with it: the
      // terminal simply keeps no Command Code page, and the web page plus
      // settings.yaml stay the fallback.
      ctx.logger?.warn(
        `llm-commandcode: could not register the dsh-TUI settings section: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }
  refresh()
  ctx.effect(() => () => {
    disposed = true
    current?.dispose()
    current = undefined
  }, 'dsh-commandcode-provider: tui settings section')
  return refresh
}
