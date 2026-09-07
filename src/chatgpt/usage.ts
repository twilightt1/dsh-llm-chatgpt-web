/**
 * Client-side token estimates (the page exposes no measured usage).
 * Reported as plain counts; consumers treat them as approximate.
 * @module dsh-llm-chatgpt-web/chatgpt-usage
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'

/** Rough char→token ratio for mixed prose/code prompts. */
export const CHARS_PER_TOKEN = 4

/** Estimate tokens for one text; always rounds up. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN))
}

/** Build a usage record from prompt + answer lengths. */
export function estimateUsage(promptChars: number, answerChars: number): TokenUsage {
  return {
    inputTokens: Math.max(1, Math.ceil(promptChars / CHARS_PER_TOKEN)),
    outputTokens: Math.max(1, Math.ceil(answerChars / CHARS_PER_TOKEN)),
  }
}
