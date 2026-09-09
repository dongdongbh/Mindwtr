/// <reference types="vitest" />
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Vitest 4 narrowed discovery defaults; retain the Vitest 3 boundary.
        exclude: [
            ...configDefaults.exclude,
            '**/dist/**',
            '**/cypress/**',
            '**/.{idea,git,cache,output,temp}/**',
            '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
        ],
        coverage: {
            provider: 'v8',
            // Keep Vitest 3's unloaded-source denominator and exclusions.
            include: ['**/*.{js,cjs,mjs,ts,mts,tsx,jsx,vue,svelte,marko,astro}'],
            exclude: [
                'coverage/**',
                'dist/**',
                '**/node_modules/**',
                '**/[.]**',
                'packages/*/test?(s)/**',
                '**/*.d.ts',
                '**/virtual:*',
                '**/__x00__*',
                // Do not retain the old raw-NUL glob: picomatch strips NUL and excludes every file.
                'cypress/**',
                'test?(s)/**',
                'test?(-*).?(c|m)[jt]s?(x)',
                '**/*{.,-}{test,spec,bench,benchmark}?(-d).?(c|m)[jt]s?(x)',
                '**/__tests__/**',
                '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
                '**/vitest.{workspace,projects}.[jt]s?(on)',
                '**/.{eslint,mocha,prettier}rc.{?(c|m)js,yml}',
            ],
            reporter: ['text', 'lcov', 'html', 'json-summary'],
        },
    },
});
