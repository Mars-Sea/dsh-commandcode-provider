# Client and settings contracts

Task-specific reference moved from the former root `AGENTS.md`. All source and test paths are relative to the repository root. Consult the relevant source and tests before changing behavior.

- **账号开通**：两种新增方式统一使用 `src/enrollment.ts`；`src/client/enrollment.ts` 由每次设置页挂载持有，`AddAccountPanel` 只负责输入和意图。面板按设计稿：「网页登录／粘贴密钥」分段切换 → 备注名 →（粘贴模式）密钥框 → 右侧「取消」+「开始登录／添加」；进行中只剩「取消开通」，命名失败为「取消／接受已有名称／重试保存名称」，判定在导出纯函数 `addAccountPanelView`（`tests/section.test.ts`）。切回网页登录会清空已填密钥。离开设置页取消未完成过程，已登录待命名则接受已有名称；命名失败保留账号，清理失败保留恢复记录并提供手动重试。默认或已有账号的 `login*` 契约继续使用原控制器。
- **自动打开授权页**：新增、默认和已有账号登录均在首次收到宿主授权地址后通过 `src/client/login-page.ts` 打开新页面，不预先打开空白页；同一尝试的轮询不重复打开，已取消尝试或已卸载的新增账号面板不会因迟到地址打开页面。浏览器可能拦截异步打开，界面始终保留授权链接及手动打开提示；打开失败不取消宿主登录。使用 `noopener,noreferrer` 隔离来源页，不能根据返回 `null` 判断是否拦截。
- **页面生命期**：`enrollmentWatch({ pageId })` 是持续远端流，先确认就绪再允许 `enrollmentBegin`。所有过程调用带页面身份；宿主将它与实际调用对端共同绑定。单次调用完成不结束过程；页面卸载主动取消并释放流，刷新或关闭由网关流取消信号触发收尾。DSH 的 `OperatorPeer` 是宿主共享作用域，不能用它冒充单个浏览器连接。载体断开不会自动重建原过程。
- **页面身份不依赖安全上下文（issue #102）**：页面身份由 `src/client/random-id.ts` 的 `randomId()` 生成，不直接调 `crypto.randomUUID()`——后者只在安全上下文存在，以 `http://<局域网 IP>:3080` 这类非 HTTPS、非 localhost 地址打开时是 `undefined`，而控制器在 `AccountsCard` 的 `useState(createEnrollment)` 惰性初始化里构造，那里的异常会被设置页插槽的错误边界接住，表现为「左侧标签正常、右侧内容区空白且无提示」。`randomUUID` 不可用时退回非安全上下文同样可用的 `crypto.getRandomValues`，按 RFC 4122 置入版本位与变体位，产出与 `randomUUID` 同形的 v4。页面身份只是宿主把开通过程绑到单个浏览器页面的分组键（宿主按不透明字符串比较，不校验 UUID 格式），不参与鉴权，因此不需要安全上下文。默认值经构造参数 `newId` 注入，测试可替换；覆盖见 `tests/random-id.test.ts`。
- **开通远端契约**：双方共享 `src/enrollment-wire.ts` 的七个严格描述符：`enrollmentBegin`、`enrollmentStatus`、`enrollmentCancel`、`enrollmentName`、`enrollmentRetry`、`enrollmentPending` 和流式 `enrollmentWatch`。前六个返回状态或恢复列表，观察流返回就绪确认；所有输入、输出使用严格编解码器。密钥仅允许在手动开始输入中出现，不进入状态、日志或设置文档。旧宿主缺少该契约时明确提示更新，不回退到旧的页面副作用编排。**状态消息只传语义键**：`EnrollmentState.messageKey` 取 `EnrollmentMessageKey`（22 个：宿主 15 个、页面控制器 7 个），`parseEnrollmentState` 校验枚举成员并拒绝自由文本；文案集中在设置页词典、渲染时才按界面语言取，因此宿主与页面不会各写一份，`phase` 也不必再兼作文案判据（同一 `phase` 对应多种语义，如 `naming` 的「正在保存名称」与「名称保存失败」）。宿主抛出的异常消息不在此列：它们不上屏，页面在所有失败路径都用自己这一侧的键覆盖。

- **登录总期限**：浏览器回调成功只关闭监听，不撤销登录计时器。身份验证带取消信号；超时、取消、替换尝试或销毁会中止验证，迟到结果不能开始存储或覆盖状态。期限同样约束等待存储的状态；宿主已发出的凭据写入不能凭空撤销，不能声称提供跨服务事务。
- **秒制设置保留毫秒精度**：显示与输入最多三位小数，范围 0.001–3600 秒，存储仍为整数毫秒；已有范围外配置照实显示，不静默截断。超时字段使用小数键盘和秒制错误说明，重试次数仍为整数。
- **设置写入所有权**：`src/client/settings.ts` 保留输入校验、草稿版本和投影，`src/client/settings-write.ts` 持有保存与即时账号操作的具名意图、统一队列、目标检查、批量配置与凭据确认。普通字段和可见模型的两个字段一次提交；配置确认后才发密钥。相关字段在排队期间变化整批冲突，无关变化使用最新版本；作用域明确返回接受、冲突、未确认或取消，重读相同值不能冒充本次接受。
- **默认目标保护与部分完成**：点击时冻结默认凭据引用，调用前变化停止，调用后变化记录原引用实际结果并提示核对；两者都保留密钥草稿，不自动写新引用或补偿删除。已确认配置仅清理本次旧草稿，等待期间的新输入、重置和模型选择保留。设置页和模型卡共用同一份写入阶段提示（都声明 `settings.commandcode` 词典，随界面语言切换中英），用量刷新依本次真实确认结果。
- **凭据事实与销毁**：凭据返回成功即为写入确认，描述仅提供存在性；描述失败或缺失保留最后确认事实，首次尚无确认时明确显示状态未知，重试入口只读状态。按引用及读取世代屏蔽迟到描述。普通切页不关闭共享控制器；插件销毁停止未开始任务，已发调用自然收束，不进入后续阶段。
- **凭据写入不再被环境变量遮蔽（alpha.3）**：凭据服务的 `describe()` 恒返回 `writable: true`，写入不再因环境变量遮蔽而被拒，服务内部的层序同步反转为「托管存储 → 继承环境 → 项目 `.env` → `$DSH_HOME/.env`」。**headless（无头）profile 有意不挂载 `credentials`／`authorization`／`deepseek-account` 三行**，没有凭据服务可读写，一次性任务只认启动环境与 `.env`。密钥解析侧见[账号与重试](accounts-and-retry.md)。
- **自动轮换**：取消固定账号时基础层仍固定账号，则显式写 `activeAccount: ''`；仅清除用户覆盖会重新露出基础层固定账号，不等于自动轮换。普通字段重置仍恢复继承。
- **用量读取的自动与显式路径**：一份用量报告是四次上游调用，而面板与账户卡片都会在无人操作时各自读取。`CommandCodeUsageController.refresh({ auto: true })` 标记「没人点过」的刷新，只有它在 `USAGE_AUTO_REFRESH_COALESCE_MS`（5 秒）内复用刚刚读取的结果；首屏 effect 与面板 tick 都走这条路径。按钮、保存、换/清凭据等显式调用不传 `auto`，不查合并窗口，永远真的去读（请求在途时仍按既有 `inFlight` 规则折叠，不会因点击再发一份）。窗口刻意很小，`fetchedAt` 因此仍如实反映数字被读取的时刻。首屏接线的真实渲染用例见 `tests/accounts-card-render.test.ts`：首屏必须调 `onRefreshAuto()`，刷新按钮必须调 `onRefresh()`。
- **隐藏页面不轮询**：`startPanelAutoRefresh()` 的 tick 先问 `AutoRefreshVisibility.isVisible()`（默认读 `document.visibilityState` 并订阅 `visibilitychange`），隐藏时跳过读取但照旧重排定时器；重新可见立即补读一次（该补读走 `auto`，5 秒内仍可能被合并）。首屏那次无条件读取 —— 那一刻没有数据可显示。可见性是可注入接缝，非浏览器环境视为始终可见。监听句柄与循环状态同层（模块级），因此启动循环的 surface 先卸载时也照样解绑，任意卸载顺序都不泄漏。
- **运行中请求的配置生效**：已确认的网关、账号列表、固定账号和模型规则用于新调用，已经开始的适配器调用继续使用自己的快照。引用凭据每次账号选择仍重新解析；清除后可能按既有优先级使用默认账号的授权文件兜底，不撤回已发请求或当前尝试已取得的密钥。
- **账户移除与清理**：`accounts`、`modelAccountRules`、固定账户及 `credentialCleanupRefs` 在一次带版本检查的 `remote.settings.mutate` 中提交，再清理凭据。失败队列持久化，页面刷新后仍显示重试；重新引用、继承配置和默认密钥受保护。无法确认凭据事实时保留队列。宿主配置与凭据服务并无共同事务，不能承诺任意外部并发重建与凭据删除跨服务原子化。

- **Client bundle**: the package's `dsh.client` declaration (`platform: web`,
  `inject: [...]`) makes the host serve `lib/client.js` as a client module.
  The bundle may only `require` the platform/seed modules the Web frontend
  actually seeds. That table is exactly `react`, `react/jsx-runtime`,
  `react-dom`, `react-dom/client`, `@deepseek-ai/cordis`, `zod`,
  `@tanstack/react-virtual`, `@deepseek-ai/dsh-client-store`,
  `@deepseek-ai/dsh-client-ui-slots`,
  `@deepseek-ai/dsh-client-ui-primitives` and
  `@deepseek-ai/dsh-client-ui-dockkit` (re-read out of the 0.2.1-rc.2 engine;
  unchanged from 0.2.1-alpha.5, 0.2.1-alpha.4, 0.2.1-alpha.3, 0.2.1-alpha.2, 0.2.1-alpha.1, 0.2.0-rc.2 and
  0.1.7-rc.2 — `zod` and `@tanstack/react-virtual` were seeded all along but
  missing from this list until the alpha.4 audit). Any other import
  must be type-only or bundled — `dsh-client-web-react`, `dsh-client-schema-form`
  and `dsh-client-ui-attachment` are NOT seeded and would fail the client
  `require()` audit in `scripts/verify-engine-load.mjs`. This client keeps the
  smaller local
  `getSnapshot`/`subscribe`/`set` subset in `src/client/snapshot-store.ts`
  instead of the seeded `@deepseek-ai/dsh-client-store` — ~30 lines, versus a fourth
  `require()` target and a client-only peer
  for the engine's `set()` semantics (dev-mode deep freeze, forced
  replacement). The settings page binds the
  `llm-commandcode` namespace through THIS PLUGIN'S OWN scope over
  `remote.settings` (`src/client/settings-scope.ts`) — the harness's
  `ctx.settingsScope` wrapper was removed by the
  0.1.7 settings rewrite and has no replacement, so this IS the client half;
  `settingsScope` must never reappear in the exported
  client `inject` list, because it is a service 0.1.7 does not provide and gating
  on it would gate EVERY surface (page, card, usage card, panel, session cost)
  into silence.
  The scope degrades on its own instead: no `remote.settings` → status
  `unavailable`, page renders its empty state. It writes the API
  key through `ctx.remote.credentials` under the `COMMANDCODE_API_KEY`
  reference — never through the settings section, so the key literal cannot
  leak into a settings document.
  `tests/settings.test.ts`, `tests/settings-scope.test.ts` and
  `tests/client-boot.test.ts` pin these
  internal faces. The exported client `inject` list is exactly
  `slots`, `locale`, `remote`: `connection` was dropped with the pre-0.1.2
  ApiProxy credential path it existed for, and a gate on a service some profiles
  never mount parks the whole bundle.
- **dsh 0.1.7's settings rewrite is the only settings world this plugin knows** (`src/config-volatile.ts`,
  the `ctx.inject(['settings'], …)` block in `src/index.ts`): 0.1.7 REPLACED the settings.yaml document with
  schema-derived profile Config forms (`SettingsProvider` → `SettingsForms`; `installSection` and the
  `settingsScope` client service are both gone), and its `settings.describe()` projects each entry through
  `volatileForm()` — a form contains ONLY schema nodes carrying `meta.volatile`, and a form edit whose path
  does not lie beneath a marked node is REFUSED. Six consequences are load-bearing:
  (1) **Every Config field except the top-level `apiKey` secret is marked via `markVolatileFields()`** — an
    unmarked field would be invisible to AND unwritable from the settings page. The mark is UNCONDITIONAL:
    `.volatile()` is a schemastery 3.18.3 feature and every supported engine (the whole
    `>=0.2.1-rc.2 <0.2.2-0` range) ships `~3.18.5`, so the method
    is always present (that is why `@deepseek-ai/schemastery` is a peer at `~3.18.5`, not `^3.18.2` — a
    profile resolving 3.18.2 would mark nothing and render a blank settings form). `apiKey` stays unmarked
    on purpose: no settings surface writes it (page and TUI both write keys through the credentials seam),
    so a config-file edit to it reloading the fiber is correct for a secret literal.
  (2) **`apply()` receives frozen `{ get() }` references for every marked field**, so `current()` is
    `unwrapVolatileConfig(config)` — a FRESH unwrap per read, because a reference's identity is stable while
    its value changes. The loader wraps EVERY marked node, unset fields included, so a parsed config always
    yields a new object per read; there is deliberately NO identity-keyed memo over it (the one that used to
    exist could never hit, and a cached plain snapshot would go stale on the next settings write). Only
    top-level fields are marked, so one unwrap level is complete. Everything downstream keeps reading a
    plain `Config`.
  (3) **Volatile writes commit in place — no remount — and notify the owning fiber** with
    `loader/volatile-update` (paths already committed). The listener re-runs the two facts that are NOT
    re-derived from `current()` per use: the web-search selection (a written private field, see the
    web-search bullet) and the dsh-TUI section re-registration (its option lists are frozen into the
    declaration). It is typed structurally because the event comes from `cordis-plugin-loader`, which is not
    a peer of this bundle.
  (4) **The Host registration is one call**: `configure({ auto: false }, ctx.fiber)` as an effect on the
    settings child, which declares that we ship our own page (so SettingsForms publishes no auto-generated
    form for this entry). There is no capability branch and no local service seam: `import type {} from
    '@deepseek-ai/dsh-settings'` augments `Context` with the real `SettingsForms`, so the call typechecks
    against the engine it will run on.
  (5) **The one-time 0.1.7 settings.yaml import needs no cooperation from us** — the engine looks the
    section up BY PROFILE ENTRY ID, and our section id and entry id are the SAME string (`llm-commandcode`).
    Never rename one without the other: a mismatch strands existing users' non-secret settings in
    `settings.yaml.imported` (logged, not applied). Pinned by `tests/volatile-config.test.ts` (the helpers),
    `tests/settings-scope.test.ts` (the client scope), `tests/package.test.ts` (four-way range sync + the
    two RC `dshReleases` records, `0.2.0-rc.2` and `0.2.1-rc.2`) and `npm run test:engine`.
  (6) **On the browser side the namespace object must be captured from an INJECT-SCOPED context — never read
    off `ctx.remote`** (`createSettingsScope(ctx, ns, resolveRemote)` in `src/client/settings-scope.ts`,
    wired by the `ctx.inject(['remote.settings'], …)` block in `src/client/index.ts`; the 0.1.7
    settings-page report: 《所有的按钮和开关都无法点击，下拉选择模型也无法使用》). `remote.settings` is a Cordis service NESTED under
    the `remote` service (api-gateway registers one `Service` per contribution namespace under the name
    `remote.<ns>`), and cordis answers a read from a fiber that does not declare that name in its inject
    list with `Error: cannot get property "remote.settings" without inject`. Our plugin declares only
    `remote`, so the old direct read threw — inside the mirror's own `try`/`catch`, which is why NOTHING was
    logged and no `settings/describe` ever left the browser. The consequences are the whole reported
    symptom: the mirror never leaves `idle`, `RemoteSettingsScope` keeps its INITIAL snapshot (`status:
    'loading'`, `writable: false`, `value: undefined`), and since `disabled = !state.writable` the page
    renders its read-only banner with every input, switch and select disabled, while the boolean toggles
    fall back to their hardcoded `defaultChecked` (which is why a reader may see "correct-looking" switches
    over empty text fields). The same rule governs every other namespace this plugin reads:
    `remote.credentials` and `remote.commandcode` were already resolved through their own inject callbacks
    (`(remoteCtx) => remoteCtx.remote.<ns>`), and `$host` / `$on` / `$mount` are plain members of the
    declared `remote` service, so those stay direct reads. A namespace that never mounts leaves the pending
    inject idle and the page keeps its degraded state — do NOT "fix" this by adding `remote.settings` to the
    exported client `inject` list, which would gate every surface (page, card, usage card, panel, session
    cost) on a service a profile may not serve. Two recovery rules ride the same wiring and are equally
    load-bearing. (a) The mount callback re-reads the USAGE report (`refreshUsage?.()` — a seam declared
    before the effect, because the inject callback can run before the controller's own `const` and a
    temporal-dead-zone read would THROW): a surface that asked before the namespace landed (the quota card's
    first paint does, every boot) stored the synthetic "remote is not mounted" failure as `status: 'error'`,
    and `shouldRefresh` only fires from `idle`, so nothing else would ever retry it. (b)
    `SettingsDescribeMirror` retries a FIRST describe failure on a bounded 1/2/4 s ladder
    (`SETTINGS_DESCRIBE_RETRY_MS`, injectable timer): with nothing ever held the scope keeps its initial
    `loading`/`writable: false` snapshot, which the settings page renders as a fully disabled form behind a
    "read-only" banner, and the forwarded invalidations need a live Host to fire — so a Host that was still
    starting up left the page dead until a reload. A failure with a HELD view schedules nothing (the page is
    already showing the last good document). Pinned by `tests/settings-scope.test.ts` (its fake context's
    `settings` getter THROWS the engine's exact error, plus the unmounted → mount + `refresh()` handshake,
    the retry ladder, and its disposal) and by `tests/client-boot.test.ts`, whose `remote` is a real
    `Service` and whose namespaces mount as `remote.<ns>` child-fiber services (one boot defers
    `commandcode` by a macrotask and asserts the mount callback re-read the report) — so a regression fails
    the boot suite, not just the browser.
- **Models-page provider card (`settings.models.provider-card`)**: a keyed
  SlotMap seat ui-settings-models declares — it
  dispatches with `entryKey = settingsNs` on every provider card of an adapter
  family. The client entry registers a cell with `key: 'llm-commandcode'`
  (the directory row's settings namespace), carrying its own inject face
  (store hooks + actions) because the declaring entry is ui-settings-models',
  not ours; the `t` seat comes from the registration's own `locale`
  namespace. The card (src/client/card.tsx) is the row's configuration panel
  driven by the OFFICIAL 编辑 toggle: closed it renders nothing (the row looks
  like any other provider row); open, it hides the official editor shell —
  for `llm-commandcode` the page's `layoutOf` returns "unknown", so that shell
  carries only a config hint over a permanently disabled apply — and shows
  the real controls (key status + route badges, paste field, sign-in,
  discard/save) wired to the SHARED settings controller (the authoritative
  credential fact is `apiKeyConfigured`; the owner's `keyConfigured` is
  fallback only). The shell is found as an immediate sibling of the renderer's
  stable `data-slot="settings.models.provider-card"` outlet wrapper (after it
  in a row, before it in the setup/add cards) by its CSS-module `editor` class
  stem — no hashed class is hardcoded — via a MutationObserver on the parent;
  if dsh restructures, detection fails benign and the stock shell reappears.
  The SlotMap merge for the two seats lives in card.tsx and must stay
  structurally identical to upstream's declaration (compile-time duplicate
  merge would fail once a peer ships it). On dsh builds without the slot the
  declaration never exists and `slots.inject` never fires — the registration
  silently does not happen; do not "harden" that into an error.
- **Service status row (`settings.section` → Integrations & display)**
  (`src/client/service-status.ts`): reads the two public files the official
  status page (status.commandcode.ai, an Upptime deployment) itself reads —
  `history/summary.json` for the verdict plus 7/30-day uptime and 7-day average
  response time, and `history/command-code.yml` for the monitor's own
  `lastUpdated`. `raw.githubusercontent.com` is tried first, jsDelivr second
  (same files, longer `@master` cache); both serve `access-control-allow-origin:
  *`, so the plain browser fetch works with no Host proxy, like `./update.ts`'s
  registry check. The snapshot is cached in `localStorage` for five minutes;
  every failure keeps the last good snapshot marked `stale` and paints it with a
  "last known result" notice, while a cold cache degrades to "status unknown".
  `checkServiceStatus` never throws and the row writes no setting, so a network
  failure cannot block Save. The dot reuses the framework's `StateDot`
  (done/warning/error/idle) instead of a local colour token, and all copy rides
  the `settings.commandcode` namespace (zh is the source of truth).
  The row pairs that published record with a live probe: `commandcode/probe`
  (`src/service-probe.ts` + `src/service-probe-wire.ts`) runs HOST-side against
  the configured API base, because `api.commandcode.ai` sends no CORS header and
  on a remote-Host setup the browser machine is not the one serving requests.
  The probe is one unauthenticated GET of `{apiBase}/alpha/whoami` — the same
  endpoint login validation and account queries use, built by the same string
  concatenation real requests use so a path-prefixed reverse proxy is exercised
  as-is (issue #111) — with a five-second timeout and `redirect: 'manual'`.
  Statuses are read as reachability: 2xx/3xx and 401/403 are `ok` (a
  credential-less GET of that endpoint IS supposed to be answered 401; 403
  covers gateway-level rejections), everything else is `http-error`, with
  distinct `timeout` and `unreachable` outcomes. It never throws and never
  claims more than "this Host reached the endpoint just now"; the row renders
  its own dot and line.
  **Deliberate limits**: the monitor probes only `https://api.commandcode.ai`'s
  root (HTTP 200), so "operational" does not prove inference works; Upptime's
  `lastUpdated` is the last PUBLISH time, not the last check — the state file is
  only rewritten when the status changes or when the daily `response-time`
  workflow forces a commit, and GitHub throttles the five-minute cron into runs
  every few hours. The row therefore says "official data updated N ago" (never
  "last check"), adds a publication-lag note past two hours
  (`SERVICE_STATUS_LAG_WARN_MS`), and leaves real-time answers to the Host
  probe. Past incidents are GitHub issues, not data files, and are left to the
  page itself (the row links to it). Pinned by `tests/service-status.test.ts`,
  `tests/service-probe.test.ts` and the probe codec cases there.
- **Browser login (`commandcode/loginBegin|loginStatus|loginCancel`)**: the
  settings page's key field can start the official `command-code login` flow
  instead of pasting a key — reverse-engineered from the CLI bundle's
  `createAuthFlowController`/`createAuthServer` (command-code@1.32.1): bind
  `127.0.0.1` from port 5959 upward, open
  `{studio}/studio/auth/cli?callback=http://localhost:{port}/callback&state=…`,
  receive a **POST JSON body** `{apiKey,state,userId,userName,keyName}` from
  the Studio page (no OAuth code exchange), validate via `/alpha/whoami`,
  then store through the credentials seam under the default slot's ref. The
  loopback server mirrors the CLI contract exactly (POST-only `/callback`,
  10 KB body cap, state-token equality, `{success}` JSON responses); three
  deliberate hardenings over the CLI — CORS origins are echoed **only when
  allowlisted** (the CLI falls back to the first origin), `Connection: close`,
  and the denial branch (`{"error":…}`) checks the state token **before** it
  ends the attempt, exactly where the CLI checks it. That last one is
  load-bearing: a denial is terminal and a `text/plain` POST rides as a CORS
  simple request (the browser sends it whatever the origin allowlist says), so
  without the check any open page could cancel a login in progress. Attempt
  ownership (`attemptSeq` + `ownsAttempt()`) is the other non-obvious rule:
  the delivered key is validated over an await, and a cancel or a new `begin()`
  during that window must win — no key write and no status publish from an
  attempt that no longer owns the flow. `begin()` likewise retires a `waiting`
  status whose server is gone (the callback was consumed, the port is closed)
  instead of handing back a dead authUrl, and it is SINGLE-FLIGHT across the
  bind: a second concurrent `begin()` (two GUI tabs, or a Sign-in that follows
  a cancel arriving before the status says `waiting`) joins the in-flight
  `starting` promise instead of binding its own loopback server — only the LAST
  bound server is reachable by `teardown()`, so the loser used to listen (and
  answer `/callback`) for the life of the process, and ten of those exhausted
  the port window. A `cancel()` in that window sets `cancelPending`, which
  `startAttempt()` observes after the bind and answers by closing the fresh
  server and publishing `failed/cancelled` rather than a live authUrl nobody
  wants. The
  three endpoints ride the SAME `commandcodeUsage` service and one combined
  contribution (one Host registration, one Client mount); the namespace-level
  `TypertRemoteNamespaceMap.commandcode` augmentation lives ONLY in
  `src/client/usage.ts` (interface merging forbids duplicate members). A
  literal composition `apiKey` still outranks the stored credential; a
  remote-Host setup (browser ≠ Host machine) falls back to manual paste by
  design.
- **Literal API keys are `role('secret')`** (`Config.apiKey` and
  `Config.accounts[].apiKey`): the settings page writes keys through the
  credentials seam, so the literal path exists only for composition configs —
  but that path IS a settings value, and the harness strips a secret role from
  every descriptor it serves (`settings.describe()` runs with
  `redactSecrets: true`). Dropping the role leaks the key to the browser
  verbatim (another machine on a remote Host). Pinned by
  `tests/config-schema.test.ts` against the real `redactSecrets`.
- **dsh-TUI settings section (`src/tui-settings.ts` + the optional
  `tuiSettingsSections` seam)**: a TUI-only user has NO other way to enter the
  API key — dsh-TUI's `/provider` wizard manages its own `llm-pi-ai` routes
  exclusively, and `/settings` renders only sections a plugin DECLARES. So the
  plugin declares a Command Code
  page over `ctx.inject(['tuiSettingsSections'], …)`, exactly like
  `commands`/`web`/`typert`; without dsh-TUI the fiber never activates and the
  plugin stays an LLM-provider-only bundle. Four rules are load-bearing.
  (1) **No dependency on the terminal front door**: the seam's types are
  re-declared locally, because the plugin must not import
  `@deepseek-harness-tui/dsh-tui`. Every read is defensive (missing service,
  non-object, missing `register` → no section) and the read goes through the
  REFLECTIVE `ctx.get('tuiSettingsSections')`, never a bare property access —
  cordis throws `cannot get property … without inject` for an undeclared
  service, which would take the plugin's boot down on every non-TUI profile.
  (2) **The key field is a `secret` field**, so dsh-TUI writes the draft
  through the credentials seam under the declared ref and never into a
  settings document; the ref must stay out of the host-reserved namespace
  (`DEEPSEEK_API_KEY`/`DEEPSEEK_*`/`DSH_*` — dsh-TUI silently DROPS a field
  with a reserved ref, which would leave a page with no key input at all), and
  a secret field has no `format`/`parse` (the host never seeds a draft from
  the document).
  (3) **Unset must stay reachable**: dsh-TUI's `select` kind can only land on
  a declared option, so `activeAccount` and `lang` are `text` + `options` (the
  host's own preset-plus-custom shape) with an `auto` sentinel whose `parse`
  emits `{ kind: 'clear' }`. `filterModelsByPlan` likewise FORMATS its
  effective default (`true` when unset) instead of the raw `undefined`, since
  a raw boolean format would render "(empty)" on a fresh install.
  (4) **Registration is a declaration, not a binding**: the host renders a
  fixed field list, so anything frozen into it (the credential ref, the
  account-slot option list) is refreshed by re-registering from the
  settings-change hook (the `loader/volatile-update` listener — see the
  settings bullet) — withdraw first, then declare, and only
  when `sectionSignature()` actually moved, or every ordinary settings write
  would churn the screen's section list. A rejecting host is contained with a
  warning (a shadow-mode capability policy, a future contract change) and stays
  retryable, never fatal. Pinned by `tests/tui-settings.test.ts`.
- **Client-side staging survives failed and concurrent saves** (`src/client/settings.ts`):
  writes run in order and stop at the first failure. Ordinary drafts already accepted by the Host may
  be reconciled; unaccepted drafts remain. Successful saves clear only the captured draft versions,
  including a frozen visible-model selection. Account lists are rebuilt from raw stored entries so
  literal-key or unknown entries the page cannot name survive unrelated account edits.
- **设置页折叠（决策记录第十章第4条，取代 issue #94 的单组折叠）**：五个顶级分组共用 `FoldableGroup`
  （`src/client/section.tsx`）——`h3` 包一个整行按钮，箭头在标题左侧，「刷新」这类分组动作放在按钮外。
  默认只展开「账户」（页头的「全部展开／全部收起」已按用户要求删除）；展开状态存在浏览器本地一个键
  `@mars-sea/dsh-commandcode-provider/settings-fold`（`src/client/group-fold.ts`，缺失、损坏或存储被禁用时回落
  默认，不进配置文档、不随 profile 同步）。收起的正文以 `hidden` 保留挂载（有意不加动画：分组折叠发生得
  太频繁），`aria-controls` 始终有效。
  标题旁摘要徽标展开收起都显示（账户数与异常数、白名单数量、已自定义项数、ZDR／联网搜索开关、服务状态）；
  组内有未填好的数字时，**收起状态**下额外挂错误徽标（`groupInvalid`）。保存按钮在校验失败时仍禁用，保存条
  多一个「定位」按钮：展开出错分组（`invalidGroups`）并聚焦第一个 `aria-invalid` 控件。折叠是**纯呈现层**：
  各字段的暂存、校验与整批提交路径不变。摘要与定位的判定都是导出纯函数，由 `tests/section.test.ts`、
  `tests/group-fold.test.ts` 固定。
- **设置页卡片化重设计（2026-10-29，用户确认设计稿后实施）**：五个分组由扁平分隔改为 16px 圆角卡片
  （`src/client/page-styles.ts`，`divided` 道具随分隔线一并删除）；页头新增状态总览条（账户健康、月额度剩余、
  服务状态、模型范围，`StatusStrip`），文案全部复用分组已有的摘要与余额字符串，不新增词条。版式：页标题
  22/28、组标题 15/22（600）、组头 52px，卡片行间 .5px 细线。卡片首屏以 `@starting-style` + 40ms stagger
  淡入并上移 8px（过渡而非关键帧，重渲染不重播）；`prefers-reduced-motion` 下只剩淡入。行间细线是有意
  推翻 2026-10-21「行间不画线」的决定：卡片内无分界时行与行会粘在一起。动效与悬停策略统一见
  「设置页动效与悬停（2026-10-29）」条目。
- **自定义上下文长度（issue #86）**：`Config.contextWindow`（全局值）与 `Config.contextWindowOverrides`
  （按模型，键为目录 id）覆盖宣告给宿主的上下文窗口，解析顺序为按模型 → 全局 → 目录。页面上是
  「模型与上下文」分组内平铺的两段内容（`ContextCard` 渲染，直接排在「隐藏套餐外模型」开关与可见模型
  白名单之后，与其它行同属该分组，无独立标题与分隔线——中间版本曾用 `SettingsSubGroup` 给出次级标题与
  细分隔线，已在用户实机查看后删除该组件与 locale 键 `contextTitle`；不再是独立顶级分组，也不再是子节）：
  全局值是 staged 字段，spec 为
  `tokenCountField`——在 `numberField` 之上只加简写后缀一层：`32K`/`1M` 按**二进制**换算
  （×1024 / ×1024²，32K = 32 768、1M = 1 048 576），换算后仍走同一对
  `CONTEXT_WINDOW_MIN/MAX` 边界（直接复用 `src/context-window.ts` 纯模块，客户端可打包导入，
  无需镜像字面量），空值清除沿用 `numberField`，额外校验普通数字必须是整数；
  `1.5K` 等简写先换算并取整，落盘永远是整数；
  这两个输入不带 `inputMode=numeric`，后缀需要字母键。按模型覆盖沿用 `visibleModels` 的独立草稿模式——
  `editContextWindowOverrides` 收整表原始文本，空值行
  渲染但保存时丢弃（不置 dirty），无法解析的行**整体阻止本次保存**（连同同批的普通字段），确认后按
  保存前草稿对象的身份清理。写入经 `save` 意图追加一次 `set` 整表到用户层：清空写 `{}` 而非 `unset`，
  避免基础层（组合配置）的旧值重新露出。配置结构以 `step(1)` 拒绝小数，非数值与越界值同样拒绝。
  只有绕过配置校验的程序化调用，才由 `resolveAdapterOptions`（`readContextWindowOverrides`）
  与适配器（`effectiveContextWindow`）清洗无效值，按有效全局值、目录值依次回落；未知模型（无目录条目）保持无
  `context` 宣告。覆盖行的模型下拉经 `allowlistedModels`（`src/client/model-select.ts`）限于
  「模型白名单」的可见模型（显示全部即整个目录），行带「模型 / 上下文长度」列头
  （`.cc-contextHead`，宽度与行内三列逐一对齐），`<select>` 用 `appearance:none` + 自绘
  `.cc-contextCaret`（同 `.cc-selectorCaret` 形状）替换平台箭头。宿主侧应用（选择器标注与
  `defaultMaxTokens` 预算）见[模型目录](model-catalog.md)。
- **单轮输出上限（issue #74）**：`Config.maxOutputTokens` 与同分组内紧随上下文长度之后的
  `Field`（spec 为 `maxOutputTokensField`）。字段有**三种**语义，靠同一个数值字段表达，因此
  与上下文长度字段有本质差别：留空＝沿用推导（默认，行为不变）、正整数＝与推导值取最小、
  `0`＝请求中**不发送** `max_tokens`。两个 token 计数字段共用 `tokenCountField`（简写文法
  `COMPACT_TOKENS` 加同一套边界检查），差异只在边界与整数值判定：上下文长度下界为 1，
  输出预算下界就是省略哨兵 0，各自传入自己的 `isValid`；上界取**网关总上限**
  `MAX_OUTPUT_TOKEN_LIMIT`（131 072，`src/output-budget.ts` 纯模块，设置页可直接打包导入
  同一常量）而不是上下文窗口范围。`64K` 简写通用，`128K` 恰好落在输出上限上、`256K` 报
  `tooLarge`；越界行与非法值**整体阻止本次保存**，`invalidCopy` 的 `'output'` 分支给出这组
  专属文案。留空保存走 `plan()` 的 `unset`（清除配置），**不是**写入 `0`——这两者的区别是
  本功能的核心。
  适配器侧只收紧不放大，且省略行为受两条守卫约束（Messages 必填、宿主显式预算优先），
  详见[适配器协议](adapter-protocol.md)。
- **`catalogIsReady` gates the stale-model cleanup** (`src/client/model-select.ts`):
  an empty catalog — before the first fetch lands, or after a failure — makes
  every selected id look retired, so the one-click cleanup would empty the
  allowlist. Require a non-empty catalog and no failure; the explicit "show
  all" action stays available without one.

- **2026-09-30 模型选择一致性**：网页显示终端覆盖后的有效选择；白名单与逐模型开关一次提交，
  包含基础层隐藏项的显式覆盖。保存冲突或缺少原子写入能力时保留草稿。
  显示全部会选中已加载的目录模型；目录失败不清空已存选择。
- **字号与校验说明**：页面及面板辅助文字至少 12px；重试次数提示与实际 0～50 次限制一致。
- **设置页动效与悬停（2026-10-29）**：可按的元素（`cc-btn`、`cc-segItem`、`cc-iconButton`、`cc-resetInline`）`:active` 时缩放（0.97，20～28px 图标按钮 0.95），160ms `cubic-bezier(.23,1,.32,1)`；折叠箭头、卡片入场、保存条、额度进度条、`cc-notice` 入场共用这条曲线，颜色与描边 150ms `ease`。只动 `transform`／`opacity`／颜色：额度条 `cc-usageBarFill` 与 `cc-miniMeterFill` 满宽，按比例 `translateX` 左移（保留圆角端），`cc-notice` 用 `@starting-style` 从上方 4px 淡入；保存条 48px、不过冲、出场快于入场。所有 `:hover` 集中在页尾的 `(hover:hover) and (pointer:fine)` 块，块内校验失败的描边排在普通悬停之后，以同等优先级压住它；整行开关（分组标题、账户卡片头）悬停只加深箭头，不铺底色。`prefers-reduced-motion` 去掉缩放与位移、保留淡入与颜色。分组、账户卡片展开收起刻意不加动画。布尔开关（`ToggleField`）用宿主 primitives 的 `Switch`（issue #108，`<button role="switch" aria-checked>`，不再是 `appearance:none` 的 checkbox 加伪元素）；`.cc-switch` 只做两处动效调整：底色与滑块统一为 160ms 强 ease-out 同步过渡；按压缩放 0.95。盒尺寸、颜色、圆角、焦点环、禁用态全部交还原语（36×20 轨道、16px 滑块、16px 行程），设计画布的 40×24 不再沿用（2026-10-30 用户反馈它比宿主自带开关胖，回到原语尺寸后无差别）。原语不收 `id`，所以开关行标题是纯文本、开关以 `aria-label` 取名，点标题不再切换。`Switch` 的签名与样式在 `0.2.1-rc.2`、`0.2.1-rc.4`、`0.2.2-alpha.2` 三版逐字一致（2026-10-30 核对），升级宿主时一并复核。约束由 `tests/styles.test.ts` 末尾五条用例锁定（最后一条禁止重新给开关加宽高覆盖，否则又会比宿主开关胖）。分组说明 `cc-groupDesc` 下直接接账户列表、提示块组或覆盖表时留 12px（设置行自带 12px 内边距，不另加）。
- **右侧只有一条边界（2026-10-22）**：设置行控件、账户卡片、分组头动作（「刷新」）、「查看模型用量」都贴内容
  右缘。为此「恢复默认」不在控件后面留列，而是放在标题行「已自定义」徽标后的 20px 圆形图标按钮（`OverrideTag`，
  `cc-resetInline`；只清空存储值的草稿只显示按钮）——同日先后试过「每行末尾留 28px 复位空位」与「卡片、分组头
  再右缩 36px 对齐空位」，用户分别反馈右侧不齐、整体不协调，均已撤回（`cc-resetSlot`、`cc-rowFluid` 已删）。
  防折行靠设置行文字列下限 200px（`.cc-rowText` 的 `flex:1 1 200px`）：最宽的两行（API 地址 280px 输入框、
  白名单按钮 + 200px 下拉）在约 520px 内容区内仍与标题同行，窄时让说明文字多折行。服务状态行的
  「打开状态页」在标题行右侧（不占控件列），官方行各段（`detailParts` 与更新时间）不可断开、整段换行。
- **设置页尺寸以设计画布为准（2026-10-21，用户要求「完全按效果图」，取代下面两条中与之冲突的尺寸）**：
  尺寸逐项取自设计画布的 `cc-kit.css`，颜色映射到 dsw 别名。按钮不再用宿主 `Button` 原语，改为本页自绘的
  `PageButton`（`cc-btn`：md 32px／14px 字／14px 图标，sm 28px／12px 字，lg 36px 仅保存条；`outline` 即设计稿
  的浅灰填充次要按钮，`danger` 为错误色实心）；输入框与模型选择器 32px、白底（`bg-layer-1`）、1px `border-l3`、
  8px 圆角，数字框单位画在框内（`cc-unitBox`，160px）；设置行上下 12px、**行间不画线**，文字与控件间距 24px；
  分组上下 16px、组间 1px `border-l2`、分组头 36px；账户卡片 1px 描边、卡片头 44px（左内缩 16px）、额度行
  缩进 32px、展开区 16px；按模型覆盖改为卡片内的小表格（表头 + 模型／值／移除三列）；徽标 20px。实测核对见
  CHANGELOG。
- **设置页形状与文字收尾（2026-10-21，实测）**：形状规则「可点的是胶囊，可填的是 8px」——页面内所有宿主
  `Button` 经 `PageButton` 加 `cc-pill`（全圆角，覆盖宿主的 8／12px）与幽灵按钮的 `cc-quiet`（label-secondary，
  悬停转 label-primary）；行级下拉与输入框圆角 8px；保存条改为 22px 全圆，与内部 36px 胶囊同心。文字：本页开启
  灰度抗锯齿，说明、摘要、数字块标签等由 label-tertiary 改为 label-secondary（Models 页卡片共用的 `cc-hint`、
  `cc-badgeMuted`、`cc-input` 不变）。账户展开区首行是「月额度剩余」大号数字（`cc-balance`，20/600），已购与
  赠送降为其右侧小字；剩余为 0 时数字标红并提示已购与赠送将无法使用（`usageMonthlyDepleted`）。标签行左侧
  接账期（区间对齐时为完整区间，否则为订阅截止日），右侧为「更新于」；原独立的「官方账期用量」行与底部
  「账期截止」已并入，底部只在有失败时显示「部分数据未取到」（2026-10-24）。
- **设置页对齐宿主原生（2026-10-21，实测）**：行样式取自宿主「通用设置」渲染后的真实样式——行上下 16px、
  每行下方 0.5px `border-l2` 细线（组内最后一行除外）、文字列与控件留 48px；行级下拉与输入框用宿主选择器的
  形状（36px、12px 圆角、`bg-module-platform` 填充、无描边，类 `cc-fieldInput`），数字框单位写在框外并占
  固定 48px 列，空值显示宿主默认值占位（`FIELD_DEFAULTS`，由 `tests/section.test.ts` 绑定到 adapter／
  transport-retry 常量）；面板里的输入仍用描边的 `cc-input`。分组头的中性摘要是灰色文字（`GroupSummary`），
  只有警告与错误用彩色徽标。账户卡片展开后隐藏卡片头的小额度条，数字块只留一排 4 个，余额并为一行，时间去掉
  秒（`formatResetAtShort`）。
- **设置页统一风格（2026-10-21）**：按钮一律用宿主 `Button` 原语（28px／8px 圆角、36px／12px
  圆角，次要操作用 `outline`，危险确认用 `outline` + `cc-dangerButton`；保存条也用它，条的 16px 圆角与按钮
  12px 圆角同心）；容器只有三种——实体卡片（账户，0.5px 描边、12px 圆角）、面板（`cc-panel`，填充底、12px
  圆角，承载添加账户、粘贴密钥、重命名）、数值块（`cc-usageStat`，8px 圆角）；登录状态、无密钥引导、移除确认、
  用量阻断都走 `Notice`（新增成功档）；账户状态徽标用 `cc-badgeOk／Warn／Error`；行级控件形状见上一条
  （单位在框外，标签不再重复单位）；「重置」在标题行（见「右侧只有一条边界」）；结果、警告与失败统一用 `Notice`（`cc-notice`，中性／警告／错误三档，带线性图标）；
  页面图标只用 `section.tsx` 里的 `Icon` 线性 SVG，不用 `×`、`↗` 等字符。Models 页服务商卡片
  （`card.tsx`、`login-row.tsx`）仍用旧的 `cc-field`／`cc-reset` 类，新类名刻意不与之重名。
- **模型分析第二版**：历史与试算仍读取同一份既有报告；模型名称复用试算目录，成本比例只比较已知小计，零小计或无计价样本不生成占比。`analytics-comparison.ts` 在客户端派生逐模型 30 天试算及相同完整工作量的成本差额；缺价、排除、历史不完整与零基准有独立展示口径，不扩展远端。页签、展开与模型筛选不增加远端读取，刷新保留草稿并使用已提交范围。窄面板按实际可用宽度恢复指标标签，未知数据不补零。统计口径及浏览器验证边界见[模型分析说明](../模型成本与性能分析.md)和[第二版设计](../模型分析第二版设计.md)。
- **压缩摘要计入会话费用读数**：`compaction/summary`（上下文压缩摘要）事件也会产生真实花费——压缩器自己调一次 `ctx.llm.stream()`，但不落在任何 turn/step 上，也不产生 `request/header`。费用投影把它折进分组，并用 `summaryTokens` 记录「已折进分组、但不属于宿主 `tokenUsage`」的那部分，对账等式因此变为「分组合计 − `summaryTokens` === 宿主 `tokenUsage`」；历史分析侧同样单独登记一条请求事实。详见[模型分析说明](../模型成本与性能分析.md)。
