/**
 * The command guard: an AI second opinion on shell approvals.
 *
 * dsh already decides *that* a tool call needs approval (permission presets, the
 * sandbox's escalation path, `PreToolUse` hooks) and then asks the user. This
 * module inserts one answerer in front of the human: the Command Code decision
 * model `typesafe/jev` (see `./systemone.ts`) is asked whether the command is
 * safe to run without asking, and only a confident *yes* turns into a one-shot
 * `allowed-once` grant. Everything else — a lower probability, a malformed
 * answer, a timeout, a rate limit, a missing key, a command we refuse to judge —
 * delegates to the next answerer with `next()`, which is the human.
 *
 * Why this seam and not the decision one: `approval/request` fires only after a
 * policy already decided to ask, so a grant here can never widen a policy (a
 * session under the strict `never` policy rejects before any answerer runs) and
 * never has to re-implement one. The same waterfall is what the browser's
 * approval panel answers through, so the guard must be registered with
 * `prepend: true` — otherwise that panel holds the request until the user
 * clicks and this answerer never runs at all.
 *
 * The approval payload carries only a `callId`, no arguments, so the command
 * text comes from a transparent observer on `tools/pre-execute` (which the tool
 * runtime dispatches for every execution, immediately before it resolves the
 * very ask we are answering). The observer always returns `next()`: it can
 * never change a decision, it only remembers what the call was.
 *
 * Fail-closed rules, in order, each of which delegates to the human:
 *
 * 1. the feature is off (the default);
 * 2. the ask is not about a shell tool, or we never saw its arguments;
 * 3. the command matches the hard denylist — those are never even sent to the
 *    model;
 * 4. the command is too long to judge in full (a truncated state would invite a
 *    verdict on a command the model did not see);
 * 5. the decision call fails for any reason (timeout, HTTP, credential,
 *    network, unreadable body);
 * 6. the probability is below the configured threshold.
 *
 * The model is billed per request ($0.042/1M input tokens once the free window
 * ends on 2026-09-24) and the endpoint has no ZDR upstream (its requests never
 * carry the `x-cmd-zdr` header the chat transports may send under `Config.zdr`),
 * so the decision is only ever asked about commands a policy already wanted a
 * human to look at, and identical decision contexts within one agent reuse
 * one result from an in-memory memo.
 *
 * @module dsh-commandcode-provider/command-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  SYSTEMONE_DEFAULT_TIMEOUT_MS,
  type SystemOneQuestion,
  type SystemOneRequest,
  type SystemOneResponse,
} from './systemone.ts'

/** Tool names whose `arguments.command` this guard judges. */
export const COMMAND_GUARD_SHELL_TOOLS: readonly string[] = ['bash', 'pwsh']

/** Question id the safety verdict is keyed by. */
export const COMMAND_GUARD_QUESTION_ID = 'safe'

/** Probability of "safe" at or above which the guard grants `allowed-once`. */
export const COMMAND_GUARD_DEFAULT_THRESHOLD = 0.9

/** Decision budget; the approval prompt must not wait longer than this. */
export const COMMAND_GUARD_DEFAULT_TIMEOUT_MS = SYSTEMONE_DEFAULT_TIMEOUT_MS

/** Bounds of the configurable probability, mirrored by the settings schemas. */
export const COMMAND_GUARD_MIN_THRESHOLD = 0.5
export const COMMAND_GUARD_MAX_THRESHOLD = 1

/** Bounds of the configurable budget, mirrored by the settings schemas. */
export const COMMAND_GUARD_MIN_TIMEOUT_MS = 200
export const COMMAND_GUARD_MAX_TIMEOUT_MS = 10_000

/**
 * Longest command the guard will send for judgement. A longer one is delegated
 * instead of truncated: a verdict on the first N characters of a command is a
 * verdict on a different command.
 */
export const COMMAND_GUARD_MAX_COMMAND_CHARS = 6000

/** Executions remembered for their arguments, and decisions memoized. */
export const COMMAND_GUARD_CACHE_ENTRIES = 64

/** How long one command's decision may be reused. */
export const COMMAND_GUARD_DECISION_TTL_MS = 10 * 60_000

/** The resolved settings the guard reads per ask. */
export interface CommandGuardSettings {
  /** Master switch; the shipped default is off. */
  readonly enabled: boolean
  /** Minimum probability of "safe" that grants `allowed-once`. */
  readonly threshold: number
  /** Decision budget in milliseconds. */
  readonly timeoutMs: number
}

/**
 * Hard denylist: commands the guard never auto-approves, and never even sends
 * for judgement. Each entry is a deliberate, narrow reading of one destructive
 * family — the goal is not to classify every dangerous command (that is the
 * model's job) but to make sure the classics cannot be talked into a grant by a
 * persuasive-looking command string.
 *
 * Every pattern is allowed to OVER-match: a false positive costs one ordinary
 * human prompt, while a false negative would hand a destructive command to a
 * model that has to guess. That asymmetry is why `sudo` is matched anywhere in
 * the line rather than only in command position, and why `fdisk` is listed even
 * though `fdisk -l` only lists partitions.
 */
export const COMMAND_GUARD_DENY_LIST: readonly { readonly id: string; readonly pattern: RegExp }[] = [
  // Recursive force-delete of a root-ish, home, cwd or wildcard target.
  // Deleting a plain project-relative path is deliberately NOT here: that is a
  // normal operation the model is allowed to judge.
  {
    id: 'rm-root',
    pattern: /\brm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*[rR][a-zA-Z]*|--recursive[^\n]*--force|--force[^\n]*--recursive)\s+(?:\/|\/\*|~|~\/\*|\$HOME(?:\/\*)?|\*|\.\/\*|\.)(?:\s|$)/,
  },
  { id: 'rm-home', pattern: /\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*\s+(?:~|\$HOME)\// },
  // Disk and filesystem primitives.
  { id: 'filesystem-write', pattern: /\b(?:mkfs(?:\.\w+)?|wipefs|fdisk|parted|shred)\b/ },
  { id: 'raw-device-write', pattern: /\bdd\b[^\n]*\bof=\/dev\// },
  { id: 'device-redirect', pattern: /(?:^|[^0-9\w])>{1,2}\s*\/dev\/(?:sd|disk|nvme|hd)/ },
  { id: 'fork-bomb', pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/ },
  // Privilege and ownership.
  { id: 'privilege-escalation', pattern: /\b(?:sudo|doas)\b/ },
  { id: 'su', pattern: /\bsu\s/ },
  { id: 'chmod-world-write', pattern: /\bchmod\b[^\n]*\b(?:777|a\+w|o\+w)\b/ },
  { id: 'chown-root', pattern: /\bchown\b[^\n]*\b(?:root|0):/ },
  // Git history, remote state and discarded work.
  { id: 'git-push', pattern: /\bgit\s+push\b/ },
  { id: 'git-history-rewrite', pattern: /\bgit\s+(?:filter-branch|filter-repo)\b/ },
  { id: 'git-hard-reset', pattern: /\bgit\s+reset\s+--hard\b/ },
  { id: 'git-clean-force', pattern: /\bgit\s+clean\b[^\n]*\s-[a-zA-Z]*f/ },
  { id: 'git-discard-worktree', pattern: /\bgit\s+(?:checkout|restore)\s+(?:--\s+)?\.(?:\s|$)/ },
  { id: 'git-stash-drop', pattern: /\bgit\s+stash\s+(?:drop|clear)\b/ },
  // Publishing and uploading.
  { id: 'publish', pattern: /\b(?:npm|pnpm|yarn|bun)\s+publish\b/ },
  { id: 'release-upload', pattern: /\b(?:gh\s+release|twine\s+upload)\b/ },
  { id: 'docker-push', pattern: /\bdocker\s+push\b/ },
  { id: 'cloud-upload', pattern: /\b(?:aws\s+s3|gsutil|gcloud\s+storage|az\s+storage)\b[^\n]*\b(?:cp|sync|mv|rm|rb)\b/ },
  { id: 'remote-copy', pattern: /\b(?:scp|rsync)\b[^\n]*(?::|@)/ },
  // A download piped straight into an interpreter.
  { id: 'pipe-to-shell', pattern: /\b(?:curl|wget|fetch)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|ksh|python\d*|node|ruby|perl)\b/ },
  // Machine state and process control.
  { id: 'power', pattern: /\b(?:shutdown|reboot|halt|poweroff)\b/ },
  { id: 'kill-everything', pattern: /\bkill\s+(?:-9\s+)?-1\b|\b(?:killall|pkill)\s+-9\b/ },
  // Credentials and shell history.
  {
    id: 'credential-write',
    pattern: /(?:>{1,2}|tee|cp|mv|rm|chmod|chown)\s[^\n]*(?:\.ssh\b|\.aws\b|\.gnupg\b|\.commandcode\/auth\.json|id_rsa|id_ed25519)/,
  },
  { id: 'history-clear', pattern: /\bhistory\s+-c\b|\bunset\s+HISTFILE\b/ },
  // System and language-level installs (they run third-party code installers).
  { id: 'global-install', pattern: /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add)\s+(?:-g\b|--global\b)/ },
  { id: 'system-install', pattern: /\b(?:apt|apt-get|dnf|yum|zypper|apk|pacman|brew)\s+(?:install|remove|purge|uninstall|upgrade)\b/ },
  { id: 'language-install', pattern: /\b(?:pip3?|pipx|gem|cargo)\s+(?:install|add)\b/ },
]

/**
 * Why the guard refuses to judge a command, when it does.
 *
 * @param command - the raw command text.
 * @returns the matching denylist id, or undefined.
 */
export function denyReasonOf(command: string): string | undefined {
  for (const entry of COMMAND_GUARD_DENY_LIST) {
    if (entry.pattern.test(command)) return entry.id
  }
  return undefined
}

/** One shell command awaiting approval, as read from its tool execution. */
export interface ShellCommandFact {
  /** Tool name (`bash` / `pwsh`). */
  readonly tool: string
  /** The command itself. */
  readonly command: string
  /** The agent's own one-line description, when it wrote one. */
  readonly description?: string
  /** The call's working directory, when it named one. */
  readonly workdir?: string
  /** The wider sandbox mode this call asks for, when it is an escalation retry. */
  readonly sandboxPermissions?: string
  /** The asker's own explanation of why approval is needed. */
  readonly reason?: string
}

/** A non-empty string member, or undefined. */
function stringMember(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const member = (value as Record<string, unknown>)[key]
  return typeof member === 'string' && member.trim() !== '' ? member : undefined
}

/**
 * Read a shell command out of a tool execution, or undefined when this call is
 * not one the guard judges (a different tool, or arguments without a command).
 *
 * @param name - the executed tool's name.
 * @param args - the execution's parsed `arguments`.
 * @returns the fact to judge, without the asker's reason (that arrives later).
 */
export function shellCommandOf(name: string, args: unknown): Omit<ShellCommandFact, 'reason'> | undefined {
  if (!COMMAND_GUARD_SHELL_TOOLS.includes(name)) return undefined
  const command = stringMember(args, 'command')
  if (command === undefined) return undefined
  const description = stringMember(args, 'description')
  const workdir = stringMember(args, 'workdir')
  const sandboxPermissions = stringMember(args, 'sandbox_permissions')
  return {
    tool: name,
    command,
    ...(description === undefined ? {} : { description }),
    ...(workdir === undefined ? {} : { workdir }),
    ...(sandboxPermissions === undefined ? {} : { sandboxPermissions }),
  }
}

/**
 * Build the decision request for one command.
 *
 * The question is deliberately one `noul`: a single probability is a decision
 * rule that can be explained, thresholded and logged in one line, and the
 * criteria carry the whole distinction between "reads, or writes reversibly
 * inside the project" and "everything else". The agent's own `description` is
 * included as context, but the criteria say the command text itself decides — a
 * model-written description is a claim, not evidence.
 *
 * @param fact - the command and its context.
 * @returns the request to send.
 */
export function buildSafetyRequest(fact: ShellCommandFact): SystemOneRequest {
  const lines = [
    `Tool: ${fact.tool}`,
    'Command:',
    fact.command,
    ...(fact.description === undefined ? [] : ['', `The agent describes this command as: ${fact.description}`]),
    ...(fact.workdir === undefined ? [] : ['', `Working directory: ${fact.workdir}`]),
    ...(fact.sandboxPermissions === undefined
      ? []
      : ['', `The harness is asking because this call requests a wider sandbox mode (${fact.sandboxPermissions}) than the one currently in force.`]),
    ...(fact.reason === undefined ? [] : ['', `The asker's reason for needing approval: ${fact.reason}`]),
  ]
  const question: SystemOneQuestion = {
    type: 'noul',
    instructions: 'Is it safe to run this command right now WITHOUT asking the user first? Judge the command text itself; a description is only a claim about it.',
    criteria: {
      true: 'Read-only, or its effects stay inside the current project and are trivially reversible: no data leaves the machine, nothing outside the project is modified, and no credentials, git history or remote state are touched.',
      false: 'Anything else. Deleting or overwriting files outside the project, rewriting or publishing git history, uploading data anywhere, installing system or global packages, changing permissions, ownership or credentials, killing processes, running as another user or as root, piping a download into a shell, or a command obfuscated enough that its effect cannot be read.',
    },
  }
  return {
    state: lines.join('\n'),
    questions: { [COMMAND_GUARD_QUESTION_ID]: question },
  }
}

/**
 * Read the safety probability out of a decision response.
 *
 * @param response - the parsed response.
 * @param questionId - the question id to read (defaults to the guard's own).
 * @returns the probability of "safe", or undefined when the answer is missing
 *   or is not a `noul` verdict.
 */
export function safeProbabilityOf(
  response: SystemOneResponse,
  questionId: string = COMMAND_GUARD_QUESTION_ID,
): number | undefined {
  const answer = response.answers[questionId]
  return answer !== undefined && answer.type === 'noul' ? answer.noul : undefined
}

/** The subset of a tool execution this guard reads. */
export interface GuardToolExecution {
  readonly callId: string
  readonly name: string
  readonly arguments: unknown
  readonly agent?: object
}

/** The subset of an approval request this guard reads. */
export interface GuardApprovalRequest {
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
  readonly signal?: AbortSignal
  readonly agent?: object
}

/** The approval vocabulary, from the harness's own closed set. */
export type GuardApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** What one ask resolved to, for logging and tests. */
export type CommandGuardVerdict =
  /** A confident "safe" — the caller grants `allowed-once`. */
  | {
    readonly kind: 'approve'
    readonly probability: number
    readonly source: 'model' | 'memo'
    /** One-line excerpt of the command, for the audit log. */
    readonly command?: string
  }
  /** Delegate to the next answerer (the human). */
  | {
    readonly kind: 'delegate'
    readonly reason: string
    readonly probability?: number
    /** One-line excerpt of the command, when the guard got far enough to know it. */
    readonly command?: string
  }

/**
 * One-line, length-bounded excerpt of a command for the log. The full text is
 * already in the session's tool call and was already sent to the decision
 * endpoint, so this adds no exposure — it is what makes "why did this run
 * without asking?" answerable from the log alone.
 */
export function commandExcerpt(command: string, limit = 160): string {
  const flat = command.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
}

/** Everything the guard needs beyond the two listeners. */
export interface CommandGuardDeps {
  /** Live settings, re-read per ask so a settings write lands on the next one. */
  settings: () => CommandGuardSettings
  /**
   * Run one decision. The binding owns the connection facts and the API key;
   * the guard owns the request and passes its own budget and cancellation.
   */
  decide: (
    request: SystemOneRequest,
    options: { signal?: AbortSignal; timeoutMs: number },
  ) => Promise<SystemOneResponse>
  /** Clock (tests). Defaults to `Date.now`. */
  now?: () => number
  /** One-line decision log (the harness logger, in the plugin entry). */
  log?: (message: string) => void
}

/** A memoized decision for one exact command. */
interface MemoEntry {
  readonly probability: number
  readonly at: number
}

interface ObservedExecution {
  readonly fact: Omit<ShellCommandFact, 'reason'>
  readonly agent: object | undefined
}

/**
 * The guard's stateful half: what was executed (by call id) and what has
 * already been decided (by agent and complete decision context), both bounded.
 *
 * The execution cache is the bridge between the two seams — `tools/pre-execute`
 * knows the arguments, `approval/request` knows the call id — and it is keyed by
 * call id with an agent-identity check when read: an entry for an execution
 * that never asked is never read, so there is nothing to clean up on the result
 * side (and the ask happens before the result anyway).
 */
export class CommandGuard {
  private readonly executions = new Map<string, ObservedExecution>()
  private decisions = new WeakMap<object, Map<string, MemoEntry>>()

  constructor(private readonly deps: CommandGuardDeps) {}

  /**
   * Remember one execution's command. Never throws, never changes a decision.
   *
   * @param execution - the execution about to run.
   */
  noteExecution(execution: GuardToolExecution): void {
    const callId = execution?.callId
    if (typeof callId !== 'string' || callId === '') return
    const fact = shellCommandOf(execution.name, execution.arguments)
    if (fact === undefined) return
    this.executions.delete(callId)
    this.executions.set(callId, { fact, agent: execution.agent })
    while (this.executions.size > COMMAND_GUARD_CACHE_ENTRIES) {
      const oldest = this.executions.keys().next()
      if (oldest.done === true) break
      this.executions.delete(oldest.value)
    }
  }

  /** Forget every remembered execution and decision (disposal, tests). */
  clear(): void {
    this.executions.clear()
    this.decisions = new WeakMap()
  }

  /**
   * Judge one approval request.
   *
   * @param request - the pending approval.
   * @returns the verdict; `approve` is the only outcome that grants anything.
   */
  async judge(request: GuardApprovalRequest): Promise<CommandGuardVerdict> {
    const settings = this.deps.settings()
    if (!settings.enabled) return { kind: 'delegate', reason: 'guard disabled' }
    const callId = request.callId
    if (callId === undefined) return { kind: 'delegate', reason: 'approval carries no call id' }
    const observed = this.executions.get(callId)
    if (observed === undefined || observed.agent !== request.agent) {
      return { kind: 'delegate', reason: 'the guard never saw this call for this agent' }
    }
    const fact = observed.fact
    const excerpt = commandExcerpt(fact.command)
    if (!COMMAND_GUARD_SHELL_TOOLS.includes(request.toolName)) {
      return { kind: 'delegate', reason: `not a shell tool (${request.toolName})` }
    }
    if (fact.command.length > COMMAND_GUARD_MAX_COMMAND_CHARS) {
      return {
        kind: 'delegate',
        reason: `command longer than ${COMMAND_GUARD_MAX_COMMAND_CHARS} characters`,
        command: excerpt,
      }
    }
    const denied = denyReasonOf(fact.command)
    if (denied !== undefined) {
      return { kind: 'delegate', reason: `denylisted command (${denied})`, command: excerpt }
    }

    const full: ShellCommandFact = {
      ...fact,
      ...(request.reason === undefined ? {} : { reason: request.reason }),
    }
    // Only an agent-scoped, identical decision state may reuse a verdict.
    // The same relative command can have different effects in another working
    // directory or sandbox mode; the asker's reason also changes the question.
    const memoKey = JSON.stringify(full)
    const now = this.deps.now?.() ?? Date.now()
    const agentDecisions = request.agent === undefined ? undefined : this.decisions.get(request.agent)
    const memo = agentDecisions?.get(memoKey)
    if (memo !== undefined) {
      if (now - memo.at < COMMAND_GUARD_DECISION_TTL_MS) {
        return this.verdict(memo.probability, settings.threshold, 'memo', excerpt)
      }
      agentDecisions?.delete(memoKey)
    }

    let response: SystemOneResponse
    try {
      response = await this.deps.decide(buildSafetyRequest(full), {
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        timeoutMs: settings.timeoutMs,
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return { kind: 'delegate', reason: `decision unavailable: ${detail}`, command: excerpt }
    }
    const probability = safeProbabilityOf(response)
    if (probability === undefined) {
      return { kind: 'delegate', reason: 'the decision carried no safe verdict', command: excerpt }
    }

    if (request.agent !== undefined) {
      const decisions = agentDecisions ?? new Map<string, MemoEntry>()
      decisions.set(memoKey, { probability, at: now })
      while (decisions.size > COMMAND_GUARD_CACHE_ENTRIES) {
        const oldest = decisions.keys().next()
        if (oldest.done === true) break
        decisions.delete(oldest.value)
      }
      this.decisions.set(request.agent, decisions)
    }
    return this.verdict(probability, settings.threshold, 'model', excerpt)
  }

  /** Apply the threshold to one probability. */
  private verdict(
    probability: number,
    threshold: number,
    source: 'model' | 'memo',
    command: string,
  ): CommandGuardVerdict {
    return probability >= threshold
      ? { kind: 'approve', probability, source, command }
      : {
        kind: 'delegate',
        reason: `safe probability ${probability.toFixed(3)} below ${threshold}`,
        probability,
        command,
      }
  }
}

/** The two listeners this module registers, typed structurally. */
interface CommandGuardEvents {
  on(
    event: 'tools/pre-execute',
    listener: (execution: GuardToolExecution, next: () => Promise<unknown>) => unknown,
    options?: { prepend?: boolean },
  ): unknown
  on(
    event: 'approval/request',
    listener: (
      request: GuardApprovalRequest,
      next: () => Promise<GuardApprovalOutcome>,
    ) => Promise<GuardApprovalOutcome> | GuardApprovalOutcome,
    options?: { prepend?: boolean },
  ): unknown
}

/**
 * Register the guard on a context that has the approval seam.
 *
 * Call this from inside `ctx.inject(['approval'], …)`: the seam's presence is
 * what makes the feature meaningful (no approval service means no asks), and
 * tying the listeners to that injected fiber is what makes them go away with it.
 *
 * @param ctx - the injected context (or a test double with `on`).
 * @param deps - settings, the decision client, clock and logger.
 * @returns a disposer for both listeners.
 */
export function applyCommandGuard(ctx: Context, deps: CommandGuardDeps): () => void {
  const guard = new CommandGuard(deps)
  const events = ctx as unknown as CommandGuardEvents

  const offPreExecute = events.on('tools/pre-execute', (execution, next) => {
    guard.noteExecution(execution)
    return next()
  }, { prepend: true })

  const offApproval = events.on('approval/request', async (request, next) => {
    // The disabled path is checked here as well as inside `judge()` so that a
    // guard nobody turned on costs one config read and logs nothing: an
    // approval prompt is an ordinary event in every session, and narrating
    // "delegated, guard disabled" for each one would be pure noise.
    try {
      if (!deps.settings().enabled) return next()
    } catch (error) {
      deps.log?.(`command guard failed: ${error instanceof Error ? error.message : String(error)}`)
      return next()
    }
    let verdict: CommandGuardVerdict
    try {
      verdict = await guard.judge(request)
    } catch (error) {
      // The guard must never be the reason an approval fails; the human path is
      // always still there.
      deps.log?.(`command guard failed: ${error instanceof Error ? error.message : String(error)}`)
      return next()
    }
    if (verdict.kind === 'approve') {
      deps.log?.(
        `command guard auto-approved a ${request.toolName} call`
        + ` (safe probability ${verdict.probability.toFixed(3)}, ${verdict.source}): ${verdict.command ?? '(command unknown)'}`,
      )
      return 'allowed-once'
    }
    deps.log?.(
      `command guard delegated a ${request.toolName} call: ${verdict.reason}`
      + `${verdict.command === undefined ? '' : ` — ${verdict.command}`}`,
    )
    return next()
  }, { prepend: true })

  return () => {
    guard.clear()
    for (const off of [offPreExecute, offApproval]) {
      if (typeof off === 'function') (off as () => void)()
    }
  }
}
