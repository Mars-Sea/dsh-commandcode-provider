/**
 * 自定义模型名称（issue #121）：按目录模型 id 覆盖宿主模型选择器里的显示名。
 * 本模块保持纯函数（无 node 依赖），Host 侧与浏览器设置页共用同一套清洗与判定。
 *
 * 背景：报告者自己的「峰谷提醒」「缓存计价」插件按模型显示名字符串判断条件；
 * 本插件默认在目录名后加 ` (CC)`，而上游目录的 `raw.name` 自身还可能带
 * ` (latest)`，两个后缀都让那些插件的匹配条件落空。让用户覆盖显示名即可，
 * 模型 id、请求体里的 `model`、本插件的计价与峰谷判定一律不变。
 */
export interface ModelNameOptions {
  /** 按目录模型 id 的显示名覆盖；空表/未设置＝沿用 `${catalogName} (CC)`。 */
  modelNames?: Readonly<Record<string, string>> | undefined
}

/** 清洗后的覆盖表。 */
export type ModelNameMap = Readonly<Record<string, string>>

/**
 * 只接收合法条目的覆盖表：非对象、空键、非字符串、纯空白一律丢弃，值去掉
 * 首尾空白。配置校验（`z.dict(z.string())`）是第一道闸，本函数额外保护绕过
 * 校验的程序化连接（与 `readContextWindowOverrides` 同一约定），返回新对象；
 * 空表读为「未设置」，避免把空 map 当成一次自定义。
 */
export function readModelNames(raw: unknown): ModelNameMap | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const entries = Object.entries(raw)
    .filter((entry): entry is [string, string] =>
      entry[0] !== '' && typeof entry[1] === 'string' && entry[1].trim() !== '')
    .map(([id, name]) => [id, name.trim()] as const)
  return entries.length === 0 ? undefined : Object.fromEntries(entries)
}

/**
 * 一次模型解析的有效显示名：覆盖值优先，否则 `${catalogName} (CC)`；没有
 * 目录条目的未知模型回落为裸 id（保持既有形状）。
 *
 * 只决定 `LlmModelInfo.name`。它绝不参与请求体里的 `model` 字段，也不参与
 * 价格表、峰谷成员或任何能力快照的匹配——那些始终按 catalog id。
 * 排序同样不看这里的结果（见 `listModels()`：排完序才套用显示名）。
 */
export function effectiveModelName(
  catalogName: string | undefined,
  modelId: string,
  options: ModelNameOptions | undefined,
): string {
  const custom = options?.modelNames?.[modelId]
  // 程序化构造可能绕过 readModelNames，再判一次而不是把空白/坏值显示出去。
  if (typeof custom === 'string' && custom.trim() !== '') return custom.trim()
  return catalogName === undefined ? modelId : `${catalogName} (CC)`
}
