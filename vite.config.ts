import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
// shown in the bar at the bottom of every screen
const define = { __APP_VERSION__: JSON.stringify(pkg.version), __APP_BUILD__: JSON.stringify(new Date().toISOString().slice(0, 10)) };

// `vite build`             → dist/ (static site, e.g. GitHub Pages)
// `vite build --mode offline` → dist-offline/index.html, everything inlined in one file (opened with a double click)
export default defineConfig(({ mode }) =>
  mode === 'offline'
    ? { define, base: './', plugins: [viteSingleFile()], build: { target: 'es2022', outDir: 'dist-offline', assetsInlineLimit: 100_000_000 } }
    : { define, base: './', server: { host: true }, build: { target: 'es2022' } },
);
