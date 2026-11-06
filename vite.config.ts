import { defineConfig } from 'vite';

// Relative base so the same build works at a GitHub Pages project path
// (/30daymapchallenge-2026day10-agent-journal/) or at a domain root.
export default defineConfig({
  base: './',
  server: { host: '0.0.0.0', allowedHosts: true },
  build: { target: 'es2022' },
});
