import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'chatgpt/daemon-main': 'src/chatgpt/daemon-main.ts',
    'mcp-main': 'src/native/mcp-main.ts',
  },
  format: ['esm'],
  dts: true,
  outDir: 'lib',
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  outputOptions: {
    entryFileNames: '[name].js',
    chunkFileNames: 'chunks/[name]-[hash].js',
  },
})
