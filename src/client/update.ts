/**
 * Plugin update hint (browser half).
 *
 * A deliberately small feature: when the "Command Code" settings page opens,
 * ask the npm registry for the package's published `latest` version and —
 * only when it is newer than the running build — let the page's footer show a
 * muted "newer version available" link to the GitHub releases. Everything
 * here is React-free and side-effect-seamed so node tests can drive it.
 *
 * Behaviour contract:
 *
 * - The registry is queried at most once per {@link UPDATE_CHECK_INTERVAL_MS}
 *   per browser profile; the learned version is cached in `localStorage`
 *   alongside the attempt time, so re-opening the settings page is free.
 * - A failed check records the attempt time too (an offline browser must not
 *   hammer the registry on every page open) but keeps any previously learned
 *   version, so the hint survives transient outages until it expires.
 * - Every failure mode (blocked network, non-OK status, malformed payload,
 *   unavailable storage) degrades to "no hint"; nothing ever throws out of
 *   {@link checkForUpdate}.
 *
 * The registry serves `access-control-allow-origin: *`, so the plain browser
 * fetch works from the GUI origin without any Host-side proxying.
 *
 * @module dsh-commandcode-provider/client/update
 */

/** How often the page may hit the registry: once a day. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

/** Abort a hung registry request rather than keep the footer waiting. */
export const FETCH_TIMEOUT_MS = 5000

/**
 * The npm registry document for this package's `latest` dist-tag. The scoped
 * name is path-escaped (`%2F`) so no client normalizes the slash away.
 */
export const NPM_LATEST_URL =
  'https://registry.npmjs.org/@mars-sea%2Fdsh-commandcode-provider/latest'

/**
 * Compare two version strings (`major.minor.patch[-pre]`). Returns a negative
 * number when `a` sorts before `b`, positive when after, zero when equal.
 *
 * Tolerant by design: a leading `v` is stripped, unparsable numeric parts
 * count as `0`, and semver prerelease rules apply (release > prerelease;
 * numeric identifiers compare numerically, everything else lexically, a
 * shorter identifier list sorts first). Enough for release tags; not a full
 * semver validator.
 */
export function compareVersions(a: string, b: string): number {
  const left = splitVersion(a)
  const right = splitVersion(b)
  const depth = Math.max(left.core.length, right.core.length)
  for (let index = 0; index < depth; index += 1) {
    const delta = (left.core[index] ?? 0) - (right.core[index] ?? 0)
    if (delta !== 0) return Math.sign(delta)
  }
  // A release outranks any prerelease of the same core version.
  if (left.pre.length === 0 && right.pre.length === 0) return 0
  if (left.pre.length === 0) return 1
  if (right.pre.length === 0) return -1
  const width = Math.max(left.pre.length, right.pre.length)
  for (let index = 0; index < width; index += 1) {
    const l = left.pre[index]
    const r = right.pre[index]
    if (l === undefined) return -1
    if (r === undefined) return 1
    const lNumeric = /^\d+$/.test(l)
    const rNumeric = /^\d+$/.test(r)
    let delta: number
    if (lNumeric && rNumeric) delta = Number(l) - Number(r)
    else if (lNumeric) delta = -1 // numeric identifiers sort below alphanumeric
    else if (rNumeric) delta = 1
    else delta = l < r ? -1 : l > r ? 1 : 0
    if (delta !== 0) return Math.sign(delta)
  }
  return 0
}

/** True when `candidate` is strictly newer than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0
}

/** Split a tolerant version string into numeric core + prerelease ids. */
function splitVersion(value: string): { core: number[]; pre: string[] } {
  const [coreText = '', preText] = value.trim().replace(/^v/i, '').split('-')
  const core = coreText === ''
    ? [0]
    : coreText.split('.').map((part) => {
        const parsed = Number.parseInt(part, 10)
        return Number.isFinite(parsed) ? parsed : 0
      })
  const pre = preText === undefined ? [] : preText.split('.')
  return { core, pre }
}

/**
 * Extract the published version from the registry's `/latest` manifest
 * (`{ name, version, … }`). Throws on anything unexpected so callers treat a
 * shape change as a failed attempt, never as bogus data.
 */
export function parseLatestVersion(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('npm latest payload is not an object')
  }
  const version = (payload as { version?: unknown }).version
  if (typeof version !== 'string' || !/^\d+\.\d+\./.test(version)) {
    throw new Error('npm latest payload has no usable version')
  }
  return version
}

/** Fetch and parse the published `latest` version. Rejects on any failure. */
export async function fetchLatestVersion(
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetchImpl(NPM_LATEST_URL, { signal: controller.signal })
    if (!response.ok) {
      throw new Error(`registry responded ${response.status}`)
    }
    return parseLatestVersion(await response.json())
  } finally {
    clearTimeout(timer)
  }
}

/** What the cache remembers about the last check. */
export interface UpdateCheckRecord {
  /** When the last attempt completed (success or failure), epoch ms. */
  at: number
  /** The last successfully learned upstream version, if any. */
  version?: string | undefined
}

/** Storage seam so tests can stand in for `localStorage`. */
export interface UpdateCheckStore {
  read(): UpdateCheckRecord | undefined
  write(record: UpdateCheckRecord): void
}

/** The `localStorage` key holding {@link UpdateCheckRecord}. */
export const UPDATE_CHECK_CACHE_KEY = '@mars-sea/dsh-commandcode-provider/update-check'

/**
 * A {@link UpdateCheckStore} backed by `localStorage`. Tolerates a missing or
 * throwing storage (SSR-ish contexts, private modes): reads yield `undefined`,
 * writes are dropped.
 */
export function localStorageUpdateStore(
  storage: Storage | undefined = typeof localStorage === 'undefined' ? undefined : localStorage,
): UpdateCheckStore {
  return {
    read(): UpdateCheckRecord | undefined {
      if (storage === undefined) return undefined
      try {
        const raw = storage.getItem(UPDATE_CHECK_CACHE_KEY)
        if (raw === null) return undefined
        const parsed: unknown = JSON.parse(raw)
        if (typeof parsed !== 'object' || parsed === null) return undefined
        const at = (parsed as { at?: unknown }).at
        if (typeof at !== 'number' || !Number.isFinite(at)) return undefined
        const version = (parsed as { version?: unknown }).version
        return {
          at,
          version: typeof version === 'string' && version !== '' ? version : undefined,
        }
      } catch {
        return undefined
      }
    },
    write(record: UpdateCheckRecord): void {
      if (storage === undefined) return
      try {
        storage.setItem(UPDATE_CHECK_CACHE_KEY, JSON.stringify(record))
      } catch {
        // Quota/private-mode failures must never break the page.
      }
    },
  }
}

/**
 * Run one throttled update check. Resolves with the newest published version
 * when it is newer than `currentVersion`, otherwise `undefined`.
 *
 * Within the throttle window (or on failure) the cached version answers, so
 * the hint keeps working offline; past the window the registry is consulted
 * again and the attempt time is refreshed either way.
 */
export async function checkForUpdate(options: {
  currentVersion: string
  now: number
  store: UpdateCheckStore
  fetchImpl?: typeof fetch
}): Promise<string | undefined> {
  const { currentVersion, now, store } = options
  const hintOf = (version: string | undefined): string | undefined =>
    version !== undefined && isNewerVersion(version, currentVersion) ? version : undefined

  const cache = store.read()
  if (cache !== undefined && now - cache.at < UPDATE_CHECK_INTERVAL_MS) {
    return hintOf(cache.version)
  }

  let learned: string | undefined
  try {
    learned = await fetchLatestVersion(options.fetchImpl)
  } catch {
    // Degrade silently: record the attempt below and fall back to the cache.
  }
  const version = learned ?? cache?.version
  store.write({ at: now, version })
  return hintOf(version)
}
