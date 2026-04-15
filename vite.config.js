import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  server: {
    hmr: { overlay: false },
  },
  build: {
    target: 'es2022', // top-level await (PlayCanvas device init)
  },
  // Pre-bundle splat-transform so dev never serves raw node_modules .mjs as text/plain
  // (dynamic import() would then throw: "'text/plain' is not a valid JavaScript MIME type").
  optimizeDeps: {
    exclude: ['playcanvas'],
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['brand/logo.svg', 'brand/16.png', 'brand/48.png'],
      workbox: {
        // App shell + static UI assets only — never precache huge splat files
        globPatterns: ['**/*.{js,css,html,ico,svg,woff2}'],
        globIgnores: [
          '**/splats/**',
          '**/tabler-icons/**',
          '**/*.ply',
          '**/*.sog',
          '**/*.compressed.ply',
        ],
      },
      manifest: {
        name: 'Photoshock',
        short_name: 'Photoshock',
        description: 'Paint on Gaussian splats and export as PLY or SOG',
        theme_color: '#24252b',
        background_color: '#24252b',
        display: 'standalone',
        orientation: 'any',
        scope: '/',
        start_url: '/',
        icons: [
          {
            src: 'brand/48.png',
            sizes: '48x48',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'brand/16.png',
            sizes: '16x16',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'brand/logo.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
      // Set to true to debug the service worker with `npm run dev`
      devOptions: {
        enabled: false,
      },
    }),
  ],
});
