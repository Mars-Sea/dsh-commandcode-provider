/**
 * The plugin's own version, read from package.json at build time.
 *
 * The client bundle inlines the JSON import (rolldown resolves it during the
 * tsdown build; node tests read it through tsx), so the rendered value always
 * matches the published package version with no second constant to keep in
 * sync. Rendered as a muted footer line on the settings page so a user can
 * report the exact build they run.
 *
 * @module dsh-commandcode-provider/client/version
 */

import pkg from '../../package.json'

/** The published package version (e.g. `'0.6.0'`). */
export const PLUGIN_VERSION: string = pkg.version

/**
 * This package's GitHub releases page, derived from the repository field so
 * the update hint's link target can never drift from the published home.
 */
export const PLUGIN_RELEASES_URL: string =
  `${pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '')}/releases`
