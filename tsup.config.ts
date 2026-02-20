import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'providers/index': 'src/providers/index.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  external: [
    '@dtelecom/server-sdk-js',
    '@dtelecom/server-sdk-node',
    '@huggingface/transformers',
    'better-sqlite3',
    'sqlite-vec',
  ],
});
