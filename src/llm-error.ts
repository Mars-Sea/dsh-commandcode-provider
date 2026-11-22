/** Preserve provider-specific failure codes across the old and new DSH error APIs. */
import { LlmError, type LlmErrorOptions, type LlmFailure } from '@deepseek-ai/dsh-llm'

// DSH 0.2.2-rc.1 uses the open-string constructor. The factory starts in rc.2.
type FailureFactory = (failure: LlmFailure, options?: ErrorOptions) => LlmError

/** Construct an open-code provider failure without changing its retry classification or facts. */
export function providerError(message: string, code: string, options?: LlmErrorOptions): LlmError {
  const ErrorClass = LlmError as typeof LlmError & { fromFailure?: FailureFactory }
  if (typeof ErrorClass.fromFailure === 'function') {
    const { cause: _cause, ...facts } = options ?? {}
    return ErrorClass.fromFailure({ ...facts, message, code }, options)
  }
  // Before rc.2 the constructor itself is the public open-string API. Keep that
  // signature confined to this fallback; rc.2 takes the factory branch above.
  const LegacyError = LlmError as new (message: string, code: string, options?: LlmErrorOptions) => LlmError
  return new LegacyError(message, code, options)
}
