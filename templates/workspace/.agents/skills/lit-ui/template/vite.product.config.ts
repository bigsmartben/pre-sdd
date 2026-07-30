import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'UIHTML',
    emptyOutDir: true,
    rollupOptions: { input: 'index.html' },
  },
});
