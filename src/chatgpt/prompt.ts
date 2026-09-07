/**
 * DSH history → one plain-text ChatGPT prompt.
 *
 * Each turn owns a fresh Temporary Chat page, so the full visible history is
 * compiled into every prompt (same stateless discipline as the upstream
 * multipart transport, without its Codex envelope). Tool calls and results
 * are rendered as labeled transcripts — V1 is text-only, so the model can
 * read tool traffic but cannot issue new calls from the page.
 * @module dsh-llm-chatgpt-web/chatgpt-prompt
 */

import { contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'

function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function renderMessage(message: Message): string {
  if (message.source.kind === 'tool') {
    const block = message.content[0]
    if (block === undefined || block.type !== 'tool-result' || message.content.length !== 1) {
      throw new LlmError(
        'ChatGPT Web adapter expects tool results as single tool-result messages.',
        'INVALID_REQUEST',
      )
    }
    if (contentHasImage(block.content)) {
      throw new LlmError('ChatGPT Web adapter cannot represent image content (V1 is text-only).', 'UNSUPPORTED_CONTENT')
    }
    return `[Tool result]\n${textOf(block.content)}`
  }
  if (contentHasImage(message.content)) {
    throw new LlmError('ChatGPT Web adapter cannot represent image content (V1 is text-only).', 'UNSUPPORTED_CONTENT')
  }
  if (message.role === 'assistant') {
    const calls = message.content.filter(block => block.type === 'tool-call')
    const parts = []
    const text = textOf(message.content.filter(block => block.type !== 'tool-call'))
    if (text.length > 0) parts.push(text)
    for (const block of calls) {
      if (block.type !== 'tool-call') continue
      parts.push(`[Tool call: ${block.name} ${block.arguments}]`)
    }
    return `[Assistant]\n${parts.join('\n')}`
  }
  return `[User]\n${textOf(message.content)}`
}

/**
 * Compile one prompt for a fresh Temporary Chat page.
 * @param options - fully assembled harness request.
 * @param maxChars - composer budget; exceeding it fails with context overflow.
 */
export function compilePrompt(options: GenerateOptions, maxChars: number): string {
  if (options.reasoningEffort !== undefined) {
    throw new LlmError(
      `ChatGPT Web does not support reasoning effort "${options.reasoningEffort}"; pick the effort via the model (chatgpt-web/light|medium|high|extra-high|pro|luna).`,
      'UNSUPPORTED_REASONING_EFFORT',
    )
  }
  if (options.stop !== undefined && options.stop.length > 0) {
    throw new LlmError('ChatGPT Web adapter does not support stop sequences.', 'UNSUPPORTED')
  }
  if (options.temperature !== undefined) {
    throw new LlmError('ChatGPT Web adapter does not support temperature.', 'UNSUPPORTED')
  }
  const sections = []
  if (options.system !== undefined && options.system.length > 0) {
    sections.push(`[System]\n${options.system}`)
  }
  for (const message of options.messages) {
    sections.push(renderMessage(message))
  }
  if (options.tools !== undefined && options.tools.length > 0) {
    const catalog = options.tools
      .map(tool => `- ${tool.name}: ${tool.description}`)
      .join('\n')
    sections.push(`[Available tools (transcript only; reply in plain text)]\n${catalog}`)
  }
  const prompt = sections.join('\n\n')
  if (prompt.length > maxChars) {
    throw new LlmError(
      `ChatGPT Web prompt is ${prompt.length} chars, over the ${maxChars}-char composer budget. Compact the session or shorten the request.`,
      'CONTEXT_WINDOW_EXCEEDED',
    )
  }
  return prompt
}
