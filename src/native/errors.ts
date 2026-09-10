import { LlmError } from '@deepseek-ai/dsh-llm'

/** A policy denial is recoverable within the same still-valid broker round. */
export class NativePolicyDeniedError extends Error {
  readonly code = 'NATIVE_POLICY_DENIED' as const
  readonly releaseRound = false as const

  constructor(message: string) {
    super(message)
    this.name = 'NativePolicyDeniedError'
  }
}

/** A native safety failure is an invalid request, never a provider retry. */
export class NativeSafetyError extends LlmError {
  readonly nativeCode: string
  readonly retryable = false as const

  constructor(message: string, cause?: unknown, nativeCode = 'NATIVE_SAFETY') {
    super(message, 'INVALID_REQUEST', cause === undefined ? undefined : { cause })
    this.name = 'NativeSafetyError'
    this.nativeCode = nativeCode
  }
}
