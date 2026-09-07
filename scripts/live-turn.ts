/**
 * Dev-only live turn: drives one real ChatGPT Web turn through the adapter
 * and prints streamed text. First run opens a headed window for manual
 * sign-in (up to 10 minutes). NOT part of the published package.
 *
 *   node --import tsx/esm scripts/live-turn.ts [model] [prompt...]
 */
import { MessageId } from '@deepseek-ai/dsh-llm'
import { ChatGptWebAdapter } from '../src/adapter.ts'
import { resolveAdapterOptions } from '../src/index.ts'

const args = process.argv.slice(2).filter(a => a !== '--headed')
const headed = process.argv.includes('--headed')
const requested = args[0] ?? 'chatgpt-web/luna'
const promptText = args.slice(1).join(' ') || 'Reply with exactly: DSH LIVE READY'

async function runOnce(model: string): Promise<void> {
  const adapter = new ChatGptWebAdapter({ options: () => resolveAdapterOptions(headed ? { headed: true } : {}) })
  try {
    let full = ''
    for await (const chunk of adapter.stream({
      provider: 'chatgpt-web',
      model,
      messages: [{
        id: MessageId('live-1'),
        role: 'user',
        content: [{ type: 'text', text: promptText }],
        source: { kind: 'user' },
      }],
    })) {
      switch (chunk.type) {
        case 'text-delta': process.stdout.write(chunk.text); full += chunk.text; break
        case 'usage': console.log(`\n[usage] ${JSON.stringify(chunk.usage)}`); break
        case 'finish': console.log(`\n[finish] ${JSON.stringify(chunk.reason)}`); break
        case 'block-end':
          if (chunk.block.type !== 'text' || chunk.block.text !== full) {
            console.log('\n[warn] assembled block differs from streamed deltas')
          }
          break
        default: break
      }
    }
  } finally {
    await adapter.dispose()
  }
}

try {
  console.log(`[live] model=${requested}`)
  await runOnce(requested)
} catch (error) {
  // Luna-only slug on a Sol account (or vice versa): fail over once.
  const message = error instanceof Error ? error.message : String(error)
  if (requested === 'chatgpt-web/luna' && /Sol model selector/.test(message)) {
    console.log('[live] Luna unavailable on this account, retrying with chatgpt-web/light')
    await runOnce('chatgpt-web/light')
  } else {
    throw error
  }
}
