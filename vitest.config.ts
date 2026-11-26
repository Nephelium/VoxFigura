import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  envDir: false,
  resolve: {
    alias: {
      '@vocalcut/edition': fileURLToPath(new URL('./src/editions/public.ts', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@vocalcut/core': fileURLToPath(new URL('./packages/core-ts/src/index.ts', import.meta.url)),
      '@vocalcut/g2p': fileURLToPath(new URL('./packages/g2p-ts/src/index.ts', import.meta.url)),
      '@vocalcut/model-adapters': fileURLToPath(new URL('./packages/model-adapters/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'packages/**/*.test.ts', 'src/data/**/*.test.ts', 'src/editions/hackathon/**/*.test.ts'],
  },
});
