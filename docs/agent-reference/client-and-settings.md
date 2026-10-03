# Client and settings contracts

Task-specific reference moved from the former root `AGENTS.md`. All source and test paths are relative to the repository root. Consult the relevant source and tests before changing behavior.

- **账号开通**：两种新增方式统一使用 `src/enrollment.ts`；`src/client/enrollment.ts` 由每次设置页挂载持有，`AddAccountPanel` 只负责输入和意图。离开设置页取消未完成过程，已登录待命名则接受已有名称；命名失败保留账号，清理失败保留恢复记录并提供手动重试。默认或已有账号的 `login*` 契约继续使用原控制器。
- **自动打开授权页**：新增、默认和已有账号登录均在首次收到宿主授权地址后通过 `src/client/login-page.ts` 打开新页面，不预先打开空白页；同一尝试的轮询不重复打开，已取消尝试或已卸载的新增账号面板不会因迟到地址打开页面。浏览器可能拦截异步打开，界面始终保留授权链接及手动打开提示；打开失败不取消宿主登录。使用 `noopener,noreferrer` 隔离来源页，不能根据返回 `null` 判断是否拦截。
- **页面生命期**：`enrollmentWatch({ pageId })` 是持续远端流，先确认就绪再允许 `enrollmentBegin`。所有过程调用带页面身份；宿主将它与实际调用对端共同绑定。单次调用完成不结束过程；页面卸载主动取消并释放流，刷新或关闭由网关流取消信号触发收尾。DSH 的 `OperatorPeer` 是宿主共享作用域，不能用它冒充单个浏览器连接。载体断开不会自动重建原过程。
- **开通远端契约**：双方共享 `src/enrollment-wire.ts` 的七个严格描述符：`enrollmentBegin`、`enrollmentStatus`、`enrollmentCancel`、`enrollmentName`、`enrollmentRetry`、`enrollmentPending` 和流式 `enrollmentWatch`。前六个返回状态或恢复列表，观察流返回就绪确认；所有输入、输出使用严格编解码器。密钥仅允许在手动开始输入中出现，不进入状态、日志或设置文档。旧宿主缺少该契约时明确提示更新，不回退到旧的页面副作用编排。

- **登录总期限**：浏览器回调成功只关闭监听，不撤销登录计时器。身份验证带取消信号；超时、取消、替换尝试或销毁会中止验证，迟到结果不能开始存储或覆盖状态。期限同样约束等待存储的状态；宿主已发出的凭据写入不能凭空撤销，不能声称提供跨服务事务。
- **秒制设置保留毫秒精度**：显示与输入最多三位小数，范围 0.001–3600 秒，存储仍为整数毫秒；已有范围外配置照实显示，不静默截断。超时字段使用小数键盘和秒制错误说明，重试次数仍为整数。
- **设置写入所有权**：`src/client/settings.ts` 保留输入校验、草稿版本和投影，`src/client/settings-write.ts` 持有保存与即时账号操作的具名意图、统一队列、目标检查、批量配置与凭据确认。普通字段和可见模型的两个字段一次提交；配置确认后才发密钥。相关字段在排队期间变化整批冲突，无关变化使用最新版本；作用域明确返回接受、冲突、未确认或取消，重读相同值不能冒充本次接受。
- **默认目标保护与部分完成**：点击时冻结默认凭据引用，调用前变化停止，调用后变化记录原引用实际结果并提示核对；两者都保留密钥草稿，不自动写新引用或补偿删除。已确认配置仅清理本次旧草稿，等待期间的新输入、重置和模型选择保留。设置页和模型卡共用中文阶段提示，用量刷新依本次真实确认结果。
- **凭据事实与销毁**：凭据返回成功即为写入确认，描述仅提供存在性；描述失败或缺失保留最后确认事实，首次尚无确认时明确显示状态未知，重试入口只读状态。按引用及读取世代屏蔽迟到描述。普通切页不关闭共享控制器；插件销毁停止未开始任务，已发调用自然收束，不进入后续阶段。
- **自动轮换**：取消固定账号时基础层仍固定账号，则显式写 `activeAccount: ''`；仅清除用户覆盖会重新露出基础层固定账号，不等于自动轮换。普通字段重置仍恢复继承。
- **运行中请求的配置生效**：已确认的网关、账号列表、固定账号和模型规则用于新调用，已经开始的适配器调用继续使用自己的快照。引用凭据每次账号选择仍重新解析；清除后可能按既有优先级使用默认账号的授权文件兜底，不撤回已发请求或当前尝试已取得的密钥。
- **账户移除与清理**：`accounts`、`modelAccountRules`、固定账户及 `credentialCleanupRefs` 在一次带版本检查的 `remote.settings.mutate` 中提交，再清理凭据。失败队列持久化，页面刷新后仍显示重试；重新引用、继承配置和默认密钥受保护。无法确认凭据事实时保留队列。宿主配置与凭据服务并无共同事务，不能承诺任意外部并发重建与凭据删除跨服务原子化。

- **Client bundle**: the package's `dsh.client` declaration (`platform: web`,
  `inject: [...]`) makes the host serve `lib/client.js` as a client module.
  The bundle may only `require` platform/seed modules (`react`,
  `react/jsx-runtime`, `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-ui-slots`,
  `@deepseek-ai/dsh-client-web-react`, `@deepseek-ai/dsh-client-ui-primitives`,
  `@deepseek-ai/dsh-client-schema-form`, `@deepseek-ai/dsh-client-ui-attachment`)
  and host-shipped platform modules resolvable from the loader's module table
  (e.g. `@deepseek-ai/dsh-client-ui-primitives`). The 0.1.7 Web shell
  seeds `@deepseek-ai/dsh-client-store`; this client keeps the smaller local
  `getSnapshot`/`subscribe`/`set` subset in `src/client/snapshot-store.ts`
  instead — ~30 lines, versus a fourth `require()` target and a client-only peer
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
    `.volatile()` is a schemastery 3.18.3 feature and the one supported engine pins `~3.18.4`, so the method
    is always present (that is why `@deepseek-ai/schemastery` is a peer at `~3.18.4`, not `^3.18.2` — a
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
    single `dshReleases` record) and `npm run test:engine`.
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
- **`catalogIsReady` gates the stale-model cleanup** (`src/client/model-select.ts`):
  an empty catalog — before the first fetch lands, or after a failure — makes
  every selected id look retired, so the one-click cleanup would empty the
  allowlist. Require a non-empty catalog and no failure; the explicit "show
  all" action stays available without one.

- **2026-09-30 模型选择一致性**：网页显示终端覆盖后的有效选择；白名单与逐模型开关一次提交，
  包含基础层隐藏项的显式覆盖。保存冲突或缺少原子写入能力时保留草稿。
  显示全部会选中已加载的目录模型；目录失败不清空已存选择。
- **字号与校验说明**：页面及面板辅助文字至少 12px；重试次数提示与实际 0～50 次限制一致。
