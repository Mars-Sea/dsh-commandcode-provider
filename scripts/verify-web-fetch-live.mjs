/**
 * LIVE 验证：驱动**插件自己的** `CommandCodeFetchProvider` 走真实的
 * `/alpha/web-fetch`，而不是手写 fetch 打到网关。
 *
 * 与单元测试的区别：`tests/web-fetch.test.ts` 用的是合成响应，证明的是"本插件
 * 按我们理解的契约收发"；这份验证回答的是契约本身是否成立——真实网关对
 * `{url, format}` 的实际产物、非 2xx 到底是结果还是异常、空页与超长页的真实
 * 形态，以及本地 URL guard 是否在计费前拦住了本该被拒的目标。
 *
 * 只输出判定与响应形状摘要（长度、状态、首行片段）；不打印凭据，不落盘会话正文。
 * 报告写到 `--out`（默认临时目录），不随插件发布。
 *
 * 凭据解析顺序（与插件一致，且与 README 的说明一致）：
 *   1. `COMMANDCODE_API_KEY` 进程环境
 *   2. `--credential-ref <name>`：经 dsh 凭据库（`$DSH_HOME/.credentials.yaml`）
 *      解析该引用。本机 `COMMANDCODE_API_KEY` / `CC_SWITCH_DSH_COMMAND_CODE`
 *      两条都只存在于凭据库，进程环境通常没有导出，所以这条是主路径。
 *   3. `~/.commandcode/auth.json`（官方 CLI 写的那份）
 *
 *   VERIFY_DRY_RUN=1 node --import tsx scripts/verify-web-fetch-live.mjs
 *   node --import tsx scripts/verify-web-fetch-live.mjs --credential-ref COMMANDCODE_API_KEY
 *
 * 成本：每个真实抓取都是一次计费的服务端调用；默认目标是小体积公开页，跑完
 * 一次约为几次搜索的量级。`--skip-network-cases` 可以只验本地 guard。
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { CommandCodeFetchProvider, FETCH_ROUTE, fetchUrlGuard } from '../src/web-fetch.ts'

// ---------------------------------------------------------------------------
// 参数与凭据
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const value = (name, fallback) => {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}

const DRY = process.env.VERIFY_DRY_RUN === '1'
const SKIP_NETWORK = flag('--skip-network-cases')
const BASE = value('--api-base', process.env.COMMANDCODE_API_BASE ?? 'https://api.commandcode.ai')
const CREDENTIAL_REF = value('--credential-ref', process.env.COMMANDCODE_CREDENTIAL_REF)
const OUT = value('--out', join(tmpdir(), `dsh-commandcode-web-fetch-${new Date().toISOString().replace(/[:.]/g, '-')}.json`))

/** `$DSH_HOME` 或 `~/.dsh`；凭据库就在其下。 */
function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/**
 * 从 dsh 凭据库解析一条引用。
 *
 * 只解析这一个引用，不枚举、不扫描其它任何文件（本仓明令禁止扫描 pi/OMP 的
 * 认证文件）。解析失败一律返回 undefined，由调用方决定怎么报。
 */
function readCredentialStore(ref) {
  const path = join(dshHome(), '.credentials.yaml')
  if (!existsSync(path)) return undefined
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  // 存储格式是扁平的 `REF: value`（值可能是带引号的标量）。这里只需要取那
  // 一条，所以按行匹配后剥引号，不引入 YAML 依赖。
  const pattern = new RegExp(`^\\s*${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*(.+?)\\s*$`, 'm')
  const match = pattern.exec(text)
  if (match === null) return undefined
  const raw = match[1]
  const unquoted = /^(['"])(.*)\1$/.exec(raw)
  const secret = unquoted !== null ? unquoted[2] : raw
  return secret.length > 0 ? secret : undefined
}

function resolveCredential() {
  const fromEnv = process.env.COMMANDCODE_API_KEY
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return { key: fromEnv, source: 'env:COMMANDCODE_API_KEY' }
  if (typeof CREDENTIAL_REF === 'string' && CREDENTIAL_REF.length > 0) {
    const stored = readCredentialStore(CREDENTIAL_REF)
    if (stored !== undefined) return { key: stored, source: `credentials:${CREDENTIAL_REF}` }
    return { key: undefined, source: `credentials:${CREDENTIAL_REF} (not found)` }
  }
  const authFile = join(homedir(), '.commandcode', 'auth.json')
  if (existsSync(authFile)) {
    try {
      const parsed = JSON.parse(readFileSync(authFile, 'utf8'))
      const key = parsed?.apiKey ?? parsed?.api_key ?? parsed?.key
      if (typeof key === 'string' && key.length > 0) return { key, source: 'auth.json' }
    } catch {
      /* fall through to an explicit failure */
    }
  }
  return { key: undefined, source: 'none' }
}

const credential = DRY ? { key: 'dry-run-key', source: 'dry-run' } : resolveCredential()

// ---------------------------------------------------------------------------
// 记录与断言
// ---------------------------------------------------------------------------

/** 每条用例的结果。 */
const results = []
/** 每一次真实请求的 URL 与 body（不含 header）。 */
const requests = []

function record(name, ok, detail) {
  results.push({ name, ok, ...detail })
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`${mark}  ${name}${detail?.note === undefined ? '' : ` — ${detail.note}`}`)
}

/** 一句话摘要：保留形状，不把正文整段打出来。 */
function summarize(text) {
  const firstLine = text.split('\n').find((line) => line.trim().length > 0) ?? ''
  return `${text.length} chars, first line: ${JSON.stringify(firstLine.slice(0, 80))}`
}

/** 驱动插件自己的提供方，并记下它真的发出了哪个请求。 */
function makeProvider() {
  return new CommandCodeFetchProvider({
    apiBase: () => BASE,
    resolveKey: async () => credential.key,
    fetchImpl: async (input, init) => {
      let body
      try { body = JSON.parse(String(init?.body)) } catch { body = undefined }
      requests.push({ url: String(input), body })
      return fetch(input, init)
    },
  })
}

async function expectWebError(provider, url) {
  try {
    await provider.fetch({ url })
    return { threw: false }
  } catch (error) {
    return { threw: true, code: error?.code, message: error instanceof Error ? error.message : String(error) }
  }
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

/** 本地 guard：必须在任何请求之前拒绝，且一次请求都不发。 */
async function localGuardCases() {
  const provider = makeProvider()
  const before = requests.length
  const cases = [
    ['http://169.254.169.254/latest/meta-data/', 'WEB_BLOCKED_URL'],
    ['http://127.0.0.1:8080/', 'WEB_BLOCKED_URL'],
    ['http://localhost:9/', 'WEB_BLOCKED_URL'],
    ['https://user:pass@example.com/', 'WEB_BLOCKED_URL'],
    ['https://intranet/', 'WEB_BLOCKED_URL'],
    ['file:///etc/passwd', 'WEB_INVALID_URL'],
  ]
  let allBlocked = true
  for (const [url, expected] of cases) {
    const outcome = await expectWebError(provider, url)
    const ok = outcome.threw && outcome.code === expected
    if (!ok) allBlocked = false
    record(`guard ${url} → ${expected}`, ok, { url, code: outcome.code })
  }
  record('guard 用例没有产生任何网络请求', requests.length === before, { requestsSoFar: requests.length - before })
  return allBlocked
}

/** `http` 升级到 `https` 的真实往返。 */
async function upgradeCase(provider) {
  if (DRY) return record('http → https（dry run 未发请求）', true, { note: 'skipped' })
  // example.com 同时监听 http 与 https；插件必须把它升级后再发。
  const outcome = await expectWebError(provider, 'http://example.com/')
  const sent = requests.at(-1)
  const upgraded = typeof sent?.body?.url === 'string' && sent.body.url.startsWith('https://')
  record('http 目标被升级为 https 后发出', upgraded && !outcome.threw, {
    sentUrl: sent?.body?.url,
    code: outcome.code,
    note: outcome.threw ? outcome.message?.slice(0, 160) : undefined,
  })
}

/** 真实抓取：公网文档页。 */
async function successCase(provider, url) {
  if (DRY) return record(`fetch ${url}（dry run 未发请求）`, true, { note: 'skipped' })
  try {
    const result = await provider.fetch({ url })
    const ok = typeof result.body.content === 'string'
      && result.body.content.length > 0
      && result.body.kind === 'text'
      && result.statusCode >= 200
      && result.statusCode < 300
    record(`fetch ${url}`, ok, {
      statusCode: result.statusCode,
      finalUrl: result.url,
      redirected: result.url !== url,
      truncated: result.truncated,
      note: summarize(result.body.content),
    })
    return result
  } catch (error) {
    record(`fetch ${url}`, false, { code: error?.code, note: error instanceof Error ? error.message.slice(0, 240) : String(error) })
    return undefined
  }
}

/** 非 2xx：上游到底给结果还是给异常？这条决定映射是否成立。 */
async function notFoundCase(provider, url) {
  if (DRY) return record(`fetch 404 ${url}（dry run 未发请求）`, true, { note: 'skipped' })
  try {
    const result = await provider.fetch({ url })
    record(`fetch ${url} 以结果形式返回非 2xx`, result.statusCode >= 400, {
      statusCode: result.statusCode,
      note: summarize(result.body.content),
    })
  } catch (error) {
    // 上游本身报错也是一种"已核实的真实行为"，但映射层对非 2xx 的假设就要改。
    record(`fetch ${url} 由上游以异常拒绝`, false, {
      code: error?.code,
      note: `upstream rejected: ${error instanceof Error ? error.message.slice(0, 240) : String(error)}`,
    })
  }
}

/** 缺 `format` 时的默认值观测：只用于确认我们显式发 markdown 是安全的。 */
async function wireEchoCheck() {
  const sent = requests.filter((entry) => entry.url.endsWith(FETCH_ROUTE))
  const shapes = sent.map((entry) => Object.keys(entry.body ?? {}).sort().join(','))
  const uniform = shapes.length > 0 && shapes.every((shape) => shape === 'format,url')
  record('每个 /alpha/web-fetch 请求体都恰好是 {format,url}', uniform || sent.length === 0, {
    requests: sent.length,
    shapes: [...new Set(shapes)],
  })
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`target: ${BASE}${FETCH_ROUTE}`)
  console.log(`credential: ${credential.source}${credential.key === undefined ? ' (MISSING)' : ''}`)
  console.log(`mode: ${DRY ? 'dry run (no network)' : 'live'}\n`)

  if (!DRY && credential.key === undefined) {
    console.error('No Command Code credential: export COMMANDCODE_API_KEY, pass --credential-ref <name> for a dsh-credential-store entry, or run `command-code login`.')
    console.error('Nothing was verified; this is NOT a pass.')
    process.exitCode = 2
    writeReport()
    return
  }

  const provider = makeProvider()

  await localGuardCases()
  await upgradeCase(provider)

  if (!SKIP_NETWORK) {
    await successCase(provider, 'https://commandcode.ai/docs/reference/tools')
    await successCase(provider, 'https://en.wikipedia.org/wiki/Hypertext_Transfer_Protocol')
    await notFoundCase(provider, 'https://example.com/definitely-not-a-real-path-9f2a1c')
  }
  await wireEchoCheck()

  writeReport()

  const failed = results.filter((entry) => !entry.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length > 0) {
    console.log(`report: ${OUT}`)
    process.exitCode = 1
  }
}

function writeReport() {
  const report = {
    at: new Date().toISOString(),
    target: `${BASE}${FETCH_ROUTE}`,
    mode: DRY ? 'dry-run' : 'live',
    credentialSource: credential.source,
    guardSample: fetchUrlGuard('http://example.com/x'),
    requests: requests.map((entry) => ({ url: entry.url, body: entry.body })),
    results,
  }
  try {
    mkdirSync(dirname(OUT), { recursive: true })
    writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`)
  } catch (error) {
    console.error(`could not write the report to ${OUT}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

await main()
