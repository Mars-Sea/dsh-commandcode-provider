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
 * @module dsh-commandcode-provider/tui-settings
 */

import type { Context } from '@deepseek-ai/cordis'

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

/** The selector value meaning "no language override — follow the shell locale". */
export const LANG_AUTO = 'auto'

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
}

/**
 * Build the section descriptor. Pure, so tests can pin the exact fields
 * without a dsh-TUI host.
 *
 * Field choices worth keeping: the two option-bearing fields (`activeAccount`,
 * `lang`) are `text` + `options` rather than `select`, because a `select`
 * cannot express "unset" — cycling only ever lands on a declared option, so a
 * `select` would strand the user on a pinned value with no way back to
 * automatic. The `auto` sentinel plus a `parse` that clears the path keeps the
 * unset state reachable. The two booleans format their EFFECTIVE default
 * (`filterModelsByPlan` unset means true at the adapter), so a fresh install
 * reads true instead of the screen's "(empty)".
 */
export function buildCommandCodeTuiSection(
  deps: CommandCodeTuiSettingsDeps,
): TuiSettingsSection {
  const ref = deps.apiKeyRef()
  const slots = deps.accountSlots()
  return {
    ns: deps.ns,
    title: deps.title ?? 'Command Code',
    descriptions: { zh: 'Command Code（非官方）' },
    groups: [
      { id: 'connection', title: 'Connection', descriptions: { zh: '连接' } },
      { id: 'models', title: 'Models', descriptions: { zh: '模型' } },
      { id: 'advanced', title: 'Advanced', descriptions: { zh: '高级' } },
    ],
    fields: [
      {
        path: ['apiKey'],
        group: 'connection',
        kind: 'text',
        label: 'API key',
        descriptions: { zh: 'API 密钥' },
        secret: { ref },
        hint: `Stored in the credential store as ${ref}, never in settings.yaml.`,
        hintDescriptions: { zh: `保存在凭据库（${ref}），不会写入 settings.yaml。` },
      },
      {
        path: ['apiBase'],
        group: 'connection',
        kind: 'text',
        label: 'API base',
        descriptions: { zh: 'API 地址' },
        placeholder: 'https://api.commandcode.ai',
        hint: 'Leave empty for the public Command Code Provider API.',
        hintDescriptions: { zh: '留空即使用官方 Command Code Provider API。' },
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
        descriptions: { zh: '隐藏套餐外的模型' },
        hint: 'Keeps models above your subscription tier out of the picker. Fails open.',
        hintDescriptions: { zh: '在选择器里隐藏超出当前订阅档位的模型；判断不出来时全部显示。' },
        // Unset means "filter" at the adapter, so render the effective default
        // rather than letting the raw boolean format report an empty value.
        format: (value) => (value === false ? 'false' : 'true'),
        parse: (text) => ({ kind: 'set', value: text.trim() === 'true' }),
      },
      {
        path: ['visibleModels'],
        group: 'models',
        kind: 'text',
        label: 'Visible models',
        descriptions: { zh: '显示的模型' },
        hint: 'Comma-separated catalog ids; empty shows every model.',
        hintDescriptions: { zh: '以逗号分隔的模型 id；留空表示显示全部模型。' },
        format: (value) => (Array.isArray(value)
          ? value.filter((id): id is string => typeof id === 'string' && id !== '')
          : []
        ).join(', '),
        parse: (text) => {
          const ids = text.split(',').map((id) => id.trim()).filter((id) => id !== '')
          return ids.length === 0 ? { kind: 'clear' } : { kind: 'set', value: ids }
        },
      },
      {
        path: ['activeAccount'],
        group: 'advanced',
        kind: 'text',
        label: 'Active account',
        descriptions: { zh: '当前账号' },
        hint: 'A pinned account id, or auto to follow the rotation order.',
        hintDescriptions: { zh: '固定使用某个账号的 id；auto 表示按轮换顺序自动选择。' },
        options: [
          {
            value: ACTIVE_ACCOUNT_AUTO,
            label: 'Automatic (rotation order)',
            descriptions: { zh: '自动（按轮换顺序）' },
          },
          ...slots.map((slot) => ({
            value: slot.id,
            label: slot.label,
            descriptions: { zh: slot.label },
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
      {
        path: ['lang'],
        group: 'advanced',
        kind: 'text',
        label: 'Command language',
        descriptions: { zh: '命令语言' },
        hint: 'Language of the /commandcode dashboard; auto follows the shell locale.',
        hintDescriptions: { zh: '/commandcode 用量面板的语言；auto 跟随终端 locale。' },
        options: [
          { value: LANG_AUTO, label: 'Automatic (shell locale)', descriptions: { zh: '自动（跟随终端 locale）' } },
          { value: 'zh', label: '中文' },
          { value: 'en', label: 'English' },
        ],
        format: (value) => (value === 'zh' || value === 'en' ? value : LANG_AUTO),
        parse: (text) => {
          const trimmed = text.trim()
          return trimmed === '' || trimmed === LANG_AUTO
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
 * credential reference behind the API-key field and the account slots behind
 * the active-account selector. Re-registration is skipped while this matches,
 * so ordinary settings writes never churn the screen's section list.
 */
function sectionSignature(section: TuiSettingsSection): string {
  const active = section.fields.find((field) => field.path.join('.') === 'activeAccount')
  return JSON.stringify({
    secret: section.fields.find((field) => field.secret !== undefined)?.secret?.ref ?? '',
    options: active?.options?.map((option) => option.value) ?? [],
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
