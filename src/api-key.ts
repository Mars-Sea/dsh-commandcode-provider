import { INVALID_CREDENTIAL_CODE, LlmError } from '@deepseek-ai/dsh-llm'

/** Printable ASCII excluding space, the values provider keys use in HTTP headers. */
const LEGAL_API_KEY = /^[\x21-\x7E]+$/

/**
 * Return one trimmed API key or reject it without exposing the credential.
 *
 * This local compatibility helper replaces the function removed from
 * `@deepseek-ai/dsh-llm` while keeping this plugin loadable on older engines
 * whose credentials package does not export the replacement predicate.
 *
 * @param raw - Credential exactly as resolved.
 * @param pkg - Package prefix for the diagnostic.
 * @param ref - Credential reference the user can correct.
 * @returns The trimmed key.
 */
export function assertUsableApiKey(raw: string, pkg: string, ref: string): string {
  const value = raw.trim()
  if (value.length === 0) {
    throw new LlmError(
      `${pkg}: the API key resolved from ${ref} is blank; set ${ref} to the raw key`
      + ' (the web Models page writes it) or export it in the launching environment',
      INVALID_CREDENTIAL_CODE,
    )
  }
  if (!LEGAL_API_KEY.test(value)) {
    throw new LlmError(
      `${pkg}: the API key resolved from ${ref} contains characters no HTTP header can carry;`
      + ` set ${ref} to the raw key alone (the web Models page writes it)`,
      INVALID_CREDENTIAL_CODE,
    )
  }
  return value
}
