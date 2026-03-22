/// <reference types="vitest" />
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@mindwtr/core": path.resolve(__dirname, "../../packages/core/src/index.ts"),
    },
  },
  // Prevent vite from obscuring rust errors in the console
  clearScreen: false,
  // Tauri expects a fixed port
  server: {
    port: 5173,
    strictPort: true,
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
  test: {
    globals: true,
    environment: 'jsdom',
    css: true,
    setupFiles: './src/test/setup.ts',
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('packages/core/src/i18n/i18n-translations')) {
            return 'i18n';
          }
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
