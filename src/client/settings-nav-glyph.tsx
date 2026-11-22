const SETTINGS_NAV_GLYPH = 'M10 4v8a2 2 0 1 0 2-2H4a2 2 0 1 0 2 2V4a2 2 0 1 0-2 2h8a2 2 0 1 0-2-2'

/** The Command Code mark as a stroke-only 16px SVG, tinted by `currentColor`. */
export function CommandCodeNavGlyph({ size = 16 }: { size?: number }) {
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
