import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Старонкі прыкладання (ADR-009): док, оверлей і старонка вяртання пасля перанакіравання.
const pages = ['index', 'dock', 'overlay', 'callback'];

/** Версія зборкі — кароткі хэш commit (відаць на ўкладцы «Стан»: так праверым, што OBS загрузіў новую версію). */
const version = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: import.meta.dirname }).toString().trim();
  } catch {
    return 'dev';
  }
})();

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [
    {
      // version.json побач са старонкамі: па ім адкрытыя док і оверлэй даведваюцца пра новую версію (src/ui/shared/update.ts).
      name: 'version-json',
      apply: 'build',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version }) });
      },
    },
  ],
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
