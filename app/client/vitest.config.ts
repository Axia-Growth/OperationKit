import { defineConfig, configDefaults } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@operationkit/shared': path.resolve(__dirname, '../shared/types.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // Vitest 4+ dropped `**/dist/**` from configDefaults.exclude; keep the build
    // output out of collection as it was under Vitest 2.
    exclude: [...configDefaults.exclude, '**/dist/**'],
    // obj 900685: uncapped, vitest sizes its pool to the CPU count — 31
    // workers per run on the 32-core host, from every session that runs the
    // client suite. Same cap as app/server/vitest.config.ts.
    // Vitest 4+ removed `poolOptions` and `minWorkers` (they are silently
    // ignored); the top-level `maxWorkers` is now the one cap for the fork pool.
    pool: 'forks',
    maxWorkers: 2,
  },
})
