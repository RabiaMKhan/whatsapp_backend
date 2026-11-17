import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Integration tests share one test database, so run files one at a time.
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 30_000,
    env: {
      NODE_ENV: 'test',
      MONGODB_URI: 'mongodb://127.0.0.1:27017/chat_app_test',
      JWT_ACCESS_SECRET: 'test-only-secret-at-least-32-characters-long',
      CLIENT_ORIGINS: 'http://localhost:3005',
    },
  },
});
