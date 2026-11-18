/**
 * Which of the settings page's four top-level groups are expanded, and where
 * that is remembered (决策记录第十章第4条).
 *
 * Accounts opens by default and the other three start folded, so the page's
 * first screen is the account list plus three one-line summaries. Whatever the
 * user then opens or folds is kept per browser profile in ONE `localStorage`
 * key holding all four flags: a group added or renamed later simply falls back
 * to its default, so no migration is ever needed. This is view state only — it
 * never enters the settings document and is not synced through the profile.
 *
 * Pure functions plus a storage adapter, so `tests/group-fold.test.ts` can pin
 * the parsing and fallbacks without a DOM.
 *
 * @module dsh-commandcode-provider/client/group-fold
 */

/** The page's foldable groups, in page order. */
export type FoldGroup = 'accounts' | 'models' | 'context' | 'advanced'
export const FOLD_GROUPS: readonly FoldGroup[] = ['accounts', 'models', 'context', 'advanced']

/** Expanded flag per group. */
export type FoldState = Readonly<Record<FoldGroup, boolean>>

/** First visit: only Accounts open. */
export const DEFAULT_FOLD_STATE: FoldState = {
  accounts: true,
  models: false,
  context: false,
  advanced: false,
}

/** The `localStorage` key holding the serialized {@link FoldState}. */
export const FOLD_STATE_KEY = '@mars-sea/dsh-commandcode-provider/settings-fold'

/**
 * Read a stored value back. Anything unusable — absent, not JSON, not an
 * object — yields the defaults; within an object, each group takes its stored
 * flag only when it is a real boolean, so a partial or older record keeps the
 * groups it knows and defaults the rest.
 */
export function parseFoldState(raw: string | null | undefined): FoldState {
  if (raw === null || raw === undefined || raw === '') return DEFAULT_FOLD_STATE
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return DEFAULT_FOLD_STATE
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return DEFAULT_FOLD_STATE
  const record = parsed as Record<string, unknown>
  const next = { ...DEFAULT_FOLD_STATE }
  for (const group of FOLD_GROUPS) {
    const value = record[group]
    if (typeof value === 'boolean') next[group] = value
  }
  return next
}

/** Open the given groups, leaving the rest as they are (the save bar's locate action). */
export function expandGroups(state: FoldState, groups: readonly FoldGroup[]): FoldState {
  if (groups.every((group) => state[group])) return state
  const next = { ...state }
  for (const group of groups) next[group] = true
  return next
}

/** Where the fold state lives; injectable so tests need no browser. */
export interface FoldStateStore {
  read(): FoldState
  write(state: FoldState): void
}

/**
 * A {@link FoldStateStore} backed by `localStorage`. A missing or throwing
 * storage (private mode, blocked site data) reads as the defaults and drops
 * writes: the page must render the same either way.
 */
export function localStorageFoldStore(
  storage: Storage | undefined = typeof localStorage === 'undefined' ? undefined : localStorage,
): FoldStateStore {
  return {
    read(): FoldState {
      if (storage === undefined) return DEFAULT_FOLD_STATE
      try {
        return parseFoldState(storage.getItem(FOLD_STATE_KEY))
      } catch {
        return DEFAULT_FOLD_STATE
      }
    },
    write(state: FoldState): void {
      if (storage === undefined) return
      try {
        storage.setItem(FOLD_STATE_KEY, JSON.stringify(state))
      } catch {
        // Quota/private-mode failures must never break the page.
      }
    },
  }
}
