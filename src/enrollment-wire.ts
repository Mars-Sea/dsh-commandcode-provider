/** 账号开通的双方使用契约。状态和恢复记录不携带密钥，密钥只出现在手动开通输入。 */
import type { InvocationDescriptor, TypertRemoteContribution, TypertSchema } from '@deepseek-ai/dsh-typert-protocol'
import { makeBoundaryValidator, makeRemoteDescriptor, makeStrictCodec, REMOTE_PACKAGE } from './wire-shared.ts'

export interface EnrollmentInput {
  id: string
  pageId: string
  mode: 'browser' | 'manual'
  label: string
  /** 用户未填写名称时，允许使用浏览器登录返回的账号名。 */
  automaticName: boolean
  key?: string
}
export type EnrollmentPhase = 'creating' | 'waiting' | 'writing' | 'naming' | 'finished' | 'cancelling' | 'cancelled' | 'failed' | 'cleanup-needed'
export interface EnrollmentState {
  id: string
  ref: string
  phase: EnrollmentPhase
  message: string
  authUrl?: string
  suggestedName?: string
}
/** 配置中的恢复日志：先登记，再写凭据；只保留引用与阶段，不保留密钥或连接身份。 */
export interface EnrollmentRecord {
  id: string
  ref: string
  phase: 'pending' | 'naming' | 'cleanup'
  label: string
}
const guard = makeBoundaryValidator('commandcode/enrollment')
const phases: readonly EnrollmentPhase[] = ['creating', 'waiting', 'writing', 'naming', 'finished', 'cancelling', 'cancelled', 'failed', 'cleanup-needed']
export function parseEnrollmentState(value: unknown): EnrollmentState {
  const source = guard.record(value, 'state')
  const phase = source.phase
  if (!phases.includes(phase as EnrollmentPhase)) return guard.reject('phase')
  const state: EnrollmentState = {
    id: guard.stringField(source, 'id', 'id'), ref: guard.stringField(source, 'ref', 'ref'),
    phase: phase as EnrollmentPhase, message: guard.stringField(source, 'message', 'message'),
  }
  for (const field of ['authUrl', 'suggestedName'] as const) {
    if (source[field] !== undefined) state[field] = guard.stringField(source, field, field)
  }
  return state
}
export function parseEnrollmentInput(value: unknown): EnrollmentInput {
  const source = guard.record(value, 'input')
  const id = guard.stringField(source, 'id', 'id')
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(id)) return guard.reject('id')
  if (source.mode !== 'browser' && source.mode !== 'manual') return guard.reject('mode')
  const input: EnrollmentInput = {
    id, pageId: parsePage(source).pageId, mode: source.mode, label: guard.stringField(source, 'label', 'label').trim(),
    automaticName: guard.booleanField(source, 'automaticName', 'automaticName'),
  }
  if (!input.label || input.label.length > 200) return guard.reject('label')
  if (input.mode === 'manual') {
    input.key = guard.stringField(source, 'key', 'key').trim()
    if (!input.key) return guard.reject('key')
  } else if (source.key !== undefined) return guard.reject('key')
  return input
}
export interface EnrollmentPage { pageId: string }
function parsePage(value: unknown): EnrollmentPage {
  const source = guard.record(value, 'page')
  const pageId = guard.stringField(source, 'pageId', 'pageId')
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(pageId)) return guard.reject('pageId')
  return { pageId }
}
export interface EnrollmentAction extends EnrollmentPage { id: string; name?: string }
const actionSchema: TypertSchema<EnrollmentAction> = {
  parse(value) {
    const source = guard.record(value, 'action')
    const action: EnrollmentAction = { id: guard.stringField(source, 'id', 'id'), ...parsePage(source) }
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(action.id)) return guard.reject('id')
    if (source.name !== undefined) action.name = guard.stringField(source, 'name', 'name').trim()
    if (action.name !== undefined && (!action.name || action.name.length > 200)) return guard.reject('name')
    return action
  },
}
const stateSchema = { parse: parseEnrollmentState }
const listSchema: TypertSchema<EnrollmentState[]> = {
  parse(value) { return Array.isArray(value) ? value.map(parseEnrollmentState) : guard.reject('list') },
}
export const ENROLLMENT_DESCRIPTORS: readonly InvocationDescriptor[] = [
  ...['enrollmentBegin', 'enrollmentStatus', 'enrollmentCancel', 'enrollmentName', 'enrollmentRetry'].map((method) => ({
    ...makeRemoteDescriptor(`commandcode/${method}`, method, `${REMOTE_PACKAGE}#EnrollmentState`, stateSchema),
    parameters: [{ name: 'input', wire: 'input', source: 'json' as const,
      codec: makeStrictCodec(`${REMOTE_PACKAGE}#${method}Input`, method === 'enrollmentBegin' ? { parse: parseEnrollmentInput } : actionSchema) }],
  })),
  { ...makeRemoteDescriptor('commandcode/enrollmentPending', 'enrollmentPending', `${REMOTE_PACKAGE}#EnrollmentStateList`, listSchema),
    parameters: [{ name: 'input', wire: 'input', source: 'json', codec: makeStrictCodec(`${REMOTE_PACKAGE}#EnrollmentPage`, { parse: parsePage }) }] },
  { ...makeRemoteDescriptor('commandcode/enrollmentWatch', 'enrollmentWatch', `${REMOTE_PACKAGE}#EnrollmentReady`, {
      parse(value: unknown) { return value === true ? true : guard.reject('ready') },
    }), mode: 'stream',
    parameters: [{ name: 'input', wire: 'input', source: 'json', codec: makeStrictCodec(`${REMOTE_PACKAGE}#EnrollmentPage`, { parse: parsePage }) }] },
]
export const ENROLLMENT_REMOTE_CONTRIBUTION: TypertRemoteContribution = { package: REMOTE_PACKAGE, descriptors: ENROLLMENT_DESCRIPTORS }
