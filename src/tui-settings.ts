/**
 * dsh-TUI settings section (`tuiSettingsSections`).
 *
 * dsh-TUI owns its settings screen and asks plugins only to DECLARE what is
 * editable. Without a declaration a TUI-only user cannot enter the Command
 * Code API key at all — the web Models page is the only surface that writes
 * it, and dsh-TUI's `/provider` wizard manages its `llm-pi-ai` routes
 * exclusively (issue #28). The seam is third-party, so this module carries
 * LOCAL structural types and reads the service defensively; registration rides
 * the plugin entry's `ctx.inject(['tuiSettingsSections'], …)`, so a profile
 * without dsh-TUI never activates the fiber.
 *
 * The API-key field is a **secret** field: the literal goes to the credentials
 * seam, never into a settings document. Its reference must stay out of the
 * host-reserved namespace (`DEEPSEEK_*`/`DSH_*`) — dsh-TUI silently DROPS a
 * field with a reserved ref, which would leave a page with no key input.
 *
 * The model allowlist is a **checkbox per catalog model**, grouped by plan
 * tier — the terminal counterpart of the web page's searchable dropdown. The
 * seam has no multi-select kind (`text | number | boolean | select`) and no
 * array element path a checkbox could own, so each model is its own `boolean`
 * field at `modelVisibility.<id>` whose `parse` writes its explicit boolean.
 * The format reads the allowlist LIVE so web changes are reflected when the
 * terminal renders. An empty allowlist means "show every model" to the adapter,
 * so the checkboxes render the EFFECTIVE set.
 *
 * @module dsh-commandcode-provider/tui-settings
 */

import type { Context } from '@deepseek-ai/cordis'

import {
  KNOWN_PLANS,
  capabilityDescription,
  isFreeModel,
} from './capabilities.ts'
import { PLAN_LABELS, PLAN_TIER_ORDER } from './plan-tiers.ts'

/** Provider-owned translations for one title, label, or hint. */
export interface TuiLocalizedText {
  readonly zh?: string
  readonly en?: string
}

/** Control kinds the dsh-TUI settings screen knows how to render. */
export type TuiSettingsFieldKind = 'text' | 'number' | 'boolean' | 'select'

/** One choice of an options-bearing field. */
export interface TuiSettingsFieldOption {
  readonly value: string
  /** Display label (English; also the fallback). */
  readonly label: string
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
  readonly descriptions?: TuiLocalizedText
  /** Optional one-line help rendered under the field. */
  readonly hint?: string
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
  readonly descriptions?: TuiLocalizedText
}

/** One plugin's section inside the dsh-TUI settings screen. */
export interface TuiSettingsSection {
  /** Settings namespace this section edits. */
  readonly ns: string
  /** Section title (English; also the fallback). */
  readonly title: string
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

/** Tiers in picker order; a model outside this set joins the "Other" group. */
const TIER_ORDER: readonly string[] = PLAN_TIER_ORDER

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
 * on purpose — a settings page must draw synchronously. A model added
 * upstream after this build still reaches the user: an empty allowlist shows
 * everything, and a model named in the allowlist but absent here is rendered
 * by the "Other" group instead of disappearing.
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
 * The two option-bearing fields (`activeAccount`, `lang`) are `text` +
 * `options` rather than `select`, because a `select` cannot express "unset" —
 * cycling only ever lands on a declared option, so it would strand the user on
 * a pinned value with no way back to automatic. The `auto` sentinel plus a
 * `parse` that clears the path keeps unset reachable. `filterModelsByPlan`
 * formats its EFFECTIVE default (unset means true at the adapter) so a fresh
 * install reads true instead of the screen's "(empty)".
 */
export function buildCommandCodeTuiSection(
  deps: CommandCodeTuiSettingsDeps,
): TuiSettingsSection {
  const ref = deps.apiKeyRef()
  const slots = deps.accountSlots()
  const choices = (deps.modelChoices ?? commandCodeTuiModelChoices)()
  const catalogIds = choices.map((choice) => choice.id)
  const known = new Set(catalogIds)
  const stored = storedIds(deps.visibleModels())
  const overrides = deps.modelVisibility?.() ?? {}
  // Models this build's catalog cannot place (retired, renamed upstream, or
  // added after this snapshot) plus stored-but-unknown ids. They get their own
  // group so they stay visible and switchable instead of silently sticking.
  const extras = [...new Set([...stored, ...Object.keys(overrides)])].filter((id) => !known.has(id))

  const tierGroups = TIER_ORDER
    .filter((tier) => choices.some((choice) => choice.tier === tier))
    .map((tier) => ({
      id: `models-${tier}`,
      title: `${PLAN_LABELS[tier] ?? tier} models`,
      descriptions: { zh: `${PLAN_LABELS[tier] ?? tier} 模型` },
    }))
  // A tier this snapshot cannot place shares the "Other" group above.
  const unranked = choices.filter((choice) => tierRank(choice.tier) === TIER_ORDER.length)
  const otherGroup = unranked.length > 0 || extras.length > 0
    ? [{ id: OTHER_GROUP_ID, title: 'Other models', descriptions: { zh: '其他模型' } }]
    : []

  /**
   * One checkbox: a boolean at a path of its OWN (`modelVisibility.<id>`).
   *
   * The path must be unique per model. dsh-TUI keys a staged draft by the
   * field's path (`fieldKey`), so N checkboxes sharing `visibleModels` share
   * ONE draft: every one of them then parses that same draft on save, all N
   * write ops address the same path, and only the LAST field's op survives —
   * which silently rewrote the allowlist from the last catalog model instead
   * of the one that was toggled. 保存显式布尔值，不能因为与白名单相同就
   * 清除用户层：清除后可能重新露出基础配置中的相反开关。
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
      return { kind: 'set', value: text.trim() === 'true' }
    },
  })

  return {
    ns: deps.ns,
    title: deps.title ?? 'Command Code',
    descriptions: { zh: 'Command Code（非官方）' },
    groups: [
      { id: 'connection', title: 'Connection', descriptions: { zh: '连接' } },
      { id: 'models', title: 'Models', descriptions: { zh: '模型' } },
      ...tierGroups,
      ...otherGroup,
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
        hint: `Stored in the credential store as ${ref}, never in configuration files.`,
        hintDescriptions: { zh: `保存在凭据库（${ref}），不会写入配置文件。` },
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
        path: ['zdr'],
        group: 'advanced',
        kind: 'boolean',
        label: 'Zero data retention (ZDR)',
        descriptions: { zh: '零数据保留（ZDR）' },
        hint: 'Route requests only through upstreams that retain nothing and never'
          + ' train on prompts (the CLI\'s CMD_ZDR=1). Models without an available'
          + ' ZDR upstream fail instead of losing protection; ZDR is usually'
          + ' billed at higher pass-through rates. Off by default.',
        hintDescriptions: {
          zh: '请求只经由不留存数据、也不用于训练的上游（等价于 CLI 的 CMD_ZDR=1）。'
            + '没有可用 ZDR 上游的模型会报错，不会降级为非 ZDR 请求；'
            + 'ZDR 通常按更高的透传价计费。默认关闭。',
        },
        // Off is the shipped default and the safe reading of an unset document.
        format: (value) => (value === true ? 'true' : 'false'),
        parse: (text) => ({ kind: 'set', value: text.trim() === 'true' }),
      },
      {
        path: ['offloadSeenImagesForCache'],
        group: 'advanced',
        kind: 'boolean',
        label: 'Stop replaying images already seen',
        descriptions: { zh: '已看过的图片不再重复发送' },
        hint: 'CLI transport only. After this model has answered, durably replace older images with text to keep later prompt text cacheable. Old pixels need a fresh file read or attachment to inspect again. Off by default.',
        hintDescriptions: { zh: '仅 CLI 传输。模型看过图片并回复后，永久用文字替代旧图，以保留后续文本缓存；重看旧图需要重新读取文件或附加。默认关闭。' },
        format: (value) => (value === true ? 'true' : 'false'),
        parse: (text) => ({ kind: 'set', value: text.trim() === 'true' }),
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
    // Only this group's membership can change the field LIST.
    other: section.fields
      .filter((field) => field.group === OTHER_GROUP_ID)
      .map((field) => field.label),
  })
}

/**
 * Register the Command Code section on a dsh-TUI host.
 *
 * @returns a refresh function that re-registers the section when a fact it
 *   renders changed — the plugin entry calls it from its
 *   `loader/volatile-update` listener — or `undefined` when the seam is
 *   unusable. The returned function is inert after the fiber is torn down.
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
      // A rejecting host (a shadow-mode capability policy, a future contract
      // change) must not take the plugin down: the terminal simply keeps no
      // Command Code page, and the web settings page stays the fallback.
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
