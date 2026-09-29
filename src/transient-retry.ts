/** 普通临时故障与额度窗口分开计数；预算按智能体的一次模型请求重置。 */
export const TRANSIENT_MAX_RETRIES = 3
export const THROTTLED_CODE = 'THROTTLED'
const boundedCodes = new Set(['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', THROTTLED_CODE])
const counts = new WeakMap<object, number>()

export function absorbTransientFailure(agent: object, code: string): 'ignored' | 'retry' | 'exhausted' {
  if (!boundedCodes.has(code)) return 'ignored'
  const used = counts.get(agent) ?? 0
  if (used >= TRANSIENT_MAX_RETRIES) return 'exhausted'
  counts.set(agent, used + 1)
  return 'retry'
}

export function resetTransientFailures(agent: object): void {
  counts.delete(agent)
}

export function transientBudgetMessage(code: string, message: string): string {
  return `Command Code 请求在 ${TRANSIENT_MAX_RETRIES} 次自动重试后仍失败，已停止重试（${code}）。`
    + '请稍后重新发送；若反复出现，请检查服务状态或请求耗时诊断。'
    + ` 原因：${message}`
}
