import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const alias = { '@shared': resolve(__dirname, 'src/shared') };

export default defineConfig({
  main: {
    resolve: { alias },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // Runs in its own utility process so speech synthesis never blocks the app.
          'tts-worker': resolve(__dirname, 'src/main/voice/tts-worker.ts'),
        },
      },
    },
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
          audio: resolve(__dirname, 'src/renderer/audio/index.html'),
          overlay: resolve(__dirname, 'src/renderer/overlay/index.html'),
        },
      },
    },
  },
});
