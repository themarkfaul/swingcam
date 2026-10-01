import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  // Relative paths so the site works from a GitHub Pages sub-folder
  // (https://<user>.github.io/swingcam/).
  base: './',
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        camera: resolve(import.meta.dirname, 'camera.html'),
        probe: resolve(import.meta.dirname, 'probe.html'),
      },
    },
  },
  // Module workers, so the encoder worker can import Mediabunny.
  worker: { format: 'es' },
});
