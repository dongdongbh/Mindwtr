
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*'],
  },
  {
    rules: {

      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {


    files: ['lib/**/*.ts', 'lib/**/*.tsx'],
    ignores: [
      'lib/**/*.test.ts',
      'lib/**/*.test.tsx',
      'lib/background-safe-fetch.ts',
      'lib/external-calendar.ts',
      'lib/analytics-heartbeat.ts',
    ],
    rules: {
      'no-restricted-globals': ['error', {
        name: 'fetch',
        message: 'Use backgroundSafeFetch from lib/background-safe-fetch: the global fetch never resolves while the app is in the background on Android (#1001).',
      }],
    },
  },
  { rules: { 'no-empty': ['error', { allowEmptyCatch: true }] } },
]);
