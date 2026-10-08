import { defineConfig } from 'vite';
export default defineConfig({
  root: 'web',
  build: {
    outDir: '../dist/web',
    emptyOutDir: false,
    rollupOptions: {
      output: {
        manualChunks: {
          terminal: ['@xterm/xterm', '@xterm/addon-fit'],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8765',
      '/terminal': { target: 'ws://127.0.0.1:8765', ws: true },
    },
  },
});
