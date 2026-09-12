/**
 * English copy for the "Command Code" settings page, and the declaration that
 * merges the page's namespace into the framework's `LocaleNamespaceMap` so
 * `ctx.locale.register` / `ctx.slots.register(..., { locale })` are typed.
 *
 * Only English is registered (the framework's single-locale form). The lookup
 * chain always ends at English, so a harness set to another language falls
 * back to this dictionary rather than showing raw keys — which is what makes
 * the page read English on every locale.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy of the Command Code settings page. */
    'settings.commandcode': SettingsCommandCodeKey
  }
}

/** Dictionary keys of the Command Code settings page. */
export type SettingsCommandCodeKey =
  | 'nav'
  | 'title'
  | 'intro'
  | 'apiKey'
  | 'apiKeyHint'
  | 'apiKeySet'
  | 'apiKeyUnset'
  | 'apiKeyLocked'
  | 'apiBase'
  | 'apiBaseHint'
  | 'workingDir'
  | 'workingDirHint'
  | 'requestTimeoutMs'
  | 'requestTimeoutMsHint'
  | 'streamIdleTimeoutMs'
  | 'streamIdleTimeoutMsHint'
  | 'advancedSettings'
  | 'advancedSettingsHint'
  | 'advancedOverriddenOne'
  | 'advancedOverriddenMany'
  | 'advancedInvalid'
  | 'filterModelsByPlan'
  | 'filterModelsByPlanHint'
  | 'webSearch'
  | 'webSearchHint'
  | 'accountsTitle'
  | 'accountsHint'
  | 'accountAdd'
  | 'accountRemove'
  | 'accountLabel'
  | 'accountKey'
  | 'accountKeyHint'
  | 'accountDefault'
  | 'activeAccount'
  | 'activeAccountAuto'
  | 'activeAccountHint'
  | 'rulesTitle'
  | 'rulesHint'
  | 'rulesEmpty'
  | 'rulesCatalogFailed'
  | 'ruleAdd'
  | 'ruleRemove'
  | 'ruleModel'
  | 'ruleModelPick'
  | 'ruleModelCount'
  | 'ruleAccount'
  | 'ruleHint'
  | 'modelSearchPlaceholder'
  | 'modelSearchEmpty'
  | 'modelStale'
  | 'visibleModelsTitle'
  | 'visibleModelsHint'
  | 'visibleModelsPick'
  | 'visibleModelsCount'
  | 'visibleModelsShowAll'
  | 'visibleModelsStaleHint'
  | 'visibleModelsCleanStale'
  | 'overridden'
  | 'reset'
  | 'invalidNumber'
  | 'numberTooSmall'
  | 'numberTooLarge'
  | 'readOnly'
  | 'unsaved'
  | 'save'
  | 'saving'
  | 'saved'
  | 'saveFailed'
  | 'discard'
  | 'cancel'
  | 'show'
  | 'hide'
  | 'usageTitle'
  | 'usageRefresh'
  | 'usageRefreshing'
  | 'usageLoading'
  | 'usageNoKey'
  | 'usageError'
  | 'usageRequests'
  | 'usageFailed'
  | 'usageSuccessRate'
  | 'usageCost'
  | 'usageTokens'
  | 'usageTokensIn'
  | 'usageTokensOut'
  | 'usageMonthly'
  | 'usagePurchased'
  | 'usageFree'
  | 'usageFiveHour'
  | 'usageWeekly'
  | 'usageExceeded'
  | 'usageReset'
  | 'usagePartial'
  | 'usageKeyClear'
  | 'usageKeyClearStaged'
  | 'usageUndoKeyClear'
  | 'usageKeyInvalid'
  | 'usageKeyInvalidHint'
  | 'usageServiceUnavailable'
  | 'usageServiceUnavailableHint'
  | 'usageNetworkError'
  | 'usageNetworkHint'
  | 'usageUpdated'
  | 'usagePeriodEnd'
  | 'usageActive'
  | 'usageCooldown'
  | 'usageInvalidKey'
  | 'usageUnconfigured'
  | 'updateAvailable'
  | 'updateHint'
  | 'loginTitle'
  | 'loginHintIdle'
  | 'loginButton'
  | 'loginStarting'
  | 'loginWaiting'
  | 'loginOpenLink'
  | 'loginCancel'
  | 'loginSuccess'
  | 'loginUnavailable'
  | 'loginDenied'
  | 'loginTimeout'
  | 'loginInvalidKey'
  | 'loginNetwork'
  | 'loginStoreFailed'
  | 'loginCancelled'
  | 'loginFailedGeneric'
  | 'cardTitle'
  | 'cardRouteActive'
  | 'cardLoadingHint'
  | 'cardRegistrationHint'

export const commandCodeCopy: Record<SettingsCommandCodeKey, string> = {
  nav: 'Command Code',
  title: 'Command Code',
  intro:
    'Configure the Command Code Provider connection. The API key is stored only'
    + ' in the local credential service and never echoed; other fields are written'
    + ' to user settings and take effect on the next request.',
  apiKey: 'API key',
  apiKeyHint: 'Create one in the commandcode.ai console. Saving with this field'
    + ' blank keeps the stored key.',
  apiKeySet: 'Configured',
  apiKeyUnset: 'Not configured',
  apiKeyLocked: 'Key provided by a read-only source',
  apiBase: 'API base URL',
  apiBaseHint: 'Defaults to https://api.commandcode.ai; usually leave as-is.',
  workingDir: 'Working directory',
  workingDirHint: 'Optional. Leave blank to use the process cwd shown as the'
    + ' placeholder; fill in only to pin a specific path.',
  requestTimeoutMs: 'Request timeout (ms)',
  requestTimeoutMsHint: 'Time to wait for the first response byte; default 60000.',
  streamIdleTimeoutMs: 'Stream idle timeout (ms)',
  streamIdleTimeoutMsHint: 'How long a stalled stream is treated as dead; default 300000'
    + ' (deliberately generous — long-thinking models can stay silent for minutes).',
  advancedSettings: 'Advanced',
  advancedSettingsHint: 'Rarely touched options: API base URL, working directory, timeouts, and model filtering.',
  advancedOverriddenOne: '1 customized',
  advancedOverriddenMany: '{count} customized',
  advancedInvalid: 'A number in Advanced settings is not ready to save; expand to fix it.',
  filterModelsByPlan: 'Hide out-of-plan models',
  filterModelsByPlanHint: 'When on, the model picker lists only models your subscription'
    + ' includes; any on-demand credit balance shows the full catalog.',
  webSearch: 'Serve dsh web search with Command Code',
  webSearchHint: 'When on, the model-facing web_search tool is backed by Command Code'
    + ' (same API key and base URL as chat), winning over other search backends.'
    + ' Off hands the selection back to the previous backend (e.g. modsearch)'
    + ' instead of forcing the shipped DeepSeek search.',
  accountsTitle: 'Account rotation',
  accountsHint: 'When the active account hits its usage limit (429) or its key'
    + ' fails (401), requests switch to the next account; when every account is'
    + ' exhausted the error names the earliest window reset.',
  accountAdd: 'Add account',
  accountRemove: 'Remove',
  accountLabel: 'Account label',
  accountKey: 'API key',
  accountKeyHint: 'This account’s API key. Saving with the field blank keeps the stored key.',
  accountDefault: 'Default account',
  activeAccount: 'Active account',
  activeAccountAuto: 'Auto (first usable account)',
  activeAccountHint: 'Pin the preferred account; applies to the next request after saving.'
    + ' If the selected account is exhausted, requests still rotate to another usable account.',
  rulesTitle: 'Route models to accounts',
  rulesHint: 'Pick models (multi-select) and route them to an account. When the'
    + ' request’s model is in a rule and that account is usable, it serves;'
    + ' an exhausted or invalid routed account falls back to the normal rotation.'
    + ' Rules match in list order — the first hit wins.',
  rulesEmpty: 'No rules yet.',
  rulesCatalogFailed: 'Could not load the model catalog — selecting models is unavailable; saved rules still apply.',
  ruleAdd: 'Add rule',
  ruleRemove: 'Remove',
  ruleModel: 'Models',
  ruleModelPick: 'Select models…',
  ruleModelCount: '{count} model(s) selected',
  ruleAccount: 'Target account',
  ruleHint: 'Check the models to route from the dropdown (multi-select), then pick the target account.',
  modelSearchPlaceholder: 'Search models…',
  modelSearchEmpty: 'No matching models.',
  modelStale: 'Retired',
  visibleModelsTitle: 'Model allowlist',
  visibleModelsHint:
    'Check the models you want to keep, and model pickers will list only those. '
    + 'If nothing is checked, every model is shown. After saving, the change '
    + 'applies the next time you open a model picker.',
  visibleModelsPick: 'Select models to keep…',
  visibleModelsCount: '{count} model(s) selected',
  visibleModelsShowAll: 'Show all',
  visibleModelsStaleHint: '{count} selected model(s) are no longer in the catalog (possibly retired);'
    + ' other models are unaffected. Clean them up or keep them.',
  visibleModelsCleanStale: 'Clean stale ({count})',
  overridden: 'Overridden',
  reset: 'Reset',
  invalidNumber: 'Invalid number',
  numberTooSmall: 'Must be at least 1 (ms)',
  numberTooLarge: 'Above the allowed maximum (2147483647 ms)',
  readOnly: 'Settings are read-only.',
  unsaved: 'Unsaved',
  save: 'Save',
  saving: 'Saving',
  saved: 'Saved ✓',
  saveFailed: 'Save failed, please retry.',
  discard: 'Discard',
  cancel: 'Cancel',
  show: 'Show',
  hide: 'Hide',
  usageTitle: 'Account usage',
  usageRefresh: 'Refresh',
  usageRefreshing: 'Refreshing…',
  usageLoading: 'Fetching account usage…',
  usageNoKey: 'Configure an API key to see this account’s usage and credit state here.',
  usageError: 'Could not fetch usage',
  usageRequests: 'Requests',
  usageFailed: 'failed',
  usageSuccessRate: 'Success rate',
  usageCost: 'Spend',
  usageTokens: 'Tokens',
  usageTokensIn: 'in',
  usageTokensOut: 'out',
  usageMonthly: 'Monthly',
  usagePurchased: 'Purchased',
  usageFree: 'Free',
  usageFiveHour: '5-hour window',
  usageWeekly: 'Weekly window',
  usageExceeded: 'Exceeded',
  usageReset: 'Resets',
  usagePartial: 'Some endpoint data unavailable',
  usageKeyClear: 'Clear stored key',
  usageKeyClearStaged: 'Will be cleared on save',
  usageUndoKeyClear: 'Undo clear',
  usageKeyInvalid: 'API key invalid or expired',
  usageKeyInvalidHint: 'The server rejects every request (401). Check the key configured for this account, or generate a new one in the commandcode.ai console.',
  usageServiceUnavailable: 'The Command Code service is temporarily unavailable',
  usageServiceUnavailableHint: 'The server returned errors (5xx); try Refresh again later.',
  usageNetworkError: 'Could not reach the Command Code service',
  usageNetworkHint: 'No request reached the server. Check your network connection or the API base setting.',
  usageUpdated: 'Updated',
  usagePeriodEnd: 'Period ends',
  usageActive: 'Active',
  usageCooldown: 'Cooling down',
  usageInvalidKey: 'Invalid key',
  usageUnconfigured: 'No API key configured for this account yet.',
  updateAvailable: 'update available',
  updateHint: 'A newer version has been published; click for release notes. The notice disappears once the plugin is updated.',
  loginTitle: 'Sign in to fetch a key',
  loginHintIdle: 'Rather not create a key by hand? Sign in and your browser opens the commandcode.ai authorization page; the approved key is stored in the local credential service and applies to the next request.',
  loginButton: 'Sign in to Command Code',
  loginStarting: 'Starting the local callback server…',
  loginWaiting: 'Waiting for authorization in your browser…',
  loginOpenLink: 'Open the authorization page ↗',
  loginCancel: 'Cancel sign-in',
  loginSuccess: 'Signed in as',
  loginUnavailable: 'Sign-in is unavailable in this environment; paste the API key instead.',
  loginDenied: 'Authorization was denied. Try again or paste the key manually.',
  loginTimeout: 'Timed out waiting for the authorization callback; try again.',
  loginInvalidKey: 'The delivered key failed validation (401). Try again or paste it manually.',
  loginNetwork: 'Could not reach the Command Code service to validate the key; check your network and retry.',
  loginStoreFailed: 'The key could not be stored in the local credential service; paste it manually.',
  loginCancelled: 'Sign-in cancelled.',
  loginFailedGeneric: 'Sign-in failed; try again or paste the key manually.',
  cardTitle: 'Command Code',
  cardRouteActive: 'Active',
  cardLoadingHint: 'Loading the Command Code configuration…',
  cardRegistrationHint: 'This card is contributed by the Command Code plugin; a newer DeepSeek Harness is needed to show the full controls.',
}
