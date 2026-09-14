/**
 * Slot contracts the plans & quota panel registers into.
 *
 * Neither slot belongs to this plugin: `sidebar.footer.action` is declared by
 * `@deepseek-ai/dsh-client-ui-sidebar` and `main` by
 * `@deepseek-ai/dsh-client-ui-layout`. Neither package is a dependency of this
 * bundle (the panel only needs their *shapes* at compile time, and neither
 * ships a client module the browser would have to resolve), so — exactly as
 * `card.tsx` does for `settings.models.provider-card` — the declarations are
 * re-stated here and merged into the framework's `SlotMap`.
 *
 * The re-statement must stay structurally identical to upstream's. That is the
 * point of the merge: the registration site typechecks against the real
 * contract (kind, scope, owner props, inject face), so an upstream change that
 * invalidates this panel is a compile error here rather than a silent
 * mis-registration at runtime. A future dsh that ships either declaration to
 * the client through some other path would collide at compile time — which is
 * the intended alarm, and why this file exists instead of a local cast.
 *
 * @module dsh-commandcode-provider/client/panel-slots
 */

import type { SidebarFooterActionOwnerProps } from './panel-view.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * The layout's central panel, selected by the footer entry's id. The
     * reserved `conversation` key hosts the Conversation; the panel this
     * plugin contributes occupies `commandcode-panel` and receives no Session
     * binding. Its owner props are empty — a global panel is root-scoped
     * chrome, so clipboard, zoom, and user selection stay the browser's.
     */
    'main': { kind: 'keyed'; scope: 'root' }
    /**
     * The sidebar-foot action list, rendered inside the foot area directly
     * ABOVE the Settings seat (`footArea` renders `footerActions` then
     * `settingsArea`). Registering here is what pins a row to the bottom of
     * the sidebar on top of Settings — unlike `sidebar.panellist`, whose rows
     * render as global panel icons at the very top of the column.
     *
     * The shell wraps nothing: the entry owns its whole surface and receives
     * only the column fold state.
     */
    'sidebar.footer.action': { kind: 'list'; scope: 'root'; owner: SidebarFooterActionOwnerProps }
  }
}
