/**
 * React components for the Command Code plans & quota panel (browser half):
 * the sidebar footer card and the dashboard it opens in the center column.
 *
 * Both render one {@link PanelView} projected by `./panel.ts` — no fact is
 * derived here. Strings arrive as keys into `view.text`, and every one of them
 * is English, because the view is built from `./panel-copy.ts` rather than the
 * harness `ctx.locale` namespace (which follows the user's language and would
 * render this panel in Chinese on a Chinese harness — the thing this surface
 * exists to avoid).
 *
 * The footer card is the panel's home: the sidebar shell renders it in the foot
 * area directly above the Settings seat, so each quota window's own spend and
 * limit — the 5-hour and the weekly one — are on screen without opening
 * anything. Clicking it selects the `main` panel this file also renders — and
 * unlike a `sidebar.panellist` row, whose button chrome and label the SHELL
 * owns, this entry owns its whole surface and therefore calls `open()` itself.
 *
 * Styles ride the stylesheet `./panel-styles.ts` returns, injected once by
 * the client entry; classes are `ccp-` prefixed to stay clear of the settings
 * page's `cc-` set.
 *
 * @module dsh-commandcode-provider/client/panel-view
 */

import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from './snapshot-store.ts'
import type { UsagePageState } from './usage.ts'
import type { SettingsPageState } from './settings.ts'
import { buildPanelView } from './panel.ts'
import type { PanelAccountView, PanelStatView, PanelView, PanelWindowView } from './panel.ts'
import type { PanelKey } from './panel-copy.ts'
// SlotMap merge for `main` / `sidebar.footer.action` (load-bearing: the slots
// this file's components register into are typed only by that augmentation).
import './panel-slots.ts'

/**
 * Owner share of the sidebar-foot action hole: the shell renders the foot area
 * and hands each action only the column fold state. There is no button chrome
 * and no `label` seat — the entry is the whole surface.
 */
export interface SidebarFooterActionOwnerProps {
  /** Whether the sidebar renders wide content (false = 56px rail). */
  wide: boolean
}

/**
 * The injected face both panel slots carry. Bound by the client entry so the
 * components stay unaware of the settings controller, the login controller,
 * the layout service and the module-level auto-refresh loop.
 *
 * NOTE the split from {@link PanelComponentProps}: this is the face the
 * registration's `inject` factory RETURNS, and the renderer does not hand it to
 * the component verbatim. `bindInjectSources` destructures the `hooks`
 * compartment OUT of the face and re-exposes each member as a `use<Name>` prop
 * (`commandCodeUsage` → `useCommandCodeUsage`). A component that reads
 * `props.hooks.*` therefore finds `undefined` at runtime and crashes on render
 * — which the slot renderer contains by ABDICATING the entry, so the surface
 * vanishes with no visible error. Read the `useX` seats instead.
 */
export interface PanelInjected {
  hooks: {
    commandCodeUsage: SnapshotStore<UsagePageState>
    commandCodeSettings: SnapshotStore<SettingsPageState>
  }
  /** Fetch the report now (the dashboard's Refresh action). */
  refresh(): void
  /** Start the shared background poll for this mount; returns its disposer. */
  startAutoRefresh(): () => void
  /** Select this panel in the center column (`ctx.layout.selectPanel`). */
  open(): void
}

/**
 * The props a panel component actually receives: the bound `useX` seats (what
 * {@link PanelInjected}'s `hooks` compartment becomes), the pass-through
 * actions, and no raw `hooks` key.
 *
 * `buildPanelView` is cheap (one pass over the account list) and recomputing it
 * per notification is what keeps a store update from ever rendering a stale
 * quota, so the selector is deliberately the whole snapshot.
 */
export interface PanelComponentProps {
  useCommandCodeUsage<T>(selector: (state: UsagePageState) => T): T
  useCommandCodeSettings<T>(selector: (state: SettingsPageState) => T): T
  refresh(): void
  startAutoRefresh(): () => void
  open(): void
}

/** Props of the sidebar footer card: the panel face plus the shell's fold state. */
export interface CommandCodeFooterEntryProps extends PanelComponentProps, SidebarFooterActionOwnerProps {}

/** The panel's view, recomputed from both seats on every notification. */
function usePanelView(props: PanelComponentProps): PanelView {
  const usage = props.useCommandCodeUsage((state) => state)
  const settings = props.useCommandCodeSettings((state) => state)
  return buildPanelView({
    usage,
    apiKeyConfigured: settings.anyAccountConfigured,
    removingIds: settings.accountsRemoving,
  })
}

/**
 * The quota ring. One glyph serves the rail button, the footer card's top row
 * and the dashboard header: a faint track plus an arc whose sweep is the
 * consumption, drawn from 12 o'clock. Circumference 2πr = 45.55 at r = 7.25.
 */
function Ring({ percent, warn, size }: { percent: number; warn: boolean; size: number }) {
  const clamped = Math.min(100, Math.max(0, percent))
  const circumference = 45.55
  // Rounded to three decimals: the raw product lands on floats like
  // 34.162499999999994, which is a needless DOM diff churn.
  const dashoffset = Math.round(circumference * (1 - clamped / 100) * 1000) / 1000
  return (
    <span className="ccp-glyph" aria-hidden="true">
      <svg viewBox="0 0 20 20" width={size} height={size} focusable="false">
        <circle cx="10" cy="10" r="7.25" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.4" />
        <circle
          cx="10"
          cy="10"
          r="7.25"
          fill="none"
          stroke={warn ? 'var(--dsw-alias-state-error-primary)' : 'currentColor'}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={String(circumference)}
          strokeDashoffset={String(dashoffset)}
          transform="rotate(-90 10 10)"
        />
      </svg>
    </span>
  )
}

/** One labelled bar. `compact` drops the reset line; the footer draws its own. */
function QuotaBar({ label, value, percent, barPercent, warn, resetsAt, resetsLabel }: {
  label: string
  value: string
  percent: string
  barPercent: number
  warn: string
  resetsAt: string
  resetsLabel: string
}) {
  const clamped = Math.min(100, Math.max(0, barPercent))
  return (
    <div className="ccp-window">
      <div className="ccp-windowHead">
        <span className="ccp-windowLabel">{label}</span>
        {warn !== '' ? <span className="ccp-warnTag">{warn}</span> : null}
        <span className="ccp-spacer" />
        {value !== '' ? <span className="ccp-windowValue">{value}</span> : null}
        <span className="ccp-windowPct">{percent}</span>
      </div>
      <div className="ccp-bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={clamped}>
        <div className={warn !== '' ? 'ccp-barFill ccp-barFillWarn' : 'ccp-barFill'} style={{ width: `${clamped}%` }} />
      </div>
      {resetsAt !== '' ? <p className="ccp-windowReset">{resetsLabel} {resetsAt}</p> : null}
    </div>
  )
}

/** A labelled figure. */
function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="ccp-tile">
      <span className="ccp-tileLabel">{label}</span>
      <span className="ccp-tileValue">{value}</span>
      {sub !== undefined && sub !== '' ? <span className="ccp-tileSub">{sub}</span> : null}
    </div>
  )
}

/** One usage tile. */
function StatTile({ stat, label }: { stat: PanelStatView; label: string }) {
  return <Tile label={label} value={stat.value} sub={stat.sub} />
}

/** The rotation/credential badge line for one account. */
function markText(account: PanelAccountView, text: (key: PanelKey) => string): string {
  if (account.mark === undefined) return ''
  if (account.mark === 'coolingDown' && account.cooldownUntil !== '') {
    return `${text('coolingDown')} · ${account.cooldownUntil}`
  }
  return text(account.mark)
}

/** `Default account` → `D`; used for the card's monogram chip. */
function initial(label: string): string {
  const trimmed = label.trim()
  return trimmed === '' ? '?' : trimmed[0]!.toUpperCase()
}

/**
 * One account's full report: the monthly limit/usage bar, the two quota
 * windows, then the credit and usage totals.
 */
function AccountCard({ account, view }: { account: PanelAccountView; view: PanelView }) {
  const text = (key: PanelKey): string => view.text[key] ?? key
  const mark = markText(account, text)
  const monthly = account.monthly

  return (
    <section className="ccp-card" aria-label={account.label}>
      <header className="ccp-cardHead">
        <span className="ccp-avatar" aria-hidden="true">{initial(account.label)}</span>
        <span className="ccp-cardIdentity">
          <span className="ccp-cardTitle">{account.label}</span>
          {account.owner !== '' ? <span className="ccp-cardOwner">{account.owner}</span> : null}
        </span>
        <span className="ccp-spacer" />
        {account.planName !== '' ? <span className="ccp-badge">{account.planName}</span> : null}
        {account.planStatus !== '' ? <span className="ccp-badge ccp-badgeWarn">{account.planStatus}</span> : null}
        {mark !== '' ? (
          <span className={account.mark === 'invalidKey' ? 'ccp-badge ccp-badgeError' : 'ccp-badgeMuted'}>{mark}</span>
        ) : null}
        {account.periodEnds !== '' ? (
          <span className="ccp-meta">{text('periodEnds')} {account.periodEnds}</span>
        ) : null}
      </header>

      {account.unconfigured ? <p className="ccp-hint">{text('unconfigured')}</p> : null}

      {monthly !== undefined && monthly.known ? (
        <QuotaBar
          label={text('monthly')}
          value={`${monthly.used} / ${monthly.limit}`}
          percent={`${monthly.percent}%`}
          barPercent={monthly.barPercent}
          warn={monthly.exhausted ? text('exhausted') : ''}
          resetsAt=""
          resetsLabel=""
        />
      ) : (
        <div className="ccp-planRow">
          <span className="ccp-fieldLabel">{text('plan')}</span>
          <span className="ccp-planName">{account.planName !== '' ? account.planName : text('unavailable')}</span>
        </div>
      )}

      {account.windows.length > 0 ? (
        <div className="ccp-windows">
          {account.windows.map((window: PanelWindowView) => (
            <QuotaBar
              key={window.label}
              label={text(window.label)}
              value={window.value}
              percent={window.capped ? `${window.percent}%` : text('windowUnlimited')}
              barPercent={window.barPercent}
              warn={window.exceeded ? text('exceeded') : ''}
              resetsAt={window.resetsAt}
              resetsLabel={text('resets')}
            />
          ))}
        </div>
      ) : null}

      {monthly !== undefined ? (
        <div className="ccp-block">
          <h4 className="ccp-blockTitle">{text('credits')}</h4>
          <div className="ccp-tiles">
            <Tile label={text('monthlyLimit')} value={monthly.limit} />
            <Tile label={text('monthlyUsed')} value={monthly.used} />
            <Tile label={text('remaining')} value={monthly.remaining} />
            <Tile label={text('purchased')} value={monthly.purchased} />
            <Tile label={text('free')} value={monthly.free} />
          </div>
        </div>
      ) : null}

      {account.stats.length > 0 ? (
        <div className="ccp-block">
          <h4 className="ccp-blockTitle">{text('usage')}</h4>
          <div className="ccp-tiles">
            {account.stats.map((stat) => (
              <StatTile key={stat.label} stat={stat} label={text(stat.label)} />
            ))}
          </div>
        </div>
      ) : null}
    </section>
  )
}

/**
 * The center-column dashboard, registered into the layout's keyed `main` slot
 * under the same id the footer card selects, so the two are one navigation
 * entry: the card shows the plan, the monthly bar and the quota window; the
 * panel shows everything, including the per-account breakdown.
 */
export function CommandCodePanel(props: PanelComponentProps) {
  const view = usePanelView(props)
  const text = (key: PanelKey): string => view.text[key] ?? key
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)

  const startAutoRefresh = props.startAutoRefresh
  useEffect(() => startAutoRefresh(), [startAutoRefresh])

  const accounts = view.accounts
  const selected = accounts.find((account) => account.id === selectedId)
    ?? view.selected
    ?? accounts[0]

  return (
    <div className="ccp-main" role="region" aria-label={text('nav')}>
      <div className="ccp-mainInner">
        <header className="ccp-header">
          <div className="ccp-headerText">
            <h2 className="ccp-title">{text('nav')}</h2>
            <p className="ccp-subtitle">{text('subtitle')}</p>
          </div>
          <span className="ccp-spacer" />
          {view.updatedAt !== '' ? <span className="ccp-meta">{text('updated')} {view.updatedAt}</span> : null}
          <Button
            variant="ghost"
            size="sm"
            disabled={view.loading || view.noKey}
            onClick={() => props.refresh()}
          >
            {view.loading ? text('refreshing') : text('refresh')}
          </Button>
        </header>

        {view.noKey ? (
          <div className="ccp-notice">
            <p className="ccp-noticeTitle">{text('noKey')}</p>
            <p className="ccp-noticeHint">{text('noKeyHint')}</p>
          </div>
        ) : null}

        {view.failure !== undefined ? (
          <div className="ccp-notice ccp-noticeError" role="alert">
            <p className="ccp-noticeTitle">{text(view.failure.title)}</p>
            <p className="ccp-noticeHint">{text(view.failure.hint)}</p>
            {view.failure.detail !== '' ? <p className="ccp-noticeDetail">{view.failure.detail}</p> : null}
          </div>
        ) : null}

        {!view.noKey && view.failure === undefined && accounts.length === 0 && view.loading ? (
          <p className="ccp-hint">{text('loading')}</p>
        ) : null}

        {view.staleError !== undefined && view.staleError !== '' ? (
          <p className="ccp-hint" role="status">{text('errorGeneric')} — {view.staleError}</p>
        ) : null}

        {accounts.length > 1 ? (
          <div className="ccp-tabs" role="tablist" aria-label={text('nav')}>
            {accounts.map((account) => (
              <button
                key={account.id}
                type="button"
                role="tab"
                aria-selected={selected?.id === account.id}
                className={selected?.id === account.id ? 'ccp-tab ccp-tabActive' : 'ccp-tab'}
                onClick={() => setSelectedId(account.id)}
              >
                {account.label}
              </button>
            ))}
          </div>
        ) : null}

        {selected !== undefined ? <AccountCard account={selected} view={view} /> : null}

        {view.partial !== undefined ? <p className="ccp-hint">{text(view.partial)}</p> : null}
      </div>
    </div>
  )
}

/**
 * The sidebar footer card, registered into `sidebar.footer.action` — the list
 * the shell renders in the sidebar's foot area directly ABOVE the Settings
 * seat, so the panel reads as a bottom-pinned sibling of Settings rather than
 * a global panel icon at the top of the column.
 *
 * The shell wraps nothing here, so this component owns the surface: the
 * button, its chrome and its accessible name. In the expanded column it draws
 * the title row, then one block per quota window (5-hour, then weekly) — the
 * window's own spend and limit (`$1.32 / $6.00`), its percentage and its bar —
 * and nothing else: the card's figures are the two windows the account runs
 * into, so the period total stays in the tooltip rather than taking a third
 * line. In the 56px rail it collapses to a 36px icon button carrying the ring,
 * matching the shell's own rail geometry. `wide` comes from the shell as an
 * owner prop — unlike the old `sidebar.panellist` row, this slot really does
 * supply it.
 */
export function CommandCodeFooterEntry(props: CommandCodeFooterEntryProps) {
  const view = usePanelView(props)

  const startAutoRefresh = props.startAutoRefresh
  useEffect(() => startAutoRefresh(), [startAutoRefresh])

  const text = (key: PanelKey): string => view.text[key] ?? key
  // The ring tracks the tightest window — the 5-hour one whenever it is capped,
  // which is the limit an account actually runs into first. `footerBars` is
  // ordered that way, so the leading bar is the headline.
  const headline = view.footerBars[0]
  // The tooltip doubles as the accessible name; it always begins with the
  // visible title, so the label the user reads is contained in the name.
  const title = view.footTitle

  if (!props.wide) {
    return (
      <button
        type="button"
        className="ccp-railButton"
        aria-label={title}
        title={title}
        onClick={() => props.open()}
      >
        <Ring percent={headline?.barPercent ?? 0} warn={headline?.warn ?? false} size={18} />
      </button>
    )
  }

  return (
    <button
      type="button"
      className="ccp-foot"
      aria-label={title}
      title={title}
      onClick={() => props.open()}
    >
      <span className="ccp-footTop">
        <Ring percent={headline?.barPercent ?? 0} warn={headline?.warn ?? false} size={16} />
        <span className="ccp-footName">{text('nav')}</span>
        <span className="ccp-spacer" />
        {view.status !== '' ? (
          <span className="ccp-badgeMuted">{view.status}</span>
        ) : view.planName !== text('nav') ? (
          <span className="ccp-badge">{view.planName}</span>
        ) : null}
      </span>

      {view.footerBars.map((bar) => (
        <span className="ccp-footRow" key={bar.label}>
          <span className="ccp-footHead">
            <span className="ccp-footLabel">{text(bar.label)}</span>
            <span className="ccp-spacer" />
            {bar.detail !== '' ? <span className="ccp-footAmount">{bar.detail}</span> : null}
            <span className="ccp-footPct">{bar.percent}</span>
          </span>
          <span className="ccp-footBar">
            <span
              className={bar.warn ? 'ccp-footFill ccp-footFillWarn' : 'ccp-footFill'}
              style={{ width: `${bar.barPercent}%` }}
            />
          </span>
        </span>
      ))}
    </button>
  )
}
