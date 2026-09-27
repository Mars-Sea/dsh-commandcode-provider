/**
 * SlotMap merge for the composer readout's seat.
 *
 * `conversation.composer.dock` is declared by dsh-client-ui-conversation and
 * occupied by dsh-client-ui-chat's `stats` cell. Neither is a dependency (we
 * need only the shape at compile time), so the declaration is re-stated and
 * merged exactly as `panel-slots.ts` does — and must stay structurally identical
 * to upstream's `{ kind: 'list'; scope: 'session' }`, so a drift is a compile
 * error here rather than a silent mis-registration.
 *
 * Only the slot's own contract is restated: the dock's standard props
 * (`useProjection`, `sessionId`, …) come from the owner at runtime, so the
 * component declares the two it reads itself.
 *
 * @module dsh-commandcode-provider/client/session-cost-slots
 */

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * Ambient entries below the composer card. A separate entry is what keeps
     * the shipped `stats` cell intact — reusing its id would REPLACE the tokens
     * / cache-hit / throughput readout — and the readout's stylesheet lifts this
     * entry out of the dock's flow so it joins that row instead of taking a line.
     */
    'conversation.composer.dock': { kind: 'list'; scope: 'session' }
  }
}

/**
 * Makes this file a MODULE, which is load-bearing: in a script file
 * `declare module '…'` is a fresh ambient declaration that SHADOWS the real
 * package (which would then export nothing else), instead of an augmentation.
 */
export {}
