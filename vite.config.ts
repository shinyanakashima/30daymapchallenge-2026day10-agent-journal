import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Relative base so the same build works at a GitHub Pages project path
// (/30daymapchallenge-2026day10-agent-journal/) or at a domain root.
export default defineConfig({
  base: './',
  server: { host: '0.0.0.0', allowedHosts: true },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
    rolldownOptions: {
      input: { main: resolve(import.meta.dirname, 'index.html'), record: resolve(import.meta.dirname, 'record.html') },
    },
  },
});
