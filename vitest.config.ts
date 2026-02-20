import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    exclude: ['examples/**', 'node_modules/**'],
  },
});
