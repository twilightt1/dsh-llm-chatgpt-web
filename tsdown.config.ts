import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/chatgpt/daemon-main.ts'],
  format: ['esm'],
  dts: true,
  outDir: 'lib',
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  outputOptions: {
    entryFileNames: '[name].js',
    chunkFileNames: 'chunks/[name]-[hash].js',
  },
})
