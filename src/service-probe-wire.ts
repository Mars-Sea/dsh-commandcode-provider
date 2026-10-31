/**
 * Wire contract for the Host-side connectivity probe (`commandcode/probe`).
 *
 * The status page's published data can lag hours: Upptime only rewrites its
 * state file when the status changes or when the daily `response-time` workflow
 * forces a commit, and GitHub throttles the five-minute cron down to a run
 * every few hours. The status row therefore pairs the published record with a
 * probe that runs on THIS Host right now.
 *
 * The browser cannot run that probe itself — `api.commandcode.ai` sends no CORS
 * header — and on a remote-Host setup the browser machine is not the machine
 * that serves requests anyway. So the request runs Host-side and crosses the
 * Typert Gateway like every other Command Code Remote.
 *
 * The probe is a plain unauthenticated GET of `{apiBase}/alpha/whoami`, built
 * with the same string concatenation real requests use so a path-prefixed
 * reverse proxy is exercised as-is. 2xx/3xx prove the endpoint answered;
 * 401/403 do too, because a credential-less GET of that endpoint is supposed to
 * be rejected — the answer still came from the API's auth layer on this Host.
 * It is not an inference test, and the UI copy never claims more than that.
 *
 * @module dsh-commandcode-provider/service-probe-wire
 */

import type { InvocationDescriptor, TypertRemoteContribution, TypertSchema } from '@deepseek-ai/dsh-typert-protocol'
import { REMOTE_PACKAGE, makeBoundaryValidator, makeRemoteDescriptor } from './wire-shared.ts'

/** Canonical `<namespace>/<method>` endpoint of the probe Remote. */
export const PROBE_ENDPOINT = 'commandcode/probe'

/** How the probe ended; the browser maps each value to localized copy. */
export type ProbeOutcome = 'ok' | 'http-error' | 'timeout' | 'unreachable'

/** The probe facts the Host returns; the browser owns every string. */
export interface CommandCodeProbeResult {
  outcome: ProbeOutcome
  /** HTTP status when a response arrived; 0 when it did not. */
  status: number
  /** Round-trip time in milliseconds; 0 when no response arrived. */
  latencyMs: number
  /** When the Host finished the probe (epoch ms, Host clock). */
  checkedAt: number
}

const OUTCOMES: readonly ProbeOutcome[] = ['ok', 'http-error', 'timeout', 'unreachable']

const { reject, record, stringField, numberField } = makeBoundaryValidator('commandcode/probe result:')

/** Strict result codec, shared verbatim by the Host registration and Client mount. */
export function parseProbeResult(value: unknown): CommandCodeProbeResult {
  const source = record(value, 'result')
  const outcome = stringField(source, 'outcome', 'outcome')
  if (!(OUTCOMES as readonly string[]).includes(outcome)) reject('outcome')
  return {
    outcome: outcome as ProbeOutcome,
    status: numberField(source, 'status', 'status'),
    latencyMs: numberField(source, 'latencyMs', 'latencyMs'),
    checkedAt: numberField(source, 'checkedAt', 'checkedAt'),
  }
}

/** The strict result codec both halves attach to the descriptor. */
export const probeSchema: TypertSchema<CommandCodeProbeResult> = {
  parse: parseProbeResult,
}

/** The one invocation descriptor, shared by the Host registration and the Client mount. */
export const PROBE_DESCRIPTOR: InvocationDescriptor = makeRemoteDescriptor<CommandCodeProbeResult>(
  PROBE_ENDPOINT,
  'probe',
  `${REMOTE_PACKAGE}#CommandCodeProbeResult`,
  probeSchema,
)

/** The Host-face contribution registered on `ctx.typert`. */
export const PROBE_HOST_CONTRIBUTION = {
  package: REMOTE_PACKAGE,
  face: 'host' as const,
  schemas: [],
  model: { services: [], events: [], objects: [] },
  invocations: [PROBE_DESCRIPTOR],
}

/** The Client-face contribution mounted on `ctx.remote`. */
export const PROBE_REMOTE_CONTRIBUTION: TypertRemoteContribution = {
  package: REMOTE_PACKAGE,
  descriptors: [PROBE_DESCRIPTOR],
}
