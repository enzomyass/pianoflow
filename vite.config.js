import { defineConfig } from 'vite';

// Relative base so the bundle loads from Capacitor's local web server
// (https://localhost/) and from file-like origins with zero network access.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2020',
    sourcemap: false,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 800,
  },
  server: {
    host: true,
  },
});
