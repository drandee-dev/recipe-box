import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
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
