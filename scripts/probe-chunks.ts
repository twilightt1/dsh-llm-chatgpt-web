import { MessageId } from '@deepseek-ai/dsh-llm'
import { ChatGptWebAdapter } from '../src/adapter.ts'
import { resolveAdapterOptions } from '../src/index.ts'
const adapter = new ChatGptWebAdapter({ options: () => resolveAdapterOptions({ headed: true }) })
try {
  for await (const chunk of adapter.stream({
    provider: 'chatgpt-web',
    model: 'chatgpt-web/light',
    messages: [{
      id: MessageId('p1'), role: 'user',
      content: [{ type: 'text', text: 'Convert this request into exactly one tool-call block and no other text. Request: run the shell command echo PROBE-OK using the bash tool.' }],
      source: { kind: 'user' },
    }],
    tools: [{ name: 'bash', description: 'run shell', parameters: { type: 'object' } }],
  })) {
    if (chunk.type === 'text-delta') process.stdout.write(chunk.text)
    else console.log(`\n[chunk ${chunk.type}]`, JSON.stringify(chunk).slice(0, 220))
  }
} finally {
  await adapter.dispose()
}
