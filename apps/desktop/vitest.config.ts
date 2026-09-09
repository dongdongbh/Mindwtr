/// <reference types="vitest" />
import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

const coverageReporters = process.env.CI
    ? ['text', 'lcovonly', 'json-summary']
    : ['text', 'lcov', 'html', 'json-summary'];

export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: [
            { find: '@', replacement: path.resolve(__dirname, './src') },
            {
                find: /^@mindwtr\/core$/,
                replacement: path.resolve(__dirname, '../../packages/core/src/index.ts'),
            },
            {
                find: /^@mindwtr\/core\/(.+)$/,
                replacement: path.resolve(__dirname, '../../packages/core/src/$1.ts'),
            },
        ],
    },
    test: {
        globals: true,
        environment: 'jsdom',
        setupFiles: './src/test/setup.ts',
        css: true,
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
                // Native build output contains compressed JS and CMake .ts files, not source.
                'src-tauri/target/**',
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
            reporter: coverageReporters,
        },
    },
});
