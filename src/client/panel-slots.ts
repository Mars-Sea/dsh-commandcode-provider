/**
 * SlotMap merge for the two seats the plans & quota panel registers into.
 *
 * Neither is ours: `main` is declared by dsh-client-ui-layout and
 * `sidebar.footer.action` by dsh-client-ui-sidebar. Neither is a dependency,
 * so the declarations are re-stated and merged exactly as `card.tsx` does —
 * they must stay structurally identical to upstream's (a drift is a compile
 * error here rather than a silent mis-registration).
 *
 * @module dsh-commandcode-provider/client/panel-slots
 */

import type { SidebarFooterActionOwnerProps } from './panel-view.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * The layout's central panel, selected by the footer entry's id. Our panel
     * occupies `commandcode-panel` and gets no Session binding; owner props are
     * empty because a root-scoped panel is chrome the browser owns anyway.
     */
    'main': { kind: 'keyed'; scope: 'root' }
    /**
     * The foot action list, rendered directly ABOVE the Settings seat — that is
     * what pins a row to the sidebar's bottom, where a `sidebar.panellist` row
     * (a global panel icon) renders at the top. The shell wraps nothing here:
     * the entry owns its whole surface and receives only the column fold state.
     */
    'sidebar.footer.action': { kind: 'list'; scope: 'root'; owner: SidebarFooterActionOwnerProps }
  }
}
