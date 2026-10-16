// Push handling for the generated service worker (vite.config.js `importScripts`).
//
// The server sends a Declarative Web Push (backend/app/push.py): iOS 18.4+ shows
// it by itself without running any code here, and opens its `navigate` URL on a
// tap. This file is for everything else: iOS 16.4 to 18.3 and desktop browsers
// need a worker to show it. Both paths use the payload's `tag`, so where a
// browser does both the second replaces the first instead of doubling it.

self.addEventListener('push', (event) => {
  let note = null
  try {
    note = event.data?.json()?.notification
  } catch {
    // Not our payload; nothing to show.
  }
  if (!note || !note.title) return
  event.waitUntil(
    self.registration.showNotification(note.title, {
      body: note.body || '',
      tag: note.tag || 'timer',
      data: { url: note.navigate || '/' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = event.notification.data?.url || '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      // Reuse the app if it is already open, rather than stacking a second one.
      for (const win of windows) {
        if ('navigate' in win && 'focus' in win) return win.navigate(url).then((w) => w?.focus())
      }
      return self.clients.openWindow(url)
    }),
  )
})
