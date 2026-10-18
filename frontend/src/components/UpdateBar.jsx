import { applyPendingUpdate, dismissUpdate, useUpdateReady } from '../lib/pwa.js'

// "A new version is ready", shown by the version that is RUNNING when a newer
// service worker is waiting. In flow under the header, not fixed: the bottom
// already holds the tab bar, toast, install card and add button, and a fixed top
// bar covers the header's Timers and Sign in.
//
// Reload is held while a capture is in progress (`busy`): a reload would throw
// away a half-pasted recipe, so the text says to finish first.
export default function UpdateBar() {
  const { show, busy } = useUpdateReady()
  if (!show) return null

  return (
    <div className="rb-update" role="status">
      <span className="rb-update-text">
        {busy ? 'A new version is ready. Finish what you are saving first.' : 'A new version is ready.'}
      </span>
      <button type="button" className="rb-update-reload" disabled={busy} onClick={applyPendingUpdate}>
        Reload
      </button>
      <button type="button" className="rb-update-later" onClick={dismissUpdate}>
        Later
      </button>
    </div>
  )
}
