/**
 * Stylesheet for the Command Code settings page — and the Models-page provider
 * card, which shares its `cc-` classes.
 *
 * Returned as a string, not injected here, so importing this module has no DOM
 * side effect: `./index.ts` installs it once under {@link PAGE_CSS_ID}.
 *
 * Variant A (native DSH alignment): controls come directly from
 * `@deepseek-ai/dsh-client-ui-primitives` (`Button`, `Switch`, `Tag`,
 * `StateDot`, `SegmentedControl`, `SettingsValueField`, `Input`, `Menu`,
 * `Modal`, product icons), so this sheet owns only layout, concentric surfaces
 * (`R20` entity cards with `12px` inset → `R10` quota surface; `R14` override
 * entries with `4px` inset → `R10` inputs), and tactile micro-interactions
 * (`--cc-ease-out: cubic-bezier(.23,1,.32,1)`). Every selector is scoped under
 * a `cc-` class (issue #48).
 *
 * @module dsh-commandcode-provider/client/page-styles
 */

export const PAGE_CSS_ID = '@mars-sea/dsh-commandcode-provider/CommandCodeSettingsPage.module.css'

export const PAGE_CSS = `
.cc-section{max-width:720px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:14px;display:flex;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;--cc-ease-out:cubic-bezier(.23,1,.32,1)}
.cc-header{padding-top:2px;display:flex}
.cc-titleRow{flex:1;justify-content:space-between;align-items:center;gap:8px;display:flex}
.cc-title{margin:0;color:var(--dsw-alias-label-primary);font-size:16px;font-weight:500;line-height:24px;letter-spacing:-.01em}
.cc-versionLink{text-decoration:none;display:inline-flex}
.cc-spacer{flex:1}
/* Native flat groups (aligned with PluginInventorySettingsTab & GeneralSection):
 * separated by a .5px border-l2 hairline, never wrapped in heavy outer cards. */
.cc-group{flex-direction:column;gap:10px;display:flex}
.cc-group+.cc-group{border-top:.5px solid var(--dsw-alias-border-l2);padding-top:14px}
.cc-groupHead{align-items:center;gap:8px;min-height:32px;display:flex}
.cc-groupHeading{flex:1;min-width:0;margin:0;font:inherit;display:flex}
.cc-disclosure{box-sizing:border-box;flex-wrap:wrap;flex:1;align-items:center;gap:6px 8px;min-width:0;min-height:32px;padding:0;border:0;border-radius:var(--dsw-radius-sm,8px);background:0 0;color:inherit;font:inherit;text-align:left;cursor:pointer;display:flex}
.cc-disclosure:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.cc-groupTitle{margin:0;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}
.cc-groupSummary{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px;font-variant-numeric:tabular-nums;white-space:nowrap}
.cc-foldChevron{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .16s var(--cc-ease-out),color .15s ease}
.cc-foldChevronClosed{transform:rotate(-90deg)}
.cc-chevronOpen{transform:rotate(180deg)}
/* Folding stays 0ms instant (frequent navigation); hidden keeps aria-controls mounted. */
.cc-groupBody{flex-direction:column;gap:8px;display:flex}
.cc-groupBody[hidden]{display:none}
.cc-groupDesc{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
/* Rows inside a flat group (GeneralSection / WebSearchCard geometry). */
.cc-rows{flex-direction:column;display:flex}
.cc-row{flex-wrap:wrap;align-items:center;gap:8px 24px;padding:11px 0;display:flex}
.cc-rows>.cc-row+.cc-row{border-top:.5px solid var(--dsw-alias-border-l2)}
.cc-rowFlush{padding:0}
.cc-rowText{flex-direction:column;flex:1 1 200px;gap:2px;min-width:0;display:flex}
.cc-rowTitleLine{align-items:center;gap:4px;min-width:0;display:flex}
.cc-rowTitle{min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px}
.cc-helpButton{justify-content:center;align-items:center;flex:none;width:20px;height:20px;padding:0;border:0;border-radius:var(--dsw-radius-xs,4px);background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer;display:inline-flex;transition:transform .15s var(--cc-ease-out),background-color .15s ease,color .15s ease}
.cc-helpButton:active:not(:disabled){transform:scale(.95)}
.cc-helpButton[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.cc-helpButton:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.cc-rowDesc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.cc-rowDesc p{margin:0}
.cc-rowDesc p+p{margin-top:4px}
.cc-rowError{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.cc-rowControl{flex:none;align-items:center;gap:6px;margin-left:auto;display:inline-flex}
.cc-overrideTag{align-items:center;gap:8px;display:inline-flex}
.cc-resetLink{padding:0;border:0;background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;transition:transform .15s var(--cc-ease-out),color .15s ease}
.cc-resetLink:active:not(:disabled){transform:scale(.95)}
.cc-resetLink:disabled{cursor:default;opacity:.4}
.cc-resetLink:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px;border-radius:4px}
/* Multi-column SettingsValueField grids (SubagentLimitsFields pattern). */
.cc-fieldGrid2{grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;border-top:.5px solid var(--dsw-alias-border-l2);display:grid}
.cc-fieldGrid3{grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;border-top:.5px solid var(--dsw-alias-border-l2);display:grid}
.cc-fieldCell{min-width:0}
.cc-monoField input{font-family:var(--ds-font-family-code)}
.cc-numField input{font-variant-numeric:tabular-nums}
@media (max-width:560px){.cc-fieldGrid2,.cc-fieldGrid3{grid-template-columns:minmax(0,1fr);gap:0}}
/* Press feedback added onto primitive Buttons & action controls. */
.cc-press{transition:transform .15s var(--cc-ease-out),background-color .15s ease,color .15s ease,border-color .15s ease}
.cc-press:active:not(:disabled){transform:scale(.97)}
.cc-dangerButton{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 50%,transparent)}
/* Switch primitive: keep 36x20 box untouched (issue #108), synchronize 160ms motion. */
.cc-rowControl>.cc-switch{transition:background-color .16s var(--cc-ease-out),transform .16s var(--cc-ease-out)}
.cc-rowControl>.cc-switch>span{transition:transform .16s var(--cc-ease-out)}
.cc-switch:active:not(:disabled){transform:scale(.95)}
/* Model multi-select trigger & Menu checklist rows. */
.cc-modelSelectAnchor{flex-direction:column;align-items:stretch;gap:6px;width:196px;display:inline-flex}
.cc-selector{box-sizing:border-box;justify-content:space-between;align-items:center;gap:8px;height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer;display:inline-flex;transition:transform .15s var(--cc-ease-out),border-color .15s ease}
.cc-selector:active:not(:disabled){transform:scale(.98)}
.cc-selector:disabled{cursor:default;opacity:.4}
.cc-selector:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.cc-selectorText{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}
.cc-selectorChevron{flex:none;color:var(--dsw-alias-label-tertiary)}
.cc-modelSearch{width:100%}
.cc-checkRow{align-items:center;gap:8px;min-width:0;display:inline-flex}
.cc-checkRow:hover{cursor:pointer}
.cc-check{box-sizing:border-box;appearance:none;flex-shrink:0;width:15px;height:15px;margin:0;border:1px solid var(--dsw-alias-border-l3);border-radius:4px;background:0 0;position:relative}
.cc-check:checked{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.cc-check:checked::after{content:'';position:absolute;top:2px;left:4.5px;width:3px;height:7px;border:solid var(--dsw-alias-label-primary-foreground,#fff);border-width:0 1.5px 1.5px 0;transform:rotate(45deg)}
.cc-checkName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* Per-model overrides (ModelsSection.modelEntry: concentric R14 = 4px pad + R10 controls). */
.cc-overrideBlock{border-top:.5px solid var(--dsw-alias-border-l2);flex-direction:column;gap:8px;padding:12px 0;display:flex}
.cc-overrideHead{justify-content:space-between;align-items:center;gap:16px;display:flex}
.cc-overrideList{flex-direction:column;gap:6px;display:flex}
.cc-overrideCols{grid-template-columns:minmax(0,1.35fr) 136px 28px;gap:6px;padding:0 6px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;display:grid}
.cc-overrideColsName{grid-template-columns:minmax(0,1.2fr) minmax(0,1fr) 28px}
.cc-overrideColRight{text-align:right;padding-right:4px}
.cc-modelEntry{border:.5px solid var(--dsw-alias-border-l4);border-radius:14px;grid-template-columns:minmax(0,1.35fr) 136px 28px;align-items:center;gap:6px;padding:4px;display:grid}
.cc-modelEntryName{grid-template-columns:minmax(0,1.2fr) minmax(0,1fr) 28px}
.cc-contextSelect{position:relative;min-width:0;display:block}
.cc-fieldInput{box-sizing:border-box;width:100%;height:30px;min-width:0;padding:0 8px;border:.5px solid var(--dsw-alias-border-l4);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;transition:border-color .15s ease}
.cc-fieldInput::placeholder{color:var(--dsw-alias-label-dimmed)}
.cc-fieldInput:focus-visible{border-color:var(--dsw-alias-state-business-primary);outline:none}
.cc-fieldInput:disabled{opacity:.5;cursor:default}
.cc-fieldInputNum{text-align:right;font-variant-numeric:tabular-nums}
.cc-fieldInputInvalid{border-color:var(--dsw-alias-state-error-primary)}
.cc-contextModel{appearance:none;-webkit-appearance:none;background:var(--dsw-alias-bg-module-platform);font-family:var(--ds-font-family-code);font-size:12px;padding-inline-end:26px;text-overflow:ellipsis;cursor:pointer}
.cc-contextCaret{position:absolute;inset-inline-end:8px;top:50%;color:var(--dsw-alias-label-tertiary);transform:translateY(-50%);pointer-events:none}
.cc-contextError{grid-column:1/-1;padding:2px 6px 2px}
/* Accounts section: entity cards (--dsw-alias-settings-card-*, R20) + concentric R10 inner surface. */
.cc-accountList{flex-direction:column;gap:8px;display:flex}
.cc-accountItem{border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l4));border-radius:var(--dsw-radius-xl,20px);background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-2));flex-direction:column;gap:10px;padding:12px;display:flex}
.cc-accountItemActive{border-color:var(--dsw-alias-border-l3)}
.cc-accountItemInvalid{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent)}
.cc-accountHead{align-items:center;gap:4px;padding:0 2px;display:flex}
.cc-accountToggle{flex-wrap:wrap;flex:1;align-items:center;gap:6px 8px;min-width:0;min-height:32px;padding:0;border:0;border-radius:var(--dsw-radius-sm,8px);background:0 0;color:inherit;font:inherit;text-align:left;cursor:pointer;display:flex}
.cc-accountToggle:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.cc-dotSpacer{flex:none;width:10px;height:10px;display:inline-block}
.cc-accountName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}
.cc-iconButton{box-sizing:border-box;flex:none;justify-content:center;align-items:center;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm,8px);background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer;display:inline-flex;transition:transform .15s var(--cc-ease-out),background-color .15s ease,color .15s ease}
.cc-iconButton:active:not(:disabled){transform:scale(.95)}
.cc-iconButton:disabled{cursor:default;opacity:.4}
.cc-iconButton:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.cc-accountMeters{flex-wrap:wrap;gap:6px 20px;padding:0 4px 2px 20px;display:flex}
.cc-miniMeter{align-items:center;gap:8px;font-size:12px;line-height:18px;display:inline-flex}
.cc-miniMeterLabel{color:var(--dsw-alias-label-tertiary)}
.cc-miniMeterTrack{overflow:hidden;background:var(--dsw-alias-bg-module-platform);border-radius:999px;width:56px;height:4px}
.cc-miniMeterFill{display:block;width:100%;height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary);transition:transform .24s var(--cc-ease-out)}
.cc-miniMeterValue{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.cc-accountDetails{container-type:inline-size;flex-direction:column;gap:10px;display:flex}
.cc-accountReport{flex-direction:column;gap:10px;display:flex}
.cc-usageHead{align-items:center;gap:8px;display:flex}
.cc-usageTitle{flex:1;margin:0;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}
.cc-usageAccount{max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.cc-usagePlanStatus{flex:none;margin:0;white-space:nowrap;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.cc-usageHint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
/* Concentric R10 quota surface inside R20 card: holds balance, windows and hairline telemetry strip. */
.cc-usageSurface{border-radius:10px;background:var(--dsw-alias-bg-module-platform);flex-direction:column;gap:10px;padding:12px 14px;display:flex}
.cc-balance{flex-direction:column;gap:2px;display:flex}
.cc-balanceRow{flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:4px 16px;display:flex}
.cc-balanceLabel{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.cc-balanceValue{color:var(--dsw-alias-label-primary);font-size:18px;font-weight:600;line-height:24px;letter-spacing:-.015em;font-variant-numeric:tabular-nums}
.cc-balanceSub{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.cc-balanceEmpty .cc-balanceValue{color:var(--dsw-alias-state-error-primary)}
.cc-balanceNote{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.cc-usageWindows{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;display:grid}
@container (max-width:460px){.cc-usageWindows{grid-template-columns:minmax(0,1fr)}}
.cc-usageWindow{flex-direction:column;gap:5px;display:flex}
.cc-usageWindowHead{align-items:baseline;gap:8px;display:flex}
.cc-usageWindowLabel{flex:1;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.cc-usageWindowValue{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:500;line-height:18px;font-variant-numeric:tabular-nums}
.cc-usageExceeded{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.cc-usageBar{overflow:hidden;background:var(--dsw-alias-border-l2);border-radius:999px;height:4px}
.cc-usageBarFill{width:100%;height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary);transition:transform .24s var(--cc-ease-out)}
.cc-usageBarFillWarn{background:var(--dsw-alias-state-error-primary)}
.cc-usageWindowReset{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}
/* Hairline telemetry strip: replaces 4 nested bordered boxes inside the card. */
.cc-usageStatsStrip{border-top:.5px solid var(--dsw-alias-border-l2);grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;padding-top:8px;display:grid}
@container (max-width:460px){.cc-usageStatsStrip{grid-template-columns:repeat(2,minmax(0,1fr))}}
.cc-usageStat{min-width:0;flex-direction:column;gap:1px;display:flex}
.cc-usageStatLabel{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.cc-usageStatValue{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px;font-variant-numeric:tabular-nums}
.cc-usageStatSub{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}
.cc-usagePartial{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
/* Add-account dashed button & inline module panel (ModelsSection.addButton / addCard). */
.cc-accountActions{flex-wrap:wrap;align-items:center;gap:8px;display:flex}
.cc-addButton{box-sizing:border-box;flex:1 1 180px;justify-content:center;align-items:center;gap:6px;height:38px;padding:0 14px;border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md,12px);background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;display:inline-flex;transition:transform .15s var(--cc-ease-out),background-color .15s ease,border-color .15s ease}
.cc-addButton:active:not(:disabled){transform:scale(.98)}
.cc-addButton:disabled{cursor:default;opacity:.4}
.cc-addButton:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.cc-analyticsEntry{max-width:100%;min-width:0}
.cc-analyticsEntryText{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cc-panel{border-radius:var(--dsw-radius-lg,16px);background:var(--dsw-alias-bg-module-platform);flex-direction:column;gap:12px;padding:14px 16px;display:flex}
.cc-panelHead{justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;display:flex}
.cc-panelTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}
.cc-panelInput{width:100%}
.cc-keyField{align-items:center;gap:8px;display:flex}
.cc-panelActions{flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:8px;display:flex}
.cc-inlineForm{flex-direction:column;gap:8px;display:flex}
.cc-inlineActions{align-items:center;gap:8px;display:flex}
/* Notices: quiet module-platform callouts with semantic tinting. */
.cc-notices{flex-direction:column;gap:8px;display:flex}
.cc-notice{box-sizing:border-box;align-items:flex-start;gap:10px;padding:10px 12px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;display:flex;transition:opacity .18s var(--cc-ease-out),transform .18s var(--cc-ease-out)}
@starting-style{.cc-notice{opacity:0;transform:translateY(-4px)}}
.cc-noticeIcon{flex:none;margin-top:1px;color:var(--dsw-alias-label-tertiary);display:inline-flex}
.cc-noticeBody{flex-direction:column;flex:1;gap:2px;min-width:0;word-break:break-word;display:flex}
.cc-noticeBody>p{margin:0}
.cc-noticeTitle{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px}
.cc-noticeActions{flex-wrap:wrap;align-items:center;gap:8px;margin-top:6px;display:flex}
.cc-noticeDetail{color:var(--dsw-alias-label-tertiary)}
.cc-noticeSuccess{background:var(--dsw-alias-state-success-tertiary,color-mix(in srgb,var(--dsw-alias-state-success-primary,#16a34a) 10%,transparent))}
.cc-noticeSuccess>.cc-noticeIcon{color:var(--dsw-alias-state-success-primary,#16a34a)}
.cc-noticeWarn{background:var(--dsw-alias-state-warn-tertiary,color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d97706) 12%,transparent))}
.cc-noticeWarn>.cc-noticeIcon,.cc-noticeWarn .cc-noticeTitle{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary,#b45309))}
.cc-noticeError{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}
.cc-noticeError>.cc-noticeIcon,.cc-noticeError .cc-noticeTitle{color:var(--dsw-alias-state-error-primary)}
/* Service status lines. */
.cc-statusBadge{align-items:center;gap:6px;white-space:nowrap;display:inline-flex}
.cc-statusLabel{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.cc-statusBad{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary,#b45309))}
.cc-statusNotice{margin:0;color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-tertiary));font-size:12px;line-height:18px}
.cc-statusLines{grid-template-columns:auto minmax(0,1fr);align-items:baseline;gap:3px 12px;margin:2px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;display:grid}
.cc-statusKey{color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.cc-statusValue{flex-wrap:wrap;align-items:center;gap:2px 8px;min-width:0;font-variant-numeric:tabular-nums;display:flex}
.cc-statusVerdict{color:var(--dsw-alias-label-primary)}
.cc-statusMeta{flex:1 1 200px;min-width:0}
.cc-statusPart{white-space:nowrap}
.cc-statusTitleLink{align-items:center;gap:3px;margin-left:auto;display:inline-flex}
.cc-statusLink{color:var(--dsw-alias-link,var(--dsw-alias-state-business-primary));text-decoration:none;font-size:12px;line-height:18px;white-space:nowrap}
.cc-statusRetry{align-items:center;gap:4px;padding:0;border:0;background:0 0;color:var(--dsw-alias-link,var(--dsw-alias-state-business-primary));font:inherit;font-size:12px;line-height:18px;white-space:nowrap;cursor:pointer;display:inline-flex}
.cc-statusRetry:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px;border-radius:4px}
/* Native SettingsForm-aligned sticky footer bar (replaces custom capsule floating pill). */
.cc-saveFooter{position:sticky;bottom:0;z-index:2;justify-content:space-between;align-items:center;gap:12px;padding:12px 0 4px;border-top:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);display:flex;transition:opacity .18s var(--cc-ease-out),transform .18s var(--cc-ease-out)}
@starting-style{.cc-saveFooter{opacity:0;transform:translateY(6px)}}
.cc-saveStatus{align-items:center;gap:8px;min-width:0;display:inline-flex}
.cc-saveText{min-width:0;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.cc-saveTextError{color:var(--dsw-alias-state-error-primary)}
.cc-saveActions{flex:none;align-items:center;gap:8px;display:inline-flex}
.cc-modalActions{justify-content:flex-end;align-items:center;gap:8px;display:flex}
/* Models-page provider card (card.tsx + login-row.tsx) shared classes. */
.cc-providerCard{flex-direction:column;display:flex}
.cc-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}
.cc-field+.cc-field{border-top:.5px solid var(--dsw-alias-border-l2)}
.cc-fieldHead{align-items:center;gap:8px;display:flex}
.cc-label{flex:1;min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5}
.cc-badges{align-items:center;gap:8px;display:inline-flex}
.cc-reset{padding:0;border:none;background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.cc-reset:disabled{cursor:default;opacity:.4}
.cc-input{box-sizing:border-box;height:32px;min-width:0;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px}
.cc-input::placeholder{color:var(--dsw-alias-label-dimmed)}
.cc-input:focus-visible{border-color:var(--dsw-alias-state-business-primary);outline:none}
.cc-input:disabled{opacity:.6;cursor:default}
.cc-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.cc-footer{justify-content:flex-end;align-items:center;gap:8px;padding-top:8px;display:flex}
.cc-failed{display:inline-block;max-width:260px;min-width:0;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.cc-loginLink{align-items:center;gap:4px;color:var(--dsw-alias-link,var(--dsw-alias-state-business-primary));text-decoration:none;font-size:12px;line-height:18px;display:inline-flex}
.cc-loginDone{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary))}
.cc-loginError{color:var(--dsw-alias-state-error-primary)}
/* Hover rules gated behind fine-pointer media query so taps never leave stuck hover colours.
 * Invalid borders follow plain borders at equal specificity. */
@media (hover:hover) and (pointer:fine){
.cc-fieldInput:hover:not(:disabled),.cc-selector:hover:not(:disabled){border-color:var(--dsw-alias-label-tertiary)}
.cc-fieldInputInvalid:hover:not(:disabled){border-color:var(--dsw-alias-state-error-primary)}
.cc-iconButton:hover:not(:disabled),.cc-helpButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.cc-iconButtonDanger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.cc-dangerButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
.cc-addButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-label-tertiary)}
.cc-resetLink:hover:not(:disabled),.cc-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.cc-disclosure:hover .cc-foldChevron,.cc-accountToggle:hover .cc-foldChevron{color:var(--dsw-alias-label-primary)}
.cc-loginLink:hover,.cc-statusLink:hover,.cc-statusRetry:hover{text-decoration:underline;text-underline-position:under}
}
/* Reduced motion neutralises movement and press scale while keeping fades and colours. */
@media (prefers-reduced-motion:reduce){
.cc-foldChevron,.cc-rowControl>.cc-switch>span,.cc-usageBarFill,.cc-miniMeterFill{transition:none}
.cc-press,.cc-iconButton,.cc-helpButton,.cc-resetLink,.cc-addButton,.cc-selector{transition:background-color .15s ease,color .15s ease,border-color .15s ease}
.cc-rowControl>.cc-switch{transition:background-color .15s ease}
.cc-press:active:not(:disabled),.cc-iconButton:active:not(:disabled),.cc-helpButton:active:not(:disabled),.cc-resetLink:active:not(:disabled),.cc-addButton:active:not(:disabled),.cc-selector:active:not(:disabled),.cc-switch:active:not(:disabled){transform:none}
.cc-notice,.cc-saveFooter{transition:opacity .18s ease;transform:none}
}
`
