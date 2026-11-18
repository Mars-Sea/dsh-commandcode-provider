/**
 * The four-character service-status pill shared by the dashboard header and the
 * settings-page header. It owns its popover, position, and keyboard dismissal;
 * the caller supplies the Host probe and the panel copy translator.
 *
 * @module dsh-commandcode-provider/client/service-status-pill
 */

import { useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent } from 'react'
import {
  IconCheckCircleOutlineRegular,
  IconRefreshOutlineRegular,
  IconRightUpOutlineRegular,
  IconWarningOutlineRegular,
  IconWarningTriangleOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { panelTextEN } from './panel-copy.ts'
import { STATUS_PAGE_URL, servicePillTone, serviceStatusView } from './service-status.ts'
import type { ServicePillTone } from './service-status.ts'
import type { ServiceStatusTranslate } from './service-status-copy.ts'
import { useServiceStatus } from './use-service-status.ts'
import type { ServiceProbeMethod } from './use-service-status.ts'

function statusDotClass(tone: string): string {
  const suffix = tone === '' ? 'Idle' : `${tone[0]!.toUpperCase()}${tone.slice(1)}`
  return `ccp-statusDot ccp-statusDot${suffix}`
}

/** A shape as well as a colour, so the pill never relies on hue alone. */
function StatusGlyph({ tone }: { tone: ServicePillTone }) {
  if (tone === 'ok') return <IconCheckCircleOutlineRegular size={10} className="ccp-statusGlyph" />
  if (tone === 'warn') return <IconWarningTriangleOutlineRegular size={10} className="ccp-statusGlyph" />
  if (tone === 'error') return <IconWarningOutlineRegular size={10} className="ccp-statusGlyph" />
  return <span className={statusDotClass('idle')} aria-hidden="true" />
}

/**
 * The service-status pill after the dashboard title: four characters, one
 * combined colour, and a click-open popover that keeps the official and local
 * halves together with the status-page exit.
 */
export function ServiceStatusPill({ probeService, t }: {
  probeService?: ServiceProbeMethod | undefined
  t?: ServiceStatusTranslate | undefined
}) {
  const status = useServiceStatus(probeService)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLSpanElement>(null)
  const pillRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const keyboardOpen = useRef(false)
  const popoverId = useId()
  const text: ServiceStatusTranslate = t ?? panelTextEN
  const view = serviceStatusView(status.snapshot, status.probe, text, Date.now())
  const tone = servicePillTone(view)
  const toneSuffix = `${tone[0]!.toUpperCase()}${tone.slice(1)}`
  const detail = [...view.detailParts, ...(view.updated === undefined ? [] : [view.updated])].join(' · ')
  // Published Web hosts do not seed every primitive exported by the npm
  // package. Measure the anchor locally so the optional pill can also mount
  // on those hosts.
  useLayoutEffect(() => {
    const pill = pillRef.current
    const panel = panelRef.current
    if (!open || pill === null || panel === null) return
    const place = () => {
      const margin = 12
      const gap = 6
      const anchor = pill.getBoundingClientRect()
      const above = Math.max(0, anchor.top - gap - margin)
      const below = Math.max(0, window.innerHeight - margin - anchor.bottom - gap)
      const contentHeight = panel.scrollHeight + panel.offsetHeight - panel.clientHeight
      const showAbove = contentHeight > below && above > below
      const maxHeight = showAbove ? above : below
      const leftLimit = Math.max(margin, window.innerWidth - margin - panel.offsetWidth)
      const left = Math.min(Math.max(margin, anchor.left), leftLimit)
      const top = showAbove
        ? anchor.top - gap - Math.min(contentHeight, maxHeight)
        : Math.max(margin, Math.min(anchor.bottom + gap, window.innerHeight - margin))
      panel.style.left = `${left}px`
      panel.style.top = `${top}px`
      panel.style.maxHeight = `${maxHeight}px`
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(place)
    observer?.observe(pill)
    observer?.observe(panel)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      observer?.disconnect()
    }
  }, [open])

  // A keyboard-opened disclosure moves focus to its first action; a pointer
  // open leaves focus on the pill so the click does not jump the page.
  useEffect(() => {
    if (!open || !keyboardOpen.current) return
    keyboardOpen.current = false
    panelRef.current?.querySelector<HTMLElement>('button, a')?.focus()
  }, [open])

  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined
    const onPointer = (event: PointerEvent) => {
      if (wrapRef.current !== null && !wrapRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      // Only reclaim focus when it was actually inside the popover; Escape is
      // also a page-level "back out" and must not yank it from elsewhere.
      if (wrapRef.current?.contains(document.activeElement)) pillRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <span className="ccp-statusWrap" ref={wrapRef}>
      <button
        type="button"
        className={`ccp-statusPill ccp-statusPill${toneSuffix}`}
        aria-label={text('serviceStatusPillLabel', { official: view.label, local: view.local })}
        aria-expanded={open}
        aria-controls={popoverId}
        onClick={(event: MouseEvent<HTMLButtonElement>) => {
          const next = !open
          if (next && event.detail === 0) keyboardOpen.current = true
          setOpen(next)
        }}
        ref={pillRef}
      >
        <StatusGlyph tone={tone} />
        {text('serviceStatusTitle')}
      </button>
      <div
        id={popoverId}
        ref={panelRef}
        className="ccp-statusPop"
        role="region"
        aria-label={text('serviceStatusTitle')}
        hidden={!open}
      >
        <div className="ccp-statusBody">
          <div className="ccp-statusRow">
            <span className="ccp-statusKey">{text('serviceStatusOfficial')}</span>
            <span className="ccp-statusValue">
              <span className={statusDotClass(view.officialTone)} aria-hidden="true" />
              <span className="ccp-statusVerdict">{view.label}</span>
            </span>
          </div>
          {detail !== '' ? <p className="ccp-statusMeta" title={view.hiddenDetail ?? view.lag ?? view.hint}>{detail}</p> : null}
          <div className="ccp-statusRow">
            <span className="ccp-statusKey">{text('serviceStatusLocal')}</span>
            <span className="ccp-statusValue">
              <span className={statusDotClass(view.localTone)} aria-hidden="true" />
              <span className={view.localTone === 'warn' ? 'ccp-statusVerdict ccp-statusWarn' : 'ccp-statusVerdict'}>{view.local}</span>
            </span>
          </div>
          {view.notice !== undefined ? <p className="ccp-statusNotice">{view.notice}</p> : null}
        </div>
        <div className="ccp-statusActions">
          {view.localTone === 'warn' ? (
            <button type="button" className="ccp-statusAction" onClick={status.retry}>
              <IconRefreshOutlineRegular size={12} />
              {text('serviceStatusLocalRetry')}
            </button>
          ) : null}
          <a className="ccp-statusOpen" href={STATUS_PAGE_URL} target="_blank" rel="noreferrer">
            {text('serviceStatusOpen')}
            <IconRightUpOutlineRegular size={12} />
          </a>
        </div>
      </div>
    </span>
  )
}
