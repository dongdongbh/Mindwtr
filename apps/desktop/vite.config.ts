/// <reference types="vitest" />
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'


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

  clearScreen: false,

  server: {
    port: 5173,
    strictPort: true,


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
