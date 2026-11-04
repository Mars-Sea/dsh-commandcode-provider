/**
 * The settings-nav glyph drawn through the host's `settings.section.icon` slot.
 *
 * This is the sanctioned seat: dsh 0.2.2-alpha.3 made the settings shell render
 * each nav row's icon from this list slot (keyed by section id, props `size` and
 * `active`) instead of a hardcoded id table, so the plugin no longer has to
 * depend on the shell's gear fallback. The host declares the slot only on that
 * engine and later — `ctx.slots.inject` simply never fires elsewhere, where
 * `./settings-nav-icon.ts` patches the shell's row instead.
 *
 * The artwork is the SAME command mark the injected fallback draws (both read
 * {@link SETTINGS_NAV_GLYPH}), so the glyph looks identical on both engines.
 *
 * @module dsh-commandcode-provider/client/settings-nav-glyph
 */

import { SETTINGS_NAV_GLYPH } from './settings-nav-icon.ts'

/**
 * Props the settings shell hands a `settings.section.icon` registrant.
 *
 * Declared structurally: the slot's owner props are not typed in the installed
 * dev engine (see `./settings-nav-slot.ts`), and the glyph needs only the size.
 */
export interface CommandCodeNavGlyphProps {
  /** Glyph edge in px; the shell passes 16. */
  size?: number
  /** Whether this section is the open one; the artwork does not vary by state. */
  active?: boolean
}

/** The Command Code mark as a stroke-only 16px SVG, tinted by `currentColor`. */
export function CommandCodeNavGlyph({ size = 16 }: CommandCodeNavGlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      style={{ flex: 'none' }}
    >
      <path
        d={SETTINGS_NAV_GLYPH}
        stroke="currentColor"
        strokeWidth={1.3}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
