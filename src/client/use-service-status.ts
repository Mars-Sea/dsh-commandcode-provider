/**
 * Shared service-status state for the settings page and the dashboard header.
 *
 * The official half is a cached remote record; the local half is one Host probe
 * of the configured API base. Both surfaces need the same projection, so the
 * hook that owns their fetch/probe lifecycle lives here instead of inside one
 * component.
 *
 * @module dsh-commandcode-provider/client/use-service-status
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CommandCodeProbeResult } from '../service-probe-wire.ts'
import {
  checkServiceStatus,
  localStorageServiceStatusStore,
  readCachedServiceStatus,
  runServiceProbeWithRetry,
} from './service-status.ts'
import type { ServiceProbe, ServiceStatusSnapshot } from './service-status.ts'

/** The Host-side probe call the panel is injected with. */
export type ServiceProbeMethod = () => Promise<
  | { ok: true; value: CommandCodeProbeResult }
  | { ok: false; error: { message: string } }
>

export interface ServiceStatusState {
  snapshot: ServiceStatusSnapshot | undefined
  probe: ServiceProbe
  retry: () => void
}

/**
 * Paint the cached official record immediately, then refresh it and run the
 * local probe. A missing probe (an older Host) is a normal state: the local
 * line says so instead of throwing.
 */
export function useServiceStatus(probeService: ServiceProbeMethod | undefined): ServiceStatusState {
  const [snapshot, setSnapshot] = useState<ServiceStatusSnapshot | undefined>(
    () => readCachedServiceStatus(localStorageServiceStatusStore()),
  )
  const [probe, setProbe] = useState<ServiceProbe>(
    probeService === undefined ? { kind: 'unavailable' } : { kind: 'checking' },
  )
  const probeRef = useRef(probeService)
  probeRef.current = probeService
  const cancelled = useRef(false)
  const runProbe = useCallback(() => {
    const current = probeRef.current
    if (current === undefined) {
      setProbe({ kind: 'unavailable' })
      return
    }
    setProbe({ kind: 'checking' })
    void runServiceProbeWithRetry(() => current()).then((next) => {
      if (!cancelled.current) setProbe(next)
    })
  }, [])
  useEffect(() => {
    cancelled.current = false
    runProbe()
    return () => {
      cancelled.current = true
    }
  }, [runProbe])
  useEffect(() => {
    let cancelledSnapshot = false
    void checkServiceStatus({ store: localStorageServiceStatusStore() }).then((next) => {
      if (!cancelledSnapshot) setSnapshot(next)
    }, () => {})
    return () => {
      cancelledSnapshot = true
    }
  }, [])
  return { snapshot, probe, retry: runProbe }
}
