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
      manifest: {
        name: 'Recipe Box',
        short_name: 'Recipes',
        description: 'Save recipes from anywhere, plan the week',
        theme_color: '#1c7c54',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-512.png', sizes: '512x512', type: 'image/png' },
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
