import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const alias = { '@shared': resolve(__dirname, 'src/shared') };

export default defineConfig({
  main: {
    resolve: { alias },
  },
  preload: {
    resolve: { alias },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias },
    plugins: [react(), tailwindcss()],
    build: {
      minify: true,
      rollupOptions: {
        input: {
          settings: resolve(__dirname, 'src/renderer/settings/index.html'),
          palette: resolve(__dirname, 'src/renderer/palette/index.html'),
        },
      },
    },
  },
});
