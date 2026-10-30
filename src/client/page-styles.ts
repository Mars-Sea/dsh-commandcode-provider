/**
 * Stylesheet for the Command Code settings page — and the Models-page provider
 * card, which shares its `cc-` classes.
 *
 * Returned as a string, not injected here, so importing this module has no DOM
 * side effect: `./index.ts` installs it once under {@link PAGE_CSS_ID}. It is a
 * module of its own rather than a literal in the entry so `tests/styles.test.ts`
 * can audit every rule without importing the React tree (which pulls
 * `*.module.css` through the primitives package and needs a loader registered
 * first). The rules are GLOBAL CSS, so containment is a contract (issue #48):
 * every selector is qualified by one of our own `cc-` classes. Colours are
 * harness theme aliases with neutral fallbacks, and the `cc-` prefix keeps
 * these clear of the panel's `ccp-` set.
 *
 * @module dsh-commandcode-provider/client/page-styles
 */

/**
 * Stylesheet id — the `data-plugin-css` value that makes injection idempotent.
 *
 * The prefix must match this package's real name and the panel stylesheet's
 * (`PANEL_CSS_ID`); the two ids must also stay DISTINCT, since they key two
 * separate style tags and a shared id would make the second injection a no-op.
 */
export const PAGE_CSS_ID = '@mars-sea/dsh-commandcode-provider/CommandCodeSettingsPage.module.css'

/**
 * The settings-page stylesheet.
 *
 * Every size is the design canvas's (the cc-kit.css of the "CommandCode 设置页
 * 重设计" artboards, 2026-10-21, as revised by the 2026-10-29 card redesign):
 * a row is 14px of vertical padding with a .5px hairline between rows, title
 * 14/22, description 12/18, a 24px gap to the control; a group is a 16px-radius
 * card on the raised surface with a 1px border-l2 stroke, its heading 52px
 * high; the page title is 22/28 and group titles 15/22, both 600. The page
 * renders with grayscale antialiasing and descriptive text in label-secondary.
 * A status strip under the header (account health, monthly remainder, service
 * status, model scope) reuses the groups' own summary strings, so it adds no
 * locale keys and cannot disagree with the card below it.
 *
 * Motion (2026-10-29): anything pressable scales on :active (0.97, the 20–28px
 * icon buttons 0.95) over 160ms of one strong ease-out,
 * cubic-bezier(.23,1,.32,1), which the fold chevron, save bar, usage bar,
 * card entrance and notice entrance share; colour and border changes fade over
 * 150ms `ease`. Only transform, opacity and colours animate — never layout.
 * Every :hover rule sits in the one `(hover:hover) and (pointer:fine)` block at
 * the end, so a tap on a touch screen does not leave a stuck hover colour;
 * :active stays outside it, since a press needs feedback on touch too. Folding
 * a group or an account card stays instant: it happens too often to be worth a
 * wait, and a hidden body keeps its `aria-controls` target mounted.
 *
 * Shapes follow one rule — clickable things are pills, fillable things are
 * 8px. Buttons are drawn here (PageButton → cc-btn: md 32px, sm 28px, lg 36px
 * for the save bar), not taken from the harness primitive. Inputs and the
 * model selector are 32px with a 1px border-l3 stroke on the raised surface; a
 * number field draws its unit inside the box (cc-unitBox). Account cards and
 * the per-model override table are 1px border-l2 cards with 12px corners;
 * panels and notices are 12px-radius fills; badges are 20px pills. Errors use
 * state-error-primary; tinted surfaces fall back to a color-mix of the state
 * colour where the theme has no tertiary token. The Models-page provider card
 * shares cc-hint / cc-badgeMuted / cc-input and keeps their colours.
 */
export const PAGE_CSS = `
.cc-section{max-width:720px;color:var(--dsw-alias-label-primary);flex-direction:column;display:flex;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;--cc-ease-out:cubic-bezier(.23,1,.32,1)}
.cc-title{margin:0;color:var(--dsw-alias-label-primary);font-size:22px;font-weight:700;line-height:28px}
.cc-intro{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:22px}
/* The glanceable header strip: four cells (account health, monthly remainder,
 * service status, model scope) on one card. Labels reuse cc-statusLabel and
 * dots reuse cc-tabDot, so no new colour language is introduced; the strip
 * folds to 2 × 2 in a narrow panel. */
.cc-statusStrip{grid-template-columns:repeat(4,minmax(0,1fr));gap:0;display:grid;margin-top:16px;border:1px solid var(--dsw-alias-border-l2);border-radius:16px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 1px 2px rgba(0,0,0,.04)}
.cc-statusCell{flex-direction:column;gap:2px;min-width:0;display:flex;padding:14px 16px}
.cc-statusCell+.cc-statusCell{border-left:1px solid var(--dsw-alias-border-l2)}
.cc-statusHead{align-items:center;gap:6px;display:flex}
.cc-statusStripValue{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:22px}
.cc-statusSub{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
@media (max-width:560px){.cc-statusStrip{grid-template-columns:repeat(2,minmax(0,1fr))}.cc-statusCell:nth-child(3){border-left:0}.cc-statusCell:nth-child(n+3){border-top:1px solid var(--dsw-alias-border-l2)}}
.cc-spacer{flex:1}
/* Groups are cards now (2026-10-29 redesign): a 16px-radius raised surface
 * with a border-l2 stroke, 16px between cards, no divider rules. The entrance
 * is a @starting-style rise with a 40ms stagger per card — transitions, not
 * keyframes, so a re-render never replays it. */
.cc-group{flex-direction:column;display:flex;margin-top:16px;border:1px solid var(--dsw-alias-border-l2);border-radius:16px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 1px 2px rgba(0,0,0,.04);transition:opacity 320ms var(--cc-ease-out),transform 320ms var(--cc-ease-out)}
@starting-style{.cc-group{opacity:0;transform:translateY(8px)}}
.cc-section>section:nth-of-type(1){transition-delay:0ms}
.cc-section>section:nth-of-type(2){transition-delay:40ms}
.cc-section>section:nth-of-type(3){transition-delay:80ms}
.cc-section>section:nth-of-type(4){transition-delay:120ms}
.cc-section>section:nth-of-type(5){transition-delay:160ms}
.cc-groupHead{align-items:center;gap:8px;display:flex;min-height:52px;padding:0 16px}
.cc-groupTitle{margin:0;color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:22px}
.cc-groupDesc{margin:2px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.cc-rows>.cc-groupDesc{margin:0 16px}
/* A block straight under a group's description (the account list, its
 * notices, the override table) keeps the same 12px as the account-mode line
 * and the actions row inside the card; a setting row brings its own 12px
 * padding instead. */
.cc-rows>.cc-groupDesc+.cc-notices,.cc-rows>.cc-groupDesc+.cc-accountList,.cc-rows>.cc-groupDesc+.cc-contextTable{margin-top:12px}
.cc-groupHeading{flex:1;min-width:0;margin:0;font:inherit;display:flex}
/* The whole heading row is the fold toggle: chevron, title, summary badges. */
.cc-disclosure{box-sizing:border-box;flex-wrap:wrap;flex:1;align-items:center;gap:6px 8px;min-width:0;min-height:52px;padding:0;border:0;background:0 0;color:inherit;font:inherit;text-align:left;cursor:pointer;border-radius:8px;display:flex}
.cc-foldChevron{color:var(--dsw-alias-label-tertiary);transition:transform .16s var(--cc-ease-out),color .15s ease}
.cc-foldChevronClosed{transform:rotate(-90deg)}
/* Folding stays instant (2026-10-29): the body stays mounted and is hidden with
 * the hidden attribute, so aria-controls always points at a real element
 * and the save bar's locate action can focus an invalid field right after
 * opening its group. */
.cc-groupBody{flex-direction:column;display:flex;padding-top:4px}
.cc-groupBody[hidden]{display:none}
.cc-disclosure:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.cc-rows{flex-direction:column;display:flex;padding-top:4px}
/* Card inset by default: every direct body child sits 16px off the card edge,
 * and only rows opt out — they carry their own 16px side padding so their
 * hairlines run the card's full width. */
.cc-rows>*{margin-left:16px;margin-right:16px}
.cc-rows>.cc-row{margin-left:0;margin-right:0}
.cc-row{flex-wrap:wrap;align-items:center;gap:8px 24px;display:flex;padding:14px 16px}
.cc-rows>.cc-row+.cc-row{border-top:.5px solid var(--dsw-alias-border-l2)}
.cc-rowFlush{padding:0}
/* The text column starts at 200px (not 300px) so the widest controls — the
 * 280px API base input, the allowlist's button + 200px selector — still sit
 * beside their label in a ~560px settings panel; the description wraps more
 * lines instead of the control dropping to a second line. */
.cc-rowText{flex-direction:column;flex:1 1 200px;gap:2px;min-width:0;display:flex}
.cc-rowTitleLine{align-items:center;gap:8px;display:flex;min-width:0}
.cc-rowTitle{min-width:0;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}
.cc-rowDesc{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.cc-rowDesc p{margin:0}
.cc-rowDesc p+p{margin-top:4px}
.cc-rowError{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.cc-rowControl{flex:none;align-items:center;gap:8px;display:inline-flex;margin-left:auto}
.cc-rowInput{width:200px}
.cc-rowInputWide{width:280px}
/* The row-level field, drawn to the design canvas: 32px, 8px corners, a 1px
 * border-l3 stroke on the raised surface. A number field draws its unit inside
 * the same box (cc-unitBox), right of the value. */
.cc-fieldInput{box-sizing:border-box;flex:none;height:32px;min-width:0;padding:0 10px;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font:inherit;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px;transition:border-color .15s ease}
.cc-fieldInput::placeholder{color:var(--dsw-alias-label-dimmed)}
.cc-fieldInput:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.cc-fieldInput:disabled{opacity:.5;cursor:default}
.cc-fieldInputInvalid{border-color:var(--dsw-alias-state-error-primary)}
.cc-unitBox{box-sizing:border-box;flex:none;align-items:center;display:inline-flex;width:160px;height:32px;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;transition:border-color .15s ease}
.cc-unitBox:focus-within{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.cc-unitBoxInvalid{border-color:var(--dsw-alias-state-error-primary)}
.cc-unitBox:has(>.cc-fieldInput:disabled){opacity:.5}
.cc-unitBox>.cc-fieldInput{flex:1;width:auto;height:30px;border:0;border-radius:0;background:0 0;outline:none;text-align:right;font-variant-numeric:tabular-nums}
.cc-unit{flex:none;padding:0 10px 0 2px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;white-space:nowrap}
/* A customized field's marker on its title line: the badge, then a 20px
 * round reset button. Reset lives here rather than after the control, so no
 * row reserves a reset column and the page keeps one right edge. */
.cc-overrideTag{align-items:center;gap:4px;display:inline-flex}
.cc-resetInline{flex:none;align-items:center;justify-content:center;display:inline-flex;width:20px;height:20px;padding:0;border:0;border-radius:999px;corner-shape:round;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:transform .16s var(--cc-ease-out),background-color .15s ease,color .15s ease}
.cc-resetInline:active:not(:disabled){transform:scale(.95)}
.cc-resetInline:disabled{cursor:default;opacity:.4}
.cc-resetInline:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.cc-icon{flex:none;width:16px;height:16px}
/* The page's buttons (PageButton), drawn to the design canvas: one capsule
 * shape, md 32px / 14px text / 14px icon, sm 28px / 12px text, lg 36px for
 * the save bar; primary is the brand fill, secondary the quiet grey fill,
 * ghost label-secondary text, danger the error fill. */
.cc-btn{box-sizing:border-box;flex:none;align-items:center;justify-content:center;gap:6px;display:inline-flex;height:32px;padding:0 14px;border:0;border-radius:999px;corner-shape:round;font:inherit;font-size:14px;line-height:22px;white-space:nowrap;cursor:pointer;text-decoration:none;transition:transform .16s var(--cc-ease-out),background-color .15s ease,color .15s ease}
.cc-btn:active:not(:disabled){transform:scale(.97)}
.cc-btnSm{height:28px;padding:0 10px;gap:4px;font-size:12px;line-height:18px}
.cc-btnLg{height:36px;padding:0 16px}
.cc-btn .cc-btnIcon{width:14px;height:14px}
.cc-btnPrimary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));color:var(--dsw-alias-label-primary-foreground,#fff)}
.cc-btnSecondary{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary)}
.cc-btnGhost{background:0 0;color:var(--dsw-alias-label-secondary)}
.cc-btnDanger{background:var(--dsw-alias-state-error-primary);color:#fff}
.cc-btn:disabled{cursor:default;opacity:.4}
.cc-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.cc-groupSummary{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:400;line-height:18px;white-space:nowrap}
.cc-badges{align-items:center;gap:8px;display:inline-flex}
.cc-badge,.cc-badgeMuted{box-sizing:border-box;flex:none;align-items:center;gap:4px;display:inline-flex;height:20px;white-space:nowrap;border-radius:999px;corner-shape:round;padding:0 8px;font-size:12px;font-weight:500;line-height:18px}
.cc-badge{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}
.cc-badgeMuted{border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-tertiary)}
.cc-badgeOutline{background:0 0;box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary)}
.cc-badgeOk{background:var(--dsw-alias-state-success-tertiary,color-mix(in srgb,var(--dsw-alias-state-success-primary,#16a34a) 10%,transparent));color:var(--dsw-alias-state-success-primary,#15803d)}
.cc-badgeError{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary)}
.cc-badgeWarn{background:var(--dsw-alias-state-warn-tertiary,var(--dsw-alias-bg-module-platform));color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-secondary))}
.cc-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}
.cc-field+.cc-field{border-top:.5px solid var(--dsw-alias-border-l2)}
.cc-fieldHead{align-items:center;gap:8px;display:flex}
.cc-label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}
.cc-reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:18px}
.cc-reset:disabled{cursor:default;opacity:.4}
.cc-input{box-sizing:border-box;height:32px;min-width:0;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font:inherit;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.cc-input::placeholder{color:var(--dsw-alias-label-dimmed)}
.cc-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.cc-input:disabled{opacity:.6;cursor:default}
.cc-inputInvalid{border-color:var(--dsw-alias-state-error-primary)}
.cc-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px}
.cc-modelSelectAnchor{flex-direction:column;align-items:stretch;gap:6px;display:inline-flex;width:200px}
.cc-selector{box-sizing:border-box;justify-content:space-between;align-items:center;gap:8px;display:inline-flex;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;text-align:left;cursor:pointer;transition:border-color .15s ease}
.cc-selector:disabled{cursor:default;opacity:.4}
.cc-selector:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.cc-selectorText{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cc-selectorChevron{color:var(--dsw-alias-label-tertiary)}
/* The search box sits inside the Menu anchor, so typing in it never trips
 * the Menu's outside-click close. */
.cc-modelSearch{width:100%}
.cc-modelSearch::-webkit-search-cancel-button{cursor:pointer}
.cc-checkRow{align-items:center;gap:8px;display:inline-flex;min-width:0}
.cc-checkRow:hover{cursor:pointer}
/* A hand-drawn box, not the platform's accent-color checkbox: the native
 * control's colours come from color-scheme, which the theme sets once at BOOT
 * and never re-applies in-session, so a native box can paint light-chrome white
 * on a dark page. The mark rides a brand-primary fill, so it takes the brand
 * foreground (the only pairing that survives dark mode's near-white brand), and
 * the outline is a border-l3 hairline because border-l2 leaves an unchecked box
 * invisible against the menu surface. */
.cc-check{box-sizing:border-box;appearance:none;flex-shrink:0;width:16px;height:16px;margin:0;border:1px solid var(--dsw-alias-border-l3);border-radius:4px;background:0 0;position:relative}
.cc-check:checked{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.cc-check:checked::after{content:'';position:absolute;top:3px;left:5px;width:3px;height:7px;border:solid var(--dsw-alias-label-primary-foreground,#fff);border-width:0 1.5px 1.5px 0;transform:rotate(45deg)}
.cc-checkName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* The settings switches are the platform's Switch primitive (issue #108); its
 * module CSS owns the box (36x20 track, 16px thumb, 16px travel), the colours,
 * capsule shape, focus ring and disabled look. This layer only joins the page's
 * motion: the primitive slides the thumb over 120ms ease and snaps the track
 * colour, so here the thumb and track share one 160ms strong ease-out and read
 * as one object, and the switch scales to .95 on press like the other small
 * pressables. The design canvas's 40x24 track is deliberately NOT re-applied
 * (2026-10-30: it made every switch read fatter than the host's own settings
 * switches, so the primitive's box is the single source of truth). The
 * cc-rowControl> qualifier lifts these above the module's single-class rules
 * whatever order the two sheets load in. The thumb is targeted as the button's
 * only child because its module class name is hashed. */
.cc-rowControl>.cc-switch{transition:background-color .16s var(--cc-ease-out),transform .16s var(--cc-ease-out)}
.cc-rowControl>.cc-switch>span{transition:transform .16s var(--cc-ease-out)}
.cc-switch:active:not(:disabled){transform:scale(.95)}
.cc-accountMode{align-items:center;gap:8px;display:flex;margin:12px 16px 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.cc-accountList{flex-direction:column;gap:8px;display:flex}
.cc-accountList+.cc-panel{margin:8px 16px 16px}
/* One row under the list: Add account (outline) leads, the analytics exit
 * (ghost) trails; the exit's long label clamps instead of wrapping the row. */
.cc-accountActions{flex-wrap:wrap;align-items:center;gap:8px;display:flex;margin:12px 16px 16px}
.cc-analyticsEntry{max-width:100%;min-width:0}
.cc-analyticsEntryText{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cc-chevronOpen{transform:rotate(180deg)}
.cc-accountItem{flex-direction:column;display:flex;border:1px solid var(--dsw-alias-border-l2);border-radius:12px}
.cc-accountItem>.cc-notice,.cc-accountItem>.cc-panel{margin:0 16px 14px}
.cc-accountItemActive{border-color:var(--dsw-alias-border-l3)}
.cc-accountHead{align-items:center;gap:4px;display:flex;padding:8px 8px 8px 0}
.cc-accountToggle{flex-wrap:wrap;align-items:center;gap:6px 8px;display:flex;flex:1;min-width:0;min-height:44px;padding:0 0 0 16px;background:0 0;border:0;border-radius:12px;color:inherit;cursor:pointer;font:inherit;text-align:left}
.cc-accountToggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:4px}
.cc-accountName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}
.cc-iconButton{flex-shrink:0;align-items:center;justify-content:center;display:inline-flex;width:28px;height:28px;padding:0;background:0 0;border:0;border-radius:8px;color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:transform .16s var(--cc-ease-out),background-color .15s ease,color .15s ease}
.cc-iconButton:active:not(:disabled){transform:scale(.95)}
.cc-iconButton:disabled{cursor:default;opacity:.4}
.cc-iconButton:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
/* Per-model context-length overrides (issue #86) as the design's small table:
 * a card holding a head row over a model / value / remove grid, a line
 * between rows; a row's error wraps onto its own line across the grid. */
.cc-contextTable{flex-direction:column;display:flex;margin:0 16px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px}
.cc-contextItem{grid-template-columns:minmax(0,1fr) 144px 28px;align-items:center;gap:8px;display:grid;padding:8px 8px 8px 12px}
.cc-contextItem+.cc-contextItem{border-top:1px solid var(--dsw-alias-border-l2)}
.cc-contextHead{grid-template-columns:minmax(0,1fr) 144px 28px;align-items:center;gap:8px;display:grid;height:32px;padding:0 8px 0 12px;border-bottom:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.cc-contextSelect{position:relative;display:block;min-width:0}
/* appearance:none swaps the platform arrow for the page's own chevron icon. */
.cc-contextModel{box-sizing:border-box;appearance:none;-webkit-appearance:none;width:100%;padding-inline-end:30px;text-overflow:ellipsis;cursor:pointer}
.cc-contextCaret{position:absolute;inset-inline-end:10px;top:50%;color:var(--dsw-alias-label-tertiary);transform:translateY(-50%);pointer-events:none}
.cc-contextSelect:has(.cc-contextModel:disabled) .cc-contextCaret{opacity:.6}
.cc-contextItem>.cc-unitBox{width:100%}
.cc-contextError{grid-column:1/-1}
.cc-tabDot{flex-shrink:0;width:8px;height:8px;border-radius:50%;corner-shape:round}
.cc-tabDotOk{background:var(--dsw-alias-state-success-primary)}
.cc-tabDotBlank{background:0 0;border:0}
.cc-tabDotWarn{background:var(--dsw-alias-state-warn-primary,#d97706)}
.cc-tabDotError{background:var(--dsw-alias-state-error-primary)}
.cc-accountMeters{flex-wrap:wrap;gap:6px 24px;display:flex;padding:0 16px 14px 32px}
.cc-miniMeter{align-items:center;gap:8px;display:inline-flex;font-size:12px;line-height:18px}
.cc-miniMeterLabel{color:var(--dsw-alias-label-secondary)}
.cc-miniMeterTrack{overflow:hidden;background:var(--dsw-alias-bg-module-platform);border-radius:999px;width:64px;height:4px}
/* The fill is always full width and slides in from the left under the track's
 * overflow clip: animating transform skips layout, and unlike scaleX it keeps
 * the fill's rounded ends. */
.cc-miniMeterFill{display:block;width:100%;background:var(--dsw-alias-brand-primary);border-radius:999px;height:100%;transition:transform .24s var(--cc-ease-out)}
.cc-miniMeterValue{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.cc-accountDetails{container-type:inline-size;border-top:1px solid var(--dsw-alias-border-l2);flex-direction:column;gap:16px;display:flex;padding:16px}
.cc-inlineForm{flex-direction:column;gap:8px;display:flex}
.cc-inlineActions{align-items:center;gap:8px;display:flex}
.cc-panel{flex-direction:column;gap:12px;display:flex;padding:16px;border-radius:12px;background:var(--dsw-alias-bg-module-platform)}
.cc-panelInput{width:100%}
.cc-keyField{align-items:center;gap:8px;display:flex}
.cc-panelActions{flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:8px;display:flex}
/* The add-account method switch, drawn as the design's segmented control: a
 * pill track on the raised surface, the chosen segment in the brand fill. */
.cc-seg{align-self:flex-start;display:inline-flex;padding:2px;border-radius:999px;corner-shape:round;background:var(--dsw-alias-bg-layer-1);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2)}
.cc-segItem{height:28px;padding:0 12px;border:0;border-radius:999px;corner-shape:round;background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;transition:transform .16s var(--cc-ease-out),background-color .15s ease,color .15s ease}
.cc-segItem:active:not(:disabled):not(.cc-segOn){transform:scale(.97)}
.cc-segItem:disabled{cursor:default;opacity:.4}
.cc-segItem:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.cc-segOn{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));color:var(--dsw-alias-label-primary-foreground,#fff)}
.cc-panelTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;line-height:22px}
.cc-accountReport{flex-direction:column;gap:16px;display:flex}
.cc-usageHead{align-items:center;gap:8px;display:flex}
.cc-usageTitle{color:var(--dsw-alias-label-primary);flex:1;margin:0;font-size:14px;font-weight:500;line-height:22px}
.cc-usageAccount{max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.cc-usagePlanStatus{flex:none;margin:0;white-space:nowrap;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.cc-usageHint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px}
/* Two fixed grids, not one auto-fit track: auto-fit wrapped the four activity
 * tiles 3 + 1 at the details' width. The activity row folds to 2 × 2 in a
 * narrow details panel. */
.cc-usageStats{grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;display:grid}
.cc-usageStatsActivity{grid-template-columns:repeat(4,minmax(0,1fr))}
@container (max-width:460px){.cc-usageStatsActivity{grid-template-columns:repeat(2,minmax(0,1fr))}}
.cc-balance{flex-direction:column;gap:2px;display:flex}
/* 两行左右分栏：标签行左账期、右更新时间；数值行左剩余、右已购与赠送。 */
.cc-balanceRow{flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:4px 16px;display:flex}
.cc-balanceLabel{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.cc-balanceValue{color:var(--dsw-alias-label-primary);font-size:20px;font-weight:600;line-height:28px;font-variant-numeric:tabular-nums}
.cc-balanceSub{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.cc-balanceEmpty .cc-balanceValue{color:var(--dsw-alias-state-error-primary)}
.cc-balanceNote{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.cc-usageStat{min-width:0;flex-direction:column;gap:2px;display:flex;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-module-platform)}
.cc-usageStatLabel{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.cc-usageStatValue{color:var(--dsw-alias-label-primary);font-size:16px;font-weight:500;line-height:24px;font-variant-numeric:tabular-nums}
.cc-usageStatSub{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cc-usageWindows{flex-direction:column;gap:14px;display:flex}
.cc-usageWindow{flex-direction:column;gap:6px;display:flex}
.cc-usageWindowHead{align-items:baseline;gap:8px;display:flex}
.cc-usageWindowLabel{color:var(--dsw-alias-label-secondary);flex:1;font-size:12px;line-height:18px}
.cc-usageWindowValue{color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.cc-usageExceeded{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.cc-usageBar{overflow:hidden;background:var(--dsw-alias-bg-module-platform);border-radius:999px;height:4px}
/* The fill is always full width and slides in from the left under the track's
 * overflow clip: animating transform skips layout, and unlike scaleX it keeps
 * the fill's rounded ends. */
.cc-usageBarFill{width:100%;background:var(--dsw-alias-brand-primary);border-radius:999px;height:100%;transition:transform .24s var(--cc-ease-out)}
.cc-usageBarFillWarn{background:var(--dsw-alias-state-error-primary)}
.cc-usageWindowReset{color:var(--dsw-alias-label-secondary);margin:0;font-size:12px;line-height:18px}
.cc-usagePartial{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12px;line-height:18px}
.cc-notices{flex-direction:column;gap:8px;display:flex;margin-bottom:12px}
.cc-section>.cc-notice{margin-top:12px}
/* One block for every result, warning and blocked state: neutral (read-only,
 * in progress), warn (partly done, needs a retry) and error (failed). The
 * icon and title take the tone; the body stays label-secondary for contrast.
 * A notice settles in from 4px above as it first renders, so a result never
 * jolts the content below it; browsers without @starting-style just show it. */
.cc-notice{box-sizing:border-box;align-items:flex-start;gap:10px;display:flex;padding:10px 12px;border-radius:12px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;transition:opacity .2s var(--cc-ease-out),transform .2s var(--cc-ease-out)}
@starting-style{.cc-notice{opacity:0;transform:translateY(-4px)}}
.cc-noticeIcon{flex:none;width:16px;height:16px;margin-top:1px;color:var(--dsw-alias-label-tertiary)}
.cc-noticeBody{flex-direction:column;flex:1;gap:2px;min-width:0;display:flex;word-break:break-word}
.cc-noticeBody>p{margin:0}
.cc-noticeTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}
.cc-noticeActions{flex-wrap:wrap;align-items:center;gap:8px;display:flex;margin-top:8px}
.cc-noticeDetail{color:var(--dsw-alias-label-tertiary)}
.cc-noticeSuccess{background:var(--dsw-alias-state-success-tertiary,color-mix(in srgb,var(--dsw-alias-state-success-primary,#16a34a) 10%,transparent))}
.cc-noticeSuccess>.cc-noticeIcon{color:var(--dsw-alias-state-success-primary,#16a34a)}
.cc-noticeWarn{background:var(--dsw-alias-state-warn-tertiary,color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d97706) 12%,transparent))}
.cc-noticeWarn>.cc-noticeIcon,.cc-noticeWarn .cc-noticeTitle{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary,#b45309))}
.cc-noticeError{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}
.cc-noticeError>.cc-noticeIcon,.cc-noticeError .cc-noticeTitle{color:var(--dsw-alias-state-error-primary)}
.cc-version{margin:32px 0 0;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.cc-versionLink{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-secondary));text-decoration:none}
.cc-providerCard{flex-direction:column;display:flex}
.cc-footer{justify-content:flex-end;align-items:center;gap:8px;display:flex}
.cc-failed{display:inline-block;max-width:260px;min-width:0;color:var(--dsw-alias-state-error-primary);margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px}
.cc-loginLink{align-items:center;gap:4px;display:inline-flex;color:var(--dsw-alias-link,var(--dsw-alias-brand-primary));text-decoration:none;font-size:12px;line-height:18px}
.cc-loginLink>.cc-iconInline{width:12px;height:12px}
/* The status row's dot + verdict sit beside the row title; the primitive's own
 * state tokens colour the dot, so only the neutral label and the failure note
 * need styling here. */
.cc-statusBadge{align-items:center;gap:6px;display:inline-flex;white-space:nowrap}
.cc-statusLabel{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.cc-statusNotice{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-tertiary));margin:0;font-size:12px;line-height:18px}
/* The service-status row's two sources: a key column (Official / This device)
 * beside a value line that wraps under itself, never under the key. */
.cc-statusLines{grid-template-columns:auto minmax(0,1fr);align-items:baseline;gap:4px 12px;display:grid;margin:2px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.cc-statusKey{color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.cc-statusValue{flex-wrap:wrap;align-items:center;gap:2px 8px;min-width:0;display:flex}
.cc-statusVerdict{color:var(--dsw-alias-label-primary)}
.cc-statusMeta{flex:1 1 200px;min-width:0}
/* One aggregate (uptime, response, age) never breaks inside itself; a line
 * that runs out of room moves the whole next segment down. */
.cc-statusPart{white-space:nowrap}
/* On the title line, flush with the page's single right edge. */
.cc-statusTitleLink{align-items:center;gap:4px;display:inline-flex;margin-left:auto}
.cc-statusBad{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary,#b45309))}
.cc-statusLink{color:var(--dsw-alias-link,var(--dsw-alias-brand-primary));text-decoration:none;font-size:12px;line-height:18px;white-space:nowrap}
.cc-loginDone{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary))}
.cc-loginError{color:var(--dsw-alias-state-error-primary)}
/* The floating save bar: a centered bar pinned to the bottom of the
 * settings scrollport. The dock is a zero-height sticky strip at the end of the
 * page, so the bar overlays the scrolling content instead of taking a row of
 * its own; while shown, the section reserves room at its end so the last line
 * can scroll clear. Hidden, it sinks and fades, and visibility (switched after
 * the transition) takes its buttons out of the tab order. It leaves faster than
 * it arrives and never overshoots: the bar shows on every edit. Its surface is
 * an elevated layer (bg-layer-1 over the settings panel's layer-2) with the
 * platform's prominent elevation and no stroke, and its corners are concentric
 * with the capsule buttons inside it (36px pills inset by 6px in a 48px pill)
 * so the gap around each button is even. */
.cc-sectionWithBar{padding-bottom:80px}
.cc-saveBarDock{position:sticky;bottom:0;z-index:2;height:0;pointer-events:none}
.cc-saveBar{--cc-saveBar-tone:var(--dsw-alias-state-warn-primary,#d97706);position:absolute;left:50%;bottom:20px;box-sizing:border-box;width:max-content;max-width:calc(100% - 24px);align-items:center;gap:10px;display:flex;height:48px;padding:6px 6px 6px 16px;border:0;border-radius:24px;corner-shape:round;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-prominent,0 12px 32px -8px rgba(0,0,0,.24),0 2px 8px rgba(0,0,0,.08));opacity:0;visibility:hidden;transform:translate(-50%,12px);transition:opacity .16s var(--cc-ease-out),transform .16s var(--cc-ease-out),visibility 0s linear .16s}
.cc-saveBarShown{opacity:1;visibility:visible;transform:translate(-50%,0);pointer-events:auto;transition:opacity .22s var(--cc-ease-out),transform .22s var(--cc-ease-out),visibility 0s}
.cc-saveBar-error{--cc-saveBar-tone:var(--dsw-alias-state-error-primary)}
.cc-saveBar-success{--cc-saveBar-tone:var(--dsw-alias-state-success-primary,#16a34a);padding-right:18px}
.cc-saveBarIcon{flex-shrink:0;align-items:center;justify-content:center;display:inline-flex;width:16px;height:16px;color:var(--cc-saveBar-tone)}
.cc-saveBarPulse{width:8px;height:8px;border-radius:50%;corner-shape:round;background:var(--cc-saveBar-tone)}
.cc-saveBarText{min-width:0;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.cc-saveBar-error .cc-saveBarText{color:var(--dsw-alias-state-error-primary)}
.cc-saveBarActions{flex-shrink:0;align-items:center;gap:4px;display:flex;margin-left:8px}
/* Hover only where a real pointer hovers. Order matters inside: the invalid
 * borders come after the plain hover borders at equal specificity, so an
 * invalid field keeps its error border under the pointer. */
@media (hover:hover) and (pointer:fine){
.cc-fieldInput:hover:not(:disabled),.cc-unitBox:hover,.cc-selector:hover:not(:disabled){border-color:var(--dsw-alias-label-tertiary)}
.cc-fieldInputInvalid:hover:not(:disabled),.cc-unitBoxInvalid:hover{border-color:var(--dsw-alias-state-error-primary)}
.cc-resetInline:hover:not(:disabled),.cc-iconButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.cc-btnPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary)))}
.cc-btnSecondary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.cc-btnGhost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.cc-btnDanger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 88%,#000)}
.cc-segItem:hover:not(:disabled):not(.cc-segOn),.cc-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
/* A whole-row toggle (group heading, account card head) shows it is one
 * target by lifting its chevron; a fill would weigh too much across the row. */
.cc-disclosure:hover .cc-foldChevron,.cc-accountToggle:hover .cc-foldChevron{color:var(--dsw-alias-label-primary)}
.cc-versionLink:hover{color:var(--dsw-alias-label-primary);text-decoration:underline;text-underline-position:under}
.cc-loginLink:hover,.cc-statusLink:hover{text-decoration:underline;text-underline-position:under}
}
/* Reduced motion drops movement and scale but keeps the fades and colour
 * changes, which carry meaning without motion. Card entrance keeps its fade
 * (the transform is neutralised), and the fold is already instant. */
@media (prefers-reduced-motion:reduce){
.cc-foldChevron,.cc-rowControl>.cc-switch>span,.cc-usageBarFill,.cc-miniMeterFill{transition:none}
.cc-btn,.cc-iconButton,.cc-resetInline,.cc-segItem{transition:background-color .15s ease,color .15s ease}
.cc-rowControl>.cc-switch{transition:background-color .15s ease}
.cc-btn:active:not(:disabled),.cc-iconButton:active:not(:disabled),.cc-resetInline:active:not(:disabled),.cc-segItem:active:not(:disabled):not(.cc-segOn),.cc-switch:active:not(:disabled){transform:none}
.cc-notice{transition:opacity .2s ease}
.cc-group{transition:opacity .2s ease;transform:none!important}
.cc-saveBar{transition:opacity .16s ease,visibility 0s linear .16s}
.cc-saveBarShown{transition:opacity .2s ease,visibility 0s}
}
`
