// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*'],
  },
  {
    rules: {
      // Stale-closure bugs shipped as mere warnings (#768); keep the tree at zero.
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    // React Native's global fetch resolves through setTimeout(0), and Android
    // never fires JavaScript timers while the app is off screen, so a request
    // made from a background sync froze until the next foreground (#1001).
    // Library code goes through backgroundSafeFetch; the files below are
    // foreground-only and opt out on purpose.
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
]);
