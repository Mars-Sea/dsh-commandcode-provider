/**
 * Slot contract the session-cost readout registers into.
 *
 * `conversation.composer.dock` belongs to `@deepseek-ai/dsh-client-ui-conversation`
 * (which declares it and renders it in the composer card) and is occupied by
 * `@deepseek-ai/dsh-client-ui-chat` (whose `stats` cell is the readout showing
 * the session's tokens, cache-hit share and throughput). Neither package is a
 * dependency of this bundle — the readout only needs the slot's *shape* at
 * compile time, and neither ships a client module the browser would have to
 * resolve — so, exactly as `panel-slots.ts` does for the sidebar seats, the
 * declaration is re-stated here and merged into the framework's `SlotMap`.
 *
 * The re-statement must stay structurally identical to upstream's
 * (`{ kind: 'list', scope: 'session' }`). That is the point of the merge: the
 * registration site typechecks against the real contract, so an upstream change
 * that invalidates this readout is a compile error here rather than a silent
 * mis-registration at runtime. A future dsh that ships this declaration to the
 * client through some other path would collide at compile time — the intended
 * alarm, and why this file exists instead of a local cast.
 *
 * Note what is deliberately NOT restated: the dock's standard props
 * (`useProjection`, `sessionId`, `useChat`, …). The owner supplies those to
 * every occupant at runtime; they are not part of the slot's registration
 * contract, so the component declares the two it reads itself (see
 * `session-cost-view.tsx`).
 *
 * @module dsh-commandcode-provider/client/session-cost-slots
 */

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * Ambient entries below the composer card. Registering a separate entry is
     * what keeps the shipped `stats` cell intact — that occupant is one
     * component owning the whole row, so reusing its id would REPLACE the
     * tokens / cache-hit / throughput readout — and the readout's stylesheet
     * then lifts this entry out of the dock's flow, so it lands at the right
     * end of that row's line instead of on a line of its own.
     */
    'conversation.composer.dock': { kind: 'list'; scope: 'session' }
  }
}

/**
 * Makes this file a MODULE, which is load-bearing rather than cosmetic. In a
 * script (non-module) file, `declare module '…'` is not an augmentation: it is
 * a fresh ambient module declaration that SHADOWS the real package, so
 * `@deepseek-ai/dsh-client-ui-slots` would suddenly export `SlotMap` and
 * nothing else — every consumer of its other exports (`Translate`, the slot
 * hooks) fails to compile. An empty export keeps the merge a merge.
 */
export {}
