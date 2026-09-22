/**
 * Opt-in raw-stream trace for the Command Code transports.
 *
 * Why this exists: this route's failure mode of record is a response that ENDS
 * EARLY. The gateway, an intermediary proxy, or the network closes the socket
 * mid-generation, so the adapter's read loop sees `done` without ever seeing
 * the transport's terminal event. From inside the adapter those two endings are
 * indistinguishable — the provider cut the stream, a proxy timed out, or the
 * socket was dropped — and the only artifact that separates them is the raw
 * wire: which events actually arrived, when the last one landed, how long the
 * socket then sat silent, and how it ended. Without that, a truncated answer is
 * a report with no evidence attached.
 *
 * Enable it per process:
 *
 * ```sh
 * DSH_COMMANDCODE_TRACE=/tmp/cc-stream.jsonl dsh web
 * DSH_COMMANDCODE_TRACE=1 dsh web     # -> $TMPDIR/dsh-commandcode-stream.jsonl
 * ```
 *
 * Any value that is not a flag is a path, and the explicit off-spellings
 * (`0`, `false`, `no`, `off`) are recognized as "off" rather than being taken
 * for a file name.
 *
 * Every model request appends one JSONL record per raw chunk plus lifecycle
 * records (`response`, `eof`, `idle-timeout`, `read-error`, `end`,
 * `stream-close`), each stamped with `at` — milliseconds since that request's
 * first byte. The chunk records carry the provider's own payload verbatim
 * (bounded per chunk), because a truncated answer is exactly what is being
 * diagnosed: treat the file as conversation content, not as a log safe to
 * share. It never carries the request body, an API key, or any request header.
 *
 * Deliberate trade-offs:
 *  - OFF costs one `process.env` read per request.
 *  - ON appends synchronously, one file open per chunk. The trace must survive
 *    a host killed mid-diagnosis, and the microseconds it costs are irrelevant
 *    beside the seconds-scale silences it is there to measure.
 *  - A trace that cannot be written turns itself off instead of failing the
 *    request it is observing: a diagnostic must never become the outage.
 *
 * @module
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** Environment variable that turns the trace on. */
export const STREAM_TRACE_ENV = 'DSH_COMMANDCODE_TRACE'

/** File used when the variable is set to a bare flag instead of a path. */
export const STREAM_TRACE_DEFAULT_FILE = 'dsh-commandcode-stream.jsonl'

/**
 * Ceiling for ONE request's trace, in bytes.
 *
 * A long generation is megabytes of SSE; the interesting part is always the
 * tail, but records are appended in arrival order, so the cap is what keeps a
 * forgotten trace from filling a disk. Hitting it stops payload records;
 * one bounded `end` and `stream-close` record can still follow so a long
 * reasoning phase cannot hide the very terminal outcome being diagnosed.
 */
export const STREAM_TRACE_MAX_BYTES = 4 * 1024 * 1024

/** One raw chunk is recorded verbatim up to this many characters. */
export const STREAM_TRACE_MAX_TEXT = 16 * 1024

/** Values of {@link STREAM_TRACE_ENV} that mean "trace to the default file". */
const FLAG_VALUES = new Set(['1', 'true', 'yes', 'on'])

/**
 * Values that explicitly mean OFF.
 *
 * A user turning the trace off writes `false` as readily as they write `1` to
 * turn it on, and without this set every one of these spellings fell through to
 * "…so it must be a path" — the trace switched ON and wrote the conversation to
 * a file NAMED `false` (or `0`, or `off`) in the process's working directory.
 */
const OFF_VALUES = new Set(['0', 'false', 'no', 'off'])

/** What the adapter writes through; {@link openStreamTrace}'s disabled stand-in is inert. */
export interface StreamTrace {
  /** Whether records are actually being written. */
  readonly enabled: boolean
  /**
   * Append one record.
   *
   * @param event - short record name (`response`, `chunk`, `eof`, …).
   * @param fields - JSON-serializable payload; never pass credentials.
   */
  record(event: string, fields?: Record<string, unknown>): void
  /** Write the closing record; safe to call twice, and on a capped trace. */
  close(): void
}

/** The inert trace used whenever the switch is off. */
const OFF: StreamTrace = { enabled: false, record: () => undefined, close: () => undefined }

/**
 * Resolve the trace file for this process.
 *
 * @param raw - the variable's raw value; defaults to the live environment.
 * @returns the file to append to, or undefined when the trace is off.
 */
export function resolveStreamTracePath(
  raw: string | undefined = process.env[STREAM_TRACE_ENV],
): string | undefined {
  const value = raw?.trim()
  if (value === undefined || value === '') return undefined
  const lower = value.toLowerCase()
  if (OFF_VALUES.has(lower)) return undefined
  if (FLAG_VALUES.has(lower)) return join(tmpdir(), STREAM_TRACE_DEFAULT_FILE)
  return value
}

/**
 * Clamp one recorded payload so a single chunk cannot consume the whole cap.
 *
 * @param text - the text to record.
 * @param max - characters to keep, defaulting to {@link STREAM_TRACE_MAX_TEXT}.
 * @returns `text` unchanged, or its head plus a marker naming what was dropped.
 */
export function boundTraceText(text: string, max: number = STREAM_TRACE_MAX_TEXT): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…[+${text.length - max} chars]`
}

/**
 * Open one request's trace.
 *
 * @param scope - what the records describe (the `provider/model` route).
 * @param options - `path` overrides the environment (tests pass a temp file);
 *   `now` overrides the clock the `at` stamps are measured with.
 * @returns a writer that never throws and never fails the request.
 */
export function openStreamTrace(
  scope: string,
  options: { path?: string; now?: () => number } = {},
): StreamTrace {
  const path = options.path ?? resolveStreamTracePath()
  if (path === undefined) return OFF
  const now = options.now ?? Date.now
  const startedAt = now()
  let written = 0
  let stopped = false
  let capped = false
  const terminals = new Set<string>()
  // The directory is created once, here, so the hot path is a single append.
  // A path that cannot be prepared disables the trace rather than throwing:
  // the request this observes must not depend on the observer.
  try {
    mkdirSync(dirname(path), { recursive: true })
  } catch {
    return OFF
  }
  const write = (record: Record<string, unknown>): void => {
    if (stopped) return
    const terminal = record.event === 'end' || record.event === 'stream-close'
    if (capped && !terminal) return
    if (terminal && terminals.has(String(record.event))) return
    let line: string
    try {
      line = `${JSON.stringify({ at: now() - startedAt, scope, ...record })}\n`
    } catch {
      // A payload that cannot be serialized (a cycle, a BigInt) drops that
      // record only; the trace stays on for the records that do serialize.
      return
    }
    // Bound final metadata too: at most two 16 KiB records beyond the payload
    // cap. Count UTF-8 bytes, since reasoning often contains non-ASCII text.
    if (terminal) {
      if (Buffer.byteLength(line) > STREAM_TRACE_MAX_TEXT) return
      terminals.add(String(record.event))
    } else if (written + Buffer.byteLength(line) > STREAM_TRACE_MAX_BYTES) {
      capped = true
      line = `${JSON.stringify({ at: now() - startedAt, scope, event: 'trace-capped', bytes: written })}\n`
    }
    try {
      appendFileSync(path, line)
      written += Buffer.byteLength(line)
    } catch {
      stopped = true
    }
  }
  write({ event: 'stream-open' })
  return {
    enabled: true,
    record(event, fields) {
      write(fields === undefined ? { event } : { event, ...fields })
    },
    close() {
      write({ event: 'stream-close', bytes: written })
    },
  }
}
