/** 网页、终端与模型目录共用的选择规则；显式开关优先于白名单。 */
export function modelIsVisible(id: string, allowlist: readonly string[], overrides: unknown): boolean {
  const flag = overrides !== null && typeof overrides === 'object' && !Array.isArray(overrides)
    ? (overrides as Record<string, unknown>)[id] : undefined
  return typeof flag === 'boolean' ? flag : allowlist.length === 0 || allowlist.includes(id)
}

/** 只接收布尔事实，手工配置中的其他值不能成为可见性开关。 */
export function readVisibility(raw: unknown): Record<string, boolean> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return Object.fromEntries(Object.entries(raw).filter(([id, value]) => id !== '' && typeof value === 'boolean'))
}
