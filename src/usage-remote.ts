/**
 * Host half of the account-usage Remote (`commandcode/report`).
 *
 * The settings page's account card needs the same report the `/commandcode`
 * command prints, but the browser never holds the API key — the fetch must
 * run Host-side. This module exposes `adapter.getUsage()` through the Typert
 * Gateway: a `TypertRemoteService` provides the receiver the Gateway resolves,
 * and the shared strict descriptor (`src/usage-wire.ts`) is registered on the
 * `typert` registry so the Gateway claims the `commandcode/report` endpoint.
 *
 * The whole wiring rides an optional `ctx.inject(['typert'], ...)` fiber: a
 * profile without the web stack (no Typert registry, no Gateway) simply never
 * activates it, exactly like the `/commandcode` command rides `commands`.
 *
 * @module dsh-commandcode-provider/usage-remote
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { CommandCodeAdapter, CommandCodeConnectionOptions } from './adapter.ts'
import { USAGE_HOST_CONTRIBUTION } from './usage-wire.ts'
import type { CommandCodeAccountsReport } from './usage-wire.ts'

/** Everything the usage service needs beyond its Cordis context. */
export interface CommandCodeUsageDeps<C extends CommandCodeConnectionOptions = CommandCodeConnectionOptions> {
  /** The registered adapter (for getUsage). */
  adapter: CommandCodeAdapter<C>
  /**
   * Multi-account report source (wired by the plugin entry). Absent in
   * programmatic setups, the service falls back to a single default-account
   * entry around `adapter.getUsage()`.
   */
  reports?: () => Promise<CommandCodeAccountsReport>
}

/**
 * The registry method surface this module uses. `Context['typert']` is typed
 * as the read-only `TypertRegistryContract`; contribution registration lives
 * on the concrete registry service, so the cast is spelled out once here.
 */
interface TypertContributionRegistry {
  register(contribution: typeof USAGE_HOST_CONTRIBUTION): () => void | Promise<void>
}

/**
 * The Remote receiver: a Cordis service the Gateway resolves by key
 * (`commandcodeUsage`) and binds to the wire namespace (`commandcode`). The
 * base class stamps the `typertRemote` binding the Gateway validates on every
 * dispatch; no decorators are needed because the descriptor is registered
 * explicitly (strict path) rather than discovered from source markers.
 */
export class CommandCodeUsageService<C extends CommandCodeConnectionOptions = CommandCodeConnectionOptions>
  extends TypertRemoteService {
  private readonly deps: CommandCodeUsageDeps<C>

  constructor(ctx: Context, deps: CommandCodeUsageDeps<C>) {
    super(ctx, 'commandcodeUsage', { namespace: 'commandcode' })
    this.deps = deps
  }

  /**
   * Account, usage, and credit state for the settings page's account card —
   * one entry per pool account when the plugin entry wired `reports`, a
   * single default-account entry otherwise. Degrades per endpoint like the
   * `/commandcode` command (failures land in `report.failures`); throws
   * `MISSING_CREDENTIAL` when no key resolves, which the Gateway folds into
   * the failure branch the page renders as a hint.
   */
  async report(): Promise<CommandCodeAccountsReport> {
    if (this.deps.reports !== undefined) return this.deps.reports()
    const report = await this.deps.adapter.getUsage()
    return {
      accounts: [{
        id: 'default',
        label: 'Default',
        configured: true,
        active: true,
        mark: '',
        cooldownUntil: 0,
        report,
      }],
    }
  }
}

/**
 * Provide the usage service and register its Remote descriptor. The registry
 * contribution is tied to this fiber's lifetime: the registry's own
 * `register()` effect would otherwise outlive the plugin.
 */
export function applyUsageRemote<C extends CommandCodeConnectionOptions>(
  ctx: Context,
  deps: CommandCodeUsageDeps<C>,
): void {
  ctx.inject(['typert'], (remoteCtx) => {
    new CommandCodeUsageService(remoteCtx, deps)
    const registry = remoteCtx.typert as unknown as TypertContributionRegistry
    const unregister = registry.register(USAGE_HOST_CONTRIBUTION)
    // The registry's own effect would outlive this fiber; withdraw the
    // contribution when the plugin unloads.
    remoteCtx.effect(() => () => void unregister(), 'dsh-commandcode-provider: usage remote')
  })
}
