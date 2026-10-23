import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
    conditions: ['kelpie-src'],
  },
  server: {
    proxy: { '/api': { target: `http://127.0.0.1:${process.env.KELPIE_PORT || 7317}`, changeOrigin: true } },
  },
});
