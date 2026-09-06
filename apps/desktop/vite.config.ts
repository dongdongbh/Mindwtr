/// <reference types="vitest" />
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: "@", replacement: path.resolve(__dirname, "./src") },
      {
        find: /^@mindwtr\/core$/,
        replacement: path.resolve(__dirname, "../../packages/core/src/index.ts"),
      },
      {
        find: /^@mindwtr\/core\/(.+)$/,
        replacement: path.resolve(__dirname, "../../packages/core/src/$1.ts"),
      },
    ],
  },
  // Prevent vite from obscuring rust errors in the console
  clearScreen: false,
  // Tauri expects a fixed port
  server: {
    port: 5173,
    strictPort: true,
    // Settings is the biggest lazy view (~190 kB chunk, hundreds of modules).
    // Without this, the dev server transforms that graph on the FIRST click of
    // Settings, which shows several seconds of skeleton in dev and in the demo
    // recordings (release builds preload the built chunk and are fine).
    warmup: {
      clientFiles: ['./src/components/views/SettingsView.tsx'],
    },
    watch: {
      ignored: ['**/src-tauri/**'],
    },
    fs: {
      allow: [
        path.resolve(__dirname, '..', '..'),
        ...(fs.existsSync(path.resolve(__dirname, '../../../Mindwtr'))
          ? [path.resolve(__dirname, '../../../Mindwtr')]
          : []),
      ],
    },
  },
  // Test config lives in vitest.config.ts (CONFIG_NAMES order wins over this file); this block is dead.
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('@radix-ui')) return 'radix-vendor';
            if (id.includes('lucide-react')) return 'icons-vendor';
            if (id.includes('@tauri-apps')) return 'tauri-vendor';
            return 'vendor';
          }
        },
      },
    },
  },
})
