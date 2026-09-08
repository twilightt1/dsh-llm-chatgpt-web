/**
 * Dev-only live turn through the BUILT lib/ (no tsx transpiler involved).
 *   node scripts/live-lib.mjs "prompt"
 */
import { MessageId } from '@deepseek-ai/dsh-llm'
import { ChatGptWebAdapter, resolveAdapterOptions } from '../lib/index.js'

const model = process.argv[2] ?? 'chatgpt-web/light'
const promptText = process.argv.slice(3).join(' ') || 'Reply with exactly this line and nothing else: LIB LIVE OK'
const adapter = new ChatGptWebAdapter({ options: () => resolveAdapterOptions({}) })
let full = ''
try {
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
      default: break
    }
  }
} finally {
  await adapter.dispose()
}
