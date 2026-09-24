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

/**
 * The settings-page stylesheet.
 *
 * The metrics are the harness's own settings pages', read out of the 0.1.7
 * bundles so the page sits beside General and Models without looking foreign:
 * a row is 16px of padding over a 0.5px border-l2 hairline, its title 14/22
 * label-primary and its description 12/18 label-tertiary, the control on the
 * right. Selectors and buttons are capsules (36px / 28px compact), inputs are
 * 32px with an 8px radius and a 0.5px border-l4 edge, a card is a 0.5px
 * border-l4 outline with a 16px radius, and a nested panel is a
 * bg-module-platform fill with a 12px radius. Errors use state-error-primary,
 * the platform's error colour (label-error is its text-only sibling).
 */
export const PAGE_CSS = `
.cc-section{max-width:720px;color:var(--dsw-alias-label-primary);flex-direction:column;display:flex}
.cc-title{margin:0;color:var(--dsw-alias-label-primary);font-size:16px;font-weight:500;line-height:24px}
.cc-intro{margin:4px 0 0;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:22px}
.cc-readOnly{margin:8px 0 0;color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-tertiary));font-size:12px;line-height:18px}
.cc-spacer{flex:1}
/* Groups: a heading over hairline-separated rows, no card surface. */
.cc-group{flex-direction:column;display:flex;margin-top:28px}
.cc-groupHead{align-items:center;gap:8px;display:flex;min-height:28px;padding-bottom:4px}
.cc-groupTitle{margin:0;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}
.cc-groupDesc{margin:0 0 12px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.cc-rows>.cc-groupDesc{margin:0;padding:4px 0 0}
.cc-disclosure{width:100%;padding:0 0 4px;border:0;background:0 0;font:inherit;text-align:left;cursor:pointer;border-radius:6px}
.cc-disclosure:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.cc-rows{flex-direction:column;display:flex}
.cc-row{align-items:center;gap:8px;display:flex;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.cc-rows>.cc-row:last-child{border-bottom:0}
.cc-rowNested{padding-left:16px}
.cc-rowFlush{padding:0;border-bottom:0}
.cc-rowText{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:32px;display:flex}
.cc-rowTitleLine{align-items:center;gap:8px;display:flex;min-width:0}
.cc-rowTitle{min-width:0;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}
.cc-rowDesc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.cc-rowDesc p{margin:0}
.cc-rowDesc p+p{margin-top:4px}
.cc-rowError{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.cc-rowControl{flex:none;align-items:center;justify-content:flex-end;gap:8px;display:inline-flex;max-width:60%}
.cc-rowInput{width:200px}
.cc-rowInputWide{width:280px}
/* The platform's link button: a compact capsule with no fill until hovered. */
.cc-linkButton{box-sizing:border-box;flex:none;align-items:center;display:inline-flex;height:28px;padding:0 10px;border:0;border-radius:14px;background:0 0;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:18px;white-space:nowrap;cursor:pointer}
.cc-linkButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.cc-linkButton:disabled{cursor:default;opacity:.4}
.cc-linkButton:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}
/* Tags: the platform Tag's capsule (11/17, weight 500). */
.cc-badges{align-items:center;gap:8px;display:inline-flex}
.cc-badge,.cc-badgeMuted{flex:none;align-items:center;display:inline-flex;white-space:nowrap;border-radius:999px;corner-shape:round;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.cc-badge{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}
.cc-badgeMuted{border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-tertiary)}
.cc-badgeWarn{background:var(--dsw-alias-state-warn-tertiary,var(--dsw-alias-bg-module-platform));color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-secondary))}
/* The stacked field (the Models-page provider card and the account forms):
 * the platform SettingsForm field's metrics. */
.cc-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}
.cc-field+.cc-field{border-top:.5px solid var(--dsw-alias-border-l2)}
.cc-fieldHead{align-items:center;gap:8px;display:flex}
.cc-label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}
.cc-reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:18px}
.cc-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.cc-reset:disabled{cursor:default;opacity:.4}
.cc-input{box-sizing:border-box;height:32px;min-width:0;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font:inherit;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.cc-input::placeholder{color:var(--dsw-alias-label-dimmed)}
.cc-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.cc-input:disabled{opacity:.6;cursor:default}
.cc-inputInvalid{border-color:var(--dsw-alias-state-error-primary)}
.cc-invalid{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12px;line-height:18px}
.cc-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px}
/* The model multi-select trigger: the platform's selector capsule (the
 * language / permission pickers on General). */
.cc-modelSelectAnchor{flex-direction:column;align-items:stretch;gap:6px;display:inline-flex;min-width:160px}
.cc-selector{box-sizing:border-box;align-items:center;gap:12px;display:inline-flex;height:36px;padding:0 14px;border:0;border-radius:18px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;text-align:left;cursor:pointer}
.cc-selector:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.cc-selector:disabled{cursor:default;opacity:.4}
.cc-selector:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}
.cc-selectorText{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cc-selectorCaret{flex-shrink:0;border-right:1.5px solid var(--dsw-alias-label-tertiary);border-bottom:1.5px solid var(--dsw-alias-label-tertiary);width:6px;height:6px;margin-bottom:3px;transform:rotate(45deg)}
/* The search box sits inside the Menu anchor, so typing in it never trips
 * the Menu's outside-click close. */
.cc-modelSearch{width:100%}
.cc-modelSearch::-webkit-search-cancel-button{cursor:pointer}
.cc-checkRow{align-items:center;gap:8px;display:inline-flex;min-width:0}
.cc-checkRow:hover{cursor:pointer}
/* A hand-drawn box rather than the platform's accent-color checkbox: the
 * native control's colours come from color-scheme, which the theme sets once
 * at BOOT (it is not re-applied when the theme is switched in-session), so a
 * native box can paint light-chrome white on a dark page. Drawn from tokens it
 * cannot. The mark rides a brand-primary fill, so it takes the theme's brand
 * foreground — the platform's pairing for anything painted on that fill, and
 * the only one that survives the dark mode's near-white brand. The box
 * outline is a border-l3 hairline: border-l2 (#ffffff1f in dark) leaves an
 * unchecked box all but invisible against the menu surface. */
.cc-check{box-sizing:border-box;appearance:none;flex-shrink:0;width:16px;height:16px;margin:0;border:1px solid var(--dsw-alias-border-l3);border-radius:4px;background:0 0;position:relative}
.cc-check:checked{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.cc-check:checked::after{content:'';position:absolute;top:3px;left:5px;width:3px;height:7px;border:solid var(--dsw-alias-label-primary-foreground,#fff);border-width:0 1.5px 1.5px 0;transform:rotate(45deg)}
.cc-checkName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* The platform SegmentedControl: a translucent track and one raised pill that
 * slides under the picked segment. Segments are equal grid tracks, so the
 * indicator's width and offset follow from the count and the index alone. */
.cc-segmented{position:relative;display:inline-grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:2px;padding:3px;border-radius:9px;background:var(--dsw-alias-interactive-bg-hover)}
.cc-segmentIndicator{position:absolute;top:3px;left:3px;width:calc((100% - 6px - 2px * (var(--cc-segment-count) - 1)) / var(--cc-segment-count));height:calc(100% - 6px);border-radius:7px;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft,0 1px 2px rgba(0,0,0,.12));transform:translateX(calc(var(--cc-segment-index) * (100% + 2px)));transition:transform .16s ease;pointer-events:none}
.cc-segment{box-sizing:border-box;position:relative;z-index:1;height:28px;padding:0 16px;border:0;border-radius:7px;background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;font-weight:500;line-height:20px;white-space:nowrap;cursor:pointer;transition:color .12s ease}
.cc-segment:hover:not(:disabled),.cc-segment[aria-checked=true]{color:var(--dsw-alias-label-primary)}
.cc-segment:disabled{cursor:default;opacity:.4}
.cc-segment:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
/* Modelled on the platform's own Switch primitive (ui-primitives
 * Switch.module.css): a 36x20 capsule that pads its track by 2px and slides a
 * 16px thumb across the 32px content box.
 *
 * Three things are load-bearing. (1) corner-shape:round on BOTH the track and
 * the thumb: the theme sets a global superellipse corner shape on every
 * element, and a superellipse capsule squares its ends off around a round
 * thumb. (2) No literal colours. --dsw-alias-brand-primary INVERTS between the
 * two modes (near-black in light, near-white in dark), so a hardcoded white
 * thumb vanishes on the checked track in dark mode; the brand foreground is the
 * token the platform paints on that fill. (3) --dsw-alias-border-l3 as the off
 * track: border-l2 (#ffffff1f in dark) leaves it indistinguishable from the
 * page. */
.cc-toggle{box-sizing:border-box;appearance:none;flex-shrink:0;width:36px;height:20px;margin:0;padding:2px;border:0;border-radius:10px;corner-shape:round;background:var(--dsw-alias-border-l3);cursor:pointer;position:relative}
.cc-toggle:checked{background:var(--dsw-alias-brand-primary)}
.cc-toggle::after{content:'';display:block;width:16px;height:16px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-label-primary-foreground);transition:transform .12s ease}
/* 32px content box minus the 16px thumb. */
.cc-toggle:checked::after{transform:translateX(16px)}
.cc-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.cc-toggle:disabled{cursor:default;opacity:.5}
.cc-chevron{flex-shrink:0;border-right:1.5px solid var(--dsw-alias-label-tertiary);border-bottom:1.5px solid var(--dsw-alias-label-tertiary);width:7px;height:7px;margin-right:6px;margin-bottom:3px;transform:rotate(45deg);transition:transform .15s ease}
.cc-chevronUp{transform:rotate(-135deg);margin-bottom:-3px}
/* Accounts: one outlined card per account, the Models page's provider card. */
.cc-accountMode{align-items:center;gap:4px;display:flex;margin:-4px 0 12px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.cc-accountList{flex-direction:column;gap:8px;display:flex}
.cc-accountList+.cc-addButton,.cc-accountList+.cc-addPanel{margin-top:8px}
.cc-accountItem{flex-direction:column;gap:10px;display:flex;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l4);border-radius:16px}
.cc-accountItemActive{border-color:var(--dsw-static-neutral-bluish-400,var(--dsw-alias-border-l3))}
.cc-accountHead{align-items:center;gap:4px;display:flex;min-height:28px}
.cc-accountToggle{align-items:center;gap:8px;display:flex;flex:1;min-width:0;padding:0;background:0 0;border:0;color:inherit;cursor:pointer;font:inherit;text-align:left}
.cc-accountToggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:4px}
.cc-accountName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}
.cc-iconButton{flex-shrink:0;align-items:center;justify-content:center;display:inline-flex;width:28px;height:28px;padding:0;background:0 0;border:0;border-radius:6px;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.cc-iconButton:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.cc-iconButton:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}
/* Three dots from one element: the dot itself plus two box-shadow copies. */
.cc-kebab{width:3px;height:3px;border-radius:50%;corner-shape:round;background:currentColor;box-shadow:0 -5px 0 currentColor,0 5px 0 currentColor}
.cc-tabDot{flex-shrink:0;width:8px;height:8px;border-radius:50%;corner-shape:round}
.cc-tabDotOk{background:var(--dsw-alias-state-success-primary)}
.cc-tabDotWarn{background:var(--dsw-alias-state-warn-primary,#d97706)}
.cc-tabDotError{background:var(--dsw-alias-state-error-primary)}
.cc-accountMeters{flex-wrap:wrap;gap:6px 20px;display:flex;padding-left:16px}
.cc-miniMeter{align-items:center;gap:8px;display:inline-flex;font-size:12px;line-height:18px}
.cc-miniMeterLabel{color:var(--dsw-alias-label-tertiary)}
.cc-miniMeterTrack{overflow:hidden;background:var(--dsw-alias-bg-module-platform);border-radius:999px;width:64px;height:4px}
.cc-miniMeterFill{display:block;background:var(--dsw-alias-brand-primary);border-radius:999px;height:100%}
.cc-miniMeterValue{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.cc-accountSetup,.cc-loginStatus{flex-direction:column;gap:8px;display:flex;padding-left:16px}
.cc-loginStatus{flex-direction:row;flex-wrap:wrap;align-items:center;gap:4px 12px}
.cc-loginStatus>p{margin:0;font-size:12px;line-height:18px}
.cc-accountDetails{container-type:inline-size;border-top:.5px solid var(--dsw-alias-border-l2);flex-direction:column;gap:14px;display:flex;padding-top:12px}
.cc-inlineForm,.cc-confirmBar{flex-direction:column;gap:8px;display:flex}
.cc-inlineActions{align-items:center;gap:8px;display:flex}
.cc-confirmBar{border:.5px solid var(--dsw-alias-state-error-primary);border-radius:12px;padding:12px 14px}
.cc-confirmText{color:var(--dsw-alias-label-primary);margin:0;font-size:14px;line-height:22px}
.cc-dangerButton{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.cc-dangerButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
/* Adding an account: the Models page's dashed add button, opening a filled
 * panel in its place. */
.cc-addButton{box-sizing:border-box;align-items:center;justify-content:center;gap:6px;display:flex;width:100%;height:44px;border:1px dashed var(--dsw-alias-border-l3);border-radius:16px;background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;cursor:pointer}
.cc-addButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.cc-addButton:disabled{cursor:default;opacity:.4}
.cc-addButton:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}
/* A plus from two crossed bars. */
.cc-addGlyph{position:relative;width:12px;height:12px}
.cc-addGlyph::before,.cc-addGlyph::after{content:'';position:absolute;background:currentColor;border-radius:1px}
.cc-addGlyph::before{left:0;right:0;top:5.25px;height:1.5px}
.cc-addGlyph::after{top:0;bottom:0;left:5.25px;width:1.5px}
.cc-addPanel{flex-direction:column;gap:12px;display:flex;padding:14px 16px;border-radius:12px;background:var(--dsw-alias-bg-module-platform)}
.cc-panelTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}
/* Account report: stat tiles are filled panels, like the platform's editors. */
.cc-accountReport{flex-direction:column;gap:14px;display:flex}
.cc-usageHead{align-items:center;gap:8px;display:flex}
.cc-usageTitle{color:var(--dsw-alias-label-primary);flex:1;margin:0;font-size:14px;font-weight:500;line-height:22px}
.cc-usageAccount{max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.cc-usagePlan{flex:none;white-space:nowrap;border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);border-radius:999px;corner-shape:round;padding:0 7px;font-size:11px;font-weight:500;line-height:17px}
.cc-usagePlanStatus{flex:none;margin:0;white-space:nowrap;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.cc-usageHint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px}
/* Two fixed grids instead of one auto-fit track: auto-fit wrapped the four
 * activity tiles 3 + 1 at the details' width. Each group fills its own row
 * (four activity tiles, three balances) and the activity row folds to 2 × 2
 * in a narrow details panel. */
.cc-usageStats{grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;display:grid}
.cc-usageStatsActivity{grid-template-columns:repeat(4,minmax(0,1fr))}
.cc-usageStatsBalance{grid-template-columns:repeat(3,minmax(0,1fr))}
@container (max-width:460px){.cc-usageStatsActivity{grid-template-columns:repeat(2,minmax(0,1fr))}}
.cc-usageStat{min-width:0;flex-direction:column;gap:2px;display:flex;padding:10px 12px;border-radius:12px;background:var(--dsw-alias-bg-module-platform)}
.cc-usageStatLabel{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.cc-usageStatValue{color:var(--dsw-alias-label-primary);font-size:16px;font-weight:500;line-height:24px;font-variant-numeric:tabular-nums}
.cc-usageStatSub{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cc-usageWindows{flex-direction:column;gap:14px;display:flex}
.cc-usageWindow{flex-direction:column;gap:6px;display:flex}
.cc-usageWindowHead{align-items:baseline;gap:8px;display:flex}
.cc-usageWindowLabel{color:var(--dsw-alias-label-secondary);flex:1;font-size:12px;line-height:18px}
.cc-usageWindowValue{color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.cc-usageExceeded{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.cc-usageBar{overflow:hidden;background:var(--dsw-alias-bg-module-platform);border-radius:999px;height:4px}
.cc-usageBarFill{background:var(--dsw-alias-brand-primary);border-radius:999px;height:100%;transition:width .3s ease}
.cc-usageBarFillWarn{background:var(--dsw-alias-state-error-primary)}
.cc-usageWindowReset{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px}
.cc-usageMeta{align-items:center;gap:8px;display:flex}
.cc-usageMetaSpacer{flex:1}
.cc-usageUpdated{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px}
.cc-usagePartial{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12px;line-height:18px}
.cc-usageBlocked{border:.5px solid var(--dsw-alias-state-error-primary);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:4px}
.cc-usageBlockedTitle{color:var(--dsw-alias-state-error-primary);margin:0;font-size:14px;font-weight:500;line-height:22px}
.cc-usageBlockedHint{color:var(--dsw-alias-label-secondary);margin:0;font-size:12px;line-height:18px}
.cc-usageBlockedDetail{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px;word-break:break-word}
.cc-version{margin:32px 0 0;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
/* The update hint rides the footer version line, quiet until hovered. */
.cc-versionLink{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-secondary));text-decoration:none}
.cc-versionLink:hover{color:var(--dsw-alias-label-primary);text-decoration:underline;text-underline-position:under}
/* The Models-page provider panel root: unstyled by design — the row card the
 * Models page owns supplies the surface, the panel only stacks its controls. */
.cc-providerCard{flex-direction:column;display:flex}
.cc-footer{justify-content:flex-end;align-items:center;gap:8px;display:flex}
.cc-failed{display:inline-block;max-width:260px;min-width:0;color:var(--dsw-alias-state-error-primary);margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px}
/* The authorization link is the only link-coloured element on a login row. */
.cc-loginLink{color:var(--dsw-alias-link,var(--dsw-alias-brand-primary));text-decoration:none;font-size:12px;line-height:18px}
.cc-loginLink:hover{text-decoration:underline;text-underline-position:under}
.cc-loginDone{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary))}
.cc-loginError{color:var(--dsw-alias-state-error-primary)}
/* The floating save bar: a centered capsule pinned to the bottom of the
 * settings scrollport. The dock is a zero-height sticky strip at the end of
 * the page, so the bar overlays the scrolling content instead of taking a row
 * of its own; while it is shown the section reserves room at its end so the
 * last line can still scroll clear of it. Hidden, it sinks and fades, and
 * visibility (switched after the transition) takes its buttons out of the tab
 * order.
 *
 * Its surface is an elevated layer (bg-layer-1 over the settings panel's
 * layer-2) with the platform's prominent elevation and no stroke. The corners
 * are concentric: a 44px capsule around 36px capsule buttons inset by 4px, so
 * the gap around each button is even. */
.cc-sectionWithBar{padding-bottom:80px}
.cc-saveBarDock{position:sticky;bottom:0;z-index:2;height:0;pointer-events:none}
.cc-saveBar{--cc-saveBar-tone:var(--dsw-alias-state-warn-primary,#d97706);position:absolute;left:50%;bottom:20px;box-sizing:border-box;width:max-content;max-width:calc(100% - 24px);align-items:center;gap:10px;display:flex;height:44px;padding:4px 4px 4px 16px;border:0;border-radius:22px;corner-shape:round;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-prominent,0 12px 32px -8px rgba(0,0,0,.24),0 2px 8px rgba(0,0,0,.08));opacity:0;visibility:hidden;transform:translate(-50%,12px);transition:opacity .16s ease,transform .16s ease,visibility 0s linear .16s}
.cc-saveBarShown{opacity:1;visibility:visible;transform:translate(-50%,0);pointer-events:auto;transition:opacity .2s ease,transform .24s cubic-bezier(.2,.9,.3,1.1),visibility 0s}
.cc-saveBar-error{--cc-saveBar-tone:var(--dsw-alias-state-error-primary)}
.cc-saveBar-success{--cc-saveBar-tone:var(--dsw-alias-state-success-primary,#16a34a);padding-right:18px}
.cc-saveBarIcon{flex-shrink:0;align-items:center;justify-content:center;display:inline-flex;width:16px;height:16px;color:var(--cc-saveBar-tone)}
.cc-saveBarPulse{width:8px;height:8px;border-radius:50%;corner-shape:round;background:var(--cc-saveBar-tone)}
.cc-saveBarText{min-width:0;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.cc-saveBar-error .cc-saveBarText{color:var(--dsw-alias-state-error-primary)}
.cc-saveBarActions{flex-shrink:0;align-items:center;gap:4px;display:flex;margin-left:8px}
.cc-saveBarButton{box-sizing:border-box;height:36px;padding:0 16px;border:0;border-radius:18px;corner-shape:round;font:inherit;font-size:14px;line-height:22px;white-space:nowrap;cursor:pointer}
.cc-saveBarButton:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}
.cc-saveBarButton:disabled{cursor:default;opacity:.4}
.cc-saveBarGhost{background:0 0;color:var(--dsw-alias-label-primary)}
.cc-saveBarGhost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.cc-saveBarPrimary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));color:var(--dsw-alias-label-primary-foreground,#fff)}
.cc-saveBarPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary)))}
@media (prefers-reduced-motion:reduce){.cc-chevron,.cc-toggle::after,.cc-usageBarFill,.cc-saveBar,.cc-saveBarShown,.cc-segmentIndicator,.cc-segment{transition:none}}
`
