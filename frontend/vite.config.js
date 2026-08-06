import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // src/lib/pwa.js imports virtual:pwa-register and registers the worker
      // itself, so the plugin must not also inject registerSW.js into the HTML.
      // That injected copy is what bound registration to the `load` event.
      injectRegister: null,
      // The plugin precaches the manifest's icons on its own; these are the
      // ones only index.html references, so they need naming.
      includeAssets: ['favicon.svg', 'favicon-96.png', 'apple-touch-icon.png'],
      workbox: {
        runtimeCaching: [
          {
            // Recipe photos come from arbitrary sites and CDNs, so they can't be
            // precached by name. CacheFirst because a saved recipe's photo does
            // not change, and without it an offline list is a page of broken
            // images even though the text came out of the mirror fine.
            urlPattern: ({ request }) => request.destination === 'image',
            handler: 'CacheFirst',
            options: {
              cacheName: 'recipe-images',
              expiration: { maxEntries: 120, maxAgeSeconds: 60 * 60 * 24 * 60 },
              // Cross-origin images without CORS come back opaque, with status
              // 0. Leaving 0 out would mean nothing from a CDN is ever stored.
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      manifest: {
        name: 'Recipe Box',
        short_name: 'Recipes',
        description: 'Save recipes from anywhere, plan the week',
        theme_color: '#1c7c54',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        // Two sets, deliberately not one "any maskable" entry. Android crops a
        // maskable icon to the launcher's shape, so its artwork has to sit
        // inside the 80% safe circle; an "any" icon is shown uncropped and
        // would look lost in that padding. scripts/icons.py generates both.
        icons: [
          { src: '/pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: '/pwa-maskable-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable',
          },
          {
            src: '/pwa-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
        // OS share sheet → import flow. Sharing from TikTok/IG apps lands here.
        share_target: {
          action: '/',
          method: 'GET',
          params: { url: 'url', text: 'text', title: 'title' },
        },
      },
    }),
  ],
})
