import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { resolve } from 'path';
import { existsSync } from 'fs';

const pluginsDir = resolve(import.meta.dirname, '..', 'plugins');
const findPkg = (pkg) => {
  const local = resolve(import.meta.dirname, 'node_modules', pkg);
  return existsSync(local) ? local : resolve(import.meta.dirname, '..', 'node_modules', pkg);
};

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    viteStaticCopy({
      targets: [
        { src: 'assets', dest: '' },
      ],
    }),
  ],
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src'),
      '@plugins': pluginsDir,
      // Plugin client code lives outside client/ and has no node_modules of its own.
      // Vite walks up from each plugin file looking for `react`/`react-dom` and finds
      // nothing (the deps are in client/node_modules). Aliasing them explicitly lets
      // plugin-authored .jsx use bare `import { useState } from 'react'`.
      react: findPkg('react'),
      'react-dom': findPkg('react-dom'),
      'react/jsx-runtime': findPkg('react/jsx-runtime.js'),
      'react/jsx-dev-runtime': findPkg('react/jsx-dev-runtime.js'),
    },
  },
  // Plugin glob discovery (client/src/lib/plugins/loader.js) globs `/../plugins/*`.
  // Vite resolves globs relative to the project root, so we need fs.allow to expose
  // the parent plugins/ directory alongside the client/.
  server: {
    host: '0.0.0.0',
    port: 3000,
    allowedHosts: true,
    fs: {
      allow: [
        resolve(import.meta.dirname, '..'),
      ],
    },
    proxy: {
      '/v1': 'http://localhost:3000',
    },
  },
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rolldownOptions: {
      input: resolve(import.meta.dirname, 'index.html'),
      output: {
        // React, React DOM and the router are half the code every page loads,
        // and they change only when those dependencies do. In a chunk of their
        // own they keep one hash across app releases, so a returning visitor
        // reuses the cached copy (assets are immutable for a year) instead of
        // downloading them again after every deploy.
        codeSplitting: {
          groups: [
            {
              name: 'react-vendor',
              test: /[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/,
            },
          ],
        },
      },
    },
  },
});
