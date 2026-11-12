/**
 * SlotMap merge for the settings-nav glyph seat.
 *
 * `settings.section.icon` is declared by `dsh-client-ui-settings-general`
 * (dsh 0.2.2-alpha.3 and later), not by a package this bundle depends on, and
 * the installed dev types are `0.2.1-rc.3`, where the seat does not exist yet.
 * The declaration is restated so the registration site type-checks.
 *
 * Keep the full declaration structurally identical to the newer shell's own
 * declaration, including its owner props, so it can coexist with either type
 * generation. Once the development dependency no longer needs this supplement,
 * it may be removed. The shell renders it once per nav row with `only: row.id`,
 * which is why the registrant's id must be the section id.
 *
 * @module dsh-commandcode-provider/client/settings-nav-slot
 */

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * Per-section glyph in the settings nav rail. A list slot keyed by section
     * id, rendered with the row's `active` state and a 16px size; the shell
     * falls back to its own gear when no entry matches.
     */
    'settings.section.icon': { kind: 'list'; scope: 'root'; inline: true; owner: { size: number; active: boolean } }
  }
}

/**
 * Makes this file a MODULE: in a script file `declare module '…'` would shadow
 * the real package instead of augmenting it.
 */
export {}
