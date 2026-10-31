/**
 * Transport failure reasons for the usage and settings diagnostics.
 *
 * Node's fetch rejects with `TypeError('fetch failed')` and keeps the real
 * cause one level down (`error.cause`): `ECONNREFUSED` when nothing listens on
 * the port, `ENOTFOUND` on DNS, a connect timeout behind a dead proxy. That
 * message alone cannot tell "the reverse proxy changed port" from "the proxy is
 * not running" from "the API is down", so per-endpoint failure lines and the
 * settings notice append a short Chinese reason plus the raw code (issue #111).
 *
 * Only the code is quoted back, never the system message: those may embed
 * internal paths, and the original message stays available through
 * `readableErrorText` for the detail line. An error with no code yields no
 * reason — the caller still renders what it has instead of an invented guess.
 *
 * @module dsh-commandcode-provider/transport-failure
 */

/** 原始错误码 → 界面原因；未列出的码只回显错误码，不做猜测。 */
const REASONS: Readonly<Record<string, string>> = {
  ECONNREFUSED: '连接被拒绝',
  ECONNRESET: '连接被重置',
  ENOTFOUND: '域名解析失败',
  EAI_AGAIN: '域名解析临时失败',
  EHOSTUNREACH: '主机不可达',
  ENETUNREACH: '网络不可达',
  ETIMEDOUT: '连接超时',
  UND_ERR_CONNECT_TIMEOUT: '连接超时',
  UND_ERR_SOCKET: '连接中断',
  UND_ERR_CLOSED: '连接已关闭',
  CERT_HAS_EXPIRED: '证书已过期',
  DEPTH_ZERO_SELF_SIGNED_CERT: '自签名证书不受信任',
  SELF_SIGNED_CERT_IN_CHAIN: '证书链中有自签名证书',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: '无法验证证书',
}

/** 取错误链上的第一个错误码：先看自身，再看 AggregateError 子项，最后看 cause。 */
function codeOf(value: unknown, depth = 0): string | undefined {
  if (depth > 4 || value === null || typeof value !== 'object') return undefined
  const entry = value as { code?: unknown; errors?: unknown; cause?: unknown }
  if (typeof entry.code === 'string' && entry.code !== '') return entry.code
  // Happy-eyeballs 连接会以 AggregateError 汇总多个地址的失败；任一首因都
  // 代表同一个「到不了」的事实，挑第一个能让原因稳定可预期。
  if (Array.isArray(entry.errors)) {
    for (const nested of entry.errors) {
      const code = codeOf(nested, depth + 1)
      if (code !== undefined) return code
    }
  }
  return codeOf(entry.cause, depth + 1)
}

/**
 * One diagnostic clause for a transport failure, or undefined when the error
 * carries no recognizable code.
 */
export function transportFailureReason(error: unknown): string | undefined {
  const code = codeOf(error)
  if (code === undefined) return undefined
  const reason = REASONS[code]
  return reason === undefined ? `网络错误（${code}）` : `${reason}（${code}）`
}

/**
 * `scheme://host:port` of a base, with path and query dropped: enough to name
 * the endpoint a failed request aimed at without echoing proxy prefixes, and
 * without any chance of a token riding along in a path.
 */
export function httpOrigin(base: string): string | undefined {
  try {
    const url = new URL(base)
    return `${url.protocol}//${url.host}`
  } catch {
    return undefined
  }
}
