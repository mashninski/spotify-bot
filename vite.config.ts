import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Старонкі прыкладання (ADR-009): док, оверлей і старонка вяртання пасля перанакіравання.
const pages = ['index', 'dock', 'overlay', 'callback'];

export default defineConfig({
  // Адносныя шляхі ў зборцы: старонкі можна размясціць у любой папцы хостынгу.
  base: './',
  oxc: {
    jsx: { runtime: 'automatic', importSource: 'preact' },
  },
  server: {
    // Толькі лакальны адрас: dev-сервер не павінен быць бачны ў сетцы.
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: Object.fromEntries(pages.map((p) => [p, resolve(import.meta.dirname, `${p}.html`)])),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
