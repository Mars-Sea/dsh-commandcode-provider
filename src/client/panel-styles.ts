/**
 * Stylesheet for the Command Code plans & quota panel (the sidebar footer card
 * and the dashboard it opens).
 *
 * Returned as a string, not injected here, so importing this module has no DOM
 * side effect: `./index.ts` installs it once under {@link PANEL_CSS_ID} and
 * removes it when the fiber unwinds.
 *
 * These rules are GLOBAL CSS, so containment is a contract (issue #48): every
 * selector is qualified by one of our own `ccp-` classes except the sidebar
 * anchor below, which carries its justification in place. `tests/styles.test.ts`
 * audits both stylesheets against the real foreign class stems. Colours are
 * harness theme aliases with neutral fallbacks; the `ccp-` prefix keeps these
 * clear of the settings page's `cc-` set.
 *
 * @module dsh-commandcode-provider/client/panel-styles
 */

/**
 * Stylesheet id — the `data-plugin-css` value that makes injection idempotent.
 *
 * The prefix must match this package's real name and the settings-page sheet's
 * (`PAGE_CSS_ID`); the two ids must also stay DISTINCT, since they key two
 * separate style tags and a shared id would make the second injection a no-op.
 */
export const PANEL_CSS_ID = '@mars-sea/dsh-commandcode-provider/CommandCodePanel.module.css'

/** The panel stylesheet. */
export const PANEL_CSS = `
/* ------------------------------------------------- sidebar footer card */
/* The shell renders this list ABOVE the Settings seat, so the card is the
   sidebar's bottom-most content, and supplies no chrome: the entry IS the
   button. Deliberately quiet — a surface beside Settings should read as part of
   the column — with one hover step and a hairline border.

   The shell's container is a flex ROW whose occupants each declare a full-width
   line and shrink-proof flex, so as a row it would overflow the column: this
   card cannot shrink and the neighbouring chip would absorb the overflow and
   collapse to nothing. The first rule is that fix, and THE ANCHOR IS
   LOAD-BEARING (issue #48): "footerActions" is not a stem this shell owns alone
   — dsh-client-ui-user-questions renders the ask-user-question dialog's button
   row as Mbwy4a_footerActions, and the unanchored rule stacked THAT row's
   side-by-side buttons on every page. "footArea" is declared by
   dsh-client-ui-sidebar alone (audited across every client bundle of the
   0.1.6-alpha.1 engine, and against our own cc-/ccp- names, which collide with
   no engine class). The DESCENDANT combinator survives a wrapper element
   appearing between the two, so a restructured shell degrades to its own row
   rather than losing the fix. tests/styles.test.ts pins both halves. */
[class*="_footArea"] [class*="_footerActions"]{flex-direction:column}
.ccp-foot{box-sizing:border-box;flex:0 0 auto;width:100%;min-width:0;font:inherit;color:var(--dsw-alias-label-secondary);text-align:left;cursor:pointer;background:0 0;border:1px solid transparent;border-radius:10px;flex-direction:column;gap:6px;margin:0 0 4px;padding:8px;display:flex}
.ccp-foot:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2)}
.ccp-foot:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.ccp-footTop{align-items:center;gap:8px;min-width:0;display:flex}
.ccp-footName{white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-primary);min-width:0;overflow:hidden;font-size:13px;font-weight:500;line-height:20px}
/* One block per quota window: a head line carrying the window's own spend and
   limit, then the FULL-WIDTH bar under it. Stacking the two lets the card show
   the dollar figures — the reason this surface exists — without squeezing the
   bar into what is left beside them. Mirrors the dashboard's window block. */
.ccp-footRow{flex-direction:column;gap:4px;min-width:0;display:flex}
.ccp-footHead{align-items:baseline;gap:8px;min-width:0;display:flex}
.ccp-footLabel{flex:1;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px}
.ccp-footAmount{flex:none;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:16px;font-variant-numeric:tabular-nums;white-space:nowrap}
/* The card's markup must stay PHRASING content — it renders inside the shell's
   own button — so these bars are spans, which makes display:block load-bearing:
   an inline box ignores width outright, so the fill would collapse to 0x0 and
   the bar would show no usage. */
.ccp-footBar{display:block;background:var(--dsw-alias-bg-layer-2);border-radius:999px;height:5px;overflow:hidden}
.ccp-footFill{display:block;background:var(--dsw-alias-brand-primary);border-radius:999px;height:100%;transition:width .3s ease}
.ccp-footFillWarn{background:var(--dsw-alias-state-error-primary)}
.ccp-footPct{flex:none;width:34px;color:var(--dsw-alias-label-secondary);text-align:right;font-size:12px;line-height:16px;font-variant-numeric:tabular-nums}

/* The 56px rail: one icon button on the shell's own 36px rail cell, so the
   collapsed column keeps a single 18px glyph like its siblings. */
.ccp-railButton{box-sizing:border-box;width:36px;height:36px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:1px solid transparent;border-radius:8px;flex:none;justify-content:center;align-items:center;margin:0 0 4px;padding:0;display:inline-flex}
.ccp-railButton:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.ccp-railButton:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}

/* The ring glyph, sized entirely by its own width/height attribute, so the
   footer row, the rail button and the dashboard can each ask for their own. */
.ccp-glyph{flex:none;justify-content:center;align-items:center;display:inline-flex;color:var(--dsw-alias-brand-primary)}

/* ------------------------------------------------------------ dashboard */
.ccp-main{background:var(--dsw-alias-bg-layer-1);width:100%;height:100%;overflow:auto;display:block}
.ccp-mainInner{max-width:760px;margin:0 auto;padding:24px 20px 40px;flex-direction:column;gap:14px;display:flex;color:var(--dsw-alias-label-primary)}
.ccp-header{align-items:center;gap:10px;display:flex;flex-wrap:wrap}
.ccp-headerText{flex:1;flex-direction:column;gap:2px;min-width:0;display:flex}
.ccp-title{min-width:0;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:18px;font-weight:600;line-height:1.4}
.ccp-titleRow{align-items:center;gap:8px;min-width:0;flex-wrap:nowrap;display:flex}
/* Four-character service pill: the whole health verdict is one colour, and the
   click opens the official/local detail without giving the header a second
   row. The dot inherits the pill colour, so text and dot always agree. */
.ccp-statusWrap{flex:none;min-width:0;display:inline-flex}
.ccp-statusPill{box-sizing:border-box;align-items:center;gap:5px;height:20px;padding:0 7px;border:1px solid transparent;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;white-space:nowrap;cursor:pointer;display:inline-flex}
.ccp-statusPillOk{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#16a34a) 10%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#16a34a) 30%,transparent);color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#16a34a) 58%,var(--dsw-alias-label-primary,#111827))}
.ccp-statusPillWarn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d97706) 10%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d97706) 30%,transparent);color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d97706) 58%,var(--dsw-alias-label-primary,#111827))}
.ccp-statusPillError{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,transparent);color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 58%,var(--dsw-alias-label-primary,#111827))}
.ccp-statusPillIdle{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.ccp-statusPill:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px}
.ccp-statusDot{flex:none;width:6px;height:6px;border-radius:50%;background:currentColor;color:var(--dsw-alias-label-tertiary);display:inline-block}
.ccp-statusDotOk{color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#16a34a) 58%,var(--dsw-alias-label-primary,#111827))}
.ccp-statusDotWarn{color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d97706) 58%,var(--dsw-alias-label-primary,#111827))}
.ccp-statusDotError{color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 58%,var(--dsw-alias-label-primary,#111827))}
.ccp-statusDotChecking{color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 58%,var(--dsw-alias-label-primary,#111827))}
.ccp-statusDotIdle,.ccp-statusDotMuted{color:var(--dsw-alias-label-secondary)}
.ccp-statusPill .ccp-statusDot{color:inherit;background:currentColor}
.ccp-statusGlyph{flex:none}
.ccp-statusPop[hidden]{display:none}
.ccp-statusPop{position:fixed;z-index:20;box-sizing:border-box;overflow:auto;width:300px;max-width:calc(100vw - 24px);padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;flex-direction:column;gap:6px;display:flex}
.ccp-statusBody{grid-template-columns:max-content minmax(0,1fr);column-gap:8px;row-gap:6px;align-items:baseline;display:grid}
.ccp-statusRow{min-width:0;display:contents}
.ccp-statusKey{color:var(--dsw-alias-label-secondary);white-space:nowrap}
.ccp-statusValue{flex-wrap:wrap;align-items:center;gap:5px;min-width:0;font-variant-numeric:tabular-nums;display:flex}
.ccp-statusVerdict{color:var(--dsw-alias-label-primary)}
.ccp-statusWarn{color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d97706) 58%,var(--dsw-alias-label-primary,#111827))}
.ccp-statusMeta{grid-column:2;margin:0;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.ccp-statusNotice{grid-column:2;margin:0;color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d97706) 58%,var(--dsw-alias-label-primary,#111827))}
.ccp-statusActions{justify-content:flex-end;align-items:center;gap:10px;margin-top:2px;display:flex}
.ccp-statusAction{align-items:center;gap:3px;padding:0;border:0;background:0 0;color:color-mix(in srgb,var(--dsw-alias-link,var(--dsw-alias-state-business-primary)) 82%,var(--dsw-alias-label-primary,#111827));font:inherit;font-size:12px;line-height:18px;text-decoration:none;white-space:nowrap;cursor:pointer;display:inline-flex}
.ccp-statusAction:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px;border-radius:4px}
.ccp-statusOpen{align-items:center;gap:3px;height:28px;padding:0 9px;border:1px solid var(--dsw-alias-border-l4);border-radius:8px;background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;text-decoration:none;white-space:nowrap;display:inline-flex}
.ccp-statusOpen:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px}
.ccp-subtitle{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
.ccp-spacer{flex:1}
.ccp-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;font-variant-numeric:tabular-nums}
/* 关闭图标沿用原语义与按钮尺寸，线性 SVG 随宿主文字颜色变化。 */
.ccp-close{min-width:28px;justify-content:center;padding-left:0;padding-right:0}
.ccp-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}

.ccp-notice{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:12px 14px;flex-direction:column;gap:4px;display:flex}
.ccp-noticeError{border-color:var(--dsw-alias-state-error-primary)}
.ccp-noticeTitle{margin:0;font-size:13px;font-weight:600;line-height:1.5}
.ccp-noticeError .ccp-noticeTitle{color:var(--dsw-alias-state-error-primary)}
.ccp-noticeHint{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.55}
.ccp-noticeDetail{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;word-break:break-word}

.ccp-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:14px;padding:16px 18px;flex-direction:column;gap:16px;display:flex}
.ccp-cardHead{align-items:center;gap:10px;display:flex;flex-wrap:wrap}
.ccp-avatar{flex:none;width:28px;height:28px;color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-module-platform);border-radius:50%;justify-content:center;align-items:center;font-size:12px;font-weight:600;line-height:1;display:inline-flex}
.ccp-cardIdentity{flex-direction:column;gap:1px;min-width:0;display:flex}
.ccp-cardTitle{font-size:13px;font-weight:600;line-height:1.4}
.ccp-cardOwner{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px}
.ccp-block{flex-direction:column;gap:8px;display:flex}
.ccp-blockTitle{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:600;line-height:1.5;text-transform:uppercase;letter-spacing:.04em}
.ccp-planRow{align-items:center;gap:8px;display:flex;flex-wrap:wrap}
.ccp-fieldLabel{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
.ccp-planName{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:1.5}

/* The monthly credits and the usage totals share one grid. */
.ccp-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}
.ccp-tile{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:8px;padding:8px 10px;flex-direction:column;gap:2px;display:flex;min-width:0}
.ccp-tileLabel{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
.ccp-tileValue{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4;font-variant-numeric:tabular-nums}
.ccp-tileSub{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* Quota bars: the monthly bar and the two windows. */
.ccp-windows{flex-direction:column;gap:14px;display:flex}
.ccp-window{flex-direction:column;gap:6px;display:flex}
.ccp-windowHead{align-items:baseline;gap:8px;display:flex}
.ccp-windowLabel{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:1.5}
.ccp-windowValue{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;font-variant-numeric:tabular-nums;white-space:nowrap}
.ccp-windowPct{color:var(--dsw-alias-label-primary);min-width:38px;text-align:right;font-size:12px;font-weight:600;line-height:1.5;font-variant-numeric:tabular-nums}
.ccp-warnTag{white-space:nowrap;background:var(--dsw-alias-state-warn-tertiary,var(--dsw-alias-bg-module-platform));color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-label-secondary));border-radius:999px;padding:0 8px;font-size:12px;font-weight:600;line-height:17px}
.ccp-bar{overflow:hidden;background:var(--dsw-alias-bg-layer-1);border-radius:999px;height:8px}
.ccp-barFill{background:var(--dsw-alias-brand-primary);border-radius:999px;height:100%;transition:width .3s ease}
.ccp-barFillWarn{background:var(--dsw-alias-state-error-primary)}
.ccp-windowReset{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}

.ccp-badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-brand-primary);border-radius:999px;padding:1px 8px;font-size:12px;font-weight:600;line-height:17px}
.ccp-badgeError{background:transparent;color:var(--dsw-alias-state-error-primary)}
.ccp-badgeWarn{background:var(--dsw-alias-state-warn-tertiary,var(--dsw-alias-bg-module-platform));color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-label-secondary))}
.ccp-badgeMuted{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:12px;font-weight:500;line-height:17px;max-width:220px;overflow:hidden;text-overflow:ellipsis}

/* Account switch: plain buttons, like the settings page's usage carousel. */
.ccp-tabs{flex-wrap:wrap;gap:6px;display:flex}
.ccp-tab{align-items:center;font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:2px 10px;font-size:12px;line-height:18px;display:inline-flex;gap:6px}
.ccp-tab:hover:not(.ccp-tabActive){color:var(--dsw-alias-label-primary)}
.ccp-tabActive{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary)}

@media (hover:hover) and (pointer:fine){
.ccp-statusOpen:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ccp-statusAction:hover{text-decoration:underline;text-underline-position:under}
}
@media (prefers-reduced-motion:reduce){.ccp-footFill,.ccp-barFill{transition:none}}
/* 分析页继承设置页和宿主控件的语义变量；独立选择器不影响账号额度页面。 */
.ccp-mainInnerAnalysis{max-width:1040px;box-sizing:border-box}
/* 宿主侧栏会缩窄中心面板，按实际可用宽度切换列数，而不是仅看浏览器宽度。 */
.ccp-analysis{font-size:14px;line-height:22px;min-width:0;color:var(--dsw-alias-label-primary);container-type:inline-size;container-name:ccp-analysis}
.ccp-analysisFilters{display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;margin:8px 0 20px}
.ccp-analysisField{display:flex;flex-direction:column;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);min-width:0}
.ccp-analysisFilters .ccp-analysisField{flex:0 1 158px}
.ccp-analysisFilters .ccp-analysisScopeField{flex-basis:184px}
.ccp-analysisFilters .ccp-analysisDateField{flex-basis:166px}
/* 对齐原生选择器、日期输入与按钮的边框盒；保留独立箭头留白和点击区域。 */
.ccp-analysisInput{box-sizing:border-box;width:100%;min-width:0;height:36px;padding:0 11px;font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l4);border-radius:8px}
.ccp-analysisSelectShell{position:relative;display:block;width:100%;min-width:0}
.ccp-analysisSelect{appearance:none;-webkit-appearance:none;padding-inline-end:40px;text-overflow:ellipsis;cursor:pointer;border:0;border-radius:18px;background:var(--dsw-alias-bg-module-platform)}
.ccp-analysisSelectShell > .ccp-analysisChevron{position:absolute;inset-inline-end:12px;top:50%;transform:translateY(-50%) rotate(90deg);pointer-events:none}
.ccp-analysisSelect:disabled + .ccp-analysisChevron{opacity:.6}
.ccp-analysisInput::placeholder{color:var(--dsw-alias-label-tertiary)}
.ccp-analysisApply{box-sizing:border-box;flex:none;height:36px;font:inherit;font-size:14px;line-height:22px;white-space:nowrap;padding:0 20px;border:0;border-radius:var(--dsw-radius-md,18px);background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);cursor:pointer;margin-left:2px}
.ccp-analysisApply:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.ccp-analysisApply:disabled{opacity:.4;cursor:wait}
.ccp-analysisInput:disabled{opacity:.6}
.ccp-analysisInput:focus-visible,.ccp-analysisApply:focus-visible,.ccp-analysisTab:focus-visible,.ccp-analysisPanel:focus-visible,.ccp-analysisModelSummary:focus-visible,.ccp-analysisScenarioSummary:focus-visible,.ccp-analysisDisclosure:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}
/* 模型列表会裁切圆角，内收焦点框以保持第一行和最后一行也清晰可见。 */
.ccp-analysisModelSummary:focus-visible,.ccp-analysisScenarioSummary:focus-visible{outline-offset:-3px;border-radius:6px}
.ccp-analysisScope{display:flex;justify-content:space-between;gap:8px 18px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin-bottom:12px}
.ccp-analysisScope > span:first-child{color:var(--dsw-alias-label-primary);font-weight:500}
.ccp-analysisOverview{display:grid;grid-template-columns:1.45fr repeat(3,1fr);gap:20px;padding:16px 18px;background:var(--dsw-alias-bg-layer-3);border:.5px solid var(--dsw-alias-border-l4);border-radius:16px;font-variant-numeric:tabular-nums}
.ccp-analysisMetric{display:flex;flex-direction:column;gap:3px;min-width:0}
.ccp-analysisLabel{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);font-weight:400}
.ccp-analysisValue{font-size:14px;line-height:22px;font-weight:500;overflow-wrap:anywhere}
.ccp-analysisSub{display:block;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-weight:400;overflow-wrap:anywhere}
.ccp-analysisOverview .ccp-analysisMetric{gap:5px}
.ccp-analysisOverview .ccp-analysisValue{font-size:20px;line-height:28px;font-weight:500}
.ccp-analysisNote{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin:9px 0 0}
.ccp-analysisMessage{margin:12px 0 0;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l4);border-radius:12px;background:var(--dsw-alias-bg-layer-3);font-size:14px;line-height:22px}
.ccp-analysisWarning{display:flex;align-items:flex-start;gap:8px}
.ccp-analysisIcon{flex:none}
.ccp-analysisWarning > .ccp-analysisIcon{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-secondary));margin-top:3px}
.ccp-analysisWarning p{margin:0}
.ccp-analysisWarning p + p{margin-top:5px}
.ccp-analysisError{color:var(--dsw-alias-state-error-primary)}
/* 沿用宿主分段控件的轨道、浮层与胶囊尺寸，保留原有页签键盘语义。 */
.ccp-analysisTabs{box-sizing:border-box;display:inline-grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:2px;padding:4px;border:0;border-radius:var(--dsw-radius-md,18px);background:var(--dsw-alias-interactive-bg-hover);margin:22px 0 0;max-width:100%}
.ccp-analysisTab{height:28px;padding:0 16px;border:0;border-radius:var(--dsw-radius-sm,14px);background:transparent;font:inherit;font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-secondary);white-space:nowrap;cursor:pointer}
.ccp-analysisTab:hover,.ccp-analysisTab[aria-selected="true"]{color:var(--dsw-alias-label-primary)}
.ccp-analysisTab[aria-selected="true"]{background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft)}
.ccp-analysisTabCount{display:inline-flex;justify-content:center;min-width:16px;padding:0 4px;margin-left:6px;border-radius:999px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.ccp-analysisPanel{padding-top:20px;min-width:0}
.ccp-analysisPanel[hidden]{display:none}
.ccp-analysisSectionHead{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px}
.ccp-analysisHeading{font-size:14px;line-height:22px;font-weight:500;margin:0}
.ccp-analysisSectionHead .ccp-analysisNote{margin:0;max-width:56ch}
.ccp-analysisModels{border:.5px solid var(--dsw-alias-border-l4);border-radius:16px;overflow:hidden}
.ccp-analysisModelRow + .ccp-analysisModelRow{border-top:.5px solid var(--dsw-alias-border-l2)}
.ccp-analysisTableHead,.ccp-analysisModelSummary,.ccp-analysisScenarioSummary{position:relative;display:grid;grid-template-columns:minmax(190px,2.1fr) minmax(150px,1.45fr) minmax(90px,.9fr) minmax(90px,.9fr) minmax(100px,1fr) 16px;gap:18px;align-items:center;padding:16px 18px;font-variant-numeric:tabular-nums}
.ccp-analysisTableHead{padding-top:11px;padding-bottom:11px;background:var(--dsw-alias-interactive-bg-hover);border-bottom:.5px solid var(--dsw-alias-border-l2);font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.ccp-analysisTableHead > span:not(:first-child){text-align:right}
.ccp-analysisScenarioHead,.ccp-analysisScenarioSummary{grid-template-columns:minmax(190px,2fr) minmax(118px,1.1fr) minmax(155px,1.35fr) minmax(142px,1.15fr) 16px}
.ccp-analysisModelSummary,.ccp-analysisScenarioSummary{cursor:pointer;list-style:none;min-height:60px}
.ccp-analysisModelSummary::-webkit-details-marker,.ccp-analysisScenarioSummary::-webkit-details-marker,.ccp-analysisDisclosure::-webkit-details-marker{display:none}
.ccp-analysisModelSummary:hover,.ccp-analysisScenarioSummary:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ccp-analysisIdentity{display:flex;flex-direction:column;gap:2px;min-width:0}
.ccp-analysisModelName{font-size:14px;line-height:22px;font-weight:500;overflow-wrap:anywhere}
.ccp-analysisModelCount{margin-top:3px}
.ccp-analysisModelSummary > .ccp-analysisMetric,.ccp-analysisScenarioSummary > .ccp-analysisMetric{align-items:flex-end}
/* 宽表使用集中表头，但保留每个指标的无障碍标签；窄面板恢复可见标签。 */
.ccp-analysisModelSummary .ccp-analysisMetricLabel,.ccp-analysisScenarioSummary .ccp-analysisMetricLabel,.ccp-analysisSearchLabel{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.ccp-analysisShare{display:flex;align-items:center;gap:8px;width:100%;max-width:148px;margin-top:3px}
.ccp-analysisShareTrack{display:block;flex:1;height:4px;overflow:hidden;background:var(--dsw-alias-bg-module-platform);border-radius:999px}
.ccp-analysisShareFill{display:block;height:100%;background:var(--dsw-alias-label-secondary);border-radius:999px}
.ccp-analysisShareValue{font-size:12px;line-height:18px;min-width:40px;text-align:right;color:var(--dsw-alias-label-tertiary)}
.ccp-analysisChevron{flex:none;color:var(--dsw-alias-label-tertiary)}
.ccp-analysisModelRow[open] > .ccp-analysisModelSummary > .ccp-analysisChevron,.ccp-analysisModelRow[open] > .ccp-analysisScenarioSummary > .ccp-analysisChevron,.ccp-analysisAggregate[open] > .ccp-analysisDisclosure > .ccp-analysisChevron,.ccp-analysisRules[open] > .ccp-analysisDisclosure > .ccp-analysisChevron{transform:rotate(90deg)}
.ccp-analysisDetails{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:22px;padding:16px 18px;background:var(--dsw-alias-bg-module-platform);border-top:.5px solid var(--dsw-alias-border-l2)}
.ccp-analysisDetailTitle{font-size:12px;line-height:18px;font-weight:600;margin:0 0 11px}
.ccp-analysisFacts{margin:0;display:flex;flex-direction:column;gap:8px}
.ccp-analysisFact{display:flex;align-items:baseline;justify-content:space-between;gap:10px;min-width:0}
.ccp-analysisFactValue{font-size:14px;line-height:22px;margin:0;text-align:right;font-variant-numeric:tabular-nums;overflow-wrap:anywhere;min-width:0}
.ccp-analysisFact .ccp-analysisLabel{flex-shrink:0}
.ccp-analysisFooter{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap;margin-top:14px}
.ccp-analysisAggregate{flex:1;min-width:210px}
.ccp-analysisAggregate > .ccp-analysisDetails{border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;margin-top:6px}
.ccp-analysisDisclosure{display:flex;gap:7px;align-items:center;cursor:pointer;list-style:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);padding:7px 0}
.ccp-analysisDisclosure > .ccp-analysisChevron{width:14px;height:14px}
.ccp-analysisMonthly{flex:none;max-width:340px;display:flex;justify-content:flex-end;flex-wrap:wrap;gap:2px 8px;align-items:baseline;text-align:right;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);padding-top:5px}
.ccp-analysisMonthlyValue{font-size:14px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.ccp-analysisMonthly .ccp-analysisNote{width:100%;margin:0}
.ccp-analysisAssumption{font-size:14px;line-height:22px;color:var(--dsw-alias-label-tertiary);margin:0 0 18px;max-width:76ch}
.ccp-analysisBaseline{margin:0 0 16px}
.ccp-analysisSearch{flex:0 1 270px}
.ccp-analysisSearchShell{position:relative;display:block}
.ccp-analysisSearchShell > .ccp-analysisIcon{position:absolute;top:10px;left:11px;color:var(--dsw-alias-label-tertiary);pointer-events:none}
.ccp-analysisSearch .ccp-analysisInput{padding-left:35px}
.ccp-analysisScenarioDetails{grid-template-columns:minmax(0,1fr) minmax(0,2fr)}
.ccp-analysisScenarioDetails .ccp-analysisFactValue{max-width:70%}
.ccp-analysisEmpty{font-size:14px;line-height:22px;color:var(--dsw-alias-label-tertiary);text-align:center;padding:34px 18px;margin:0;border:1px dashed var(--dsw-alias-border-l4);border-radius:8px}
.ccp-analysisRules{margin-top:22px;border-top:.5px solid var(--dsw-alias-border-l2);padding-top:8px}
.ccp-analysisRulesBody{display:grid;grid-template-columns:1fr 1fr;gap:24px;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:22px;margin-top:9px}
.ccp-analysisRulesBody p{margin:0 0 10px}
@container ccp-analysis (max-width:920px){
.ccp-analysisTableHead{display:none}
.ccp-analysisModelSummary{grid-template-columns:repeat(4,minmax(0,1fr)) 16px;gap:12px 18px}
.ccp-analysisScenarioSummary{grid-template-columns:repeat(3,minmax(0,1fr)) 16px;gap:12px 18px}
.ccp-analysisModelSummary > .ccp-analysisIdentity,.ccp-analysisScenarioSummary > .ccp-analysisIdentity{grid-column:1/-2}
.ccp-analysisModelSummary > .ccp-analysisChevron{grid-column:5;grid-row:1;justify-self:end}
.ccp-analysisScenarioSummary > .ccp-analysisChevron{grid-column:4;grid-row:1;justify-self:end}
.ccp-analysisModelSummary > .ccp-analysisMetric,.ccp-analysisScenarioSummary > .ccp-analysisMetric{align-items:flex-start}
.ccp-analysisModelSummary .ccp-analysisMetricLabel,.ccp-analysisScenarioSummary .ccp-analysisMetricLabel{position:static;width:auto;height:auto;padding:0;margin:0;overflow:visible;clip:auto;white-space:normal}
.ccp-analysisDetails{grid-template-columns:repeat(2,minmax(0,1fr))}
}
@container ccp-analysis (max-width:588px){
.ccp-analysisFilters{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.ccp-analysisFilters[data-mode="range"] .ccp-analysisScopeField{grid-column:1/-1}
.ccp-analysisApply{grid-column:1/-1;margin:0;width:100%}
.ccp-analysisOverview{grid-template-columns:repeat(2,minmax(0,1fr));gap:20px 18px;padding:16px}
.ccp-analysisModelSummary,.ccp-analysisScenarioSummary{grid-template-columns:repeat(2,minmax(0,1fr));gap:15px 18px;padding:16px}
.ccp-analysisModelSummary > .ccp-analysisIdentity,.ccp-analysisScenarioSummary > .ccp-analysisIdentity{grid-column:1/-1;padding-right:24px}
.ccp-analysisModelSummary > .ccp-analysisChevron,.ccp-analysisScenarioSummary > .ccp-analysisChevron{position:absolute;top:18px;right:16px;grid-column:auto;grid-row:auto}
.ccp-analysisDetails,.ccp-analysisScenarioDetails{gap:20px;grid-template-columns:1fr;padding:16px}
.ccp-analysisAggregate{width:100%;min-width:0}
.ccp-analysisMonthly{width:100%;max-width:none;justify-content:flex-start;text-align:left;padding-top:0}
.ccp-analysisSectionHead{align-items:flex-start}
.ccp-analysisSectionHead .ccp-analysisSearch{flex-basis:100%;width:100%;order:2}
.ccp-analysisRulesBody{grid-template-columns:1fr;gap:12px}
/* 英文页签带数量时允许换行，避免轨道或文字撑出宿主的窄面板。 */
.ccp-analysisTabs{margin-top:18px;grid-auto-columns:minmax(0,1fr)}
.ccp-analysisTab{height:auto;min-height:28px;padding:4px 8px;white-space:normal}
}
@media (max-width:640px){.ccp-mainInnerAnalysis{padding:20px 16px 32px}}
`
