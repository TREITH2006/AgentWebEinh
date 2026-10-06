import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'node:path';
import { copyFileSync, existsSync } from 'node:fs';

const SRC = resolve(import.meta.dirname, 'src');
const OUT = resolve(import.meta.dirname, 'dist');
const MANIFEST = resolve(import.meta.dirname, 'manifest.json');

function copyManifest(): Plugin {
  return {
    name: 'copy-manifest',
    closeBundle() {
      if (existsSync(MANIFEST)) {
        copyFileSync(MANIFEST, resolve(OUT, 'manifest.json'));
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const isContent = mode === 'content';

  if (isContent) {
    return {
      publicDir: false,
      build: {
        outDir: OUT,
        emptyOutDir: false,
        target: 'es2022',
        minify: false,
        rollupOptions: {
          input: { 'content-script': resolve(SRC, 'content/content-script.ts') },
          output: {
            format: 'iife',
            entryFileNames: 'content/content-script.js',
          },
        },
      },
    };
  }

  return {
    root: SRC,
    publicDir: resolve(import.meta.dirname, 'public'),
    build: {
      outDir: OUT,
      emptyOutDir: false,
      target: 'es2022',
      minify: false,
      rollupOptions: {
        input: {
          'service-worker': resolve(SRC, 'background/service-worker.ts'),
          'popup/popup': resolve(SRC, 'popup/popup.html'),
        },
        output: {
          entryFileNames: '[name].js',
          chunkFileNames: 'assets/[name]-[hash].js',
        },
      },
    },
    plugins: [copyManifest()],
  };
});
