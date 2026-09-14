/**
 * The composer's live session-cost figure (browser half).
 *
 * This component renders NO surface of its own. The cost lives inside the
 * harness's own token-usage UI: the amount becomes the last item of the shipped
 * pill's text run (`1.2M tokens · Cache hit 87% · $0.0123`) and the per-bucket
 * breakdown becomes extra rows in the usage dialog that pill opens.
 * `./session-cost-display.ts` owns that injection and `./session-cost.ts` owns
 * every number and every string; this file owns nothing but the two seats the
 * figures come from and the lifetime of the injection.
 *
 * It is still registered as an entry in `conversation.composer.dock`, because
 * that registration is what delivers the seats: `useProjection` is a standard
 * prop the composer hands every dock occupant, so there is no other way to read
 * the session's token accounting. Registering under the shipped `stats` cell's
 * id instead would REPLACE the harness's readout rather than extend it;
 * `./session-cost-display.ts` records why that trade is refused.
 *
 * The rendered node is a hidden marker — `display:none`, so it can add neither a
 * box nor a flex gap to the composer card. It exists to locate THIS composer
 * from the entry (`closest()` on the dock's outlet anchor), so a session-scoped
 * composer reads its own card rather than whichever row comes first in the
 * document. It is rendered only while there is something to show, so a session
 * with nothing priceable contributes no markup at all.
 *
 * Two seats are read, from two different owners: `useProjection` comes from the
 * composer (a standard prop of the dock, not part of this registration), and
 * `useCommandCodePrices` comes from our own registration's `inject` face, which
 * `bindInjectSources` re-exposes from the `hooks` compartment. Reading
 * `props.hooks.*` instead finds `undefined` at runtime and crashes the render,
 * which the slot renderer contains by ABDICATING the entry — a surface that
 * vanishes with no visible error.
 *
 * Both effects are `useEffect`, never `useLayoutEffect`: there is nothing on
 * screen to align with (the injection is a text run and a hidden marker), and a
 * layout effect would log a warning from the server render the tests use.
 *
 * @module dsh-commandcode-provider/client/session-cost-view
 */

import { useEffect, useRef } from 'react'
import type { SnapshotStore } from './snapshot-store.ts'
import type { SessionCostPricesState } from './prices.ts'
import { SessionCostDisplay } from './session-cost-display.ts'
import {
  buildSessionCostView,
  type SessionModelSelectionProjection,
  type SessionUsageBuckets,
} from './session-cost.ts'

/** The dock outlet this entry renders inside, i.e. what it can scope itself from. */
const DOCK_ANCHOR = '[data-slot="conversation.composer.dock"]'

/** Module-level constant so the marker's `style` prop never diffs. */
const HIDDEN_STYLE = { display: 'none' } as const

/**
 * The injected face this registration carries. Bound by the client entry so the
 * component stays unaware of the Remote, the controller, and its caching.
 *
 * NOTE the split from {@link SessionCostComponentProps}: the renderer
 * destructures this face's `hooks` compartment and re-exposes each member as a
 * `use<Name>` prop (`commandCodePrices` → `useCommandCodePrices`); it does not
 * hand the component this object verbatim.
 */
export interface SessionCostInjected {
  hooks: {
    commandCodePrices: SnapshotStore<SessionCostPricesState>
  }
}

/**
 * The projection keys this readout reads, declared structurally because the
 * plugin bundle does not depend on the session-controller package (whose
 * `UseProjection` this mirrors).
 */
interface ProjectionSeats {
  tokenUsage: SessionUsageBuckets
  modelSelection: SessionModelSelectionProjection
}

/** The projection reader the composer supplies to every dock occupant. */
export interface UseProjectionLike {
  <K extends keyof ProjectionSeats>(key: K): ProjectionSeats[K] | undefined
  <K extends keyof ProjectionSeats, S>(
    key: K,
    selector: (value: ProjectionSeats[K] | undefined) => S,
    eq?: (a: S, b: S) => boolean,
  ): S
}

/** The props this component actually receives. */
export interface SessionCostComponentProps {
  useCommandCodePrices<T>(selector: (state: SessionCostPricesState) => T): T
  useProjection: UseProjectionLike
}

/** Log a missing seat once per page, so a silent no-op stays diagnosable. */
let warnedMissingSeat = false

/**
 * The composer's session-cost entry. Guards the two seats before rendering the
 * mount: a dsh that does not supply the projection seat to dock occupants gets
 * an absent cost and one console line, never a render crash — which the renderer
 * would answer by abdicating the entry with no visible trace.
 */
export function CommandCodeSessionCost(props: SessionCostComponentProps) {
  if (typeof props.useProjection !== 'function' || typeof props.useCommandCodePrices !== 'function') {
    if (!warnedMissingSeat) {
      warnedMissingSeat = true
      console.error(
        '[dsh-commandcode-provider] the composer does not supply the projection/hook seats the session-cost readout needs; the readout stays hidden',
      )
    }
    return null
  }
  return <SessionCostEntry {...props} />
}

/** The mount: one injection lifetime, one hidden marker. Every hook lives here. */
function SessionCostEntry(props: SessionCostComponentProps) {
  const markerRef = useRef<HTMLSpanElement | null>(null)
  const displayRef = useRef<SessionCostDisplay | null>(null)
  const prices = props.useCommandCodePrices((state) => state)
  const usage = props.useProjection('tokenUsage')
  const selection = props.useProjection('modelSelection')
  const view = buildSessionCostView({ usage, selection, table: prices.table, now: Date.now() })

  useEffect(() => {
    // No DOM outside a browser: the server render used by the tests, and a
    // node-hosted assembly, must both stay no-ops.
    if (typeof document === 'undefined') return
    const display = new SessionCostDisplay({
      doc: document,
      scope: () => markerRef.current?.closest(DOCK_ANCHOR)?.parentElement ?? null,
    })
    displayRef.current = display
    display.start()
    return () => {
      displayRef.current = null
      display.dispose()
    }
  }, [])

  // Every render: the projection is a fresh fold, so there is nothing cheaper to
  // compare than the plan the display derives from it — and the display rewrites
  // a node only when that node's own text actually moved.
  useEffect(() => {
    displayRef.current?.sync(view)
  })

  if (view === undefined) return null
  return <span ref={markerRef} style={HIDDEN_STYLE} data-ccp-session-cost-anchor="" />
}
