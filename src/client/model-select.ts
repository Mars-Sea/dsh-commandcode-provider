/**
 * Model-select helpers for the settings page's model editors (browser half).
 *
 * The routing-rule editor and the visible-models filter both pick catalog
 * models through the same checkbox multi-select dropdown (`ModelMultiSelect`
 * in section.tsx). The dropdown's data shaping — search filtering, stale-id
 * detection, tier grouping — lives here, React-free, so node tests can drive
 * it directly.
 *
 * Dependency-free by design: the client bundle may only import platform/seed
 * modules, so the plan snapshot below is a deliberately small vendored copy
 * (tier key → heading label) rather than an import of src/capabilities.ts.
 * When upstream adds a plan tier, extend BOTH tables.
 *
 * @module dsh-commandcode-provider/model-select
 */

/**
 * Minimum plan tier → dropdown section heading. Mirrors the Host-side
 * `KNOWN_PLANS` values + `PLAN_LABELS` in src/capabilities.ts (kept as a
 * vendored copy because the client bundle cannot import host modules).
 * Covers every tier key `KNOWN_PLANS` uses today; an unknown tier key falls
 * back to the raw key rather than vanishing the row.
 */
const TIER_HEADINGS: Readonly<Record<string, string>> = {
  go: 'Go',
  goat: 'GOAT',
  pro: 'Pro',
  provider: 'Provider',
  max: 'Max',
}

/**
 * The dropdown section heading for a catalog model id, or undefined for
 * models outside the known plan tiers (unmapped models and stale ids render
 * unheaded). `knownPlans` is the Host-side `KNOWN_PLANS` table, threaded in
 * by the caller so this module stays dependency-free.
 */
export function tierHeadingFor(
  modelId: string,
  knownPlans: Readonly<Record<string, string>>,
): string | undefined {
  const tier = knownPlans[modelId]
  if (tier === undefined) return undefined
  return TIER_HEADINGS[tier] ?? tier
}

/** One selectable catalog model (mirrors `CatalogModelOption` in settings.ts). */
export interface SelectableModel {
  /** Catalog model id (e.g. `deepseek/deepseek-v4-pro`). */
  id: string
  /** Display name from the catalog. */
  name: string
}

/** One dropdown row: a live catalog model or a stale selection. */
export interface ModelSelectOption {
  /** Catalog model id (stale ids keep their raw id as the value). */
  value: string
  /** Display name (stale ids fall back to the raw id). */
  label: string
  /** True when the id is selected but the catalog no longer carries it. */
  stale: boolean
}

/** One dropdown section: a plan-tier heading plus its rows. */
export interface ModelSelectGroup {
  /** Section heading, or undefined for models outside the known plan tiers. */
  heading: string | undefined
  /** Rows in this section, in picker order. */
  options: ModelSelectOption[]
}

/**
 * Whether `text` matches `query` as a case-insensitive substring over the
 * model id AND display name. An empty/blank query matches everything.
 */
export function matchesModelQuery(
  model: SelectableModel,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  return model.id.toLowerCase().includes(needle)
    || model.name.toLowerCase().includes(needle)
}

/**
 * Build the dropdown options: the catalog (already in picker order) plus
 * any selected ids the catalog no longer carries, flagged stale so the UI
 * can mark them — a saved selection never silently loses an entry, and the
 * user can see which ones went stale upstream.
 *
 * When `query` is non-blank, catalog rows are filtered by
 * {@link matchesModelQuery}; stale rows are kept only while they match too,
 * so a search for a live model does not surface unrelated stale ids.
 */
export function buildModelSelectOptions(
  catalog: readonly SelectableModel[],
  selected: readonly string[],
  query = '',
): ModelSelectOption[] {
  const catalogIds = new Set(catalog.map((model) => model.id))
  const options = catalog
    .filter((model) => matchesModelQuery(model, query))
    .map((model) => ({ value: model.id, label: model.name, stale: false }))
  // Dedupe defensively (order-preserving): hand-edited settings can repeat
  // or blank an id, and duplicate Menu ids would confuse selection state.
  const seen = new Set(catalogIds)
  for (const id of selected) {
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    if (catalogIds.has(id)) continue
    if (!matchesModelQuery({ id, name: id }, query)) continue
    options.push({ value: id, label: id, stale: true })
  }
  return options
}

/**
 * Group dropdown options under plan-tier headings (`tierOf` maps a model id
 * to its tier heading, or undefined for unmapped models — see
 * {@link tierHeadingFor}). Live rows keep their relative order; stale ids
 * and unmapped live rows share one trailing unheaded group. Groups merge
 * repeats, so a catalog interleaving two tiers still renders one section
 * per tier.
 */
export function groupModelSelectOptions(
  options: readonly ModelSelectOption[],
  tierOf: (modelId: string) => string | undefined,
): ModelSelectGroup[] {
  const groups: ModelSelectGroup[] = []
  const byHeading = new Map<string | undefined, ModelSelectGroup>()
  for (const option of options) {
    // Stale ids always render unheaded (their tier is unknowable); unmapped
    // live rows join the same trailing group so `heading: undefined`
    // appears at most once.
    const heading = option.stale ? undefined : tierOf(option.value)
    let group = byHeading.get(heading)
    if (group === undefined) {
      group = { heading, options: [] }
      byHeading.set(heading, group)
      groups.push(group)
    }
    group.options.push(option)
  }
  return groups
}

/**
 * Toggle one model id in a selection: remove it when present, append it
 * when absent (append keeps catalog order irrelevant — the picker re-sorts
 * by plan tier on render).
 */
export function toggleModelSelection(
  selected: readonly string[],
  modelId: string,
): string[] {
  return selected.includes(modelId)
    ? selected.filter((value) => value !== modelId)
    : [...selected, modelId]
}

/** The catalog facts the visible-models card reads (mirrors `SettingsPageState`). */
export interface CatalogReadiness {
  /** Catalog model ids the Host reported (`[]` before the first fetch lands). */
  catalogIds: readonly string[]
  /** Whether the catalog fetch failed (or the Remote is unavailable). */
  catalogFailed: boolean
}

/**
 * Whether the catalog is trustworthy enough to call an unlisted selection
 * "retired". FALSE while the first fetch is still in flight and after a
 * failure, because the catalog is empty then and every selected id would look
 * stale — which turns the one-click stale cleanup into a button that silently
 * empties the allowlist. A successfully loaded but empty catalog is treated as
 * untrustworthy too: an empty list is far more likely a Host problem than every
 * model being retired at once, and the explicit "show all" entry covers the
 * user who really wants to clear the list.
 */
export function catalogIsReady(readiness: CatalogReadiness): boolean {
  return readiness.catalogIds.length > 0 && !readiness.catalogFailed
}

/**
 * Selected ids the loaded catalog no longer carries, in selection order.
 * Callers gate user-visible "stale" affordances on {@link catalogIsReady} —
 * the list itself is informational.
 */
export function staleModelIds(
  selected: readonly string[],
  readiness: CatalogReadiness,
): string[] {
  const catalogIds = new Set(readiness.catalogIds)
  return selected.filter((id) => !catalogIds.has(id))
}
