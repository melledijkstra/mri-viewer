import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // Allow deployment in a subdirectory like GitHub Pages
  server: {
    port: 3000,
    open: true
  }
});
