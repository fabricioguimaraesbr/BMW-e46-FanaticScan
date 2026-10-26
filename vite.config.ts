import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `vite build`             → dist/ (static site, e.g. GitHub Pages)
// `vite build --mode offline` → dist-offline/index.html, everything inlined in one file (opened with a double click)
export default defineConfig(({ mode }) =>
  mode === 'offline'
    ? { base: './', plugins: [viteSingleFile()], build: { target: 'es2022', outDir: 'dist-offline', assetsInlineLimit: 100_000_000 } }
    : { base: './', server: { host: true }, build: { target: 'es2022' } },
);
