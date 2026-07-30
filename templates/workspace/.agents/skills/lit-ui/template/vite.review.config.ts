import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: '.psp/review-dist',
    emptyOutDir: true,
    rollupOptions: { input: 'review.html' },
  },
});
