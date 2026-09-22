/**
 * Stylesheet for the Command Code settings page — and the Models-page provider
 * card, which shares its `cc-` classes.
 *
 * Returned as a string rather than injected here so the modules stay free of
 * DOM side effects at import time: `./index.ts` installs it once, keyed by
 * `PAGE_CSS_ID`. It is a module of its own rather than a literal inside the
 * client entry so `tests/styles.test.ts` can audit every rule without importing
 * the React tree (which pulls `*.module.css` through the primitives package and
 * needs a loader registered first).
 *
 * Every colour comes from a harness theme alias with a neutral fallback, so the
 * page follows the active theme (light/dark and any brand pack) without
 * hardcoded values. Classes are `cc-` prefixed to stay clear of the panel's
 * `ccp-` set.
 *
 * @module dsh-commandcode-provider/client/page-styles
 */

/**
 * Stylesheet id (the `data-plugin-css` value that makes injection idempotent).
 *
 * The package prefix must match the one the panel stylesheet uses
 * (`PANEL_CSS_ID` in `./panel-styles.ts`) and this package's real name: an id is
 * the injection's identity, so a stale fork prefix would let a second copy of
 * the plugin inject the same rules twice and would misreport the owner in the
 * DOM. The two ids must also stay distinct from each other — they key two
 * separate style tags, and a shared id would make the second injection a no-op
 * that silently drops one stylesheet.
 */
export const PAGE_CSS_ID = '@mars-sea/dsh-commandcode-provider/CommandCodeSettingsPage.module.css'

/** The settings-page stylesheet. */
export const PAGE_CSS = `
.cc-section{max-width:720px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}
.cc-title{margin:0;font-size:18px;font-weight:600}
.cc-intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;line-height:1.5}
.cc-readOnly{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}
.cc-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:4px 16px}
.cc-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}
.cc-field+.cc-field{border-top:1px solid var(--dsw-alias-border-l2)}
.cc-fieldHead{align-items:center;gap:8px;display:flex}
.cc-label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}
.cc-badges{align-items:center;gap:8px;display:inline-flex}
.cc-badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.cc-badgeMuted{white-space:nowrap;color:var(--dsw-alias-label-tertiary);border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px}
.cc-reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}
.cc-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.cc-reset:disabled{cursor:default;opacity:.5}
.cc-input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}
.cc-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.cc-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
/* The routing-rule model multi-select: a button trigger that opens an
 * anchored Menu of checkbox rows. The trigger mirrors .cc-input sizing so it
 * sits flush with the sibling account select. */
.cc-ruleTrigger{align-items:center;gap:8px;display:flex;width:100%;text-align:left;cursor:pointer}
.cc-ruleTrigger:disabled{cursor:default}
.cc-ruleTriggerText{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cc-ruleCaret{flex-shrink:0;border-right:1.5px solid var(--dsw-alias-label-tertiary);border-bottom:1.5px solid var(--dsw-alias-label-tertiary);width:6px;height:6px;margin-right:4px;margin-bottom:2px;transform:rotate(45deg)}
.cc-checkRow{align-items:center;gap:8px;display:inline-flex;min-width:0}
.cc-checkRow:hover{cursor:pointer}
.cc-check{appearance:none;flex-shrink:0;width:15px;height:15px;margin:0;border:1px solid var(--dsw-alias-border-l2);border-radius:4px;background:var(--dsw-alias-bg-layer-1);position:relative}
.cc-check:checked{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.cc-check:checked::after{content:'';position:absolute;top:2px;left:5px;width:3px;height:7px;border:solid #fff;border-width:0 1.5px 1.5px 0;transform:rotate(45deg)}
.cc-checkName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* The model multi-select search box: stacked under the trigger while the
 * dropdown is open, same input sizing so the pair reads as one control. The
 * box lives inside the Menu anchor (which renders inside the Menu's root
 * span), so focusing/typing it never trips the Menu's outside-click close. */
.cc-modelSelectAnchor{flex-direction:column;gap:6px;display:flex;width:100%}
.cc-modelSearch{width:100%}
.cc-modelSearch::-webkit-search-cancel-button{cursor:pointer}
/* Selects need their own treatment to sit flush with the text inputs:
 * the UA stylesheet renders <select> border-box (34px total vs the inputs'
 * 36px) and forces its own menulist text metrics, so drop the native
 * chrome entirely (appearance:none), restore content-box so the outer box
 * matches the inputs again, and draw the chevron ourselves. Longhand
 * background-* only — the shorthand would reset .cc-input's background. */
select.cc-input{appearance:none;-webkit-appearance:none;-moz-appearance:none;box-sizing:content-box;padding-right:32px;background-image:url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='7' viewBox='0 0 12 7'%3E%3Cpath d='M1 1l5 5 5-5' fill='none' stroke='%23888f98' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 11px center}
.cc-inputInvalid{border-color:var(--dsw-alias-label-error)}
.cc-invalid{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}
/* The Advanced card: its header row is one full-width toggle button; the
 * chevron is two borders on a rotated square (no icon dependency). */
.cc-advancedHead{align-items:center;gap:8px;display:flex;width:100%;padding:12px 0;background:0 0;border:none;cursor:pointer;font:inherit;text-align:left}
.cc-advancedHead:hover .cc-advancedTitle{color:var(--dsw-alias-label-primary)}
.cc-advancedTitle{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5}
.cc-advancedSpacer{flex:1}
.cc-chevron{flex-shrink:0;border-right:1.5px solid var(--dsw-alias-label-tertiary);border-bottom:1.5px solid var(--dsw-alias-label-tertiary);width:8px;height:8px;margin-right:4px;margin-bottom:2px;transform:rotate(45deg);transition:transform .15s ease}
.cc-chevronUp{transform:rotate(-135deg);margin-bottom:-3px}
.cc-advancedBody{flex-direction:column;display:flex}
.cc-advancedBody>.cc-field:first-of-type{border-top:1px solid var(--dsw-alias-border-l2)}
.cc-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}
.cc-footer{justify-content:flex-end;align-items:center;gap:8px;display:flex}
.cc-toggleRow{align-items:center;gap:8px;cursor:pointer;display:flex}
.cc-toggleRow:has(.cc-toggle:disabled){cursor:default}
.cc-toggle{appearance:none;flex-shrink:0;background:var(--dsw-alias-border-l2);border-radius:999px;width:30px;height:18px;margin:0;cursor:pointer;position:relative;transition:background .15s ease}
.cc-toggle:checked{background:var(--dsw-alias-brand-primary)}
.cc-toggle::after{content:'';background:#fff;border-radius:50%;width:14px;height:14px;position:absolute;top:2px;left:2px;transition:left .15s ease}
.cc-toggle:checked::after{left:14px}
.cc-toggle:disabled{cursor:default;opacity:.5}
.cc-failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}
.cc-usageCard{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:14px 16px;flex-direction:column;gap:12px;display:flex}
.cc-usageHead{align-items:center;gap:8px;display:flex}
.cc-usageTitle{color:var(--dsw-alias-label-primary);flex:1;margin:0;font-size:13px;font-weight:600;line-height:1.5}
.cc-usageAccount{max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.cc-usagePlan{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-brand-primary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:600;line-height:17px}
.cc-usagePlanStatus{white-space:nowrap;color:var(--dsw-alias-label-error);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.cc-usageRefresh{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}
.cc-usageRefresh:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.cc-usageRefresh:disabled{cursor:default;opacity:.5}
.cc-usageHint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}
.cc-usageError{align-items:center;gap:8px;color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5;display:flex}
.cc-usageStats{grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;display:grid}
.cc-usageStat{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:8px;padding:8px 10px;flex-direction:column;gap:2px;display:flex}
.cc-usageStatLabel{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5}
.cc-usageStatValue{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.cc-usageStatSub{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5}
.cc-usageWindows{flex-direction:column;gap:16px;display:flex}
.cc-usageWindow{flex-direction:column;gap:6px;display:flex}
.cc-usageWindowHead{align-items:baseline;gap:8px;display:flex}
.cc-usageWindowLabel{color:var(--dsw-alias-label-secondary);flex:1;font-size:12px;font-weight:500;line-height:1.5}
.cc-usageWindowValue{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:500;line-height:1.5}
.cc-usageExceeded{color:var(--dsw-alias-label-error);font-size:11px;font-weight:500;line-height:1.5}
.cc-usageBar{overflow:hidden;background:var(--dsw-alias-bg-layer-1);border-radius:999px;height:6px}
.cc-usageBarFill{background:var(--dsw-alias-brand-primary);border-radius:999px;height:100%;transition:width .3s ease}
.cc-usageBarFillWarn{background:var(--dsw-alias-label-error)}
@media (prefers-reduced-motion:reduce){.cc-chevron,.cc-toggle,.cc-toggle::after,.cc-usageBarFill{transition:none}}.cc-usageWindowReset{color:var(--dsw-alias-label-tertiary);margin:0;font-size:11px;line-height:1.5}
.cc-usageMeta{align-items:center;gap:8px;display:flex}
.cc-accountReport{flex-direction:column;gap:12px;display:flex}
.cc-tabs{flex-wrap:wrap;gap:6px;display:flex}
.cc-tab{align-items:center;font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:2px 10px;font-size:12px;line-height:18px;display:inline-flex;gap:6px}
.cc-tab:hover:not(.cc-tabActive){color:var(--dsw-alias-label-primary)}
.cc-tabActive{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary)}
.cc-tabDotOk{background:var(--dsw-alias-brand-primary);border-radius:50%;width:6px;height:6px}
.cc-tabDotWarn{background:#d97706;border-radius:50%;width:6px;height:6px}
.cc-tabDotError{background:var(--dsw-alias-label-error);border-radius:50%;width:6px;height:6px}
.cc-usageMetaSpacer{flex:1}
.cc-usageUpdated{color:var(--dsw-alias-label-tertiary);margin:0;font-size:11px;line-height:1.5}
.cc-usagePartial{color:var(--dsw-alias-label-error);margin:0;font-size:11px;line-height:1.5}
.cc-usageBlocked{border:1px solid var(--dsw-alias-label-error);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:4px}
.cc-usageBlockedTitle{color:var(--dsw-alias-label-error);margin:0;font-size:13px;font-weight:600;line-height:1.5}
.cc-usageBlockedHint{color:var(--dsw-alias-label-secondary);margin:0;font-size:12px;line-height:1.5}
.cc-usageBlockedDetail{color:var(--dsw-alias-label-secondary);margin:0;font-size:11px;line-height:1.5;word-break:break-word;opacity:.85}
.cc-version{margin:4px 0 0;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
/* The Models-page provider panel root: unstyled by design — the row card the
 * Models page owns supplies the surface, the panel only stacks its controls. */
.cc-providerCard{flex-direction:column;display:flex}
/* The update hint rides the footer version line: warning-tinted (with a
 * muted fallback for themes without the alias), quiet until hovered. */
.cc-versionLink{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary));text-decoration:none}
.cc-versionLink:hover{color:var(--dsw-alias-label-primary);text-decoration:underline;text-underline-position:under}
/* The login panel rides the connection card as one more field row; the
 * authorization link is the only branded element on it. */
.cc-loginLink{color:var(--dsw-alias-brand-primary);text-decoration:none;font-size:12px;line-height:1.5}
.cc-loginLink:hover{text-decoration:underline;text-underline-position:under}
.cc-loginDone{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary))}
.cc-loginError{color:var(--dsw-alias-label-error)}
.cc-saved{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary));margin:0;font-size:12px;font-weight:500;line-height:1.5}
.cc-badgeWarn{background:var(--dsw-alias-state-warning-secondary,var(--dsw-alias-bg-module-platform));color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary))}
`
