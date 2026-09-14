/**
 * Stylesheet for the Command Code plans & quota panel (the sidebar footer card
 * and the dashboard it opens).
 *
 * Returned as a string rather than injected here so the modules stay free of
 * DOM side effects at import time — the client entry installs it once, keyed
 * by the same `data-plugin-css` attribute the settings-page stylesheet uses,
 * and removes it again when the plugin's fiber unwinds.
 *
 * Every colour comes from a harness theme alias with a neutral fallback, so
 * the panel follows the active theme (light/dark and any brand pack) without
 * hardcoded values. Classes are `ccp-` prefixed to stay clear of the settings
 * page's `cc-` set.
 *
 * @module dsh-commandcode-provider/client/panel-styles
 */

/** Stylesheet id (the `data-plugin-css` value that makes injection idempotent). */
export const PANEL_CSS_ID = '@xer-on/dsh-commandcode-provider/CommandCodePanel.module.css'

/** The panel stylesheet. */
export const PANEL_CSS = `
/* ------------------------------------------------- sidebar footer card */
/* The shell's foot area renders this list ABOVE the Settings seat, so the card
   is the sidebar's bottom-most content. The shell supplies no chrome: the entry
   is the button. It is deliberately quiet — a surface that sits beside Settings
   should read as part of the column, not as a call to action — with one hover
   step and a hairline border.

   The shell's container is a flex ROW whose occupants (this card and ui-cordis's
   footer chip) each declare a full-width line and shrink-proof flex, so as a row
   it would overflow the column. Both were written for a full-width line, which
   is exactly what a column gives them. Matched by the CSS-module class STEM —
   never a hashed name — so a dsh that renames it degrades to the shell's own
   row rather than breaking. */
[class*="_footerActions"]{flex-direction:column}
.ccp-foot{box-sizing:border-box;flex:0 0 auto;width:100%;min-width:0;font:inherit;color:var(--dsw-alias-label-secondary);text-align:left;cursor:pointer;background:0 0;border:1px solid transparent;border-radius:10px;flex-direction:column;gap:6px;margin:0 0 4px;padding:8px;display:flex}
.ccp-foot:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2)}
.ccp-foot:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.ccp-footTop{align-items:center;gap:8px;min-width:0;display:flex}
.ccp-footName{white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-primary);min-width:0;overflow:hidden;font-size:13px;font-weight:500;line-height:20px}
/* One block per quota window: a head line carrying the window's own spend and
   limit, then the FULL-WIDTH bar under it. Stacking the two lets the card show
   the dollar figures — the reason this surface exists — without squeezing the
   bar into what is left beside them. Mirrors the dashboard's own window block. */
.ccp-footRow{flex-direction:column;gap:4px;min-width:0;display:flex}
.ccp-footHead{align-items:baseline;gap:8px;min-width:0;display:flex}
.ccp-footLabel{flex:1;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.ccp-footAmount{flex:none;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums;white-space:nowrap}
/* The card's markup must stay PHRASING content — it renders inside the shell's
   own button — so these bars are spans, not divs. That makes display:block
   load-bearing on BOTH: an inline box ignores width and height outright, so
   without it the 5px track still painted (a flex item is blockified by its
   container) while the fill collapsed to 0x0 and the bar showed no usage. */
.ccp-footBar{display:block;background:var(--dsw-alias-bg-layer-2);border-radius:999px;height:5px;overflow:hidden}
.ccp-footFill{display:block;background:var(--dsw-alias-brand-primary);border-radius:999px;height:100%;transition:width .3s ease}
.ccp-footFillWarn{background:var(--dsw-alias-state-error-primary)}
.ccp-footPct{flex:none;width:34px;color:var(--dsw-alias-label-secondary);text-align:right;font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}

/* The 56px rail: one icon button on the shell's own rail geometry (36px cell),
   so the collapsed column keeps a single 18px glyph like its siblings. */
.ccp-railButton{box-sizing:border-box;width:36px;height:36px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:1px solid transparent;border-radius:8px;flex:none;justify-content:center;align-items:center;margin:0 0 4px;padding:0;display:inline-flex}
.ccp-railButton:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.ccp-railButton:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}

/* The ring glyph. Sized entirely by its own width/height attribute, so the
   footer row, the rail button and the dashboard can each ask for their own. */
.ccp-glyph{flex:none;justify-content:center;align-items:center;display:inline-flex;color:var(--dsw-alias-brand-primary)}

/* ------------------------------------------------------------ dashboard */
/* The center column in the layout frame: fill it, scroll the content column,
   and cap the reading width like the harness's own panels. */
.ccp-main{background:var(--dsw-alias-bg-layer-1);width:100%;height:100%;overflow:auto;display:block}
.ccp-mainInner{max-width:760px;margin:0 auto;padding:24px 20px 40px;flex-direction:column;gap:14px;display:flex;color:var(--dsw-alias-label-primary)}
.ccp-header{align-items:center;gap:10px;display:flex;flex-wrap:wrap}
.ccp-headerText{flex-direction:column;gap:2px;display:flex;min-width:0}
.ccp-title{margin:0;font-size:18px;font-weight:600;line-height:1.4}
.ccp-subtitle{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
.ccp-spacer{flex:1}
.ccp-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5;font-variant-numeric:tabular-nums}
.ccp-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}

/* Notices: the no-key guidance, a blocked report, and a stale-data error. */
.ccp-notice{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:12px 14px;flex-direction:column;gap:4px;display:flex}
.ccp-noticeError{border-color:var(--dsw-alias-state-error-primary)}
.ccp-noticeTitle{margin:0;font-size:13px;font-weight:600;line-height:1.5}
.ccp-noticeError .ccp-noticeTitle{color:var(--dsw-alias-state-error-primary)}
.ccp-noticeHint{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.55}
.ccp-noticeDetail{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5;word-break:break-word}

.ccp-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:14px;padding:16px 18px;flex-direction:column;gap:16px;display:flex}
.ccp-cardHead{align-items:center;gap:10px;display:flex;flex-wrap:wrap}
.ccp-avatar{flex:none;width:28px;height:28px;color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-module-platform);border-radius:50%;justify-content:center;align-items:center;font-size:12px;font-weight:600;line-height:1;display:inline-flex}
.ccp-cardIdentity{flex-direction:column;gap:1px;min-width:0;display:flex}
.ccp-cardTitle{font-size:13px;font-weight:600;line-height:1.4}
.ccp-cardOwner{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px}
.ccp-block{flex-direction:column;gap:8px;display:flex}
.ccp-blockTitle{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:600;line-height:1.5;text-transform:uppercase;letter-spacing:.04em}
.ccp-planRow{align-items:center;gap:8px;display:flex;flex-wrap:wrap}
.ccp-fieldLabel{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
.ccp-planName{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:1.5}

/* Stat tiles: the monthly credits and the usage totals share one grid. */
.ccp-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}
.ccp-tile{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:8px;padding:8px 10px;flex-direction:column;gap:2px;display:flex;min-width:0}
.ccp-tileLabel{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5}
.ccp-tileValue{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4;font-variant-numeric:tabular-nums}
.ccp-tileSub{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* Quota bars: the monthly bar and the two windows stack in one column, each a
   label row plus the track. */
.ccp-windows{flex-direction:column;gap:14px;display:flex}
.ccp-window{flex-direction:column;gap:6px;display:flex}
.ccp-windowHead{align-items:baseline;gap:8px;display:flex}
.ccp-windowLabel{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:1.5}
.ccp-windowValue{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;font-variant-numeric:tabular-nums;white-space:nowrap}
.ccp-windowPct{color:var(--dsw-alias-label-primary);min-width:38px;text-align:right;font-size:12px;font-weight:600;line-height:1.5;font-variant-numeric:tabular-nums}
.ccp-warnTag{white-space:nowrap;background:var(--dsw-alias-state-warn-tertiary,var(--dsw-alias-bg-module-platform));color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-label-secondary));border-radius:999px;padding:0 8px;font-size:11px;font-weight:600;line-height:17px}
.ccp-bar{overflow:hidden;background:var(--dsw-alias-bg-layer-1);border-radius:999px;height:8px}
.ccp-barFill{background:var(--dsw-alias-brand-primary);border-radius:999px;height:100%;transition:width .3s ease}
.ccp-barFillWarn{background:var(--dsw-alias-state-error-primary)}
.ccp-windowReset{color:var(--dsw-alias-label-tertiary);margin:0;font-size:11px;line-height:1.5}

/* Badges. */
.ccp-badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-brand-primary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:600;line-height:17px}
.ccp-badgeError{background:transparent;color:var(--dsw-alias-state-error-primary)}
.ccp-badgeWarn{background:var(--dsw-alias-state-warn-tertiary,var(--dsw-alias-bg-module-platform));color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-label-secondary))}
.ccp-badgeMuted{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px;max-width:220px;overflow:hidden;text-overflow:ellipsis}

/* Account switch: plain buttons, like the settings page's usage carousel. */
.ccp-tabs{flex-wrap:wrap;gap:6px;display:flex}
.ccp-tab{align-items:center;font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:2px 10px;font-size:12px;line-height:18px;display:inline-flex;gap:6px}
.ccp-tab:hover:not(.ccp-tabActive){color:var(--dsw-alias-label-primary)}
.ccp-tabActive{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary)}

@media (prefers-reduced-motion:reduce){.ccp-footFill,.ccp-barFill{transition:none}}
`
