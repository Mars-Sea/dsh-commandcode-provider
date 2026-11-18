/**
 * Shared copy for the Command Code service-status surface.
 *
 * The status pill lives in the plans & quota panel header
 * (`panel.commandcode`), so this table is spread into that dictionary. The
 * settings page no longer renders a status row; keeping the copy out of
 * `settings.commandcode` avoids a second, unused key set.
 *
 * @module dsh-commandcode-provider/client/service-status-copy
 */

import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

/** Locale keys owned by the service-status surface. */
export type ServiceStatusCopyKey =
  | 'serviceStatusTitle'
  | 'serviceStatusPillLabel'
  | 'serviceStatusHint'
  | 'serviceStatusChecking'
  | 'serviceStatusUp'
  | 'serviceStatusDegraded'
  | 'serviceStatusDown'
  | 'serviceStatusUnknown'
  | 'serviceStatusOfficial'
  | 'serviceStatusLocal'
  | 'serviceStatusUptime'
  | 'serviceStatusUptimeWeek'
  | 'serviceStatusUptimeMonth'
  | 'serviceStatusResponseWeek'
  | 'serviceStatusStaleAt'
  | 'serviceStatusUpdatedJustNow'
  | 'serviceStatusUpdatedMinutes'
  | 'serviceStatusUpdatedHours'
  | 'serviceStatusUpdatedUnknown'
  | 'serviceStatusLag'
  | 'serviceStatusLocalChecking'
  | 'serviceStatusLocalOk'
  | 'serviceStatusLocalHttp'
  | 'serviceStatusLocalTimeout'
  | 'serviceStatusLocalUnreachable'
  | 'serviceStatusLocalUnavailable'
  | 'serviceStatusLocalRetry'
  | 'serviceStatusStale'
  | 'serviceStatusUnavailable'
  | 'serviceStatusOpen'

/** The translator shape {@link serviceStatusView} needs (a narrower settings `t`). */
export type ServiceStatusTranslate = Translate<ServiceStatusCopyKey>

/** Simplified Chinese copy. */
export const SERVICE_STATUS_ZH: Record<ServiceStatusCopyKey, string> = {
  serviceStatusTitle: '服务状态',
  serviceStatusPillLabel: '服务状态：{official}。本机：{local}',
  serviceStatusHint: '官方数据来自状态页的公开记录，仅在状态变化或每日汇总时发布；超过一天未更新会标记为已过期。本机连通由宿主刚探测，失败可重试。',
  serviceStatusChecking: '正在检查…',
  serviceStatusUp: '服务正常',
  serviceStatusDegraded: '部分降级',
  serviceStatusDown: '服务中断',
  serviceStatusUnknown: '状态未知',
  // 服务状态分「官方」「本机」两行；胶囊只报综合判定，本机探测失败不抢占官方判定。
  serviceStatusOfficial: '官方',
  serviceStatusLocal: '本机',
  serviceStatusUptime: '可用率 {value}',
  serviceStatusUptimeWeek: '7 天 {value}',
  serviceStatusUptimeMonth: '30 天 {value}',
  serviceStatusResponseWeek: '平均响应 {value}',
  serviceStatusStaleAt: '数据停在 {date}',
  serviceStatusUpdatedJustNow: '刚刚更新',
  serviceStatusUpdatedMinutes: '{count} 分钟前更新',
  serviceStatusUpdatedHours: '{count} 小时前更新',
  serviceStatusUpdatedUnknown: '更新时间未知',
  serviceStatusLag: '官方数据仅在状态变化或每日汇总时发布，可能滞后数小时。',
  serviceStatusLocalChecking: '正在探测…',
  serviceStatusLocalOk: '连通正常 · {latency} ms',
  serviceStatusLocalHttp: '本次探测未成功（HTTP {status}）',
  serviceStatusLocalTimeout: '本次探测未成功（超时）',
  serviceStatusLocalUnreachable: '本次探测未成功（无法连接）',
  serviceStatusLocalUnavailable: '未知（宿主未提供探测）',
  serviceStatusLocalRetry: '重新探测',
  serviceStatusStale: '无法获取状态数据，以下为上次成功获取的结果。',
  serviceStatusUnavailable: '无法获取状态数据。',
  serviceStatusOpen: '打开状态页',
}

/** English copy (must mirror {@link SERVICE_STATUS_ZH}). */
export const SERVICE_STATUS_EN: Record<ServiceStatusCopyKey, string> = {
  serviceStatusTitle: 'Service status',
  serviceStatusPillLabel: 'Service status: {official}. This device: {local}',
  serviceStatusHint: 'Published data comes from the official status page and is only written on a status change or the daily summary; anything older than a day is flagged as expired. Local connectivity is probed by the host just now and can be retried.',
  serviceStatusChecking: 'Checking…',
  serviceStatusUp: 'Operational',
  serviceStatusDegraded: 'Degraded performance',
  serviceStatusDown: 'Service outage',
  serviceStatusUnknown: 'Status unknown',
  serviceStatusOfficial: 'Official',
  serviceStatusLocal: 'This device',
  serviceStatusUptime: 'uptime {value}',
  serviceStatusUptimeWeek: '7d {value}',
  serviceStatusUptimeMonth: '30d {value}',
  serviceStatusResponseWeek: 'avg {value}',
  serviceStatusStaleAt: 'Data stops at {date}',
  serviceStatusUpdatedJustNow: 'updated just now',
  serviceStatusUpdatedMinutes: 'updated {count} min ago',
  serviceStatusUpdatedHours: 'updated {count} h ago',
  serviceStatusUpdatedUnknown: 'update time unknown',
  serviceStatusLag: 'Official data is only published on a status change or the daily summary, so it may lag by hours.',
  serviceStatusLocalChecking: 'Probing…',
  serviceStatusLocalOk: 'Reachable · {latency} ms',
  serviceStatusLocalHttp: 'Probe failed (HTTP {status})',
  serviceStatusLocalTimeout: 'Probe failed (timed out)',
  serviceStatusLocalUnreachable: 'Probe failed (unreachable)',
  serviceStatusLocalUnavailable: 'Unknown (host provides no probe)',
  serviceStatusLocalRetry: 'Probe again',
  serviceStatusStale: 'Status data unavailable; showing the last known result.',
  serviceStatusUnavailable: 'Status data unavailable.',
  serviceStatusOpen: 'Open status page',
}
